// Scripted stand-ins for both agents, used when no ANTHROPIC_API_KEY is set
// (or MOCK_AI=1). They call the very same tools as the real agents, so the
// whole money path (hold, PayPal order, approval, capture, refund) can be
// built and tested without spending anything on a model.
import type { AgentTool } from "./loop.ts";
import { addDays, availability, localNow, type Booking, type Business } from "../store.ts";

type OnTool = (name: string, input: unknown, out: unknown) => void;

async function call(tools: AgentTool[], name: string, input: Record<string, unknown>, onTool: OnTool) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`mock: no tool ${name}`);
  const out = await t.run(t.schema.parse(input));
  onTool(name, input, out);
  return out as Record<string, unknown>;
}

const names = new Map<string, string>();

function nameFrom(text: string): string | undefined {
  const m = text.match(/\b(?:my name is|i am|i'm|name:)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  return m?.[1];
}

export async function mockBuyerTurn(sessionId: string, text: string, tools: AgentTool[], onTool: OnTool): Promise<string> {
  const found = nameFrom(text);
  if (found) names.set(sessionId, found);
  const name = names.get(sessionId);
  if (!name) return "Happy to sort that out. What name should the booking be under?";

  const search = await call(tools, "find_businesses", { query: text }, onTool);
  const list = search.businesses as Array<{ business_id: string; name: string }>;
  const pick = list[0];
  const ask = `Hello, I'm booking for my customer ${name}. They asked: "${text.replace(/\s+/g, " ").slice(0, 200)}". Please hold the best matching time and create the payment.`;
  const res = await call(tools, "message_business", { business_id: pick.business_id, message: ask }, onTool);
  const payment = res.payment as { order_id: string; amount: string; service: string; date: string; time: string } | undefined;
  if (!payment) return `I asked ${pick.name}, and they said: ${res.reply as string}`;
  const approval = await call(tools, "request_payment_approval", { order_id: payment.order_id }, onTool);
  if ("error" in approval) {
    return `${pick.name} can do ${payment.service} on ${payment.date} at ${payment.time} for USD ${payment.amount}, but that is above your spending limit, so I have not shown you a payment. Raise the limit or tell me what to change.`;
  }
  return `${pick.name} is holding ${payment.service} on ${payment.date} at ${payment.time} for you, USD ${payment.amount}. Approve it with PayPal below to confirm; nothing is charged until you do.`;
}

export async function mockSecretaryTurn(b: Business, _sessionId: string, message: string, tools: AgentTool[], onTool: OnTool): Promise<string> {
  const lower = message.toLowerCase();
  const name = message.match(/my customer ([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/)?.[1] ?? "Guest";
  const services = (await call(tools, "list_services", {}, onTool)).services as Business["services"];
  const svc =
    services.find((s) => s.name.toLowerCase().split(/[^a-z]+/).some((w) => w.length > 3 && lower.includes(w))) ?? services[0];

  const today = localNow(b.timezone).date;
  const wantAfternoon = lower.includes("afternoon") || lower.includes("evening");
  const startOffset = lower.includes("tomorrow") ? 1 : 0;
  for (let d = startOffset; d < 8; d++) {
    const date = addDays(today, d);
    const free = availability(b.id, svc.id, date);
    if (!free.length) continue;
    await call(tools, "check_availability", { service_id: svc.id, date }, onTool);
    const time = (wantAfternoon && free.find((t) => t >= "12:00")) || free[0];
    const hold = await call(tools, "hold_time", { service_id: svc.id, date, time, customer_name: name }, onTool);
    if ("error" in hold) return String(hold.error);
    const pay = await call(tools, "create_payment", { hold_id: hold.hold_id }, onTool);
    if ("error" in pay) return String(pay.error);
    return `Held ${svc.name} on ${date} at ${time} (${b.city} time) for ${name}, USD ${svc.price}. PayPal order ${pay.order_id} is ready; the customer must approve it. Policy: ${b.policy}`;
  }
  return `Sorry, ${svc.name} has no free time in the next week.`;
}

export function mockAfterPayment(bk: Booking): string {
  return `Done. PayPal confirmed your payment of ${bk.currency} ${bk.amount}, and ${bk.serviceName} on ${bk.date} at ${bk.time} is booked. Your reference is ${bk.ref}.`;
}

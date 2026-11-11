// Scripted stand-ins for both agents, used when no ANTHROPIC_API_KEY is set
// (or MOCK_AI=1). They call the very same tools as the real agents, so the
// whole money path (hold, PayPal order, approval, capture, refund) can be
// built and tested without spending anything on a model.
import type { AgentTool } from "./loop.ts";
import { addDays, availability, localNow, weekdayOf, type Booking, type Business } from "../store.ts";

type OnTool = (name: string, input: unknown, out: unknown) => void;

async function call(tools: AgentTool[], name: string, input: Record<string, unknown>, onTool: OnTool) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`mock: no tool ${name}`);
  const out = await t.run(t.schema.parse(input));
  onTool(name, input, out);
  return out as Record<string, unknown>;
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
export const niceDate = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
const cityTime = (b: { timezone: string }) => b.timezone.split("/")[1]?.replace("_", " ");

const names = new Map<string, string>();
const pending = new Map<string, string>(); // what they asked for before giving a name

function nameFrom(text: string): string | undefined {
  const m = text.match(/\b(?:my name is|i am|i'm|it's|name:)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  if (m) return m[1];
  const bare = text.trim().match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\.?$/);
  return bare?.[1];
}

export async function mockBuyerTurn(sessionId: string, text: string, tools: AgentTool[], onTool: OnTool): Promise<string> {
  const found = nameFrom(text);
  if (found) names.set(sessionId, found);
  const name = names.get(sessionId);
  const ask = (pending.get(sessionId) ?? "") + " " + text;
  if (!name) {
    pending.set(sessionId, text);
    return "Happy to sort that out. What name should I put it under?";
  }
  pending.delete(sessionId);

  const search = await call(tools, "find_businesses", { query: ask }, onTool);
  const list = search.businesses as Array<{ business_id: string; name: string; city: string }>;
  const pick = list[0];
  const msg = `Hi, I'm booking for ${name}. They'd like: ${ask.replace(/\s+/g, " ").trim().slice(0, 200)}. What's your best match and earliest fitting time? Please hold it and create the payment.`;
  const res = await call(tools, "message_business", { business_id: pick.business_id, message: msg }, onTool);
  // Only the server's offer is used for facts (rule 8); the Secretary's prose is ignored here.
  const offer = res.offer as { offer_id: string; price: string; item: string; date: string; time: string } | undefined;
  if (!offer) return `I checked with ${pick.name}. ${res.reply as string}`;
  const payment = { amount: offer.price, service: offer.item, date: offer.date, time: offer.time };
  const approval = await call(tools, "request_payment_approval", { offer_id: offer.offer_id }, onTool);
  if ("error" in approval) {
    return `${pick.name} can do ${payment.service} on ${niceDate(payment.date)} at ${payment.time} for $${payment.amount}, but that's over your $${String(approval.error).match(/limit of USD (\d+)/)?.[1] ?? ""} spending limit, so I haven't sent you a payment. Raise your limit in Settings, or tell me what to change.`;
  }
  return `${pick.name} in ${pick.city} can do ${payment.service} on ${niceDate(payment.date)} at ${payment.time}, local time, for $${payment.amount}. I've held it for 15 minutes. Approve with PayPal below to confirm it.`;
}

function pickDate(b: Business, lower: string, svcId: string): string | undefined {
  const today = localNow(b.timezone).date;
  const dayIdx = DAYS.findIndex((d) => lower.includes(d));
  const start = lower.includes("tomorrow") ? 1 : 0;
  for (let d = start; d < 10; d++) {
    const date = addDays(today, d);
    if (dayIdx >= 0 && weekdayOf(date) !== dayIdx) continue;
    if (availability(b.id, svcId, date).length) return date;
  }
  return undefined;
}

export async function mockSecretaryTurn(b: Business, _sessionId: string, message: string, tools: AgentTool[], onTool: OnTool): Promise<string> {
  const lower = message.toLowerCase();
  const name = message.match(/booking for ([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/)?.[1] ?? "Guest";
  const items = (await call(tools, "list_services", {}, onTool)).items as Array<{ service_id: string; name: string; price: string }>;
  const score = (name: string) => name.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3 && lower.includes(w)).length;
  const hit = [...items].sort((x, y) => score(y.name) - score(x.name))[0];
  if (!hit) return "Sorry, we have nothing on sale right now.";
  const svc = { id: hit.service_id, name: hit.name, price: hit.price };

  const date = pickDate(b, lower, svc.id);
  if (!date) return `Sorry, ${svc.name} has nothing free in the next week or so.`;
  const avail = await call(tools, "check_availability", { service_id: svc.id, date }, onTool);
  const free = avail.free_start_times as string[];
  const wantAfternoon = lower.includes("afternoon") || lower.includes("evening");
  const time = (wantAfternoon && free.find((t) => t >= "12:00")) || free[0];
  const hold = await call(tools, "hold_time", { service_id: svc.id, date, time, customer_name: name }, onTool);
  if ("error" in hold) return String(hold.error);
  const pay = await call(tools, "create_payment", { hold_id: hold.hold_id }, onTool);
  if ("error" in pay) return String(pay.error);
  return `Our best match is ${svc.name}. I've held ${niceDate(date)} at ${time} (${cityTime(b)} time) for ${name}, $${svc.price}, and created the PayPal order. It's only booked once they approve. ${b.policy}`;
}

export function mockAfterPayment(bk: Booking): string {
  return `You're booked. PayPal confirmed $${bk.amount}, and ${bk.serviceName} on ${niceDate(bk.date)} at ${bk.time} is yours. Your reference is ${bk.ref}; it's in Bookings too.`;
}

// The customer's side: a personal AI agent that finds a business, talks to
// that business's Secretary, and brings a payment back for its human to
// approve in PayPal. It can never pay by itself.
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { requestApproval, session } from "../commerce.ts";
import { emit } from "../events.ts";
import { BUSINESSES, type Booking } from "../store.ts";
import { askSecretary, noteForSecretary } from "./secretary.ts";
import { aiMode, runAgent, tool } from "./loop.ts";
import { mockBuyerTurn, mockAfterPayment } from "./mock.ts";

const SYSTEM = [
  "You are the customer's personal AI assistant. You book appointments and classes for them with businesses that run an AI Secretary.",
  "",
  "How you work:",
  "- Use find_businesses to choose a business, then message_business to talk to its Secretary. Ask it for services, prices and free times; do not guess them.",
  "- Ask the Secretary to hold the time that best fits what the customer asked, under the customer's name, and to create the payment.",
  "- If you do not know the customer's name, ask them before holding a time.",
  "- When the Secretary gives you an order id, call request_payment_approval with it. The customer then sees a PayPal button; nothing is paid until they approve it there.",
  "- After that, stop and tell the customer in two or three short sentences what they are approving: the business, service, date, time, price, and the cancellation policy.",
  "- Never say a booking is confirmed until a message from the Ordina server says PayPal confirmed the payment.",
  "- The customer has a spending limit. The server refuses any payment above it; if that happens, say so and offer options.",
  "",
  "Style: warm, short, plain sentences. No lists unless comparing options. Use the business's local time and say which city it is in.",
].join("\n");

const histories = new Map<string, Anthropic.Beta.BetaMessageParam[]>();
const busy = new Set<string>();

function findBusinesses(query: string) {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const scored = BUSINESSES.map((b) => {
    const hay = [b.name, b.category, b.city, b.about, ...b.services.map((s) => s.name)].join(" ").toLowerCase();
    return { b, score: words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0) };
  }).sort((a, z) => z.score - a.score);
  const hits = scored.filter((x) => x.score > 0);
  return (hits.length ? hits : scored).map(({ b }) => ({
    business_id: b.id,
    name: b.name,
    category: b.category,
    city: b.city,
    timezone: b.timezone,
    about: b.about,
    services: b.services.map((s) => `${s.name}: ${s.minutes} min, USD ${s.price}`),
    cancellation_policy: b.policy,
  }));
}

function toolsFor(sessionId: string) {
  return [
    tool({
      name: "find_businesses",
      description: "Search businesses that accept agent bookings, by what the customer wants (service, kind of business, city).",
      schema: z.strictObject({ query: z.string() }),
      run: ({ query }) => ({ businesses: findBusinesses(query) }),
    }),
    tool({
      name: "message_business",
      description:
        "Send one message to a business's AI Secretary and get its reply. If the Secretary created a payment, the reply includes it.",
      schema: z.strictObject({ business_id: z.string(), message: z.string() }),
      run: ({ business_id, message }) => askSecretary(sessionId, business_id, message.slice(0, 2000)),
    }),
    tool({
      name: "request_payment_approval",
      description:
        "Show a PayPal payment to the customer for approval. Refused if it is above the customer's spending limit.",
      schema: z.strictObject({ order_id: z.string() }),
      run: ({ order_id }) => requestApproval(sessionId, order_id),
    }),
  ];
}

export class BusyError extends Error {}

export async function buyerTurn(sessionId: string, text: string): Promise<string> {
  if (busy.has(sessionId)) throw new BusyError("Still working on your last message.");
  busy.add(sessionId);
  try {
    const s = session(sessionId);
    emit({ sessionId, kind: "assistant", actor: "buyer", title: "You", detail: text, data: { role: "user" } });
    let reply: string;
    if (aiMode() === "mock") {
      reply = await mockBuyerTurn(sessionId, text, toolsFor(sessionId), (name, input, out) => {
        if (name === "message_business") return; // the Secretary's side already logs the exchange
        emit({ sessionId, kind: "tool", actor: "buyer", title: name, detail: JSON.stringify(input), data: { result: out } });
      });
    } else {
      const history = histories.get(sessionId) ?? [];
      histories.set(sessionId, history);
      const today = new Date().toISOString().slice(0, 10);
      history.push({
        role: "user",
        content: `[Today is ${today} (UTC). Spending limit: USD ${s.budget.toFixed(2)}]\n${text.slice(0, 2000)}`,
      });
      const r = await runAgent({
        system: SYSTEM,
        tools: toolsFor(sessionId),
        messages: history,
        maxIterations: 8,
        onToolCall: (name, input, out) => {
          if (name === "message_business") return; // the Secretary's side already logs the exchange
          emit({ sessionId, kind: "tool", actor: "buyer", title: name, detail: JSON.stringify(input), data: { result: out } });
        },
      });
      reply = r.text || "Sorry, I lost track there. Could you say that again?";
    }
    emit({ sessionId, kind: "assistant", actor: "buyer", title: "Your assistant", detail: reply, data: { role: "assistant" } });
    return reply;
  } finally {
    busy.delete(sessionId);
  }
}

/** After PayPal confirms: tell both agents, and let the customer's agent sum up. */
export async function afterPayment(sessionId: string, booking: Booking): Promise<string> {
  const note = `PayPal confirmed the payment of ${booking.currency} ${booking.amount}. Booking ${booking.ref} is confirmed: ${booking.serviceName} on ${booking.date} at ${booking.time} for ${booking.customerName}.`;
  noteForSecretary(sessionId, booking.businessId, note);
  let reply: string;
  if (aiMode() === "mock" || !histories.has(sessionId)) {
    reply = mockAfterPayment(booking);
  } else {
    const history = histories.get(sessionId)!;
    history.push({ role: "user", content: `[Ordina server] ${note} Tell the customer in one or two sentences.` });
    try {
      const r = await runAgent({ system: SYSTEM, tools: toolsFor(sessionId), messages: history, maxIterations: 2 });
      reply = r.text || mockAfterPayment(booking);
    } catch {
      reply = mockAfterPayment(booking);
    }
  }
  emit({ sessionId, kind: "assistant", actor: "buyer", title: "Your assistant", detail: reply, data: { role: "assistant" } });
  return reply;
}

export function resetBuyers() {
  histories.clear();
  busy.clear();
}

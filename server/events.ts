// The "agent wire": everything that passes between the customer's agent, the
// business's Secretary and PayPal, pushed to the browser over SSE.
import { EventEmitter } from "node:events";

export type WireEvent = {
  id: number;
  at: number;
  sessionId: string;
  businessId?: string;
  kind:
    | "buyer_to_business" // customer's agent -> Secretary
    | "business_to_buyer" // Secretary -> customer's agent
    | "tool" // a tool one of the agents ran
    | "paypal" // a PayPal API call and its result
    | "guardrail" // something the server refused
    | "approval" // a payment waits for the human
    | "booking" // a booking confirmed or refunded
    | "assistant"; // the customer's agent answered its human
  actor: "buyer" | "secretary" | "paypal" | "server" | "owner";
  title: string;
  detail?: string;
  data?: Record<string, unknown>;
};

const bus = new EventEmitter();
bus.setMaxListeners(200);
const history = new Map<string, WireEvent[]>();
let seq = 0;

export function emit(e: Omit<WireEvent, "id" | "at">): WireEvent {
  const full: WireEvent = { ...e, id: ++seq, at: Date.now() };
  const list = history.get(e.sessionId) ?? [];
  list.push(full);
  if (list.length > 300) list.shift();
  history.set(e.sessionId, list);
  bus.emit(`s:${e.sessionId}`, full);
  if (e.businessId) bus.emit(`b:${e.businessId}`, full);
  return full;
}

export function eventsFor(sessionId: string): WireEvent[] {
  return history.get(sessionId) ?? [];
}

export function subscribe(channel: `s:${string}` | `b:${string}`, fn: (e: WireEvent) => void): () => void {
  bus.on(channel, fn);
  return () => bus.off(channel, fn);
}

export function clearSession(sessionId: string) {
  history.delete(sessionId);
}

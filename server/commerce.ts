// The money path. Agents can ask for these actions, but every rule that
// protects the customer or the business is enforced here, in code:
// - the price comes from the business's list, never from a model;
// - a payment above the customer's budget is refused before it is shown;
// - nothing is paid without the human approving it in PayPal;
// - a booking exists only after PayPal says the capture COMPLETED for the
//   exact amount and currency of the held service.
import { emit } from "./events.ts";
import * as paypal from "./paypal.ts";
import {
  confirmBooking,
  getBooking,
  getBusiness,
  getHold,
  getService,
  holdByOrder,
  bookingByOrder,
  zonedToUtc,
  type Booking,
} from "./store.ts";

export type Session = {
  id: string;
  budget: number; // the most the customer's agent may ask them to pay, in USD
  pendingOrderId?: string; // the one payment waiting for the human
};

const sessions = new Map<string, Session>();

export function session(id: string): Session {
  let s = sessions.get(id);
  if (!s) {
    s = { id, budget: 50 };
    sessions.set(id, s);
  }
  return s;
}

export function setBudget(id: string, budget: number) {
  const s = session(id);
  s.budget = Math.max(0, Math.min(500, Math.round(budget)));
  return s;
}

/** Secretary tool: create the PayPal order for a held time. */
export async function startPayment(holdId: string, sessionId: string) {
  const hold = getHold(holdId);
  if (!hold || hold.sessionId !== sessionId) return { error: "No such hold in this conversation." };
  if (hold.status !== "held") return { error: `The hold is ${hold.status}; hold the time again first.` };
  const b = getBusiness(hold.businessId)!;
  const s = getService(b, hold.serviceId)!;
  if (hold.orderId) {
    return { order_id: hold.orderId, amount: s.price, currency: b.currency, already_created: true };
  }
  emit({
    sessionId,
    businessId: b.id,
    kind: "paypal",
    actor: "secretary",
    title: "Create PayPal order",
    detail: `${s.name}, ${hold.date} ${hold.time}: ${b.currency} ${s.price}`,
  });
  const order = await paypal.createOrder({
    amount: s.price,
    currency: b.currency,
    description: `${s.name} at ${b.name}, ${hold.date} ${hold.time}`,
    referenceId: hold.id,
    brandName: b.name,
  });
  hold.orderId = order.id;
  emit({
    sessionId,
    businessId: b.id,
    kind: "paypal",
    actor: "paypal",
    title: `Order ${order.status}`,
    detail: order.id,
    data: { orderId: order.id },
  });
  return {
    order_id: order.id,
    amount: s.price,
    currency: b.currency,
    service: s.name,
    date: hold.date,
    time: hold.time,
    hold_expires_in_minutes: Math.max(0, Math.round((hold.expiresAt - Date.now()) / 60_000)),
  };
}

/** Buyer tool: show a payment to the human. Refused above the budget. */
export function requestApproval(sessionId: string, orderId: string) {
  const s = session(sessionId);
  const hold = holdByOrder(orderId);
  if (!hold || hold.sessionId !== sessionId) return { error: "Unknown order for this conversation." };
  if (hold.status !== "held") return { error: `The hold behind this order is ${hold.status}.` };
  const b = getBusiness(hold.businessId)!;
  const svc = getService(b, hold.serviceId)!;
  const amount = Number(svc.price);
  if (amount > s.budget) {
    emit({
      sessionId,
      businessId: b.id,
      kind: "guardrail",
      actor: "server",
      title: "Over budget: payment not shown",
      detail: `${b.currency} ${svc.price} is above the ${b.currency} ${s.budget.toFixed(2)} limit you set.`,
    });
    return {
      error: `Refused: ${b.currency} ${svc.price} is above the customer's limit of ${b.currency} ${s.budget.toFixed(2)}. Tell the customer and ask whether they want to raise the limit or choose something else.`,
    };
  }
  s.pendingOrderId = orderId;
  const card = {
    orderId,
    businessId: b.id,
    businessName: b.name,
    service: svc.name,
    date: hold.date,
    time: hold.time,
    timezone: b.timezone,
    amount: svc.price,
    currency: b.currency,
    policy: b.policy,
    expiresAt: hold.expiresAt,
  };
  emit({
    sessionId,
    businessId: b.id,
    kind: "approval",
    actor: "server",
    title: "Waiting for your approval in PayPal",
    detail: `${svc.name} at ${b.name}, ${b.currency} ${svc.price}`,
    data: card,
  });
  return {
    status: "shown_to_customer",
    note: "The customer now sees a PayPal button. Nothing is paid until they approve it. Stop and tell them what they are approving.",
  };
}

export type CaptureOutcome =
  | { ok: true; booking: Booking }
  | { ok: false; reason: string };

/** Browser, after the human approved in PayPal: capture and confirm. */
export async function captureAndConfirm(sessionId: string, orderId: string): Promise<CaptureOutcome> {
  const s = session(sessionId);
  const existing = bookingByOrder(orderId);
  if (existing && existing.sessionId === sessionId) return { ok: true, booking: existing };
  const hold = holdByOrder(orderId);
  if (!hold || hold.sessionId !== sessionId) return { ok: false, reason: "Unknown order for this conversation." };
  if (s.pendingOrderId !== orderId) return { ok: false, reason: "This payment was not the one shown for approval." };
  const b = getBusiness(hold.businessId)!;
  const svc = getService(b, hold.serviceId)!;
  if (hold.status !== "held") {
    return { ok: false, reason: `The time is no longer held (${hold.status}). Nothing was charged.` };
  }

  let cap: paypal.CaptureResult;
  try {
    cap = await paypal.captureOrder(orderId);
  } catch (err) {
    const reason = err instanceof paypal.PayPalError ? err.issue : "PAYPAL_ERROR";
    emit({ sessionId, businessId: b.id, kind: "paypal", actor: "paypal", title: `Capture failed: ${reason}` });
    return { ok: false, reason: `PayPal did not complete the payment (${reason}).` };
  }
  emit({
    sessionId,
    businessId: b.id,
    kind: "paypal",
    actor: "paypal",
    title: `Capture ${cap.captureStatus ?? cap.status}`,
    detail: `${cap.currency ?? ""} ${cap.amount ?? ""} ${cap.captureId ?? ""}`.trim(),
  });

  // Positive confirmation only: the capture itself must say COMPLETED, for
  // exactly the held service's price and currency.
  const exact = cap.amount === svc.price && cap.currency === b.currency;
  if (cap.status !== "COMPLETED" || cap.captureStatus !== "COMPLETED" || !cap.captureId || !exact) {
    emit({
      sessionId,
      businessId: b.id,
      kind: "guardrail",
      actor: "server",
      title: "Not booked: payment not confirmed",
      detail: `status ${cap.status}/${cap.captureStatus}, amount ${cap.currency} ${cap.amount}`,
    });
    return { ok: false, reason: "PayPal did not confirm the full payment, so nothing was booked." };
  }

  const booking = confirmBooking(hold, {
    orderId,
    captureId: cap.captureId,
    amount: cap.amount!,
    currency: cap.currency!,
  });
  s.pendingOrderId = undefined;
  emit({
    sessionId,
    businessId: b.id,
    kind: "booking",
    actor: "secretary",
    title: `Booking confirmed, ref ${booking.ref}`,
    detail: `${booking.serviceName}, ${new Date(`${booking.date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })} at ${booking.time}, ${b.city} time`,
    data: { bookingId: booking.id, orderId },
  });
  return { ok: true, booking };
}

/** Owner dashboard: full refund of a booking through PayPal. */
export async function refundBooking(bookingId: string, by: "owner" | "customer" = "owner"): Promise<{ ok: true; booking: Booking } | { ok: false; reason: string }> {
  const bk = getBooking(bookingId);
  if (!bk) return { ok: false, reason: "No such booking." };
  if (bk.status !== "confirmed") return { ok: true, booking: bk };
  const b = getBusiness(bk.businessId)!;
  emit({
    sessionId: bk.sessionId,
    businessId: b.id,
    kind: "paypal",
    actor: by === "owner" ? "owner" : "buyer",
    title: by === "owner" ? "Refund requested by the business" : "You cancelled; refund requested",
    detail: `${bk.currency} ${bk.amount} on capture ${bk.captureId}`,
  });
  let res: paypal.RefundResult;
  try {
    res = await paypal.refundCapture(bk.captureId, `Refund from ${b.name} for booking ${bk.ref}`);
  } catch (err) {
    const reason = err instanceof paypal.PayPalError ? err.issue : "PAYPAL_ERROR";
    emit({ sessionId: bk.sessionId, businessId: b.id, kind: "paypal", actor: "paypal", title: `Refund failed: ${reason}` });
    return { ok: false, reason: `PayPal refused the refund (${reason}).` };
  }
  emit({
    sessionId: bk.sessionId,
    businessId: b.id,
    kind: "paypal",
    actor: "paypal",
    title: `Refund ${res.status}`,
    detail: res.id,
  });
  if (res.status !== "COMPLETED" && res.status !== "PENDING") {
    return { ok: false, reason: `PayPal answered ${res.status}.` };
  }
  bk.status = res.status === "COMPLETED" ? "refunded" : "refund_pending";
  bk.refundedAt = Date.now();
  bk.refundId = res.id;
  emit({
    sessionId: bk.sessionId,
    businessId: b.id,
    kind: "booking",
    actor: "owner",
    title: res.status === "COMPLETED" ? `Booking ${bk.ref} refunded` : `Refund for ${bk.ref} pending at PayPal`,
    detail: res.status === "PENDING" ? "PayPal is still processing the refund." : undefined,
  });
  return { ok: true, booking: bk };
}

/** When a customer may still cancel for a full refund (null if never). */
export function cancelDeadline(bk: Booking): number | null {
  const b = getBusiness(bk.businessId);
  if (!b || bk.status !== "confirmed") return null;
  return zonedToUtc(bk.date, bk.time, b.timezone) - b.cancelHours * 3_600_000;
}

/** The customer cancels; refunded in full through PayPal if the policy allows. */
export async function customerCancel(sessionIds: string[], bookingId: string, now = Date.now()) {
  const bk = getBooking(bookingId);
  if (!bk || !sessionIds.includes(bk.sessionId)) return { ok: false as const, reason: "No such booking." };
  if (bk.status !== "confirmed") return { ok: false as const, reason: "This booking is already cancelled." };
  const deadline = cancelDeadline(bk)!;
  if (now > deadline) {
    const b = getBusiness(bk.businessId)!;
    return { ok: false as const, reason: `Too late to cancel for a refund. ${b.policy}` };
  }
  return refundBooking(bk.id, "customer");
}

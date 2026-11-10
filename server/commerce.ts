// The money path. Agents can ask for these actions, but every rule that
// protects the customer, the business or Ordina is enforced here, in code
// (docs/BUSINESS_SIDE.md):
// - the price comes from the business's list, never from a model;
// - a payment above the customer's limit is refused before it is shown;
// - nothing is paid without the human approving it in PayPal;
// - a booking exists only after PayPal says the capture COMPLETED for the
//   exact amount and currency of the held item;
// - the business is owed the net PayPal reported, minus what refunds cost;
// - no refund through Agent Pay once the business has been paid out.
import { emit } from "./events.ts";
import * as paypal from "./paypal.ts";
import {
  addRefund,
  bookingByOrder,
  confirmBooking,
  fromCents,
  getBooking,
  getBusiness,
  getHold,
  getItemAnyState,
  getService,
  holdByOrder,
  toCents,
  updateBooking,
  type Booking,
} from "./store.ts";

const niceDate = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

export type Session = { id: string; budget: number; pendingOrderId?: string; pinnedBusinessId?: string };
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

/** Secretary tool: create the PayPal order for a held time, at the listed price. */
export async function startPayment(holdId: string, sessionId: string) {
  const hold = getHold(holdId);
  if (!hold || hold.sessionId !== sessionId) return { error: "No such hold in this conversation." };
  if (hold.status !== "held") return { error: `The hold is ${hold.status}; hold the time again first.` };
  const b = getBusiness(hold.businessId)!;
  const s = getService(b, hold.serviceId);
  if (!s) return { error: "That item is no longer offered." };
  if (hold.orderId) return { order_id: hold.orderId, amount: s.price, currency: b.currency, already_created: true };
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
  emit({ sessionId, businessId: b.id, kind: "paypal", actor: "paypal", title: `Order ${order.status}`, detail: order.id, data: { orderId: order.id } });
  return {
    order_id: order.id,
    amount: s.price,
    currency: b.currency,
    service: s.name,
    kind: s.kind,
    date: hold.date,
    time: hold.time,
    hold_expires_in_minutes: Math.max(0, Math.round((hold.expiresAt - Date.now()) / 60_000)),
  };
}

/** Buyer tool: show a payment to the human. Refused above their limit. */
export function requestApproval(sessionId: string, orderId: string) {
  const s = session(sessionId);
  const hold = holdByOrder(orderId);
  if (!hold || hold.sessionId !== sessionId) return { error: "Unknown order for this conversation." };
  if (hold.status !== "held") return { error: `The hold behind this order is ${hold.status}.` };
  const b = getBusiness(hold.businessId)!;
  const svc = getService(b, hold.serviceId);
  if (!svc) return { error: "That item is no longer offered." };
  if (Number(svc.price) > s.budget) {
    emit({
      sessionId,
      businessId: b.id,
      kind: "guardrail",
      actor: "server",
      title: "Over your limit: payment not shown",
      detail: `${b.currency} ${svc.price} is above the ${b.currency} ${s.budget.toFixed(2)} limit you set.`,
    });
    return {
      error: `Refused: ${b.currency} ${svc.price} is above the customer's limit of ${b.currency} ${s.budget.toFixed(2)}. Tell the customer and ask whether they want to raise the limit or choose something else.`,
    };
  }
  s.pendingOrderId = orderId;
  emit({
    sessionId,
    businessId: b.id,
    kind: "approval",
    actor: "server",
    title: "Waiting for your approval in PayPal",
    detail: `${svc.name} at ${b.name}, ${b.currency} ${svc.price}`,
    data: {
      orderId,
      businessId: b.id,
      businessName: b.name,
      service: svc.name,
      kind: svc.kind,
      date: hold.date,
      time: hold.time,
      timezone: b.timezone,
      amount: svc.price,
      currency: b.currency,
      policy: b.policy,
      expiresAt: hold.expiresAt,
    },
  });
  return {
    status: "shown_to_customer",
    note: "The customer now sees a PayPal button. Nothing is paid until they approve it. Stop and tell them what they are approving.",
  };
}

export type CaptureOutcome = { ok: true; booking: Booking } | { ok: false; reason: string };

/** Browser, after the human approved in PayPal: capture and confirm. */
export async function captureAndConfirm(sessionId: string, orderId: string): Promise<CaptureOutcome> {
  const s = session(sessionId);
  const existing = bookingByOrder(orderId);
  if (existing && existing.sessionId === sessionId) return { ok: true, booking: existing };
  const hold = holdByOrder(orderId);
  if (!hold || hold.sessionId !== sessionId) return { ok: false, reason: "Unknown order for this conversation." };
  if (s.pendingOrderId !== orderId) return { ok: false, reason: "This payment was not the one shown for approval." };
  const b = getBusiness(hold.businessId)!;
  const svc = getItemAnyState(hold.serviceId)!;
  if (hold.status !== "held") return { ok: false, reason: `The time is no longer held (${hold.status}). Nothing was charged.` };

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

  // Positive confirmation only: COMPLETED, for exactly the listed price.
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

  const feeKnown = cap.paypalFee !== undefined && cap.netAmount !== undefined;
  let booking = confirmBooking(hold, {
    orderId,
    captureId: cap.captureId,
    amount: cap.amount!,
    currency: cap.currency!,
    paypalFee: cap.paypalFee ?? "0.00",
    netAmount: cap.netAmount ?? "0.00",
    payerName: cap.payerName,
    payerEmail: cap.payerEmail,
  });
  if (!feeKnown) {
    // Never guess what the business is owed.
    booking = updateBooking(booking.id, { payout_status: "failed", payout_note: "PayPal did not report its fee; pay out by hand." });
  }
  s.pendingOrderId = undefined;
  emit({
    sessionId,
    businessId: b.id,
    kind: "booking",
    actor: "secretary",
    title: `${svc.kind === "pickup" ? "Order" : "Booking"} confirmed, ref ${booking.ref}`,
    detail: `${booking.serviceName}, ${niceDate(booking.date)} at ${booking.time}, ${b.city} time`,
    data: { bookingId: booking.id, orderId },
  });
  return { ok: true, booking };
}

// ---------- refunds and cancellations ----------
type Result = { ok: true; booking: Booking } | { ok: false; reason: string };

/** What the business will be paid for a booking, in cents (never below zero). */
export function payoutCents(bk: Booking): number {
  return Math.max(0, toCents(bk.netAmount) - toCents(bk.refundDebit));
}
export const refundableCents = (bk: Booking) => toCents(bk.amount) - toCents(bk.refunded);
export const canRefund = (bk: Booking) => bk.payoutStatus === "waiting" && refundableCents(bk) > 0;

async function refund(bk: Booking, cents: number, by: "customer" | "business"): Promise<Result> {
  if (bk.payoutStatus !== "waiting") {
    return { ok: false, reason: "This booking has already been paid out to the business. Any refund is settled directly between you." };
  }
  if (!Number.isInteger(cents) || cents <= 0) return { ok: false, reason: "Enter an amount above zero." };
  if (cents > refundableCents(bk)) return { ok: false, reason: `At most $${fromCents(refundableCents(bk))} can still be refunded.` };
  const b = getBusiness(bk.businessId)!;
  const amount = fromCents(cents);
  emit({
    sessionId: bk.sessionId,
    businessId: b.id,
    kind: "paypal",
    actor: by === "business" ? "owner" : "buyer",
    title: by === "business" ? `${b.name} refunded $${amount}` : "You cancelled; refund requested",
    detail: `${bk.currency} ${amount} on capture ${bk.captureId}`,
  });
  let res: paypal.RefundResult;
  try {
    res = await paypal.refundCapture(bk.captureId, {
      amount,
      currency: bk.currency,
      note: `Refund from ${b.name} for ${bk.ref}`,
      key: `${bk.id}-${bk.refunded}-${amount}`,
    });
  } catch (err) {
    const reason = err instanceof paypal.PayPalError ? err.issue : "PAYPAL_ERROR";
    emit({ sessionId: bk.sessionId, businessId: b.id, kind: "paypal", actor: "paypal", title: `Refund failed: ${reason}` });
    return { ok: false, reason: `PayPal refused the refund (${reason}). Nothing changed.` };
  }
  if (res.status !== "COMPLETED" && res.status !== "PENDING") return { ok: false, reason: `PayPal answered ${res.status}. Nothing changed.` };
  addRefund({ id: res.id, bookingId: bk.id, amount: res.amount, debit: res.debit, status: res.status, by });
  const refunded = toCents(bk.refunded) + toCents(res.amount);
  const debit = toCents(bk.refundDebit) + toCents(res.debit);
  const full = refunded >= toCents(bk.amount);
  const updated = updateBooking(bk.id, {
    refunded: fromCents(refunded),
    refund_debit: fromCents(debit),
    payout_status: full || toCents(bk.netAmount) - debit <= 0 ? "none" : "waiting",
  });
  emit({
    sessionId: bk.sessionId,
    businessId: b.id,
    kind: "paypal",
    actor: "paypal",
    title: `Refund ${res.status}`,
    detail: `$${res.amount} back to the customer${res.status === "PENDING" ? " (PayPal is still processing it)" : ""}`,
  });
  return { ok: true, booking: updated };
}

/** When a customer may still cancel for a full refund (null if they cannot). */
export function cancelDeadline(bk: Booking): number | null {
  const b = getBusiness(bk.businessId);
  if (!b || bk.status !== "confirmed" || b.cancelHours === null || bk.payoutStatus !== "waiting") return null;
  return bk.startsAt - b.cancelHours * 3_600_000;
}

/** The customer cancels: a full refund, only inside the business's window. */
export async function customerCancel(sessionIds: string[], bookingId: string, now = Date.now()): Promise<Result> {
  const bk = getBooking(bookingId);
  if (!bk || !sessionIds.includes(bk.sessionId)) return { ok: false, reason: "No such booking." };
  if (bk.status !== "confirmed") return { ok: false, reason: "This booking is already cancelled." };
  const deadline = cancelDeadline(bk);
  if (deadline === null || now > deadline) {
    return { ok: false, reason: `Too late to cancel for a refund. ${getBusiness(bk.businessId)!.policy}` };
  }
  const out = await refund(bk, refundableCents(bk), "customer");
  if (!out.ok) return out;
  const booking = updateBooking(bk.id, { status: "cancelled", cancelled_by: "customer" });
  emit({ sessionId: bk.sessionId, businessId: bk.businessId, kind: "booking", actor: "buyer", title: `You cancelled ${bk.ref}` });
  return { ok: true, booking };
}

/** The business cancels, refunding whatever amount it chooses (0 up to what is left). */
export async function businessCancel(businessId: string, bookingId: string, refundDollars: string): Promise<Result> {
  const bk = getBooking(bookingId);
  if (!bk || bk.businessId !== businessId) return { ok: false, reason: "No such booking." };
  if (bk.status !== "confirmed") return { ok: false, reason: "This booking is already cancelled." };
  let cents: number;
  try {
    cents = toCents(refundDollars || "0");
  } catch {
    return { ok: false, reason: "Enter the refund as an amount, like 20 or 20.00." };
  }
  let current = bk;
  if (cents > 0) {
    const out = await refund(bk, cents, "business");
    if (!out.ok) return out;
    current = out.booking;
  } else if (bk.payoutStatus !== "waiting") {
    return { ok: false, reason: "This booking has already been paid out." };
  }
  const booking = updateBooking(current.id, { status: "cancelled", cancelled_by: "business" });
  emit({
    sessionId: bk.sessionId,
    businessId: bk.businessId,
    kind: "booking",
    actor: "owner",
    title: `${getBusiness(businessId)!.name} cancelled ${bk.ref}`,
    detail: cents > 0 ? `$${fromCents(cents)} refunded to you through PayPal.` : "No refund was given.",
  });
  return { ok: true, booking };
}

/** The business refunds part of a booking without cancelling it. */
export async function businessRefund(businessId: string, bookingId: string, dollars: string): Promise<Result> {
  const bk = getBooking(bookingId);
  if (!bk || bk.businessId !== businessId) return { ok: false, reason: "No such booking." };
  let cents: number;
  try {
    cents = toCents(dollars);
  } catch {
    return { ok: false, reason: "Enter the refund as an amount, like 20 or 20.00." };
  }
  return refund(bk, cents, "business");
}

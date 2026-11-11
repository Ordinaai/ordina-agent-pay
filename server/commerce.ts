// The money path, on PayPal Multiparty (docs: AGENT_COMMERCE_SPEC in Ordina).
// Agents may ask for these actions; every rule is enforced here, in code:
//  1. The price comes from the business's list, never from what an agent writes.
//  2. A payment above the customer's limit is refused before it is shown.
//  3. No agent can pay; only the customer approves in PayPal.
//  4. A booking exists only on a COMPLETED capture for the exact amount and
//     currency, paid to this business's own PayPal.
//  5. A hold that ran out is never charged; an offer is captured once, by its
//     own conversation.
//  6. A business PayPal cannot pay (not connected, not live, paused) cannot be booked.
//  7. Money is released only after the booking plus the delay, and counted
//     released only when PayPal confirms.
//  8. Only server objects (the payment offer, the booking) are facts; nothing
//     an agent says in prose is.
import { randomBytes } from "node:crypto";
import { emit } from "./events.ts";
import * as paypal from "./paypal.ts";
import {
  addRefund,
  bookingByOrder,
  canBePaid,
  confirmBooking,
  fromCents,
  getBooking,
  getBusiness,
  getHold,
  getItemAnyState,
  getService,
  holdByOrder,
  holdByPayToken,
  PLATFORM_FEE_PERCENT,
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

/** The one object a customer's agent may treat as the deal (rule 8). */
export type PaymentOffer = {
  offer_id: string; // the PayPal order id
  business_id: string;
  business_name: string;
  item: string;
  kind: "appointment" | "pickup";
  date: string;
  time: string;
  timezone: string;
  price: string;
  currency: string;
  cancellation_policy: string;
  expires_at: string;
  paid_to: string; // shown to the customer: the business's own PayPal
};

/** Ordina's fee for a price, in cents (a PayPal platform fee; 0 at launch). */
export const platformFeeCents = (price: string) => Math.round((toCents(price) * PLATFORM_FEE_PERCENT) / 100);

/** Secretary tool: create the PayPal order for a held time, at the listed price, paid to the business. */
export async function startPayment(holdId: string, sessionId: string): Promise<PaymentOffer | { error: string }> {
  const hold = getHold(holdId);
  if (!hold || hold.sessionId !== sessionId) return { error: "No such hold in this conversation." };
  if (hold.status !== "held") return { error: `The hold is ${hold.status}; hold the time again first.` };
  const b = getBusiness(hold.businessId)!;
  if (b.status !== "live" || !canBePaid(b)) return { error: `${b.name} cannot take payments right now.` };
  const s = getService(b, hold.serviceId);
  if (!s) return { error: "That item is no longer offered." };
  const offer = (orderId: string): PaymentOffer => ({
    offer_id: orderId,
    business_id: b.id,
    business_name: b.name,
    item: s.name,
    kind: s.kind,
    date: hold.date,
    time: hold.time,
    timezone: b.timezone,
    price: s.price,
    currency: b.currency,
    cancellation_policy: b.policy,
    expires_at: new Date(hold.expiresAt).toISOString(),
    paid_to: `${b.name}'s PayPal`,
  });
  if (hold.orderId) return offer(hold.orderId);
  emit({
    sessionId,
    businessId: b.id,
    kind: "paypal",
    actor: "secretary",
    title: "Create PayPal order",
    detail: `${s.name}, ${hold.date} ${hold.time}: ${b.currency} ${s.price}, paid to ${b.name}`,
  });
  const order = await paypal.createOrder({
    amount: s.price,
    currency: b.currency,
    description: `${s.name} at ${b.name}, ${hold.date} ${hold.time}`,
    referenceId: hold.id,
    brandName: b.name,
    payeeMerchantId: b.paypal.merchantId!,
    platformFee: fromCents(platformFeeCents(s.price)),
  });
  hold.orderId = order.id;
  emit({ sessionId, businessId: b.id, kind: "paypal", actor: "paypal", title: `Order ${order.status}`, detail: order.id, data: { orderId: order.id } });
  return offer(order.id);
}

/** Buyer tool: show the offer to the human. Refused above their limit. */
export function requestApproval(sessionId: string, offerId: string) {
  const s = session(sessionId);
  const hold = holdByOrder(offerId);
  if (!hold || hold.sessionId !== sessionId) return { error: "Unknown offer for this conversation." };
  if (hold.status !== "held") return { error: `The hold behind this offer is ${hold.status}.` };
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
  s.pendingOrderId = offerId;
  hold.payToken ??= randomBytes(18).toString("base64url");
  emit({
    sessionId,
    businessId: b.id,
    kind: "approval",
    actor: "server",
    title: "Waiting for your approval in PayPal",
    detail: `${svc.name} at ${b.name}, ${b.currency} ${svc.price}`,
    data: {
      orderId: offerId,
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
      payPath: `/pay/${hold.payToken}`,
    },
  });
  return {
    status: "shown_to_customer",
    pay_path: `/pay/${hold.payToken}`,
    note: "The customer now sees this offer with a PayPal button (in this chat, or on its pay page). Nothing is paid until they approve it in PayPal. Tell them what they are approving, using only the offer's fields.",
  };
}

/** The hosted pay page's view of an offer, by its token (no session needed: the token is the key). */
export function offerByPayToken(token: string) {
  const hold = holdByPayToken(token);
  if (!hold || !hold.orderId) return null;
  const b = getBusiness(hold.businessId)!;
  const svc = getItemAnyState(hold.serviceId)!;
  const booking = bookingByOrder(hold.orderId);
  return {
    sessionId: hold.sessionId,
    view: {
      orderId: hold.orderId,
      businessName: b.name,
      city: b.city,
      service: svc.name,
      kind: svc.kind,
      date: hold.date,
      time: hold.time,
      timezone: b.timezone,
      amount: svc.price,
      currency: b.currency,
      policy: b.policy,
      customerName: hold.customerName,
      expiresAt: hold.expiresAt,
      state: booking ? "booked" : hold.status === "held" ? "awaiting_approval" : hold.status,
      bookingRef: booking?.ref ?? null,
    },
  };
}

export type CaptureOutcome = { ok: true; booking: Booking } | { ok: false; reason: string };

/** Browser, after the human approved in PayPal: capture and confirm. */
export async function captureAndConfirm(sessionId: string, orderId: string): Promise<CaptureOutcome> {
  const s = session(sessionId);
  const existing = bookingByOrder(orderId);
  if (existing && existing.sessionId === sessionId) return { ok: true, booking: existing };
  const hold = holdByOrder(orderId);
  if (!hold || hold.sessionId !== sessionId) return { ok: false, reason: "Unknown offer for this conversation." };
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
    detail: `${cap.currency ?? ""} ${cap.amount ?? ""} to ${b.name}, held by PayPal`.trim(),
  });

  // Rule 4: positive confirmation, for the exact price, to this business.
  const exact = cap.amount === svc.price && cap.currency === b.currency;
  const rightPayee = !!cap.payeeMerchantId && cap.payeeMerchantId === b.paypal.merchantId;
  const known = cap.paypalFee !== undefined && cap.netAmount !== undefined;
  if (cap.status !== "COMPLETED" || cap.captureStatus !== "COMPLETED" || !cap.captureId || !exact || !rightPayee || !known) {
    emit({
      sessionId,
      businessId: b.id,
      kind: "guardrail",
      actor: "server",
      title: "Not booked: payment not confirmed",
      detail: `status ${cap.status}/${cap.captureStatus}, amount ${cap.currency} ${cap.amount}, payee ${rightPayee ? "ok" : "wrong"}`,
    });
    return { ok: false, reason: "PayPal did not confirm the full payment to this business, so nothing was booked." };
  }

  let booking = confirmBooking(hold, {
    orderId,
    captureId: cap.captureId,
    amount: cap.amount!,
    currency: cap.currency!,
    payeeMerchantId: cap.payeeMerchantId!,
    paypalFee: cap.paypalFee!,
    platformFee: cap.platformFee ?? "0.00",
    netAmount: cap.netAmount!,
    payerId: cap.payerId,
    payerName: cap.payerName,
    payerEmail: cap.payerEmail,
  });
  // Standard flow: PayPal paid the seller at capture; there is nothing to hold or release.
  if (cap.disbursement !== "HELD") {
    booking = updateBooking(booking.id, { release_status: "released", released_at: Date.now(), release_due_at: Date.now() });
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

export const refundableCents = (bk: Booking) => toCents(bk.amount) - toCents(bk.refunded);
/**
 * PayPal's own limit: a capture can be refunded for 180 days. While PayPal holds
 * the money the refund comes out of it; after release it comes out of the
 * business's own PayPal balance (founder, 11 Nov 2026). Ordina holds nothing either way.
 */
export const REFUND_WINDOW_MS = 180 * 86_400_000;
export const refundOpenUntil = (bk: Booking) => bk.createdAt + REFUND_WINDOW_MS;
export const canRefund = (bk: Booking, now = Date.now()) =>
  refundableCents(bk) > 0 && now < refundOpenUntil(bk) && bk.releaseStatus !== "releasing";
/** What the business will get when the money is released (PayPal's net, less refunds). */
export const businessGetsCents = (bk: Booking) => {
  if (bk.releaseStatus === "none") return 0;
  const refunded = toCents(bk.refunded);
  if (refunded === 0) return toCents(bk.netAmount);
  // A refund returns the customer's money from the held amount; PayPal returns its
  // percentage fee pro rata, keeps the fixed part. Estimated until PayPal reports it.
  const share = 1 - refunded / toCents(bk.amount);
  return Math.max(0, Math.round(toCents(bk.netAmount) * share));
};

async function refund(bk: Booking, cents: number, by: "customer" | "business", now = Date.now()): Promise<Result> {
  if (bk.releaseStatus === "releasing") return { ok: false, reason: "PayPal is releasing this payment right now. Try again in a minute." };
  if (now >= refundOpenUntil(bk)) {
    return { ok: false, reason: "PayPal refunds are possible for 180 days after payment, and this one is older. Settle it directly with the customer." };
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
      sellerMerchantId: bk.payeeMerchantId,
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
  addRefund({ id: res.id, bookingId: bk.id, amount: res.amount, status: res.status, by });
  const refunded = toCents(bk.refunded) + toCents(res.amount);
  // While held, a full refund leaves nothing to release. After release, the money
  // came from the business's own PayPal balance and the release itself stands.
  const releaseStatus = bk.releaseStatus === "held" && refunded >= toCents(bk.amount) ? "none" : bk.releaseStatus;
  const updated = updateBooking(bk.id, { refunded: fromCents(refunded), release_status: releaseStatus });
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
  if (!b || bk.status !== "confirmed" || b.cancelHours === null || !canRefund(bk)) return null;
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

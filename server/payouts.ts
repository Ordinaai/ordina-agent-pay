// Paying businesses out through PayPal Payouts, 24 hours after each booking
// happens. A booking counts as paid out only when PayPal reports the payout
// item SUCCESS; until then it shows exactly what PayPal said.
import { payoutCents } from "./commerce.ts";
import * as paypal from "./paypal.ts";
import { fromCents, getBooking, getBusiness, payoutsDue, payoutsInFlight, updateBooking, type Booking } from "./store.ts";
import { all } from "./db.ts";

let running = false;

/** Send every payout that is due (or, with `force`, every one still waiting, for one business). */
export async function runPayouts(opts: { now?: number; forceBusinessId?: string } = {}) {
  if (running) return { sent: 0 };
  running = true;
  try {
    const due: Booking[] = opts.forceBusinessId
      ? all("SELECT id FROM bookings WHERE business_id = ? AND payout_status = 'waiting'", opts.forceBusinessId).map(
          (r) => getBooking(String(r.id))!,
        )
      : payoutsDue(opts.now ?? Date.now());

    const byBiz = new Map<string, Booking[]>();
    for (const bk of due) {
      const amount = payoutCents(bk);
      if (amount <= 0) {
        updateBooking(bk.id, { payout_status: "none", payout_note: "Nothing left to pay out after refunds." });
        continue;
      }
      byBiz.set(bk.businessId, [...(byBiz.get(bk.businessId) ?? []), bk]);
    }

    let sent = 0;
    for (const [businessId, list] of byBiz) {
      const b = getBusiness(businessId);
      if (!b?.payoutEmail) {
        for (const bk of list) updateBooking(bk.id, { payout_note: "Add your PayPal email in Setup to get paid." });
        continue;
      }
      const batchKey = `ap-${businessId}-${Date.now()}`.slice(0, 100);
      for (const bk of list) updateBooking(bk.id, { payout_status: "sending", payout_note: null });
      try {
        const batch = await paypal.createPayout(
          batchKey,
          list.map((bk) => ({
            senderItemId: bk.id,
            email: b.payoutEmail!,
            amount: fromCents(payoutCents(bk)),
            currency: bk.currency,
            note: `${bk.serviceName}, ref ${bk.ref}`,
          })),
        );
        for (const bk of list) {
          updateBooking(bk.id, { payout_status: "sent", payout_batch_id: batch.batchId, payout_amount: fromCents(payoutCents(bk)) });
        }
        sent += list.length;
      } catch (err) {
        const why = err instanceof paypal.PayPalError ? err.issue : "PAYPAL_ERROR";
        for (const bk of list) updateBooking(bk.id, { payout_status: "waiting", payout_note: `PayPal refused the payout (${why}); it will be retried.` });
      }
    }
    await pollPayouts();
    return { sent };
  } finally {
    running = false;
  }
}

const FINAL: Record<string, Booking["payoutStatus"]> = {
  SUCCESS: "paid",
  UNCLAIMED: "unclaimed",
  FAILED: "failed",
  RETURNED: "failed",
  BLOCKED: "failed",
  REFUNDED: "failed",
  REVERSED: "failed",
};

/** Read back what PayPal did with every payout we sent. */
export async function pollPayouts() {
  const byBatch = new Map<string, Booking[]>();
  for (const bk of payoutsInFlight()) byBatch.set(bk.payoutBatchId!, [...(byBatch.get(bk.payoutBatchId!) ?? []), bk]);
  for (const [batchId, list] of byBatch) {
    let items: paypal.PayoutItemState[];
    try {
      items = await paypal.getPayout(batchId);
    } catch {
      continue; // try again next round
    }
    for (const bk of list) {
      const it = items.find((i) => i.senderItemId === bk.id);
      if (!it) continue;
      const status = FINAL[it.status];
      updateBooking(bk.id, {
        payout_status: status ?? "sent",
        payout_item_id: it.payoutItemId,
        payout_note:
          status === "unclaimed"
            ? "PayPal is holding it: no PayPal account uses that email yet. Sign up with it within 30 days to claim."
            : status === "failed"
              ? `PayPal could not pay this out${it.error ? `: ${it.error}` : ""}.`
              : null,
      });
    }
  }
}

/** Every minute in production. */
export function startPayoutClock() {
  const tick = () => runPayouts().catch((e) => console.error("payouts", e));
  setInterval(tick, 60_000).unref();
  setTimeout(tick, 5_000).unref();
}

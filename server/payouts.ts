// Releasing held money to businesses (rule 7). PayPal holds every payment
// (Multiparty, DELAYED disbursement); after the booking or pickup plus the
// delay, Ordina asks PayPal to release it (Referenced Payouts). A booking
// counts as released only when PayPal reports SUCCESS.
import * as paypal from "./paypal.ts";
import { getBooking, releasesDue, releasesInFlight, updateBooking, type Booking } from "./store.ts";
import { all } from "./db.ts";

let running = false;

/** Release everything due (or, with forceBusinessId, everything still held for one business). */
export async function runReleases(opts: { now?: number; forceBusinessId?: string } = {}) {
  if (running) return { released: 0, pending: 0, failed: 0 };
  running = true;
  try {
    const due: Booking[] = opts.forceBusinessId
      ? all("SELECT id FROM bookings WHERE business_id = ? AND release_status = 'held'", opts.forceBusinessId).map((r) => getBooking(String(r.id))!)
      : releasesDue(opts.now ?? Date.now());
    let released = 0;
    let pending = 0;
    let failed = 0;
    for (const bk of due) {
      updateBooking(bk.id, { release_status: "releasing", release_note: null });
      let res: paypal.ReleaseResult;
      try {
        res = await paypal.releaseFunds(bk.captureId, bk.id);
      } catch (err) {
        const why = err instanceof paypal.PayPalError ? err.issue : "PAYPAL_ERROR";
        updateBooking(bk.id, { release_status: "held", release_note: `PayPal did not release it (${why}); it will be retried.` });
        failed++;
        continue;
      }
      if (res.status === "SUCCESS") {
        updateBooking(bk.id, { release_status: "released", release_item_id: res.itemId ?? null, released_at: Date.now() });
        released++;
      } else if (res.status === "PENDING") {
        updateBooking(bk.id, { release_item_id: res.itemId ?? null, release_note: "PayPal is processing the release." });
        pending++;
      } else {
        updateBooking(bk.id, { release_status: "failed", release_note: `PayPal could not release it${res.reason ? `: ${res.reason}` : ""}.` });
        failed++;
      }
    }
    return { released, pending, failed };
  } finally {
    running = false;
  }
}

/** Retry releases PayPal left pending (it answers again with the final state). */
export async function retryPendingReleases() {
  for (const bk of releasesInFlight()) {
    try {
      const res = await paypal.releaseFunds(bk.captureId, bk.id);
      if (res.status === "SUCCESS") updateBooking(bk.id, { release_status: "released", released_at: Date.now(), release_note: null });
      else if (res.status === "FAILED") updateBooking(bk.id, { release_status: "failed", release_note: res.reason ?? "PayPal could not release it." });
    } catch {
      // next round
    }
  }
}

/** Every minute in production. */
export function startReleaseClock() {
  const tick = () =>
    runReleases()
      .then(retryPendingReleases)
      .catch((e) => console.error("releases", e));
  setInterval(tick, 60_000).unref();
  setTimeout(tick, 5_000).unref();
}

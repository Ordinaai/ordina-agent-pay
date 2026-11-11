// End to end in test mode (scripted agents, PayPal Multiparty mock, in-memory SQLite).
// One describe block per rule in the spec (Ordina docs/AGENT_COMMERCE_SPEC.md).
import { beforeEach, describe, expect, it } from "vitest";

process.env.MOCK_AI = "1";
process.env.DATA_DIR = ":memory:";
delete process.env.PAYPAL_CLIENT_ID;

const { buyerTurn, afterPayment, resetBuyers } = await import("../server/agents/buyer.ts");
const { resetSecretaries } = await import("../server/agents/secretary.ts");
const commerce = await import("../server/commerce.ts");
const { eventsFor } = await import("../server/events.ts");
const paypal = await import("../server/paypal.ts");
const store = await import("../server/store.ts");
const { seedDemoBusinesses } = await import("../server/seed.ts");
const { runReleases } = await import("../server/payouts.ts");
const { setupErrors } = await import("../server/business-api.ts");
const { refreshSeller } = await import("../server/paypal-connect.ts");

seedDemoBusinesses();

let n = 0;
const sid = () => `test-session-${++n}`;
const pendingOffer = (s: string): string => {
  const e = [...eventsFor(s)].reverse().find((x) => x.kind === "approval");
  return (e?.data as { orderId: string }).orderId;
};
async function book(text: string) {
  const s = sid();
  const reply = await buyerTurn(s, text);
  const offerId = pendingOffer(s);
  paypal.mockApprove(offerId);
  const out = await commerce.captureAndConfirm(s, offerId);
  if (!out.ok) throw new Error(out.reason);
  return { s, reply, booking: out.booking };
}
/** A new business, set up and connected to PayPal through the onboarding flow. */
async function connectedBusiness(opts: { confirmEmail?: boolean } = {}) {
  const b = store.createBusiness({ name: `Barber ${++n}`, category: "Barber", city: "Lagos", timezone: "Africa/Lagos", ownerEmail: `b${n}@example.com` });
  store.saveItems(b.id, [{ kind: "appointment", name: "Skin fade", minutes: 60, price: "15.00", dailyLimit: null }]);
  store.updateBusiness(b.id, { cancelHours: 12, hours: { 1: ["09:00", "18:00"], 2: ["09:00", "18:00"], 3: ["09:00", "18:00"], 4: ["09:00", "18:00"], 5: ["09:00", "18:00"], 6: ["09:00", "18:00"], 0: ["09:00", "18:00"] } });
  const tracking = `t-${b.id}`;
  store.updateBusiness(b.id, { paypalTrackingId: tracking });
  await paypal.createSellerReferral({ trackingId: tracking, returnUrl: "/api/biz/paypal/return" });
  const merchant = paypal.mockCompleteReferral(tracking, `seller${n}@example.com`, opts)!;
  const after = await refreshSeller(store.getBusiness(b.id)!, merchant);
  return after;
}

beforeEach(() => {
  store.resetStore();
  resetBuyers();
  resetSecretaries();
});

describe("a customer books and pays", () => {
  it("asks for a name first, then books what was asked", async () => {
    const s = sid();
    expect(await buyerTurn(s, "A silk press on Saturday please")).toMatch(/What name/);
    expect(await buyerTurn(s, "Ada")).toMatch(/Silk press on Saturday/);
  });

  it("books with PayPal's fee, the business as payee, and the payer as the customer", async () => {
    const { s, booking } = await book("My name is Ada Obi, book me a silk press in Lagos");
    expect(booking).toMatchObject({
      amount: "35.00",
      serviceName: "Silk press",
      customerName: "Ada Obi",
      payeeMerchantId: "DEMO-LUMEN-HAIR",
      paypalFee: "1.71",
      platformFee: "0.00",
      netAmount: "33.29",
      payerEmail: "sandbox-buyer@example.com",
      releaseStatus: "held",
    });
    expect(await afterPayment(s, booking)).toMatch(booking.ref);
  });
});

describe("rule 1: the price comes from the business's list", () => {
  it("the offer and the PayPal order carry the listed price", async () => {
    const s = sid();
    const b = store.getBusiness("lumen-hair")!;
    const item = b.services.find((x) => x.name === "Wash and style")!;
    const date = (() => {
      for (let d = 1; d < 9; d++) {
        const x = store.addDays(store.localNow(b.timezone).date, d);
        if (store.availability(b.id, item.id, x).length) return x;
      }
      throw new Error("no date");
    })();
    const hold = store.createHold({ businessId: b.id, serviceId: item.id, date, time: store.availability(b.id, item.id, date)[0], customerName: "A", sessionId: s });
    if ("error" in hold) throw new Error(hold.error);
    const offer = await commerce.startPayment(hold.id, s);
    expect(offer).toMatchObject({ price: "20.00", currency: "USD", business_name: "Lumen Hair Studio", paid_to: "Lumen Hair Studio's PayPal" });
  });
});

describe("rule 2: the customer's limit", () => {
  it("refuses to show a payment above the limit", async () => {
    const s = sid();
    commerce.setBudget(s, 30);
    expect(await buyerTurn(s, "I'm Tunde, I need knotless braids")).toMatch(/over your .30 spending limit/);
    expect(commerce.session(s).pendingOrderId).toBeUndefined();
    expect(eventsFor(s).some((e) => e.kind === "guardrail")).toBe(true);
  });
});

describe("rule 3: no agent can pay", () => {
  it("nothing is captured before the customer approves in PayPal", async () => {
    const s = sid();
    await buyerTurn(s, "My name is Ada, wash and style please");
    const out = await commerce.captureAndConfirm(s, pendingOffer(s));
    expect(out.ok).toBe(false);
    expect(store.listBookings("lumen-hair")).toHaveLength(0);
  });
});

describe("rule 4: booked only on a completed capture, to this business", () => {
  it("refuses when the money would go to a different PayPal account", async () => {
    const s = sid();
    await buyerTurn(s, "My name is Ada, wash and style please");
    const offerId = pendingOffer(s);
    // The business reconnected another PayPal account after the offer was made.
    store.updateBusiness("lumen-hair", { paypalMerchantId: "SOMEONE-ELSE" });
    paypal.mockApprove(offerId);
    const out = await commerce.captureAndConfirm(s, offerId);
    store.updateBusiness("lumen-hair", { paypalMerchantId: "DEMO-LUMEN-HAIR" });
    expect(out.ok).toBe(false);
    expect(store.listBookings("lumen-hair")).toHaveLength(0);
  });

  it("capturing twice returns the same booking", async () => {
    const { s, booking } = await book("My name is Ada, wash and style please");
    const again = await commerce.captureAndConfirm(s, booking.orderId);
    expect(again.ok && again.booking.id).toBe(booking.id);
    expect(store.listBookings("lumen-hair")).toHaveLength(1);
  });
});

describe("rule 5: holds and offers", () => {
  it("an expired hold is never charged", async () => {
    const s = sid();
    await buyerTurn(s, "My name is Ada, wash and style please");
    const offerId = pendingOffer(s);
    store.holdByOrder(offerId)!.expiresAt = Date.now() - 1;
    paypal.mockApprove(offerId);
    expect((await commerce.captureAndConfirm(s, offerId)).ok).toBe(false);
    expect(store.listBookings("lumen-hair")).toHaveLength(0);
  });

  it("another conversation cannot approve or capture my offer", async () => {
    const mine = sid();
    await buyerTurn(mine, "My name is Ada, wash and style please");
    const offerId = pendingOffer(mine);
    expect(commerce.requestApproval(sid(), offerId)).toHaveProperty("error");
    paypal.mockApprove(offerId);
    expect((await commerce.captureAndConfirm(sid(), offerId)).ok).toBe(false);
  });

  it("a held appointment is not offered to anyone else, and pickups stop at the daily limit", async () => {
    const s = sid();
    await buyerTurn(s, "My name is Ada, follow-up session at Harbour Physio");
    const hold = store.holdByOrder(pendingOffer(s))!;
    expect(store.availability(hold.businessId, hold.serviceId, hold.date)).not.toContain(hold.time);

    const b = store.getBusiness("crumb-co")!;
    const cake = b.services.find((x) => x.name.startsWith("Celebration"))!;
    let date = "";
    for (let d = 2; d < 9 && !date; d++) {
      const x = store.addDays(store.localNow(b.timezone).date, d);
      if (store.availability(b.id, cake.id, x).length) date = x;
    }
    for (let i = 0; i < cake.dailyLimit!; i++) {
      expect(store.createHold({ businessId: b.id, serviceId: cake.id, date, time: "10:00", customerName: `C${i}`, sessionId: sid() })).not.toHaveProperty("error");
    }
    expect(store.availability(b.id, cake.id, date)).toEqual([]);
  });
});

describe("rule 6: only businesses PayPal can pay", () => {
  it("connecting PayPal through onboarding makes a business bookable once it goes live", async () => {
    const b = await connectedBusiness();
    expect(b.paypal).toMatchObject({ receivable: true, emailConfirmed: true });
    expect(setupErrors(b)).toEqual({});
    store.updateBusiness(b.id, { status: "live" });
    expect(store.liveBusinesses().some((x) => x.id === b.id)).toBe(true);
  });

  it("an unconfirmed PayPal email blocks going live and booking", async () => {
    const b = await connectedBusiness({ confirmEmail: false });
    expect(setupErrors(b).paypal).toMatch(/Confirm your email address/);
    store.updateBusiness(b.id, { status: "live" }); // even if forced live
    const h = store.createHold({ businessId: b.id, serviceId: b.services[0].id, date: "2099-01-01", time: "10:00", customerName: "A", sessionId: sid() });
    expect(h).toMatchObject({ error: expect.stringMatching(/not taking bookings/) });
    expect(store.liveBusinesses().some((x) => x.id === b.id)).toBe(false);
  });

  it("a business that never connected PayPal cannot go live", () => {
    const b = store.createBusiness({ name: "No PayPal", category: "Barber", city: "Lagos", timezone: "Africa/Lagos", ownerEmail: "np@example.com" });
    expect(setupErrors(b).paypal).toMatch(/Connect your PayPal/);
  });

  it("a paused business takes no bookings and is not found", () => {
    store.updateBusiness("green-table", { status: "paused" });
    const b = store.getBusiness("green-table")!;
    const h = store.createHold({ businessId: b.id, serviceId: b.services[0].id, date: "2099-01-01", time: "12:00", customerName: "A", sessionId: sid() });
    expect(h).toMatchObject({ error: expect.stringMatching(/not taking bookings/) });
    expect(store.liveBusinesses().some((x) => x.id === "green-table")).toBe(false);
    store.updateBusiness("green-table", { status: "live" });
  });
});

describe("rule 7: release after the booking, counted only on PayPal's word", () => {
  it("holds until due, releases after, then refunds through Ordina stop", async () => {
    const { s, booking } = await book("My name is Ada, wash and style please");
    await runReleases({ now: booking.releaseDueAt - 1 });
    expect(store.getBooking(booking.id)!.releaseStatus).toBe("held");
    await runReleases({ now: booking.releaseDueAt + 1 });
    expect(store.getBooking(booking.id)!).toMatchObject({ releaseStatus: "released", releasedAt: expect.any(Number) });
    expect((await commerce.businessRefund("lumen-hair", booking.id, "5")).ok).toBe(false);
    expect((await commerce.customerCancel([s], booking.id, 0)).ok).toBe(false);
  });

  it("a fully refunded booking has nothing to release", async () => {
    const { booking } = await book("My name is Ada, wash and style please");
    await commerce.businessCancel("lumen-hair", booking.id, "20.00");
    await runReleases({ now: booking.releaseDueAt + 1 });
    expect(store.getBooking(booking.id)!.releaseStatus).toBe("none");
  });
});

describe("refunds and cancellations (before release)", () => {
  it("customer: full refund inside the window, refused after it", async () => {
    const { s, booking } = await book("My name is Ada, a pastry box from the bakery on saturday");
    expect((await commerce.customerCancel(["someone-else-1"], booking.id)).ok).toBe(false);
    const deadline = commerce.cancelDeadline(booking)!;
    expect((await commerce.customerCancel([s], booking.id, deadline + 1)).ok).toBe(false);
    const ok = await commerce.customerCancel([s], booking.id, deadline - 1);
    if (!ok.ok) throw new Error(ok.reason);
    expect(ok.booking).toMatchObject({ status: "cancelled", cancelledBy: "customer", refunded: "18.00", releaseStatus: "none" });
  });

  it("business: cancels with a refund it chooses; no more than what is left; only its own bookings", async () => {
    const { booking } = await book("My name is Ada, follow-up session at Harbour Physio");
    const out = await commerce.businessCancel("harbour-physio", booking.id, "30");
    if (!out.ok) throw new Error(out.reason);
    expect(out.booking).toMatchObject({ status: "cancelled", cancelledBy: "business", refunded: "30.00", releaseStatus: "held" });
    // The business still gets its share of the $15 left (estimated until PayPal reports it).
    expect(commerce.businessGetsCents(out.booking)).toBeGreaterThan(0);
    expect((await commerce.businessRefund("harbour-physio", booking.id, "16")).ok).toBe(false);
    expect((await commerce.businessCancel("lumen-hair", booking.id, "0")).ok).toBe(false);
  });

  it("a refund is made on behalf of the business that was paid, never another", async () => {
    const { booking } = await book("My name is Ada, wash and style please");
    await expect(
      paypal.refundCapture(booking.captureId, { sellerMerchantId: "SOMEONE-ELSE", amount: "1.00", currency: "USD", note: "x", key: "x" }),
    ).rejects.toThrow(/PERMISSION_DENIED/);
  });
});

describe("rule 8: only server objects are facts", () => {
  it("an offer id the server never made is refused", () => {
    const s = sid();
    expect(commerce.requestApproval(s, "MADE-UP-BY-AN-AGENT")).toHaveProperty("error");
  });

  it("the offer handed to the customer's agent matches the store, field by field", async () => {
    const s = sid();
    const { askSecretary } = await import("../server/agents/secretary.ts");
    const r = await askSecretary(s, "harbour-physio", "Hi, I'm booking for my customer Ada. A sports massage please, hold it and create the payment.");
    expect(r.offer).toBeDefined();
    const hold = store.holdByOrder(r.offer!.offer_id)!;
    const item = store.getItemAnyState(hold.serviceId)!;
    expect(r.offer).toMatchObject({ price: item.price, item: item.name, date: hold.date, time: hold.time, business_id: "harbour-physio" });
  });
});

describe("time zones", () => {
  it("turns business-local time into the right instant", () => {
    expect(new Date(store.zonedToUtc("2026-11-14", "10:00", "Africa/Lagos")).toISOString()).toBe("2026-11-14T09:00:00.000Z");
    expect(new Date(store.zonedToUtc("2026-07-01", "10:00", "Europe/London")).toISOString()).toBe("2026-07-01T09:00:00.000Z");
  });
});

// End to end in mock mode (scripted agents, mocked PayPal, in-memory SQLite).
// Each test proves one rule from docs/BUSINESS_SIDE.md holds whatever an agent says.
import { beforeEach, describe, expect, it } from "vitest";

process.env.MOCK_AI = "1";
process.env.DATA_DIR = ":memory:";
process.env.DEMO_PAYOUT_EMAIL = "demo-payouts@example.com";
delete process.env.PAYPAL_CLIENT_ID;

const { buyerTurn, afterPayment, resetBuyers } = await import("../server/agents/buyer.ts");
const { resetSecretaries } = await import("../server/agents/secretary.ts");
const commerce = await import("../server/commerce.ts");
const { eventsFor } = await import("../server/events.ts");
const paypal = await import("../server/paypal.ts");
const store = await import("../server/store.ts");
const { seedDemoBusinesses } = await import("../server/seed.ts");
const { runPayouts } = await import("../server/payouts.ts");
const { setupErrors } = await import("../server/business-api.ts");

seedDemoBusinesses();

let n = 0;
const sid = () => `test-session-${++n}`;
const pendingOrder = (s: string): string => {
  const e = [...eventsFor(s)].reverse().find((x) => x.kind === "approval");
  return (e?.data as { orderId: string }).orderId;
};
async function book(text: string) {
  const s = sid();
  const reply = await buyerTurn(s, text);
  const orderId = pendingOrder(s);
  paypal.mockApprove(orderId);
  const out = await commerce.captureAndConfirm(s, orderId);
  if (!out.ok) throw new Error(out.reason);
  return { s, reply, booking: out.booking };
}

beforeEach(() => {
  store.resetStore();
  paypal.resetMock();
  resetBuyers();
  resetSecretaries();
});

describe("customer books and pays", () => {
  it("asks for a name first, then books what was asked", async () => {
    const s = sid();
    expect(await buyerTurn(s, "A silk press on Saturday please")).toMatch(/What name/);
    expect(await buyerTurn(s, "Ada")).toMatch(/Silk press on Saturday/);
  });

  it("books only after a completed capture, and records PayPal's fee", async () => {
    const s = sid();
    expect(await buyerTurn(s, "My name is Ada Obi, book me a silk press in Lagos")).toMatch(/Approve with PayPal/);
    const orderId = pendingOrder(s);
    expect((await commerce.captureAndConfirm(s, orderId)).ok).toBe(false); // not approved yet
    expect(store.listBookings("lumen-hair")).toHaveLength(0);

    paypal.mockApprove(orderId);
    const out = await commerce.captureAndConfirm(s, orderId);
    if (!out.ok) throw new Error(out.reason);
    expect(out.booking).toMatchObject({ amount: "35.00", serviceName: "Silk press", customerName: "Ada Obi", payoutStatus: "waiting" });
    // Mock fee 3.49% + 0.49 = 1.71; net 33.29.
    expect(out.booking).toMatchObject({ paypalFee: "1.71", netAmount: "33.29" });
    expect(await afterPayment(s, out.booking)).toMatch(out.booking.ref);
    const again = await commerce.captureAndConfirm(s, orderId);
    expect(again.ok && again.booking.id).toBe(out.booking.id);
    expect(store.listBookings("lumen-hair")).toHaveLength(1);
  });

  it("refuses to show a payment above the limit", async () => {
    const s = sid();
    commerce.setBudget(s, 30);
    expect(await buyerTurn(s, "I'm Tunde, I need knotless braids")).toMatch(/over your .30 spending limit/);
    expect(commerce.session(s).pendingOrderId).toBeUndefined();
    expect(eventsFor(s).some((e) => e.kind === "guardrail")).toBe(true);
  });

  it("another chat cannot approve or capture my order", async () => {
    const mine = sid();
    await buyerTurn(mine, "My name is Ada, wash and style please");
    const orderId = pendingOrder(mine);
    expect(commerce.requestApproval(sid(), orderId)).toHaveProperty("error");
    paypal.mockApprove(orderId);
    expect((await commerce.captureAndConfirm(sid(), orderId)).ok).toBe(false);
  });

  it("an expired hold is never charged", async () => {
    const s = sid();
    await buyerTurn(s, "My name is Ada, wash and style please");
    const orderId = pendingOrder(s);
    store.holdByOrder(orderId)!.expiresAt = Date.now() - 1;
    paypal.mockApprove(orderId);
    expect((await commerce.captureAndConfirm(s, orderId)).ok).toBe(false);
    expect(store.listBookings("lumen-hair")).toHaveLength(0);
  });

  it("a held appointment time is not offered to anyone else", async () => {
    const s = sid();
    await buyerTurn(s, "My name is Ada, follow-up session at Harbour Physio");
    const hold = store.holdByOrder(pendingOrder(s))!;
    expect(store.availability(hold.businessId, hold.serviceId, hold.date)).not.toContain(hold.time);
  });

  it("pickup items stop at the owner's daily limit", async () => {
    const b = store.getBusiness("crumb-co")!;
    const cake = b.services.find((x) => x.name.startsWith("Celebration"))!;
    const date = (() => {
      for (let d = 2; d < 9; d++) {
        const x = store.addDays(store.localNow(b.timezone).date, d);
        if (store.availability(b.id, cake.id, x).length) return x;
      }
      throw new Error("no date");
    })();
    for (let i = 0; i < cake.dailyLimit!; i++) {
      const h = store.createHold({ businessId: b.id, serviceId: cake.id, date, time: "10:00", customerName: `C${i}`, sessionId: sid() });
      expect(h).not.toHaveProperty("error"); // the same pickup time can be shared
    }
    expect(store.availability(b.id, cake.id, date)).toEqual([]);
  });
});

describe("cancellations and refunds", () => {
  it("customer: full refund inside the window, refused after it", async () => {
    const { s, booking } = await book("My name is Ada, a pastry box from the bakery on saturday");
    expect((await commerce.customerCancel(["someone-else-1"], booking.id)).ok).toBe(false);
    const deadline = commerce.cancelDeadline(booking)!;
    expect((await commerce.customerCancel([s], booking.id, deadline + 1)).ok).toBe(false);
    const ok = await commerce.customerCancel([s], booking.id, deadline - 1);
    if (!ok.ok) throw new Error(ok.reason);
    expect(ok.booking).toMatchObject({ status: "cancelled", cancelledBy: "customer", refunded: "18.00", payoutStatus: "none" });
  });

  it("business: cancels with a refund it chooses, and is paid the rest minus what the refund cost", async () => {
    const { booking } = await book("My name is Ada, follow-up session at Harbour Physio");
    // $45 sale: fee 2.06, net 42.94. Refund $30: PayPal returns 1.05 of its fee, debits 28.95.
    const out = await commerce.businessCancel("harbour-physio", booking.id, "30");
    if (!out.ok) throw new Error(out.reason);
    expect(out.booking).toMatchObject({ status: "cancelled", cancelledBy: "business", refunded: "30.00", refundDebit: "28.95" });
    expect(store.fromCents(commerce.payoutCents(out.booking))).toBe("13.99");
    // No more than what is left.
    expect((await commerce.businessRefund("harbour-physio", booking.id, "16")).ok).toBe(false);
    // Another business cannot touch it.
    expect((await commerce.businessCancel("lumen-hair", booking.id, "0")).ok).toBe(false);
  });

  it("business: cancelling with no refund keeps the money for payout", async () => {
    const { booking } = await book("My name is Ada, wash and style please");
    const out = await commerce.businessCancel("lumen-hair", booking.id, "0");
    if (!out.ok) throw new Error(out.reason);
    expect(out.booking.payoutStatus).toBe("waiting");
    expect(commerce.payoutCents(out.booking)).toBe(store.toCents(booking.netAmount));
  });
});

describe("payouts", () => {
  it("pays out after the booking, only on PayPal SUCCESS, and then refunds stop", async () => {
    const { s, booking } = await book("My name is Ada, wash and style please");
    await runPayouts({ now: booking.payoutDueAt - 1 });
    expect(store.getBooking(booking.id)!.payoutStatus).toBe("waiting"); // not due yet

    await runPayouts({ now: booking.payoutDueAt + 1 });
    const paid = store.getBooking(booking.id)!;
    expect(paid).toMatchObject({ payoutStatus: "paid", payoutAmount: paid.netAmount });

    expect((await commerce.businessRefund("lumen-hair", booking.id, "5")).ok).toBe(false);
    expect((await commerce.customerCancel([s], booking.id, 0)).ok).toBe(false);
  });

  it("a fully refunded booking is never paid out", async () => {
    const { booking } = await book("My name is Ada, wash and style please");
    await commerce.businessCancel("lumen-hair", booking.id, "20.00");
    await runPayouts({ now: booking.payoutDueAt + 1 });
    expect(store.getBooking(booking.id)!).toMatchObject({ payoutStatus: "none", payoutBatchId: null });
  });

  it("waits, with a note, when the business has no PayPal email", async () => {
    const { booking } = await book("My name is Ada, wash and style please");
    store.updateBusiness("lumen-hair", { payoutEmail: null });
    await runPayouts({ now: booking.payoutDueAt + 1 });
    expect(store.getBooking(booking.id)!).toMatchObject({ payoutStatus: "waiting", payoutNote: expect.stringMatching(/PayPal email/) });
    store.updateBusiness("lumen-hair", { payoutEmail: "demo-payouts@example.com" });
  });
});

describe("businesses", () => {
  it("a new business can't go live until everything required is set", () => {
    const b = store.createBusiness({ name: "Test Barber", category: "Barber", city: "Lagos", timezone: "Africa/Lagos", ownerEmail: "t@example.com" });
    expect(Object.keys(setupErrors(b)).sort()).toEqual(["cancelHours", "hours", "items", "payoutEmail"]);
    store.saveItems(b.id, [{ kind: "appointment", name: "Haircut", minutes: 30, price: "10.00", dailyLimit: null }]);
    const done = store.updateBusiness(b.id, { cancelHours: 12, hours: { 1: ["09:00", "17:00"] }, payoutEmail: "barber@example.com" });
    expect(setupErrors(done)).toEqual({});
    expect(store.slugify("Crumb & Co Bakery")).toBe("crumb-co-bakery");
  });

  it("a paused business takes no bookings and is not found", async () => {
    store.updateBusiness("green-table", { status: "paused" });
    const b = store.getBusiness("green-table")!;
    const h = store.createHold({ businessId: b.id, serviceId: b.services[0].id, date: "2099-01-01", time: "12:00", customerName: "A", sessionId: sid() });
    expect(h).toMatchObject({ error: expect.stringMatching(/not taking bookings/) });
    expect(store.liveBusinesses().some((x) => x.id === "green-table")).toBe(false);
    store.updateBusiness("green-table", { status: "live" });
  });

  it("an item switched off keeps its past bookings", async () => {
    const { booking } = await book("My name is Ada, plant-based class");
    const b = store.getBusiness("green-table")!;
    store.saveItems(b.id, [{ kind: "appointment", name: "Pilau and chapati class", minutes: 120, price: "40.00", dailyLimit: null }]);
    expect(store.getBooking(booking.id)!.serviceName).toMatch(/Plant-based/);
  });
});

describe("time zones", () => {
  it("turns business-local time into the right instant", () => {
    expect(new Date(store.zonedToUtc("2026-11-14", "10:00", "Africa/Lagos")).toISOString()).toBe("2026-11-14T09:00:00.000Z");
    expect(new Date(store.zonedToUtc("2026-07-01", "10:00", "Europe/London")).toISOString()).toBe("2026-07-01T09:00:00.000Z");
    expect(new Date(store.zonedToUtc("2026-11-14", "10:00", "Europe/London")).toISOString()).toBe("2026-11-14T10:00:00.000Z");
  });
});

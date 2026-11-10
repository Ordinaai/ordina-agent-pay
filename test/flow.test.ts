// End to end in mock mode: both agents scripted, PayPal mocked. Proves the
// money rules hold whatever an agent says.
import { beforeEach, describe, expect, it } from "vitest";

process.env.MOCK_AI = "1";
delete process.env.PAYPAL_CLIENT_ID;

const { buyerTurn, afterPayment, resetBuyers } = await import("../server/agents/buyer.ts");
const { resetSecretaries } = await import("../server/agents/secretary.ts");
const { captureAndConfirm, refundBooking, requestApproval, session, setBudget, startPayment } = await import(
  "../server/commerce.ts"
);
const { eventsFor } = await import("../server/events.ts");
const paypal = await import("../server/paypal.ts");
const store = await import("../server/store.ts");

let n = 0;
const sid = () => `test-session-${++n}`;

function pendingOrder(s: string): string {
  const e = [...eventsFor(s)].reverse().find((x) => x.kind === "approval");
  return (e?.data as { orderId: string }).orderId;
}

beforeEach(() => {
  store.resetStore();
  paypal.resetMock();
  resetBuyers();
  resetSecretaries();
});

describe("agent books and pays", () => {
  it("asks for a name first", async () => {
    const s = sid();
    expect(await buyerTurn(s, "Book me a silk press")).toMatch(/what name/i);
  });

  it("holds, asks for approval, and books only after a completed capture", async () => {
    const s = sid();
    const reply = await buyerTurn(s, "My name is Ada Obi, book me a silk press in Lagos");
    expect(reply).toMatch(/Approve with PayPal/);
    const orderId = pendingOrder(s);
    expect(store.listBookings()).toHaveLength(0);

    // Capturing before the payer approved: PayPal refuses, nothing is booked.
    const early = await captureAndConfirm(s, orderId);
    expect(early.ok).toBe(false);
    expect(store.listBookings()).toHaveLength(0);

    expect(paypal.mockApprove(orderId)).toBe(true);
    const out = await captureAndConfirm(s, orderId);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.booking.amount).toBe("35.00");
    expect(out.booking.serviceName).toBe("Silk press");
    expect(out.booking.customerName).toBe("Ada Obi");
    expect(await afterPayment(s, out.booking)).toMatch(out.booking.ref);

    // Capturing twice returns the same booking, not a second one.
    const again = await captureAndConfirm(s, orderId);
    expect(again.ok && again.booking.id).toBe(out.booking.id);
    expect(store.listBookings()).toHaveLength(1);
  });

  it("refuses to show a payment above the budget", async () => {
    const s = sid();
    setBudget(s, 30);
    const reply = await buyerTurn(s, "I'm Tunde, I need knotless braids");
    expect(reply).toMatch(/over your .30 spending limit/);
    expect(session(s).pendingOrderId).toBeUndefined();
    expect(eventsFor(s).some((e) => e.kind === "guardrail")).toBe(true);
  });

  it("another session cannot approve or capture my order", async () => {
    const mine = sid();
    const theirs = sid();
    await buyerTurn(mine, "My name is Ada, wash and style please");
    const orderId = pendingOrder(mine);
    expect(requestApproval(theirs, orderId)).toHaveProperty("error");
    paypal.mockApprove(orderId);
    const stolen = await captureAndConfirm(theirs, orderId);
    expect(stolen.ok).toBe(false);
  });

  it("an expired hold is never charged", async () => {
    const s = sid();
    await buyerTurn(s, "My name is Ada, wash and style please");
    const orderId = pendingOrder(s);
    const hold = store.holdByOrder(orderId)!;
    hold.expiresAt = Date.now() - 1;
    paypal.mockApprove(orderId);
    const out = await captureAndConfirm(s, orderId);
    expect(out.ok).toBe(false);
    expect(store.listBookings()).toHaveLength(0);
  });

  it("a held time is not offered to anyone else", async () => {
    const s = sid();
    await buyerTurn(s, "My name is Ada, follow-up session at Harbour Physio");
    const hold = store.holdByOrder(pendingOrder(s))!;
    const free = store.availability(hold.businessId, hold.serviceId, hold.date);
    expect(free).not.toContain(hold.time);
  });

  it("the owner refunds through PayPal", async () => {
    const s = sid();
    await buyerTurn(s, "My name is Ada, plant-based class");
    const orderId = pendingOrder(s);
    paypal.mockApprove(orderId);
    const out = await captureAndConfirm(s, orderId);
    if (!out.ok) throw new Error(out.reason);
    const r = await refundBooking(out.booking.id);
    expect(r.ok && r.booking.status).toBe("refunded");
    // A second refund is a no-op, not a second PayPal call.
    const r2 = await refundBooking(out.booking.id);
    expect(r2.ok && r2.booking.status).toBe("refunded");
  });

  it("the price comes from the list, not from a hold someone tampered with", async () => {
    const s = sid();
    const b = store.BUSINESSES[0];
    const date = (() => {
      for (let d = 1; d < 8; d++) {
        const x = store.addDays(store.localNow(b.timezone).date, d);
        if (store.availability(b.id, "wash-style", x).length) return x;
      }
      throw new Error("no date");
    })();
    const time = store.availability(b.id, "wash-style", date)[0];
    const hold = store.createHold({ businessId: b.id, serviceId: "wash-style", date, time, customerName: "Ada", sessionId: s });
    if ("error" in hold) throw new Error(hold.error);
    const pay = await startPayment(hold.id, s);
    expect(pay).toMatchObject({ amount: "20.00", currency: "USD" });
  });
});

describe("customer cancels", () => {
  beforeEach(() => {
    store.resetStore();
    paypal.resetMock();
    resetBuyers();
    resetSecretaries();
  });

  it("refunds in full inside the policy window, refuses after it", async () => {
    const { customerCancel, cancelDeadline } = await import("../server/commerce.ts");
    const s = sid();
    await buyerTurn(s, "My name is Ada, a pastry box from the bakery on saturday");
    const orderId = pendingOrder(s);
    paypal.mockApprove(orderId);
    const out = await captureAndConfirm(s, orderId);
    if (!out.ok) throw new Error(out.reason);
    expect(out.booking.serviceName).toMatch(/Pastry box/);

    // Someone else's chat list cannot cancel it.
    expect((await customerCancel(["someone-else-1"], out.booking.id)).ok).toBe(false);

    // After the deadline: refused, still booked.
    const late = await customerCancel([s], out.booking.id, cancelDeadline(out.booking)! + 1);
    expect(late.ok).toBe(false);
    expect(store.getBooking(out.booking.id)!.status).toBe("confirmed");

    // Before it: refunded through PayPal.
    const ok = await customerCancel([s], out.booking.id, cancelDeadline(out.booking)! - 1);
    expect(ok.ok && ok.booking.status).toBe("refunded");
  });

  it("asks for a name, then books what was asked first", async () => {
    const s = sid();
    expect(await buyerTurn(s, "A silk press on Saturday please")).toMatch(/What name/);
    const reply = await buyerTurn(s, "Ada");
    expect(reply).toMatch(/Silk press on Saturday/);
  });
});

describe("time zones", () => {
  it("turns business-local time into the right instant", () => {
    expect(new Date(store.zonedToUtc("2026-11-14", "10:00", "Africa/Lagos")).toISOString()).toBe("2026-11-14T09:00:00.000Z");
    expect(new Date(store.zonedToUtc("2026-07-01", "10:00", "Europe/London")).toISOString()).toBe("2026-07-01T09:00:00.000Z");
    expect(new Date(store.zonedToUtc("2026-11-14", "10:00", "Europe/London")).toISOString()).toBe("2026-11-14T10:00:00.000Z");
  });
});

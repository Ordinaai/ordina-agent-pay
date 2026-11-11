// End to end in test mode, STANDARD flow (the default and the hackathon entry):
// PayPal Orders on one seller account, money with the seller at capture.
import { beforeEach, describe, expect, it } from "vitest";

process.env.MOCK_AI = "1";
process.env.DATA_DIR = ":memory:";
delete process.env.PAYPAL_FLOW;
delete process.env.PAYPAL_CLIENT_ID;

const { buyerTurn, resetBuyers } = await import("../server/agents/buyer.ts");
const { resetSecretaries } = await import("../server/agents/secretary.ts");
const commerce = await import("../server/commerce.ts");
const { eventsFor } = await import("../server/events.ts");
const paypal = await import("../server/paypal.ts");
const store = await import("../server/store.ts");
const { seedDemoBusinesses } = await import("../server/seed.ts");
const { runReleases } = await import("../server/payouts.ts");

seedDemoBusinesses();

let n = 0;
const sid = () => `std-session-${++n}`;
const pendingOffer = (s: string) => ([...eventsFor(s)].reverse().find((x) => x.kind === "approval")?.data as { orderId: string }).orderId;
async function book(text: string) {
  const s = sid();
  await buyerTurn(s, text);
  const offerId = pendingOffer(s);
  paypal.mockApprove(offerId);
  const out = await commerce.captureAndConfirm(s, offerId);
  if (!out.ok) throw new Error(out.reason);
  return { s, booking: out.booking };
}

beforeEach(() => {
  store.resetStore();
  resetBuyers();
  resetSecretaries();
});

describe("standard flow", () => {
  it("is the default", () => {
    expect(paypal.paypalFlow()).toBe("standard");
  });

  it("pays the one seller at capture; nothing to hold or release", async () => {
    const { booking } = await book("My name is Ada, wash and style please");
    expect(booking).toMatchObject({ payeeMerchantId: "DEMO-SELLER", releaseStatus: "released", amount: "20.00", paypalFee: "1.19", netAmount: "18.81" });
    await runReleases({ forceBusinessId: "lumen-hair" });
    expect(store.getBooking(booking.id)!.releaseStatus).toBe("released");
  });

  it("still refuses a capture paid to a different seller (rule 4)", async () => {
    const s = sid();
    await buyerTurn(s, "My name is Ada, wash and style please");
    const offerId = pendingOffer(s);
    store.updateBusiness("lumen-hair", { paypalMerchantId: "SOMEONE-ELSE" });
    paypal.mockApprove(offerId);
    const out = await commerce.captureAndConfirm(s, offerId);
    store.updateBusiness("lumen-hair", { paypalMerchantId: "DEMO-SELLER" });
    expect(out.ok).toBe(false);
  });

  it("refunds: the customer inside the window, the owner any amount", async () => {
    const a = await book("My name is Ada, a pastry box from the bakery on saturday");
    const ok = await commerce.customerCancel([a.s], a.booking.id, commerce.cancelDeadline(a.booking)! - 1);
    expect(ok.ok && ok.booking).toMatchObject({ status: "cancelled", refunded: "18.00" });

    const b = await book("My name is Ada, follow-up session at Harbour Physio");
    const r = await commerce.businessRefund("harbour-physio", b.booking.id, "10");
    expect(r.ok && r.booking.refunded).toBe("10.00");
  });

  it("the customer's limit and the server's offer still rule (rules 2 and 8)", async () => {
    const s = sid();
    commerce.setBudget(s, 30);
    expect(await buyerTurn(s, "I'm Tunde, I need knotless braids")).toMatch(/over your .30 spending limit/);
    expect(commerce.requestApproval(sid(), "MADE-UP")).toHaveProperty("error");
  });
});

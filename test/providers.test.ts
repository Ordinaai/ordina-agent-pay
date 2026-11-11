// Providers: the gateway reads businesses through them, real businesses are
// never offered for Sandbox money, and a provider that refuses a booking it
// held leaves the customer fully refunded.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
const providers = await import("../server/providers/index.ts");
const { simulatedProvider } = await import("../server/providers/simulated.ts");
const { ordinaProvider } = await import("../server/providers/ordina.ts");

seedDemoBusinesses();

let n = 0;
const original = simulatedProvider.recordBooking;
beforeEach(() => {
  store.resetStore();
  resetBuyers();
  resetSecretaries();
});
afterEach(() => {
  simulatedProvider.recordBooking = original;
});

async function payFor(text: string) {
  const s = `prov-session-${++n}`;
  await buyerTurn(s, text);
  const offerId = ([...eventsFor(s)].reverse().find((x) => x.kind === "approval")?.data as { orderId: string }).orderId;
  paypal.mockApprove(offerId);
  return { s, out: await commerce.captureAndConfirm(s, offerId) };
}

describe("providers", () => {
  it("with Sandbox or mock money, only the simulated provider is in use", () => {
    expect(paypal.paypalMode()).not.toBe("live");
    expect(providers.providers().map((p) => p.id)).toEqual(["simulated"]);
    expect(providers.bookableBusinesses().length).toBeGreaterThan(0);
  });

  it("the Ordina adapter lists nothing and refuses every hold", () => {
    expect(ordinaProvider.sandboxSafe).toBe(false);
    expect(ordinaProvider.businesses()).toEqual([]);
    const h = ordinaProvider.hold({ businessId: "x", serviceId: "y", date: "2026-11-12", time: "10:00", customerName: "Ada", sessionId: "s" });
    expect("error" in h).toBe(true);
  });

  it("search finds by word stems and never returns an empty list", () => {
    expect(providers.searchBusinesses("haircut")[0].name).toBe("Lumen Hair Studio");
    expect(providers.searchBusinesses("cakes")[0].name).toBe("Crumb & Co Bakery");
    expect(providers.searchBusinesses("zzzz qqqq").length).toBe(providers.bookableBusinesses().length);
  });

  it("tells the provider about a confirmed booking", async () => {
    const seen: string[] = [];
    simulatedProvider.recordBooking = async (bk) => {
      seen.push(bk.ref);
      return { ok: true, providerRef: bk.ref };
    };
    const { out } = await payFor("I'm Ada Obi. A silk press please, as early as possible.");
    expect(out.ok).toBe(true);
    if (out.ok) expect(seen).toEqual([out.booking.ref]);
  });

  it("refunds in full when the provider refuses a booking it held", async () => {
    simulatedProvider.recordBooking = async () => ({ ok: false, reason: "calendar offline" });
    const { s, out } = await payFor("I'm Ada Obi. A silk press please, as early as possible.");
    expect(out.ok).toBe(false);
    const [bk] = store.bookingsForSessions([s]);
    expect(bk.status).toBe("cancelled");
    expect(bk.refunded).toBe(bk.amount);
  });
});

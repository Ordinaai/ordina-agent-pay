// The hosted pay page (/pay/<token>). Any AI assistant (Claude through MCP, or
// our own playground) sends the customer here to approve one offer in PayPal.
import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";
import { useCallback, useEffect, useState } from "react";
import { Icon, Mark } from "./ui.tsx";

type Offer = {
  orderId: string;
  businessName: string;
  city: string;
  service: string;
  kind: "appointment" | "pickup";
  date: string;
  time: string;
  timezone: string;
  amount: string;
  currency: string;
  policy: string;
  customerName: string;
  expiresAt: number;
  state: "awaiting_approval" | "booked" | "expired" | "released" | "paid";
  bookingRef: string | null;
};

const niceDate = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const cityOf = (tz: string) => tz.split("/")[1]?.replace("_", " ") ?? tz;

export function PayPage({ token }: { token: string }) {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [paypal, setPaypal] = useState<{ mode: string; clientId: string | null; buyerCountry: string | null }>({
    mode: "mock",
    clientId: null,
    buyerCountry: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(() => {
    fetch(`/api/offers/${encodeURIComponent(token)}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "This payment link is not valid.");
        setOffer(j.offer);
        setPaypal({ mode: j.paypal, clientId: j.paypalClientId, buyerCountry: j.paypalBuyerCountry ?? null });
      })
      .catch((e) => setError(e.message));
  }, [token]);
  useEffect(load, [load]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const capture = async () => {
    setWorking(true);
    setError(null);
    try {
      const r = await fetch(`/api/offers/${encodeURIComponent(token)}/capture`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "PayPal did not confirm the payment. Nothing was charged.");
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  };
  const mockPay = async () => {
    setWorking(true);
    await fetch(`/api/offers/${encodeURIComponent(token)}/mock-approve`, { method: "POST" }).catch(() => {});
    await capture();
  };

  const left = offer ? Math.max(0, offer.expiresAt - now) : 0;
  const booked = offer?.state === "booked";
  const expired = offer && !booked && (left === 0 || offer.state === "expired");

  return (
    <div className="paypage">
      <div className="paypage-card">
        <span className="brand">
          <Mark /> Ordina <em className="for">Agent Checkout</em>
        </span>
        {!offer && !error && <p className="muted">Loading</p>}
        {!offer && error && (
          <div className="paypage-msg">
            <h1>Link not found</h1>
            <p>{error}</p>
          </div>
        )}
        {offer && (
          <>
            <p className="paypage-eyebrow">
              {booked ? "Booked" : expired ? "This hold has ended" : `Your agent arranged this for ${offer.customerName}`}
            </p>
            <h1>{offer.service}</h1>
            <p className="paypage-biz">
              {offer.businessName}, {offer.city}
            </p>
            <dl className="paypage-facts">
              <div>
                <dt>{offer.kind === "pickup" ? "Pickup" : "When"}</dt>
                <dd>
                  {niceDate(offer.date)}, {offer.time} ({cityOf(offer.timezone)} time)
                </dd>
              </div>
              <div>
                <dt>Total</dt>
                <dd className="paypage-amt">
                  ${offer.amount} <small>{offer.currency}</small>
                </dd>
              </div>
            </dl>
            {booked ? (
              <div className="receipt">
                <span className="receipt-ok" aria-hidden>
                  <Icon d="M5 12l4 4L19 6" />
                </span>
                <div>
                  <strong>Paid and booked, ref {offer.bookingRef}</strong>
                  <span>PayPal confirmed the payment. {offer.businessName} has your booking.</span>
                </div>
              </div>
            ) : expired ? (
              <p className="paypage-note">Nothing was charged. Ask your agent to hold a time again.</p>
            ) : (
              <>
                <div className="paypage-pay">
                  {paypal.mode !== "mock" && paypal.clientId ? (
                    <PayPalScriptProvider
                      options={{
                        clientId: paypal.clientId,
                        currency: offer.currency,
                        intent: "capture",
                        ...(paypal.buyerCountry ? { buyerCountry: paypal.buyerCountry } : {}),
                      }}
                    >
                      <PayPalButtons
                        style={{ layout: "vertical", tagline: false, height: 46, shape: "pill", color: "gold" }}
                        disabled={working}
                        createOrder={async () => offer.orderId}
                        onApprove={async () => capture()}
                        onError={() => setError("PayPal could not finish the payment. Nothing was charged.")}
                      />
                    </PayPalScriptProvider>
                  ) : (
                    <button className="pp" onClick={mockPay} disabled={working}>
                      {working ? (
                        "Confirming with PayPal"
                      ) : (
                        <>
                          Pay with <b>Pay</b>
                          <b className="pal">Pal</b>
                        </>
                      )}
                    </button>
                  )}
                </div>
                <p className="paypage-note">
                  This time is held for {Math.floor(left / 60000)} min {String(Math.floor((left % 60000) / 1000)).padStart(2, "0")} s. Nothing is charged until you
                  approve in PayPal. {offer.policy}
                </p>
              </>
            )}
            {error && <p className="err">{error}</p>}
          </>
        )}
        <p className="paypage-foot">
          Your AI agent can't pay by itself. The price comes from {offer?.businessName ?? "the business"}, and the booking exists only once PayPal
          confirms your payment.
        </p>
      </div>
    </div>
  );
}

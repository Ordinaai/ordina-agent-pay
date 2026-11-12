// The hosted pay page (/pay/<token>). Any AI assistant (Claude through MCP, or
// our own playground) sends the customer here to approve one offer in PayPal.
// A night stage, and on it the pass: the same object the chat and the front door show.
import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";
import { useCallback, useEffect, useState } from "react";
import { HoldClock, Mark, Pass, Seal } from "./ui.tsx";

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
  const clock = `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}`;

  return (
    <div className="stage on-night">
      <header className="stage-top">
        <span className="brand">
          <Mark light /> Ordina <em className="for">Agent Checkout</em>
        </span>
        {offer && paypal.mode !== "live" && (
          <span className="badge" title="Test mode: no real money moves">
            {paypal.mode === "mock" ? "Test mode" : "PayPal Sandbox"}
          </span>
        )}
      </header>
      <main className="stage-main">
        {!offer && !error && (
          <p className="stage-wait">
            <span className="spin" aria-hidden /> Loading
          </p>
        )}
        {!offer && error && (
          <div className="stage-msg">
            <span className="eyebrow">Payment link</span>
            <h1>Link not found</h1>
            <p>{error}</p>
            <p>Ask your agent for a new link.</p>
          </div>
        )}
        {offer && (
          <>
            <p className="stage-lede">
              {booked ? "Booked" : expired ? "This hold has ended" : `Your agent arranged this for ${offer.customerName}`}
            </p>
            <Pass
              label="Payment offer"
              title={offer.service}
              place={`${offer.businessName}, ${offer.city}`}
              when={`${offer.kind === "pickup" ? "Pickup " : ""}${niceDate(offer.date)}, ${offer.time} ${cityOf(offer.timezone)} time`}
              amount={offer.amount}
              currency={offer.currency}
              state={booked ? "paid" : expired ? "expired" : "offer"}
              status={
                booked ? (
                  <span className="badge ok">Paid</span>
                ) : expired ? (
                  <span className="badge">Hold ended</span>
                ) : (
                  <HoldClock label={`Held for ${clock}`} />
                )
              }
              note={
                booked
                  ? `PayPal confirmed the payment. ${offer.businessName} has your booking.`
                  : expired
                    ? "Nothing was charged. Ask your agent to hold a time again."
                    : `Nothing is charged until you approve in PayPal. ${offer.policy}`
              }
              enter
            >
              {booked && <Seal title="Paid and booked" detail={offer.bookingRef ? `Ref ${offer.bookingRef} · PayPal confirmed` : "PayPal confirmed"} />}
              {!booked && !expired && (
                <div className="pass-pay">
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
                        style={{ layout: "vertical", tagline: false, height: 46, shape: "rect", color: "gold" }}
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
              )}
              {error && <p className="err pass-err">{error}</p>}
            </Pass>
            <p className="stage-trust">
              Your AI agent cannot pay by itself. The price comes from {offer.businessName}, and the booking exists only once PayPal confirms your
              payment.
            </p>
          </>
        )}
      </main>
    </div>
  );
}

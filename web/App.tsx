import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

// ---------- types shared with the server ----------
type WireEvent = {
  id: number;
  at: number;
  sessionId: string;
  businessId?: string;
  kind: "buyer_to_business" | "business_to_buyer" | "tool" | "paypal" | "guardrail" | "approval" | "booking" | "assistant";
  actor: "buyer" | "secretary" | "paypal" | "server" | "owner";
  title: string;
  detail?: string;
  data?: Record<string, unknown>;
};
type Config = {
  ai: "claude" | "mock";
  model: string | null;
  paypal: "sandbox" | "live" | "mock";
  paypalClientId: string | null;
  businesses: Array<{ id: string; name: string; category: string; city: string; timezone: string }>;
};
type ApprovalCard = {
  orderId: string;
  businessId: string;
  businessName: string;
  service: string;
  date: string;
  time: string;
  timezone: string;
  amount: string;
  currency: string;
  policy: string;
  expiresAt: number;
};
type Booking = {
  id: string;
  ref: string;
  serviceName: string;
  date: string;
  time: string;
  customerName: string;
  amount: string;
  currency: string;
  captureId: string;
  status: "confirmed" | "refund_pending" | "refunded";
  createdAt: number;
};

const STARTERS = [
  { label: "A silk press in Lagos", text: "I'm Ada. Book me a silk press in Lagos, Saturday if possible." },
  { label: "Physio in London", text: "My name is Tom. A physio follow-up in London tomorrow afternoon, please." },
  { label: "A cooking class in Nairobi", text: "I'm Wanjiru. Find me a cooking class in Nairobi this week." },
];

// ---------- helpers ----------
async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `Request failed (${res.status})`);
  return json as T;
}

function useSession(): string {
  return useMemo(() => {
    const key = "oap-session";
    let id = localStorage.getItem(key);
    if (!id || !/^[a-z0-9-]{8,64}$/.test(id)) {
      id = crypto.randomUUID();
      localStorage.setItem(key, id);
    }
    return id;
  }, []);
}

function useEvents(url: string | null): WireEvent[] {
  const [events, setEvents] = useState<WireEvent[]>([]);
  useEffect(() => {
    if (!url) return;
    setEvents([]);
    const es = new EventSource(url);
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as WireEvent;
      setEvents((prev) => (prev.some((x) => x.id === e.id) ? prev : [...prev, e]));
    };
    return () => es.close();
  }, [url]);
  return events;
}

/** Keep a scroll container pinned to its end when `dep` changes. */
function useStickToBottom(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scroll methods,
    // and React would call it as a cleanup function.
    const el = ref.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [dep]);
  return ref;
}

const cityOf = (tz: string) => tz.split("/")[1]?.replace("_", " ") ?? tz;
const niceDate = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const money = (s: string | undefined) => s?.match(/(\d+\.\d{2})/)?.[1];
const initials = (name = "") =>
  name
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0])
    .join("");

// ---------- app ----------
export function App() {
  const sessionId = useSession();
  const [config, setConfig] = useState<Config | null>(null);
  const events = useEvents(`/api/events?session=${sessionId}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  const send = useCallback(
    async (msg: string) => {
      const t = msg.trim();
      if (!t || busy) return;
      setBusy(true);
      setError(null);
      try {
        await post("/api/chat", { session: sessionId, text: t });
      } catch (e) {
        setError(e instanceof Error ? e.message : "The message did not send. Try again.");
      } finally {
        setBusy(false);
      }
    },
    [busy, sessionId],
  );

  const reset = () => {
    localStorage.removeItem("oap-session");
    location.reload();
  };

  const activeBiz = [...events].reverse().find((e) => e.businessId)?.businessId;

  return (
    <div className="page">
      <nav className="nav">
        <a className="logo" href="/" aria-label="Agent Pay home">
          <span className="logo-mark" aria-hidden>
            <i />
            <i />
          </span>
          Agent Pay
        </a>
        <div className="nav-right">
          {config && (
            <span className="mode" title={config.model ?? "Scripted agents, no AI key set"}>
              <span className={`mode-dot ${config.ai === "claude" && config.paypal !== "mock" ? "on" : ""}`} />
              {config.ai === "claude" ? "Claude" : "Scripted agents"} · {config.paypal === "mock" ? "PayPal mock" : "PayPal Sandbox"}
            </span>
          )}
          <button className="nav-btn" onClick={reset}>
            Reset demo
          </button>
        </div>
      </nav>

      <header className="hero">
        <h1>
          Your agent books it. <em>You approve the payment.</em>
        </h1>
        <p>
          Your AI agent agrees the booking with the business's own AI Secretary, then brings back one PayPal payment. Nothing is
          charged until you say yes.
        </p>
      </header>

      <main className="stage">
        <CustomerPhone sessionId={sessionId} events={events} config={config} busy={busy} error={error} onSend={send} />
        <Channel events={events} config={config} busy={busy} />
        <BusinessPhone config={config} follow={activeBiz} />
      </main>

      <section className="rules" aria-label="Why it is safe">
        <div className="rule">
          <h3>The business sets the price</h3>
          <p>Every PayPal order is created at the business's listed price. Nothing an AI writes can change the amount.</p>
        </div>
        <div className="rule">
          <h3>Your limit is a hard limit</h3>
          <p>Above your spending limit, the server refuses to show you the payment at all. Your agent has no way to pay on its own.</p>
        </div>
        <div className="rule">
          <h3>Booked only when PayPal says so</h3>
          <p>A booking exists only after PayPal confirms the capture, for the exact amount. A hold that runs out is never charged.</p>
        </div>
      </section>

      <footer className="foot">
        Built by Ordina for the PayPal AI Hackathon 2026 · Agents on Claude · Payments by PayPal · Fictional businesses, test money only
      </footer>
    </div>
  );
}

// ---------- device frame ----------
function Phone({ label, children, tone }: { label: string; children: ReactNode; tone: "you" | "biz" }) {
  return (
    <figure className={`device device-${tone}`} aria-label={label}>
      <figcaption className="device-label">{label}</figcaption>
      <div className="phone">
        <div className="phone-screen">
          <div className="statusbar" aria-hidden>
            <span>9:41</span>
            <span className="island" />
            <span className="sb-icons">
              <i />
              <i />
              <b />
            </span>
          </div>
          {children}
        </div>
      </div>
    </figure>
  );
}

// ---------- the customer's phone ----------
function CustomerPhone({
  sessionId,
  events,
  config,
  busy,
  error,
  onSend,
}: {
  sessionId: string;
  events: WireEvent[];
  config: Config | null;
  busy: boolean;
  error: string | null;
  onSend: (t: string) => void;
}) {
  const [text, setText] = useState("");
  const [budget, setBudget] = useState(50);
  const [limitOpen, setLimitOpen] = useState(false);

  useEffect(() => {
    post("/api/budget", { session: sessionId, budget }).catch(() => {});
  }, [sessionId, budget]);

  const paidOrders = useMemo(
    () => new Set(events.filter((e) => e.kind === "booking" && e.data?.orderId).map((e) => String(e.data!.orderId))),
    [events],
  );

  // A payment card is raised mid-turn, before the reply that explains it;
  // show it after that reply so the conversation reads in order.
  const items = useMemo(() => {
    const out: WireEvent[] = [];
    let held: WireEvent[] = [];
    for (const e of events) {
      if (e.kind === "approval") held.push(e);
      else if (e.kind === "assistant") {
        out.push(e);
        if (e.data?.role !== "user") {
          out.push(...held);
          held = [];
        }
      }
    }
    return [...out, ...held];
  }, [events]);

  const scroller = useStickToBottom(`${items.length}-${busy}`);
  const submit = (t: string) => {
    setText("");
    onSend(t);
  };

  return (
    <Phone label="Your phone" tone="you">
      <div className="appbar">
        <span className="agent-orb" aria-hidden />
        <div className="appbar-text">
          <strong>Your agent</strong>
          <span>{busy ? "Working on it" : "Books things for you"}</span>
        </div>
        <button className={`limit-pill ${limitOpen ? "open" : ""}`} onClick={() => setLimitOpen((o) => !o)} aria-expanded={limitOpen}>
          Limit ${budget}
        </button>
      </div>
      {limitOpen && (
        <div className="limit-sheet">
          <div className="limit-top">
            <label htmlFor="limit">Spending limit</label>
            <output htmlFor="limit">${budget}</output>
          </div>
          <input id="limit" type="range" min={10} max={150} step={5} value={budget} onChange={(e) => setBudget(Number(e.target.value))} />
          <p>Your agent can't bring you a payment above this.</p>
        </div>
      )}

      <div className="convo" ref={scroller}>
        {items.length === 0 && (
          <div className="hello">
            <span className="agent-orb big" aria-hidden />
            <p className="hello-title">What should I book?</p>
            <p className="hello-sub">I'll find the place, agree a time with them, and check with you before any money moves.</p>
            <div className="starters">
              {STARTERS.map((s) => (
                <button key={s.label} className="starter" onClick={() => submit(s.text)} disabled={busy}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {items.map((e) =>
          e.kind === "approval" ? (
            <Ticket
              key={e.id}
              card={e.data as unknown as ApprovalCard}
              paid={paidOrders.has(String(e.data?.orderId))}
              sessionId={sessionId}
              config={config}
            />
          ) : (
            <div key={e.id} className={`bubble ${e.data?.role === "user" ? "out" : "in"}`}>
              {e.detail}
            </div>
          ),
        )}
        {busy && (
          <div className="bubble in thinking" aria-live="polite">
            <span className="dots" aria-hidden>
              <i />
              <i />
              <i />
            </span>
          </div>
        )}
      </div>

      {error && <p className="phone-error">{error}</p>}
      <form
        className="compose"
        onSubmit={(e) => {
          e.preventDefault();
          submit(text);
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Message your agent"
          maxLength={500}
          disabled={busy}
          aria-label="Message your agent"
        />
        <button disabled={busy || !text.trim()} aria-label="Send">
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden>
            <path d="M10 16V4M5 9l5-5 5 5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </form>
    </Phone>
  );
}

function useCountdown(until: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, until - now);
  return { left, label: `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}` };
}

/** The payment the agents agreed, waiting for the human. */
function Ticket({ card, paid, sessionId, config }: { card: ApprovalCard; paid: boolean; sessionId: string; config: Config | null }) {
  const { left, label } = useCountdown(card.expiresAt);
  const [working, setWorking] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const expired = !paid && left === 0;

  const capture = useCallback(async () => {
    setWorking(true);
    setMsg(null);
    try {
      await post("/api/pay/capture", { session: sessionId, orderId: card.orderId });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "PayPal did not confirm the payment. Nothing was charged.");
    } finally {
      setWorking(false);
    }
  }, [card.orderId, sessionId]);

  const mockPay = async () => {
    setWorking(true);
    await post("/api/pay/mock-approve", { session: sessionId, orderId: card.orderId }).catch(() => {});
    await capture();
  };

  return (
    <div className={`ticket ${paid ? "paid" : ""} ${expired ? "expired" : ""}`}>
      <div className="ticket-top">
        <span className="biz-chip">
          <span className="biz-dot">{initials(card.businessName)}</span>
          {card.businessName}
        </span>
        {paid ? (
          <span className="ticket-state ok">
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
              <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Paid
          </span>
        ) : expired ? (
          <span className="ticket-state">Hold ended</span>
        ) : (
          <span className="ticket-state">Held {label}</span>
        )}
      </div>
      <div className="ticket-what">{card.service}</div>
      <div className="ticket-when">
        {niceDate(card.date)} · {card.time} <span>{cityOf(card.timezone)} time</span>
      </div>
      <div className="ticket-total">
        <span>Total</span>
        <strong>
          ${card.amount} <small>{card.currency}</small>
        </strong>
      </div>
      {!paid && !expired && (
        <div className="ticket-pay">
          {config?.paypal !== "mock" && config?.paypalClientId ? (
            <PayPalScriptProvider options={{ clientId: config.paypalClientId, currency: card.currency, intent: "capture" }}>
              <PayPalButtons
                style={{ layout: "horizontal", tagline: false, height: 42, shape: "pill", color: "gold" }}
                disabled={working}
                createOrder={async () => card.orderId}
                onApprove={async () => capture()}
                onError={() => setMsg("PayPal could not finish the payment. Nothing was charged.")}
              />
            </PayPalScriptProvider>
          ) : (
            <button className="pp-btn" onClick={mockPay} disabled={working}>
              {working ? (
                "Confirming"
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
      <p className="ticket-fine">{paid ? "Booked. The business has it." : expired ? "Nothing was charged. Ask your agent to hold it again." : card.policy}</p>
      {msg && <p className="ticket-fine err">{msg}</p>}
    </div>
  );
}

// ---------- the channel between the two agents ----------
type MoneyState = { step: "none" | "order" | "waiting" | "paid" | "refunded" | "blocked"; amount?: string; note?: string };

function moneyState(events: WireEvent[]): MoneyState {
  let s: MoneyState = { step: "none" };
  for (const e of events) {
    if (e.kind === "paypal" && e.title === "Create PayPal order") s = { step: "order", amount: money(e.detail) };
    else if (e.kind === "approval") s = { step: "waiting", amount: String(e.data?.amount ?? s.amount ?? "") };
    else if (e.kind === "guardrail") s = { step: "blocked", amount: money(e.detail) ?? s.amount, note: e.title };
    else if (e.kind === "paypal" && e.title.startsWith("Capture COMPLETED")) s = { step: "paid", amount: money(e.detail) ?? s.amount };
    else if (e.kind === "paypal" && e.title.startsWith("Refund COMPLETED")) s = { step: "refunded", amount: s.amount };
  }
  return s;
}

function Channel({ events, config, busy }: { events: WireEvent[]; config: Config | null; busy: boolean }) {
  const [raw, setRaw] = useState(false);
  const shown = events.filter((e) => (raw ? e.kind !== "assistant" : e.kind !== "assistant" && e.kind !== "tool"));
  const ref = useStickToBottom(`${shown.length}-${busy}-${raw}`);
  const bizName = (id?: string) => config?.businesses.find((b) => b.id === id)?.name ?? "The business";
  const active = [...events].reverse().find((e) => e.businessId)?.businessId;
  const toolCount = events.filter((e) => e.kind === "tool").length;
  const m = moneyState(events);

  return (
    <section className="channel" aria-label="What the two agents say to each other">
      <div className="channel-head">
        <span className="ch-party you">Your agent</span>
        <span className={`ch-line ${busy ? "busy" : ""}`} aria-hidden>
          <i />
        </span>
        <span className="ch-party biz">{active ? `${bizName(active)}'s Secretary` : "The business's Secretary"}</span>
      </div>

      <div className="channel-feed" ref={ref}>
        {shown.length === 0 && !busy && (
          <div className="channel-empty">
            <p>The agents talk here.</p>
            <span>Ask your agent for something on the left. You'll see it agree the details with the business, live.</span>
          </div>
        )}
        {shown.map((e) => (
          <ChannelItem key={e.id} e={e} biz={bizName(e.businessId)} />
        ))}
        {busy && (
          <div className="ch-typing" aria-hidden>
            <span className="dots">
              <i />
              <i />
              <i />
            </span>
          </div>
        )}
      </div>

      <div className={`gate gate-${m.step}`}>
        <span className="gate-logo" aria-hidden>
          <b>Pay</b>
          <b className="pal">Pal</b>
        </span>
        <div className="gate-text">
          <strong>
            {
              {
                none: "No payment yet",
                order: "Order created",
                waiting: "Waiting for your approval",
                paid: "Payment captured",
                refunded: "Refunded",
                blocked: "Payment blocked",
              }[m.step]
            }
          </strong>
          <span>
            {
              {
                none: "Money moves only after you approve.",
                order: "At the business's listed price.",
                waiting: "Your agent can't approve for you.",
                paid: "Confirmed by PayPal. The booking is made.",
                refunded: "Returned by the business through PayPal.",
                blocked: "It was above your spending limit.",
              }[m.step]
            }
          </span>
        </div>
        {m.amount && m.step !== "none" && <span className="gate-amount">${m.amount}</span>}
        {toolCount > 0 && (
          <button className="raw-toggle" onClick={() => setRaw((r) => !r)} aria-pressed={raw}>
            {raw ? "Hide raw calls" : `Show raw calls (${toolCount})`}
          </button>
        )}
      </div>
    </section>
  );
}

function ChannelItem({ e, biz }: { e: WireEvent; biz: string }) {
  if (e.kind === "buyer_to_business" || e.kind === "business_to_buyer") {
    const you = e.kind === "buyer_to_business";
    return (
      <div className={`ch-msg ${you ? "from-you" : "from-biz"}`}>
        <span className="ch-who">{you ? "Your agent" : `${biz}'s Secretary`}</span>
        <p>{e.detail}</p>
      </div>
    );
  }
  if (e.kind === "tool") {
    return (
      <div className={`ch-raw ${e.actor === "buyer" ? "from-you" : "from-biz"}`}>
        <code>
          {e.title}({e.detail === "{}" ? "" : e.detail})
        </code>
      </div>
    );
  }
  // Milestones, said plainly.
  let tone = "info";
  let text = e.title;
  if (e.kind === "paypal") {
    if (e.title === "Create PayPal order") text = `PayPal order created for $${money(e.detail) ?? ""}`;
    else if (e.title.startsWith("Order ")) return null;
    else if (e.title.startsWith("Capture COMPLETED")) {
      tone = "ok";
      text = `PayPal captured $${money(e.detail) ?? ""}`;
    } else if (e.title.startsWith("Refund requested")) text = "The business started a refund";
    else if (e.title.startsWith("Refund COMPLETED")) text = "PayPal refunded the payment";
    else tone = "bad";
  } else if (e.kind === "approval") {
    tone = "you";
    text = "Sent to you to approve";
  } else if (e.kind === "guardrail") {
    tone = "bad";
    text = `${e.title}. ${e.detail ?? ""}`;
  } else if (e.kind === "booking") {
    tone = e.title.includes("refund") ? "info" : "ok";
  }
  return (
    <div className={`ch-mark ${tone}`}>
      <span>{text}</span>
    </div>
  );
}

// ---------- the business owner's phone ----------
function BusinessPhone({ config, follow }: { config: Config | null; follow?: string }) {
  const [biz, setBiz] = useState("lumen-hair");
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refunding, setRefunding] = useState<string | null>(null);
  const ownerEvents = useEvents(`/api/owner/${biz}/events`);
  const firstLoad = useRef(true);
  const known = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (follow) setBiz(follow);
  }, [follow]);

  const load = useCallback(() => {
    fetch(`/api/owner/${biz}`)
      .then((r) => r.json())
      .then((j) => setBookings(j.bookings ?? []))
      .catch(() => {});
  }, [biz]);
  useEffect(() => {
    load();
  }, [load, ownerEvents.length]);

  useEffect(() => {
    // Rows present on first load are not "new"; later arrivals glow once.
    if (firstLoad.current && bookings.length) {
      bookings.forEach((b) => known.current.add(b.id));
      firstLoad.current = false;
      return;
    }
    const t = setTimeout(() => bookings.forEach((b) => known.current.add(b.id)), 4000);
    return () => clearTimeout(t);
  }, [bookings]);

  const refund = async (id: string) => {
    setRefunding(id);
    setError(null);
    try {
      await post("/api/owner/refund", { bookingId: id, businessId: biz });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The refund did not go through.");
    } finally {
      setRefunding(null);
    }
  };

  const paid = bookings.filter((b) => b.status === "confirmed");
  const takings = paid.reduce((n, b) => n + Number(b.amount), 0);
  const current = config?.businesses.find((b) => b.id === biz);

  return (
    <Phone label="The business owner's phone" tone="biz">
      <div className="appbar">
        <span className="biz-avatar" aria-hidden>
          {initials(current?.name)}
        </span>
        <div className="appbar-text">
          <strong>{current?.name ?? "Business"}</strong>
          <span className="live">
            <i /> Secretary answering
          </span>
        </div>
      </div>

      <div className="seg" role="tablist" aria-label="Choose a business">
        {config?.businesses.map((b) => (
          <button key={b.id} role="tab" aria-selected={b.id === biz} className={b.id === biz ? "on" : ""} onClick={() => setBiz(b.id)}>
            {b.city}
          </button>
        ))}
      </div>

      <div className="owner-body">
        <div className="takings">
          <span>Paid through PayPal</span>
          <strong>${takings.toFixed(2)}</strong>
          <em>
            {paid.length} {paid.length === 1 ? "booking" : "bookings"} · no invoices to chase
          </em>
        </div>

        {error && <p className="phone-error">{error}</p>}
        <div className="feed-title">Bookings</div>
        {bookings.length === 0 && (
          <p className="owner-empty">When a customer's agent books and the payment clears, it lands here. No forms, no chasing.</p>
        )}
        <div className="bookings">
          {bookings.map((b) => (
            <div key={b.id} className={`bk ${known.current.has(b.id) ? "" : "fresh"} ${b.status}`}>
              <div className="bk-row">
                <strong>{b.serviceName}</strong>
                <span className="bk-amt">${b.amount}</span>
              </div>
              <div className="bk-row sub">
                <span>
                  {b.customerName} · {niceDate(b.date)}, {b.time}
                </span>
                {b.status === "confirmed" ? (
                  <button className="bk-refund" onClick={() => refund(b.id)} disabled={refunding === b.id}>
                    {refunding === b.id ? "Refunding" : "Refund"}
                  </button>
                ) : (
                  <span className="bk-status">{b.status === "refunded" ? "Refunded" : "Refund pending"}</span>
                )}
              </div>
              <div className="bk-ref">
                Paid via PayPal · ref {b.ref}
                {!known.current.has(b.id) && <span className="new-tag">New</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Phone>
  );
}

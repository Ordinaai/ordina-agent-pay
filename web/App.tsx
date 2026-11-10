import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ---------- shared shapes ----------
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
  paypal: "sandbox" | "live" | "mock";
  paypalClientId: string | null;
  businesses: Array<{ id: string; name: string; city: string; timezone: string }>;
};
type Approval = {
  orderId: string;
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
type MyBooking = {
  id: string;
  ref: string;
  chatId: string;
  businessName: string;
  city: string;
  timezone: string;
  serviceName: string;
  date: string;
  time: string;
  amount: string;
  currency: string;
  status: "confirmed" | "refund_pending" | "refunded";
  policy: string;
  cancelUntil: number | null;
  createdAt: number;
};
type Chat = { id: string; title: string; at: number };
type View = { name: "chat"; id: string | null } | { name: "bookings" } | { name: "settings" };

const SUGGESTIONS = [
  "Book me a silk press in Lagos on Saturday",
  "A physio follow-up in London tomorrow afternoon",
  "Order a celebration cake for pickup",
  "Find me a cooking class in Nairobi this week",
];

// ---------- helpers ----------
async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `Request failed (${res.status})`);
  return json as T;
}

function useStored<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: T | ((p: T) => T)) =>
      setV((prev) => {
        const val = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        localStorage.setItem(key, JSON.stringify(val));
        return val;
      }),
    [key],
  );
  return [v, set];
}

function useEvents(chatId: string | null): WireEvent[] {
  const [events, setEvents] = useState<WireEvent[]>([]);
  useEffect(() => {
    setEvents([]);
    if (!chatId) return;
    const es = new EventSource(`/api/events?session=${chatId}`);
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as WireEvent;
      setEvents((prev) => (prev.some((x) => x.id === e.id) ? prev : [...prev, e]));
    };
    return () => es.close();
  }, [chatId]);
  return events;
}

const niceDate = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const cityOf = (tz: string) => tz.split("/")[1]?.replace("_", " ") ?? tz;
const money = (s?: string) => s?.match(/(\d+\.\d{2})/)?.[1];
const shortWhen = (t: number) => new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

// ---------- turn model: one request from you and everything that followed ----------
type Step = { id: number; text: string; tone?: "bad" | "ok" };
type Turn = {
  key: number;
  user: string;
  steps: Step[];
  replies: string[];
  approvals: Approval[];
  receipts: Array<{ id: number; orderId: string; title: string; detail?: string }>;
  businesses: string[];
};

function describe(e: WireEvent, biz: (id?: string) => string): Step | null {
  const r = (e.data?.result ?? {}) as Record<string, unknown>;
  let input: Record<string, unknown> = {};
  try {
    input = e.detail ? JSON.parse(e.detail) : {};
  } catch {
    /* not JSON */
  }
  switch (e.kind) {
    case "tool":
      if (e.title === "find_businesses") {
        const n = (r.businesses as unknown[] | undefined)?.length ?? 0;
        return { id: e.id, text: `Searched ${n} businesses that take agent bookings` };
      }
      if (e.title === "request_payment_approval") return { id: e.id, text: "Sent the payment to you to approve" };
      if (e.title === "list_services") return { id: e.id, text: `${biz(e.businessId)} shared its services and prices` };
      if (e.title === "check_availability")
        return { id: e.id, text: `${biz(e.businessId)} checked free times on ${niceDate(String(input.date ?? ""))}` };
      if (e.title === "hold_time")
        return "error" in r
          ? { id: e.id, text: `${biz(e.businessId)} could not hold that time`, tone: "bad" }
          : { id: e.id, text: `${biz(e.businessId)} held ${String(input.time)} for 15 minutes` };
      if (e.title === "create_payment") return null; // the PayPal line says it better
      return { id: e.id, text: e.title };
    case "buyer_to_business":
      return { id: e.id, text: `Messaged ${biz(e.businessId)}'s AI Secretary` };
    case "business_to_buyer":
      return { id: e.id, text: `${biz(e.businessId)} replied` };
    case "paypal":
      if (e.title === "Create PayPal order") return { id: e.id, text: `Created a PayPal order for $${money(e.detail) ?? ""}` };
      if (e.title.startsWith("Order ")) return null;
      if (e.title.startsWith("Capture COMPLETED")) return { id: e.id, text: `PayPal confirmed $${money(e.detail) ?? ""}`, tone: "ok" };
      if (e.title.startsWith("Refund COMPLETED")) return { id: e.id, text: "PayPal refunded the payment", tone: "ok" };
      if (e.title.includes("requested")) return null;
      return { id: e.id, text: e.title, tone: "bad" };
    case "guardrail":
      return { id: e.id, text: e.title, tone: "bad" };
    default:
      return null;
  }
}

function buildTurns(events: WireEvent[], biz: (id?: string) => string): Turn[] {
  const turns: Turn[] = [];
  for (const e of events) {
    if (e.kind === "assistant" && e.data?.role === "user") {
      turns.push({ key: e.id, user: e.detail ?? "", steps: [], replies: [], approvals: [], receipts: [], businesses: [] });
      continue;
    }
    const t = turns[turns.length - 1];
    if (!t) continue;
    if (e.businessId && !t.businesses.includes(biz(e.businessId))) t.businesses.push(biz(e.businessId));
    if (e.kind === "assistant") t.replies.push(e.detail ?? "");
    else if (e.kind === "approval") t.approvals.push(e.data as unknown as Approval);
    else if (e.kind === "booking") t.receipts.push({ id: e.id, orderId: String(e.data?.orderId ?? ""), title: e.title, detail: e.detail });
    const s = describe(e, biz);
    if (s) t.steps.push(s);
  }
  return turns;
}

// ---------- app ----------
export function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [chats, setChats] = useStored<Chat[]>("ap-chats", []);
  const [limit, setLimit] = useStored<number>("ap-limit", 50);
  const [view, setView] = useState<View>({ name: "chat", id: null });
  const [drawer, setDrawer] = useState(false);
  // Remount the chat only when you navigate, not when a new chat gets its id.
  const [chatKey, setChatKey] = useState("new-0");

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  const go = (v: View) => {
    setView(v);
    if (v.name === "chat") setChatKey(v.id ?? `new-${Date.now()}`);
    setDrawer(false);
  };
  const chatId = view.name === "chat" ? view.id : null;

  return (
    <div className={`app ${drawer ? "drawer-open" : ""}`}>
      <aside className="side" aria-label="Navigation">
        <div className="side-top">
          <span className="brand">
            <Mark /> Agent Pay
          </span>
        </div>
        <button className="side-new" onClick={() => go({ name: "chat", id: null })}>
          <Icon d="M12 5v14M5 12h14" /> New chat
        </button>
        <nav className="side-nav">
          <button className={view.name === "bookings" ? "on" : ""} onClick={() => go({ name: "bookings" })}>
            <Icon d="M7 3v3M17 3v3M4 9h16M5 6h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z" /> Bookings
          </button>
          <button className={view.name === "settings" ? "on" : ""} onClick={() => go({ name: "settings" })}>
            <Icon d="M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4" /> Spending limit
          </button>
        </nav>
        <div className="side-label">Chats</div>
        <div className="side-chats">
          {chats.length === 0 && <p className="side-empty">Your chats will show here.</p>}
          {chats.map((c) => (
            <button key={c.id} className={chatId === c.id ? "on" : ""} onClick={() => go({ name: "chat", id: c.id })} title={c.title}>
              {c.title}
            </button>
          ))}
        </div>
        <div className="side-foot">
          <span className="me">G</span>
          <div>
            <strong>Guest</strong>
            <span>${limit} limit per payment</span>
          </div>
        </div>
      </aside>
      <button className="scrim" aria-label="Close menu" onClick={() => setDrawer(false)} />

      <main className="main">
        <header className="top">
          <button className="icon-btn menu" aria-label="Open menu" onClick={() => setDrawer(true)}>
            <Icon d="M4 7h16M4 12h16M4 17h16" />
          </button>
          <span className="top-title">
            {view.name === "bookings" ? "Bookings" : view.name === "settings" ? "Spending limit" : "Agent Pay"}
          </span>
          {config && (
            <span className="env" title="Test mode: no real money moves">
              {config.paypal === "mock" ? "Test mode" : "PayPal Sandbox"}
            </span>
          )}
          <button className="icon-btn new" aria-label="New chat" onClick={() => go({ name: "chat", id: null })}>
            <Icon d="M12 5v14M5 12h14" />
          </button>
        </header>

        {view.name === "chat" && (
          <ChatView
            key={chatKey}
            chatId={view.id}
            config={config}
            limit={limit}
            onCreate={(id, title) => {
              setChats((cs) => [{ id, title, at: Date.now() }, ...cs].slice(0, 50));
              setView({ name: "chat", id });
            }}
            openBookings={() => go({ name: "bookings" })}
          />
        )}
        {view.name === "bookings" && <BookingsView chats={chats} openChat={(id) => go({ name: "chat", id })} />}
        {view.name === "settings" && <LimitView limit={limit} setLimit={setLimit} />}
      </main>
    </div>
  );
}

// ---------- chat ----------
function ChatView({
  chatId,
  config,
  limit,
  onCreate,
  openBookings,
}: {
  chatId: string | null;
  config: Config | null;
  limit: number;
  onCreate: (id: string, title: string) => void;
  openBookings: () => void;
}) {
  const [liveId, setLiveId] = useState<string | null>(chatId);
  const events = useEvents(liveId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const biz = useCallback((id?: string) => config?.businesses.find((b) => b.id === id)?.name ?? "The business", [config]);
  const turns = useMemo(() => buildTurns(events, biz), [events, biz]);
  const paid = useMemo(() => new Set(events.filter((e) => e.kind === "booking" && e.data?.orderId).map((e) => String(e.data!.orderId))), [events]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [events.length, busy]);

  const send = async (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    let id = liveId;
    if (!id) {
      id = crypto.randomUUID();
      setLiveId(id);
      onCreate(id, t.length > 42 ? `${t.slice(0, 40)}...` : t);
    }
    setBusy(true);
    setError(null);
    try {
      await post("/api/budget", { session: id, budget: limit });
      await post("/api/chat", { session: id, text: t });
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't send. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (!liveId || (turns.length === 0 && !busy)) {
    return (
      <div className="home">
        <div className="home-inner">
          <Mark big />
          <h1>What can I book or buy for you?</h1>
          <p className="home-sub">I find the business, agree the details with its AI Secretary, and bring you one PayPal payment to approve.</p>
          <Composer onSend={send} busy={busy} autoFocus />
          <div className="suggest">
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => send(s)} disabled={busy}>
                {s}
              </button>
            ))}
          </div>
          {error && <p className="err">{error}</p>}
        </div>
      </div>
    );
  }

  const last = turns[turns.length - 1];
  return (
    <div className="chat">
      <div className="thread" ref={scroller}>
        <div className="thread-inner">
          {turns.map((t) => (
            <TurnView
              key={t.key}
              turn={t}
              live={busy && t === last}
              paid={paid}
              chatId={liveId}
              config={config}
              openBookings={openBookings}
            />
          ))}
          {error && <p className="err">{error}</p>}
        </div>
      </div>
      <div className="dock">
        <Composer onSend={send} busy={busy} />
        <p className="dock-note">Your agent can't pay by itself. Every payment waits for you in PayPal.</p>
      </div>
    </div>
  );
}

function TurnView({
  turn,
  live,
  paid,
  chatId,
  config,
  openBookings,
}: {
  turn: Turn;
  live: boolean;
  paid: Set<string>;
  chatId: string;
  config: Config | null;
  openBookings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [first, ...later] = turn.replies;
  const lastStep = turn.steps[turn.steps.length - 1];
  return (
    <div className="turn">
      <div className="you">
        <p>{turn.user}</p>
      </div>
      <div className="agent">
        <Mark small />
        <div className="agent-body">
          {(turn.steps.length > 0 || live) && (
            <div className={`work ${open ? "open" : ""}`}>
              <button className="work-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
                {live ? <span className="spin" aria-hidden /> : <Icon d="M5 12l4 4L19 6" />}
                <span className="work-title">
                  {live
                    ? lastStep?.text ?? "Thinking"
                    : turn.businesses.length
                      ? `Worked with ${turn.businesses.join(", ")}`
                      : "Looked into it"}
                </span>
                <span className="work-count">{turn.steps.length} steps</span>
                <Icon d="M9 6l6 6-6 6" className="chev" />
              </button>
              {open && (
                <ol className="work-steps">
                  {turn.steps.map((s) => (
                    <li key={s.id} className={s.tone ?? ""}>
                      {s.text}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
          {first && <p className="reply">{first}</p>}
          {turn.approvals.map((a) => (
            <PayCard key={a.orderId} a={a} paid={paid.has(a.orderId)} chatId={chatId} config={config} />
          ))}
          {turn.receipts
            .filter((r) => !r.title.toLowerCase().includes("refund"))
            .map((r) => (
              <Receipt key={r.id} r={r} openBookings={openBookings} />
            ))}
          {later.map((t, i) => (
            <p className="reply" key={i}>
              {t}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}

function Composer({ onSend, busy, autoFocus }: { onSend: (t: string) => void; busy: boolean; autoFocus?: boolean }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);
  const submit = () => {
    if (!text.trim() || busy) return;
    onSend(text);
    setText("");
  };
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={ref}
        rows={1}
        value={text}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Ask your agent to book or buy something"
        maxLength={1000}
        aria-label="Message your agent"
      />
      <button className="send" disabled={busy || !text.trim()} aria-label="Send">
        {busy ? <span className="spin light" aria-hidden /> : <Icon d="M12 19V5M6 11l6-6 6 6" />}
      </button>
    </form>
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

function PayCard({ a, paid, chatId, config }: { a: Approval; paid: boolean; chatId: string; config: Config | null }) {
  const { left, label } = useCountdown(a.expiresAt);
  const [working, setWorking] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const expired = !paid && left === 0;

  const capture = useCallback(async () => {
    setWorking(true);
    setMsg(null);
    try {
      await post("/api/pay/capture", { session: chatId, orderId: a.orderId });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "PayPal did not confirm the payment. Nothing was charged.");
    } finally {
      setWorking(false);
    }
  }, [a.orderId, chatId]);

  const mockPay = async () => {
    setWorking(true);
    await post("/api/pay/mock-approve", { session: chatId, orderId: a.orderId }).catch(() => {});
    await capture();
  };

  return (
    <div className={`pay ${paid ? "is-paid" : ""} ${expired ? "is-expired" : ""}`}>
      <div className="pay-head">
        <span>{paid ? "Paid" : expired ? "Hold ended" : "Approve payment"}</span>
        {!paid && !expired && <span className="pay-timer">Held for {label}</span>}
      </div>
      <div className="pay-body">
        <div className="pay-what">
          <strong>{a.service}</strong>
          <span>{a.businessName}</span>
          <span>
            {niceDate(a.date)}, {a.time} {cityOf(a.timezone)} time
          </span>
        </div>
        <div className="pay-amt">
          ${a.amount}
          <small>{a.currency}</small>
        </div>
      </div>
      {!paid && !expired && (
        <div className="pay-action">
          {config?.paypal !== "mock" && config?.paypalClientId ? (
            <PayPalScriptProvider options={{ clientId: config.paypalClientId, currency: a.currency, intent: "capture" }}>
              <PayPalButtons
                style={{ layout: "horizontal", tagline: false, height: 44, shape: "pill", color: "gold" }}
                disabled={working}
                createOrder={async () => a.orderId}
                onApprove={async () => capture()}
                onError={() => setMsg("PayPal could not finish the payment. Nothing was charged.")}
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
      <p className="pay-fine">
        {paid ? "Payment confirmed by PayPal." : expired ? "Nothing was charged. Ask me to hold it again." : a.policy}
      </p>
      {msg && <p className="pay-fine err">{msg}</p>}
    </div>
  );
}

function Receipt({ r, openBookings }: { r: { title: string; detail?: string }; openBookings: () => void }) {
  const ref = r.title.match(/ref (\w+)/)?.[1];
  return (
    <div className="receipt">
      <span className="receipt-ok" aria-hidden>
        <Icon d="M5 12l4 4L19 6" />
      </span>
      <div>
        <strong>Booked{ref ? `, ref ${ref}` : ""}</strong>
        {r.detail && <span>{r.detail}</span>}
      </div>
      <button onClick={openBookings}>View</button>
    </div>
  );
}

// ---------- bookings ----------
function BookingsView({ chats, openChat }: { chats: Chat[]; openChat: (id: string) => void }) {
  const [items, setItems] = useState<MyBooking[] | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ id: string; text: string; bad?: boolean } | null>(null);
  const ids = chats.map((c) => c.id);

  const load = useCallback(() => {
    if (!ids.length) {
      setItems([]);
      return;
    }
    fetch(`/api/bookings?sessions=${ids.join(",")}`)
      .then((r) => r.json())
      .then((j) => setItems(j.bookings ?? []))
      .catch(() => setItems([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(",")]);
  useEffect(() => {
    load();
  }, [load]);

  const cancel = async (b: MyBooking) => {
    setWorking(b.id);
    setMsg(null);
    try {
      await post("/api/bookings/cancel", { sessions: ids, bookingId: b.id });
      setMsg({ id: b.id, text: `Cancelled. PayPal is returning $${b.amount} to you.` });
      load();
    } catch (e) {
      setMsg({ id: b.id, text: e instanceof Error ? e.message : "Couldn't cancel.", bad: true });
    } finally {
      setWorking(null);
      setConfirm(null);
    }
  };

  const upcoming = (items ?? []).filter((b) => b.status === "confirmed");
  const past = (items ?? []).filter((b) => b.status !== "confirmed");

  return (
    <div className="page">
      <div className="page-inner">
        <h2>Bookings</h2>
        <p className="page-sub">Everything your agent booked and you paid for.</p>
        {items === null && <p className="muted">Loading</p>}
        {items?.length === 0 && (
          <div className="blank">
            <p>No bookings yet.</p>
            <span>Ask your agent for something, approve the payment, and it shows up here.</span>
          </div>
        )}
        {upcoming.length > 0 && <div className="group">Upcoming</div>}
        {upcoming.map((b) => {
          const canCancel = b.cancelUntil !== null && Date.now() < b.cancelUntil;
          return (
            <div key={b.id} className="bk">
              <div className="bk-main">
                <strong>{b.serviceName}</strong>
                <span>
                  {b.businessName}, {b.city}
                </span>
                <span>
                  {niceDate(b.date)} at {b.time} {cityOf(b.timezone)} time
                </span>
                <span className="bk-ref">
                  Ref {b.ref} · Paid with PayPal ·{" "}
                  <button className="linkish" onClick={() => openChat(b.chatId)}>
                    Open chat
                  </button>
                </span>
              </div>
              <div className="bk-side">
                <span className="bk-amt">${b.amount}</span>
                {confirm === b.id ? (
                  <div className="confirm">
                    <span>Cancel and get ${b.amount} back?</span>
                    <div>
                      <button className="btn-danger" onClick={() => cancel(b)} disabled={working === b.id}>
                        {working === b.id ? "Cancelling" : "Cancel booking"}
                      </button>
                      <button className="btn-ghost" onClick={() => setConfirm(null)}>
                        Keep it
                      </button>
                    </div>
                  </div>
                ) : canCancel ? (
                  <>
                    <button className="btn-line" onClick={() => setConfirm(b.id)}>
                      Cancel
                    </button>
                    <span className="bk-note">Free until {shortWhen(b.cancelUntil!)}</span>
                  </>
                ) : (
                  <span className="bk-note">Past the free cancellation window</span>
                )}
              </div>
              {msg?.id === b.id && <p className={`bk-msg ${msg.bad ? "bad" : ""}`}>{msg.text}</p>}
            </div>
          );
        })}
        {past.length > 0 && <div className="group">Cancelled</div>}
        {past.map((b) => (
          <div key={b.id} className="bk is-past">
            <div className="bk-main">
              <strong>{b.serviceName}</strong>
              <span>
                {b.businessName}, {niceDate(b.date)} at {b.time}
              </span>
              <span className="bk-ref">Ref {b.ref}</span>
            </div>
            <div className="bk-side">
              <span className="bk-amt">${b.amount}</span>
              <span className="bk-note">{b.status === "refunded" ? "Refunded" : "Refund pending"}</span>
            </div>
            {msg?.id === b.id && <p className="bk-msg">{msg.text}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- spending limit ----------
function LimitView({ limit, setLimit }: { limit: number; setLimit: (n: number) => void }) {
  return (
    <div className="page">
      <div className="page-inner narrow">
        <h2>Spending limit</h2>
        <p className="page-sub">The most your agent may ask you to pay at once. Anything above it is refused before it reaches you.</p>
        <div className="limit">
          <div className="limit-val">${limit}</div>
          <input
            type="range"
            min={10}
            max={300}
            step={5}
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            aria-label="Spending limit in US dollars"
          />
          <div className="limit-scale">
            <span>$10</span>
            <span>$300</span>
          </div>
        </div>
        <ul className="promises">
          <li>Your agent never pays by itself. Every payment waits for you in PayPal.</li>
          <li>Prices come from the business, never from the AI.</li>
          <li>A booking only exists once PayPal confirms the payment.</li>
        </ul>
      </div>
    </div>
  );
}

// ---------- tiny UI bits ----------
function Icon({ d, className }: { d: string; className?: string }) {
  return (
    <svg className={`ic ${className ?? ""}`} viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Mark({ big, small }: { big?: boolean; small?: boolean }) {
  return <span className={`mark ${big ? "big" : ""} ${small ? "small" : ""}`} aria-hidden />;
}

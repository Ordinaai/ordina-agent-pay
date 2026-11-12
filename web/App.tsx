import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ConnectPicker } from "./connect.tsx";
import { HoldClock, Icon, Mark, Pass, Seal, SecretaryStar } from "./ui.tsx";

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
  /** Sandbox only: the buyer country PayPal's buttons assume (so the card button can be tried anywhere). */
  paypalBuyerCountry?: string | null;
  /** standard: the business is paid at capture; multiparty: PayPal holds it until after the booking. */
  paypalFlow?: "standard" | "multiparty";
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
  status: "confirmed" | "cancelled";
  cancelledBy: "customer" | "business" | null;
  refunded: string;
  paidAs: string | null;
  kind: "appointment" | "pickup";
  policy: string;
  cancelUntil: number | null;
  createdAt: number;
};
type Chat = { id: string; title: string; at: number };
type Pinned = {
  id: string;
  name: string;
  category: string;
  city: string;
  about: string;
  live: boolean;
  sells: Array<{ name: string; kind: "appointment" | "pickup"; price: string; minutes: number | null }>;
};
type View = { name: "chat"; id: string | null } | { name: "bookings" } | { name: "settings" } | { name: "connect" };

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
// Each step belongs to a lane: who did it. The trace shows the lane as a small soft chip.
type Lane = "assistant" | "secretary" | "server" | "paypal";
const LANES: Record<Lane, string> = { assistant: "Your assistant", secretary: "Secretary", server: "Server", paypal: "PayPal" };
type Step = { id: number; text: string; tone?: "bad" | "ok"; lane: Lane };
type Turn = {
  key: number;
  user: string;
  steps: Step[];
  replies: string[];
  approvals: Approval[];
  receipts: Array<{ id: number; orderId: string; title: string; detail?: string }>;
  businesses: string[];
};

function laneOf(e: WireEvent): Lane {
  if (e.kind === "paypal") return "paypal"; // the order, the capture, the refund
  if (e.kind === "guardrail") return "server"; // the checks and the spending limit
  if (e.kind === "tool") {
    if (e.title === "hold_time" || e.title === "create_payment" || e.title === "request_payment_approval") return "server";
    return e.actor === "secretary" ? "secretary" : e.actor === "buyer" ? "assistant" : "server";
  }
  if (e.kind === "buyer_to_business") return "assistant";
  if (e.kind === "business_to_buyer") return "secretary";
  return e.actor === "secretary" ? "secretary" : e.actor === "paypal" ? "paypal" : e.actor === "buyer" ? "assistant" : "server";
}

function describe(e: WireEvent, biz: (id?: string) => string): Step | null {
  const said = say(e, biz);
  return said ? { ...said, lane: laneOf(e) } : null;
}

function say(e: WireEvent, biz: (id?: string) => string): Omit<Step, "lane"> | null {
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
export function App({ handle }: { handle?: string }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [pinned, setPinned] = useState<Pinned | null | undefined>(handle ? undefined : null);
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
    if (handle) {
      fetch(`/api/b/${encodeURIComponent(handle)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => setPinned(j?.business ?? null))
        .catch(() => setPinned(null));
    }
  }, [handle]);

  const go = (v: View) => {
    setView(v);
    if (v.name === "chat") {
      setChatKey(v.id ?? `new-${Date.now()}`);
      if (!v.id && pinned) {
        // A new chat from the menu is a general one, not the business's link.
        setPinned(null);
        history.replaceState(null, "", "/try");
      }
    }
    setDrawer(false);
  };
  const chatId = view.name === "chat" ? view.id : null;

  return (
    <div className={`app play ${drawer ? "drawer-open" : ""}`}>
      <aside className="side" aria-label="Navigation">
        <div className="side-top">
          <span className="brand">
            <Mark /> Ordina <em className="for">Agent Checkout</em>
          </span>
        </div>
        <button className="btn-line side-new" onClick={() => go({ name: "chat", id: null })}>
          <Icon d="M12 5v14M5 12h14" /> New chat
        </button>
        <nav className="side-nav">
          <button className={view.name === "bookings" ? "on" : ""} onClick={() => go({ name: "bookings" })}>
            <Icon d="M7 3v3M17 3v3M4 9h16M5 6h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z" /> Bookings
          </button>
          <button className={view.name === "settings" ? "on" : ""} onClick={() => go({ name: "settings" })}>
            <Icon d="M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4" /> Spending limit
          </button>
          <button className={view.name === "connect" ? "on" : ""} onClick={() => go({ name: "connect" })}>
            <Icon d="M9 15l6-6M10 6l1-1a4 4 0 0 1 6 6l-1 1M14 18l-1 1a4 4 0 0 1-6-6l1-1" /> Use in your assistant
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
        <a className="side-biz" href="/business">
          <Icon d="M4 20V9l8-5 8 5v11M9 20v-6h6v6" /> Business view
        </a>
        <div className="side-foot">
          <span className="me">G</span>
          <div>
            <strong>Guest</strong>
            <span>
              <b className="num">${limit}</b> limit per payment
            </span>
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
            {view.name === "bookings" ? "Bookings" : view.name === "settings" ? "Spending limit" : view.name === "connect" ? "Use in your assistant" : "Your agent"}
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
            pinned={view.id ? null : pinned}
            handleMissing={!!handle && pinned === null && !view.id}
            config={config}
            limit={limit}
            onCreate={(id, title) => {
              setChats((cs) => [{ id, title, at: Date.now() }, ...cs].slice(0, 50));
              setView({ name: "chat", id });
            }}
            openBookings={() => go({ name: "bookings" })}
          />
        )}
        {view.name === "bookings" && (
          <BookingsView chats={chats} openChat={(id) => go({ name: "chat", id })} newChat={() => go({ name: "chat", id: null })} />
        )}
        {view.name === "settings" && <LimitView limit={limit} setLimit={setLimit} />}
        {view.name === "connect" && <ConnectView onTry={() => go({ name: "chat", id: null })} />}
      </main>
    </div>
  );
}

// ---------- chat ----------
function ChatView({
  chatId,
  pinned,
  handleMissing,
  config,
  limit,
  onCreate,
  openBookings,
}: {
  chatId: string | null;
  pinned?: Pinned | null;
  handleMissing?: boolean;
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
  // The booking reference for each paid order, so the pass can seal with it.
  const refs = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of events) {
      const ref = e.kind === "booking" && e.data?.orderId ? e.title.match(/ref (\w+)/)?.[1] : undefined;
      if (ref) m.set(String(e.data!.orderId), ref);
    }
    return m;
  }, [events]);
  const inner = useRef<HTMLDivElement>(null);
  const hasTurns = turns.length > 0;

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [events.length, busy]);
  // Steps and the pass are revealed in sequence after their events arrive: keep the newest in view.
  useEffect(() => {
    const el = scroller.current;
    const box = inner.current;
    if (!el || !box || typeof ResizeObserver !== "function") return;
    let last = box.offsetHeight;
    const ro = new ResizeObserver(() => {
      const h = box.offsetHeight;
      const grew = h - last;
      last = h;
      if (grew > 0 && el.scrollHeight - el.scrollTop - el.clientHeight < grew + 240) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    });
    ro.observe(box);
    return () => ro.disconnect();
  }, [hasTurns]);

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
      if (pinned?.live && turns.length === 0) await post("/api/pin", { session: id, businessId: pinned.id });
      await post("/api/chat", { session: id, text: t });
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not send. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (!liveId || (turns.length === 0 && !busy)) {
    return (
      <div className="home">
        <div className="home-inner">
          {pinned ? (
            <>
              <span className="pin-badge rise">{pinned.name.slice(0, 1)}</span>
              <h1 className="rise">Book with {pinned.name}</h1>
              <p className="home-sub rise" style={{ "--i": 1 } as CSSProperties}>
                {pinned.category} in {pinned.city}. {pinned.about || "Tell me what you would like and when, and I will arrange it with their Secretary."}
              </p>
              {!pinned.live && <p className="err">{pinned.name} is not taking bookings right now.</p>}
            </>
          ) : (
            <>
              <span className="home-mark rise">
                <Mark big />
              </span>
              <h1 className="rise">What can I book for you?</h1>
              <p className="home-sub rise" style={{ "--i": 1 } as CSSProperties}>
                {handleMissing
                  ? "That link does not lead to a business taking bookings, but I can find you another."
                  : "I find the business, agree the details with its AI Secretary, and bring you one PayPal payment to approve."}
              </p>
            </>
          )}
          <Composer onSend={send} busy={busy || (pinned ? !pinned.live : false)} autoFocus />
          <div className="suggest">
            {(pinned
              ? pinned.sells.slice(0, 4).map((x) => `${x.kind === "pickup" ? "Order" : "Book"} ${x.name.toLowerCase()} ($${x.price})`)
              : SUGGESTIONS
            ).map((s) => (
              <button key={s} onClick={() => send(s)} disabled={busy || (pinned ? !pinned.live : false)}>
                <span>{s}</span>
                <Icon d="M5 12h14M13 6l6 6-6 6" />
              </button>
            ))}
          </div>
          {error && <p className="err">{error}</p>}
        </div>
        <ul className="home-facts">
          <li>
            <Icon d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9-9-9ZM8 8h.01" />
            <span>Prices come from the business, never from the AI.</span>
          </li>
          <li>
            <Icon d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3ZM9 12l2 2 4-4" />
            <span>Your agent never pays by itself. Every payment waits for you in PayPal.</span>
          </li>
          <li>
            <Icon d="M7 3v3M17 3v3M4 9h16M5 6h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1ZM9 15l2 2 4-4" />
            <span>A booking only exists once PayPal confirms the payment.</span>
          </li>
        </ul>
      </div>
    );
  }

  const last = turns[turns.length - 1];
  return (
    <div className="chat">
      <div className="thread" ref={scroller}>
        <div className="thread-inner" ref={inner}>
          {turns.map((t) => (
            <TurnView
              key={t.key}
              turn={t}
              live={busy && t === last}
              paid={paid}
              refs={refs}
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
        <p className="dock-note">Your agent cannot pay by itself. Every payment waits for you in PayPal.</p>
      </div>
    </div>
  );
}

// The orchestrated moment: steps are revealed one at a time while a turn is being worked on,
// then the trace folds away and the reply and the pass arrive. Presentation only: the events,
// and what they say, are untouched. A turn loaded from history shows everything at once.
const STEP_MS = 320;
function usePaced(total: number, live: boolean) {
  const [shown, setShown] = useState(() => (live ? 0 : total));
  const phase = useRef<"stream" | "done">(live ? "stream" : "done");
  useEffect(() => {
    if (phase.current === "done") {
      if (shown !== total) setShown(total);
      return;
    }
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || shown >= total) {
      if (shown !== total) setShown(total);
      if (!live) phase.current = "done";
      return;
    }
    const t = setTimeout(() => setShown((n) => n + 1), STEP_MS);
    return () => clearTimeout(t);
  }, [total, shown, live]);
  const streaming = phase.current === "stream";
  const visible = streaming ? Math.min(shown, total) : total;
  return { visible, working: streaming && (live || visible < total) };
}

function TurnView({
  turn,
  live,
  paid,
  refs,
  chatId,
  config,
  openBookings,
}: {
  turn: Turn;
  live: boolean;
  paid: Set<string>;
  refs: Map<string, string>;
  chatId: string;
  config: Config | null;
  openBookings: () => void;
}) {
  const { visible, working } = usePaced(turn.steps.length, live);
  // Open while the agents work, folded to one line when they finish, unless you chose otherwise.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? working;
  const settled = visible >= turn.steps.length;
  const steps = turn.steps.slice(0, visible);
  const [first, ...later] = turn.replies;
  return (
    <div className="turn">
      <div className="you">
        <p>{turn.user}</p>
      </div>
      <div className="agent">
        <Mark small />
        <div className="agent-body">
          {(turn.steps.length > 0 || live) && (
            <div className={`trace ${open ? "open" : ""} ${working ? "is-live" : ""}`}>
              <button className="trace-head" onClick={() => setChosen(!open)} aria-expanded={open}>
                <span className="trace-ico">{working ? <span className="spin" aria-hidden /> : <Icon d="M5 12l4 4L19 6" />}</span>
                <span className="trace-title">
                  {working
                    ? turn.businesses.length
                      ? `Working with ${turn.businesses.join(", ")}`
                      : "Thinking"
                    : turn.businesses.length
                      ? `Worked with ${turn.businesses.join(", ")}`
                      : "Looked into it"}
                </span>
                {steps.length > 0 && (
                  <span className="trace-count">
                    · {steps.length} {steps.length === 1 ? "step" : "steps"}
                  </span>
                )}
                <Icon d="M9 6l6 6-6 6" className="chev" />
              </button>
              <div className="trace-body">
                <ol className="trace-steps">
                  {steps.map((s, i) => {
                    const now = working && i === steps.length - 1;
                    return (
                      <li key={s.id} className={`trace-step lane-${s.lane} ${s.tone ?? ""} ${now ? "is-now" : ""}`}>
                        <span className="trace-lane">
                          {s.lane === "secretary" && <SecretaryStar size={11} />}
                          {LANES[s.lane]}
                        </span>
                        <span className="trace-text">{s.text}</span>
                      </li>
                    );
                  })}
                </ol>
              </div>
            </div>
          )}
          {settled && first && <p className="reply">{first}</p>}
          {settled &&
            turn.approvals.map((a) => (
              <PayCard key={a.orderId} a={a} paid={paid.has(a.orderId)} bookingRef={refs.get(a.orderId)} chatId={chatId} config={config} />
            ))}
          {settled &&
            turn.receipts
              .filter((r) => !r.title.toLowerCase().includes("refund"))
              .map((r) => (
                <Receipt key={r.id} r={r} sealed={turn.approvals.some((a) => a.orderId === r.orderId)} openBookings={openBookings} />
              ))}
          {settled &&
            later.map((t, i) => (
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

function PayCard({
  a,
  paid,
  bookingRef,
  chatId,
  config,
}: {
  a: Approval;
  paid: boolean;
  bookingRef?: string;
  chatId: string;
  config: Config | null;
}) {
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
    <Pass
      label="Payment offer"
      title={a.service}
      place={a.businessName}
      when={`${niceDate(a.date)}, ${a.time} ${cityOf(a.timezone)} time`}
      amount={a.amount}
      currency={a.currency}
      state={paid ? "paid" : expired ? "expired" : "offer"}
      status={
        paid ? <span className="badge ok">Paid</span> : expired ? <span className="badge">Hold ended</span> : <HoldClock label={`Held for ${label}`} />
      }
      note={
        paid
          ? config?.paypalFlow === "multiparty"
            ? `Payment confirmed by PayPal. ${a.businessName} receives it after your booking.`
            : `Payment confirmed by PayPal and paid to ${a.businessName}.`
          : expired
            ? "Nothing was charged. Ask me to hold it again."
            : `Paid to ${a.businessName} through PayPal, with PayPal's buyer protection. ${a.policy}`
      }
      enter
    >
      {paid && <Seal title="Paid and booked" detail={bookingRef ? `Ref ${bookingRef} · PayPal confirmed` : "PayPal confirmed"} />}
      {!paid && !expired && (
        <div className="pass-pay">
          {config?.paypal !== "mock" && config?.paypalClientId ? (
            <PayPalScriptProvider
              options={{
                clientId: config.paypalClientId,
                currency: a.currency,
                intent: "capture",
                ...(config.paypalBuyerCountry ? { buyerCountry: config.paypalBuyerCountry } : {}),
              }}
            >
              {/* Vertical: the horizontal layout never shows PayPal's "Debit or Credit Card" button,
                  which is how a customer without a PayPal account pays. */}
              <PayPalButtons
                style={{ layout: "vertical", tagline: false, height: 44, shape: "rect", color: "gold" }}
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
      {msg && <p className="err pass-err">{msg}</p>}
    </Pass>
  );
}

// After the pass has sealed: one quiet line, and the way to the booking.
function Receipt({ r, sealed, openBookings }: { r: { title: string; detail?: string }; sealed: boolean; openBookings: () => void }) {
  const ref = r.title.match(/ref (\w+)/)?.[1];
  return (
    <p className="booked">
      <Icon d="M5 12l4 4L19 6" />
      <span>
        <strong>
          Booked
          {ref && (
            <>
              , ref <b className="num">{ref}</b>
            </>
          )}
        </strong>
        {!sealed && r.detail && <> · {r.detail}</>}{" "}
        <button className="linkish" onClick={openBookings}>
          View booking
        </button>
      </span>
    </p>
  );
}

// ---------- bookings ----------
function BookingsView({ chats, openChat, newChat }: { chats: Chat[]; openChat: (id: string) => void; newChat: () => void }) {
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
      setMsg({ id: b.id, text: e instanceof Error ? e.message : "Could not cancel.", bad: true });
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
            <p>No bookings yet</p>
            <span>Ask your agent for something, approve the payment, and it shows up here.</span>
            <button className="btn-dark" onClick={newChat}>
              <Icon d="M12 5v14M5 12h14" /> New chat
            </button>
          </div>
        )}
        {upcoming.length > 0 && (
          <div className="group">
            <span className="eyebrow">Upcoming</span>
            <span className="num">{upcoming.length}</span>
          </div>
        )}
        {upcoming.length > 0 && (
          <div className="bk-list">
            {upcoming.map((b) => {
              const canCancel = b.cancelUntil !== null && Date.now() < b.cancelUntil;
              return (
                <article key={b.id} className="bk">
                  <div className="bk-what">
                    <strong>{b.serviceName}</strong>
                    <span>
                      {b.businessName}, {b.city}
                    </span>
                  </div>
                  <div className="bk-when">
                    <span className="num">
                      {niceDate(b.date)} at {b.time} {cityOf(b.timezone)} time
                    </span>
                    <span className="bk-ref">
                      <span className="num">Ref {b.ref}</span> · Paid with PayPal{b.paidAs ? ` as ${b.paidAs}` : ""} ·{" "}
                      <button className="linkish" onClick={() => openChat(b.chatId)}>
                        Open chat
                      </button>
                    </span>
                  </div>
                  <span className="badge ok bk-status">Confirmed</span>
                  <span className="bk-amt">${b.amount}</span>
                  <div className="bk-act">
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
                </article>
              );
            })}
          </div>
        )}
        {past.length > 0 && (
          <div className="group">
            <span className="eyebrow">Cancelled</span>
            <span className="num">{past.length}</span>
          </div>
        )}
        {past.length > 0 && (
          <div className="bk-list">
            {past.map((b) => (
              <article key={b.id} className="bk is-past">
                <div className="bk-what">
                  <strong>{b.serviceName}</strong>
                  <span>{b.businessName}</span>
                </div>
                <div className="bk-when">
                  <span className="num">
                    {niceDate(b.date)} at {b.time}
                  </span>
                  <span className="bk-ref">
                    <span className="num">Ref {b.ref}</span>
                  </span>
                </div>
                <span className="badge bk-status">Cancelled</span>
                <span className="bk-amt">${b.amount}</span>
                <div className="bk-act">
                  <span className="bk-note">
                    {b.cancelledBy === "business" ? "Cancelled by the business" : "You cancelled"}
                    {Number(b.refunded) > 0 ? `, $${b.refunded} refunded` : ", no refund"}
                  </span>
                </div>
                {msg?.id === b.id && <p className="bk-msg">{msg.text}</p>}
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- the same checkout from the assistant you already use ----------
function ConnectView({ onTry }: { onTry: () => void }) {
  return (
    <div className="page">
      <div className="page-inner">
        <h2>Use in your assistant</h2>
        <p className="page-sub">
          Add Ordina to the AI assistant you already use, then ask it to book something. You approve each payment in PayPal.
        </p>
        <div className="connect-fit">
          <ConnectPicker compact onTry={onTry} />
        </div>
        <ul className="promises">
          <li>
            <b>find_businesses</b> searches the businesses you can book and pay, with their prices and cancellation policy.
          </li>
          <li>
            <b>message_business</b> talks to the business's Secretary. When it holds a time, you get one PayPal link to approve.
          </li>
          <li>
            <b>booking_status</b> tells the assistant when PayPal has confirmed the payment and the booking exists.
          </li>
        </ul>
        <p className="fine">No tool can pay. The assistant gives you the link, and nothing is charged until you approve in PayPal.</p>
      </div>
    </div>
  );
}

// ---------- spending limit ----------
function LimitView({ limit, setLimit }: { limit: number; setLimit: (n: number) => void }) {
  return (
    <div className="page">
      <div className="page-inner">
        <h2>Spending limit</h2>
        <p className="page-sub">The most your agent may ask you to pay at once. Anything above it is refused before it reaches you.</p>
        <div className="limit-grid">
          <div className="limit">
            <span className="eyebrow">Per payment</span>
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
    </div>
  );
}

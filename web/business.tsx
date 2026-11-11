// The business owner's app (/business): sign up, set up what you sell, go
// live, see bookings and the money PayPal holds and releases, refund or cancel.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Icon, Mark } from "./ui.tsx";

type Kind = "appointment" | "pickup";
type Item = { id?: string; kind: Kind; name: string; minutes: number | string; price: string; dailyLimit: number | string | null };
type Hours = Record<number, [string, string] | null>;
type Biz = {
  id: string;
  handle: string;
  name: string;
  category: string;
  city: string;
  timezone: string;
  about: string;
  notes: string;
  cancelHours: number | null;
  policy: string;
  hours: Hours;
  paypal: { merchantId: string | null; email: string | null; receivable: boolean; emailConfirmed: boolean; checkedAt: number | null };
  status: "setup" | "live" | "paused";
  services: Item[];
  email: string;
  setupErrors: Record<string, string>;
  link: string;
};
type Refund = { id: string; amount: string; by: string; status: string; createdAt: number };
type Booking = {
  id: string;
  ref: string;
  serviceName: string;
  kind: Kind;
  date: string;
  time: string;
  startsAt: number;
  customerName: string;
  payerEmail: string | null;
  payerName: string | null;
  amount: string;
  paypalFee: string;
  platformFee: string;
  netAmount: string;
  refunded: string;
  status: "confirmed" | "cancelled";
  cancelledBy: "customer" | "business" | null;
  releaseStatus: "held" | "releasing" | "released" | "failed" | "none";
  releaseDueAt: number;
  releaseNote: string | null;
  releasedAt: number | null;
  businessGets: string;
  refundable: string;
  refunds: Refund[];
};
type Totals = { sales: string; refunded: string; fees: string; platformFees: string; held: string; released: string };
type Page = "overview" | "bookings" | "setup";
type Flow = "standard" | "multiparty";
// How money moves, from the server: standard = paid to the business at capture;
// multiparty = PayPal holds it, then releases it after the booking.
let FLOW: Flow = "standard";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ORDER = [1, 2, 3, 4, 5, 6, 0];

async function api<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error((json as { error?: string }).error ?? `Request failed (${res.status})`), { status: res.status, body: json });
  return json as T;
}
type ApiErr = Error & { body?: { fields?: Record<string, string>; rows?: Record<number, string> } };

const niceDate = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const when = (t: number) => new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const usd = (s: string | null | undefined) => `$${s ?? "0.00"}`;

// ---------- shell ----------
export function BusinessApp() {
  const [me, setMe] = useState<Biz | null | undefined>(undefined);
  const [cities, setCities] = useState<string[]>([]);
  const [demoPayouts, setDemoPayouts] = useState(false);
  const [selfServe, setSelfServe] = useState(false);
  const [page, setPage] = useState<Page>("overview");
  const [drawer, setDrawer] = useState(false);

  const load = useCallback(() => {
    api<{ business: Biz; cities: string[]; demoPayouts: boolean; selfServe: boolean; flow: Flow }>("/api/biz/me")
      .then((r) => {
        FLOW = r.flow;
        setSelfServe(r.selfServe);
        setMe(r.business);
        setCities(r.cities);
        setDemoPayouts(r.demoPayouts);
      })
      .catch(() => setMe(null));
  }, []);
  useEffect(load, [load]);
  // Coming back from PayPal: /business?paypal=connected | needs_attention | cancelled
  const [paypalNotice] = useState(() => new URLSearchParams(location.search).get("paypal"));
  useEffect(() => {
    if (paypalNotice) history.replaceState(null, "", "/business");
  }, [paypalNotice]);
  useEffect(() => {
    if (me && selfServe && (me.status === "setup" || paypalNotice)) setPage("setup");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id, selfServe]);

  if (me === undefined) return <div className="center-load"><span className="spin" /></div>;
  if (me === null) return <DemoPicker onIn={(b) => { setMe(b); load(); }} />;

  const go = (p: Page) => {
    setPage(p);
    setDrawer(false);
  };
  const setStatus = async (status: "live" | "paused") => {
    try {
      const r = await api<{ business: Biz }>("/api/biz/status", "POST", { status });
      setMe(r.business);
    } catch (e) {
      const body = (e as ApiErr).body;
      if (body?.fields) setPage("setup");
    }
  };
  const ready = Object.keys(me.setupErrors).length === 0;

  return (
    <div className={`app biz ${drawer ? "drawer-open" : ""}`}>
      <aside className="side" aria-label="Navigation">
        <div className="side-top">
          <span className="brand">
            <Mark /> Ordina <em className="for">Agent Checkout</em>
          </span>
        </div>
        <nav className="side-nav">
          <button className={page === "overview" ? "on" : ""} onClick={() => go("overview")}>
            <Icon d="M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-3H4zM14 7h6V4h-6z" /> Overview
          </button>
          <button className={page === "bookings" ? "on" : ""} onClick={() => go("bookings")}>
            <Icon d="M7 3v3M17 3v3M4 9h16M5 6h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z" /> Bookings
          </button>
          {selfServe && (
            <button className={page === "setup" ? "on" : ""} onClick={() => go("setup")}>
              <Icon d="M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4" /> Setup
              {!ready && <span className="dot-warn" aria-label="Setup not finished" />}
            </button>
          )}
        </nav>
        <div className="side-spacer" />
        <div className="side-foot">
          <span className="me biz-me">{me.name.slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>{me.name}</strong>
            <span>{selfServe ? me.email : `${me.city}, simulated business`}</span>
          </div>
          <button
            className="icon-btn show"
            aria-label={selfServe ? "Sign out" : "Switch business"}
            title={selfServe ? "Sign out" : "Switch business"}
            onClick={async () => {
              await api("/api/biz/logout", "POST").catch(() => {});
              setMe(null);
            }}
          >
            <Icon d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" />
          </button>
        </div>
      </aside>
      <button className="scrim" aria-label="Close menu" onClick={() => setDrawer(false)} />

      <main className="main">
        <header className="top">
          <button className="icon-btn menu" aria-label="Open menu" onClick={() => setDrawer(true)}>
            <Icon d="M4 7h16M4 12h16M4 17h16" />
          </button>
          <span className="top-title">{page === "overview" ? "Overview" : page === "bookings" ? "Bookings" : "Setup"}</span>
          <span className={`status-pill s-${me.status}`}>{me.status === "live" ? "Live" : me.status === "paused" ? "Paused" : "Not live yet"}</span>
          {!selfServe ? null : me.status === "live" ? (
            <button className="btn-line" onClick={() => setStatus("paused")}>
              Pause
            </button>
          ) : (
            <button className="btn-dark" disabled={!ready} onClick={() => setStatus("live")} title={ready ? "" : "Finish setup first"}>
              {me.status === "paused" ? "Resume" : "Go live"}
            </button>
          )}
        </header>
        {page === "overview" && <Overview me={me} demoPayouts={demoPayouts} openSetup={() => go("setup")} openBookings={() => go("bookings")} />}
        {page === "bookings" && <Bookings />}
        {page === "setup" && selfServe && <Setup me={me} cities={cities} onSaved={setMe} paypalNotice={paypalNotice} />}
      </main>
    </div>
  );
}

// ---------- the simulated businesses (default: no sign-up in this build) ----------
type Demo = { id: string; name: string; category: string; city: string; link: string };

function DemoPicker({ onIn }: { onIn: (b: Biz) => void }) {
  const [state, setState] = useState<{ signup: boolean; businesses: Demo[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    api<{ signup: boolean; businesses: Demo[] }>("/api/biz/demos")
      .then(setState)
      .catch(() => setState({ signup: false, businesses: [] }));
  }, []);
  if (!state) return <div className="center-load"><span className="spin" /></div>;
  if (state.signup) return <AuthScreen onIn={onIn} />;

  const open = async (id: string) => {
    setBusy(id);
    setMsg(null);
    try {
      onIn((await api<{ business: Biz }>("/api/biz/demo", "POST", { businessId: id })).business);
    } catch (e) {
      setMsg((e as Error).message);
      setBusy(null);
    }
  };

  return (
    <div className="auth">
      <div className="auth-card">
        <span className="brand">
          <Mark /> Ordina <em className="for">Agent Checkout</em>
        </span>
        <h1>See it from the business side</h1>
        <p className="auth-sub">
          These are simulated businesses that take PayPal Sandbox payments. Open one to see what customers' agents booked, what PayPal paid,
          and to refund or cancel.
        </p>
        <div className="demo-list">
          {state.businesses.map((d) => (
            <button key={d.id} className="demo-biz" disabled={!!busy} onClick={() => open(d.id)}>
              <span className="me biz-me">{d.name.slice(0, 1)}</span>
              <span className="demo-biz-text">
                <strong>{d.name}</strong>
                <span>
                  {d.category}, {d.city}
                </span>
              </span>
              <Icon d="M9 6l6 6-6 6" />
            </button>
          ))}
          {state.businesses.length === 0 && <p className="muted-s">No simulated businesses are running.</p>}
        </div>
        {msg && <p className="err">{msg}</p>}
        <p className="auth-switch">
          <a className="linkish" href="/">
            Book as a customer
          </a>
        </p>
      </div>
    </div>
  );
}

// ---------- sign up / sign in (BUSINESS_SIGNUP=1) ----------
function AuthScreen({ onIn }: { onIn: (b: Biz) => void }) {
  const [mode, setMode] = useState<"signup" | "login">("signup");
  const [cities, setCities] = useState<string[]>([]);
  const [f, setF] = useState({ name: "", category: "", city: "", email: "", password: "" });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // The city list is public; read it from a harmless endpoint.
    fetch("/api/biz/cities").then((r) => r.json()).then((j) => setCities(j.cities ?? [])).catch(() => {});
  }, []);

  const missing =
    mode === "signup"
      ? !f.name.trim() || !f.category.trim() || !f.city || !f.email.trim() || f.password.length < 8
      : !f.email.trim() || !f.password;

  const submit = async () => {
    setBusy(true);
    setErrs({});
    setMsg(null);
    try {
      const r = await api<{ business: Biz }>(`/api/biz/${mode}`, "POST", f);
      onIn(r.business);
    } catch (e) {
      const body = (e as ApiErr).body;
      if (body?.fields) setErrs(body.fields);
      else setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const field = (k: keyof typeof f) => ({
    value: f[k],
    onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value }),
  });

  return (
    <div className="auth">
      <div className="auth-card">
        <span className="brand">
          <Mark /> Ordina <em className="for">Agent Checkout</em>
        </span>
        <h1>{mode === "signup" ? "Let AI agents book and pay you" : "Welcome back"}</h1>
        <p className="auth-sub">
          {mode === "signup"
            ? "Your own AI Secretary answers customers' agents, takes bookings and orders, and gets you paid through PayPal."
            : "Sign in to see your bookings and the money PayPal holds for you."}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!missing) submit();
          }}
        >
          {mode === "signup" && (
            <>
              <Field label="Business name" error={errs.name}>
                <input {...field("name")} autoComplete="organization" placeholder="Lumen Hair Studio" />
              </Field>
              <Field label="What kind of business" error={errs.category}>
                <input {...field("category")} placeholder="Hair salon, bakery, physio clinic" />
              </Field>
              <Field label="City" error={errs.city} hint="Sets your time zone.">
                <select {...field("city")}>
                  <option value="">Choose your city</option>
                  {cities.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </Field>
            </>
          )}
          <Field label="Email" error={errs.email}>
            <input {...field("email")} type="email" autoComplete="email" />
          </Field>
          <Field label="Password" error={errs.password} hint={mode === "signup" ? "At least 8 characters." : undefined}>
            <input {...field("password")} type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} />
          </Field>
          {msg && <p className="err">{msg}</p>}
          <button className="btn-dark wide" disabled={missing || busy}>
            {busy ? "One moment" : mode === "signup" ? "Create my business" : "Sign in"}
          </button>
        </form>
        <p className="auth-switch">
          {mode === "signup" ? "Already have an account? " : "New to Ordina? "}
          <button
            className="linkish"
            onClick={() => {
              setMode(mode === "signup" ? "login" : "signup");
              setErrs({});
              setMsg(null);
            }}
          >
            {mode === "signup" ? "Sign in" : "Create a business"}
          </button>
        </p>
        <p className="auth-switch">
          <a className="linkish" href="/">
            I'm a customer
          </a>
        </p>
      </div>
    </div>
  );
}

function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <label className={`field ${error ? "has-err" : ""}`}>
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-err">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

// ---------- overview ----------
function useBookings() {
  const [data, setData] = useState<{ bookings: Booking[]; totals: Totals } | null>(null);
  const load = useCallback(() => {
    api<{ bookings: Booking[]; totals: Totals }>("/api/biz/bookings").then(setData).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);
  return { data, load };
}

function Overview({ me, demoPayouts, openSetup, openBookings }: { me: Biz; demoPayouts: boolean; openSetup: () => void; openBookings: () => void }) {
  const { data, load } = useBookings();
  const [copied, setCopied] = useState(false);
  const [running, setRunning] = useState(false);
  const link = `${location.origin}${me.link}`;
  const upcoming = (data?.bookings ?? []).filter((b) => b.status === "confirmed" && b.startsAt > Date.now() - 3_600_000).slice(-5).reverse();
  const ready = Object.keys(me.setupErrors).length === 0;

  return (
    <div className="page">
      <div className="page-inner wide">
        {!ready && (
          <button className="banner" onClick={openSetup}>
            <strong>Finish setup to go live.</strong> {Object.keys(me.setupErrors).length} thing
            {Object.keys(me.setupErrors).length === 1 ? "" : "s"} left. Customers' agents can't find you until then.
            <Icon d="M9 6l6 6-6 6" />
          </button>
        )}
        <h2>{me.name}</h2>
        <p className="page-sub">
          {me.status === "live"
            ? "Your Secretary is taking bookings from customers' AI agents."
            : me.status === "paused"
              ? "Paused. Customers' agents can't find or book you."
              : "Not live yet."}
        </p>

        {FLOW === "standard" ? (
          <div className="stats">
            <Stat label="Sales" value={usd(data?.totals.sales)} />
            <Stat label="Paid to your PayPal" value={usd(data?.totals.released)} hint="After PayPal's fees and refunds" />
            <Stat label="PayPal fees" value={usd(data?.totals.fees)} />
            <Stat label="Refunded" value={usd(data?.totals.refunded)} />
          </div>
        ) : (
          <div className="stats">
            <Stat label="Sales" value={usd(data?.totals.sales)} />
            <Stat label="Held by PayPal for you" value={usd(data?.totals.held)} hint="Released 24 hours after each booking" />
            <Stat label="Released to your PayPal" value={usd(data?.totals.released)} hint={me.paypal.email ?? "Connect PayPal"} />
            <Stat label="Refunded" value={usd(data?.totals.refunded)} />
          </div>
        )}
        <p className="fine">
          {FLOW === "standard"
            ? "Customers pay straight into your PayPal account the moment they approve. You can refund any amount for 180 days, from your PayPal balance. "
            : `Customers pay straight into your PayPal account; PayPal holds each payment until 24 hours after the booking, then releases it to you. PayPal fees so far ${usd(data?.totals.fees)}. `}
          {Number(data?.totals.platformFees) > 0 ? `Ordina fees ${usd(data?.totals.platformFees)}.` : "Ordina takes no cut of your sales."}
        </p>

        <div className="two">
          <section className="card">
            <div className="card-head">
              <h3>Coming up</h3>
              <button className="linkish" onClick={openBookings}>
                All bookings
              </button>
            </div>
            {upcoming.length === 0 && <p className="muted-s">Nothing coming up yet. Bookings appear the moment PayPal confirms the payment.</p>}
            {upcoming.map((b) => (
              <div key={b.id} className="mini">
                <div>
                  <strong>{b.serviceName}</strong>
                  <span>
                    {b.customerName} · {niceDate(b.date)}, {b.time}
                  </span>
                </div>
                <span className="mini-amt">{usd(b.amount)}</span>
              </div>
            ))}
          </section>

          <section className="card">
            <div className="card-head">
              <h3>Your link</h3>
            </div>
            <p className="muted-s">Share it on Instagram, WhatsApp or your website. It opens a customer's agent already talking to your Secretary.</p>
            <div className="linkbox">
              <code>{link}</code>
              <button
                className="btn-line"
                disabled={me.status !== "live"}
                onClick={() => {
                  navigator.clipboard.writeText(link).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            {me.status !== "live" && <p className="fine">Works once you're live.</p>}
            {me.status === "live" && (
              <a className="linkish" href={me.link} target="_blank" rel="noreferrer">
                Try it as a customer
              </a>
            )}
          </section>
        </div>

        {demoPayouts && FLOW === "multiparty" && (
          <section className="card demo">
            <div className="card-head">
              <h3>Release held money, test mode</h3>
            </div>
            <p className="muted-s">
              PayPal normally releases each payment to you 24 hours after the booking. In test mode you can release everything held now.
            </p>
            <button
              className="btn-line"
              disabled={running || !Number(data?.totals.held)}
              onClick={async () => {
                setRunning(true);
                await api("/api/biz/releases/run", "POST").catch(() => {});
                setRunning(false);
                load();
              }}
            >
              {running ? "Asking PayPal" : "Release now"}
            </button>
          </section>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <strong>{value}</strong>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  );
}

// ---------- bookings ----------
const RELEASE_TEXT: Record<Booking["releaseStatus"], string> = {
  held: "Held by PayPal",
  releasing: "PayPal is releasing it",
  released: "Released to your PayPal",
  failed: "PayPal could not release it",
  none: "Nothing to release",
};

function Bookings() {
  const { data, load } = useBookings();
  const [tab, setTab] = useState<"upcoming" | "past" | "cancelled">("upcoming");
  const now = Date.now();
  const list = useMemo(() => {
    const all = data?.bookings ?? [];
    if (tab === "cancelled") return all.filter((b) => b.status === "cancelled");
    if (tab === "upcoming") return all.filter((b) => b.status === "confirmed" && b.startsAt >= now).reverse();
    return all.filter((b) => b.status === "confirmed" && b.startsAt < now);
  }, [data, tab, now]);

  return (
    <div className="page">
      <div className="page-inner wide">
        <h2>Bookings</h2>
        <p className="page-sub">Everything customers' agents booked and paid for. You can refund any amount for 180 days after payment.</p>
        <div className="tabs">
          {(["upcoming", "past", "cancelled"] as const).map((t) => (
            <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
              {t === "upcoming" ? "Upcoming" : t === "past" ? "Past" : "Cancelled"}
            </button>
          ))}
        </div>
        {data && list.length === 0 && <div className="blank"><p>Nothing here.</p></div>}
        {list.map((b) => (
          <BookingRow key={b.id} b={b} onChange={load} />
        ))}
      </div>
    </div>
  );
}

function BookingRow({ b, onChange }: { b: Booking; onChange: () => void }) {
  const [mode, setMode] = useState<null | "refund" | "cancel">(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const canMoney = Number(b.refundable) > 0;

  const open = (m: "refund" | "cancel") => {
    setMode(m);
    setAmount(m === "cancel" ? b.refundable : "");
    setMsg(null);
  };
  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      if (mode === "cancel") await api(`/api/biz/bookings/${b.id}/cancel`, "POST", { refund: amount || "0" });
      else await api(`/api/biz/bookings/${b.id}/refund`, "POST", { amount });
      setMsg({ text: mode === "cancel" ? "Cancelled. The customer can see it in their Bookings." : `Refunded $${amount} through PayPal.` });
      setMode(null);
      onChange();
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  };
  const amountMissing = mode === "refund" ? !amount.trim() || Number(amount) <= 0 : amount.trim() === "";
  const amountTooBig = Number(amount) > Number(b.refundable);

  return (
    <div className={`brow ${b.status === "cancelled" ? "is-past" : ""}`}>
      <div className="brow-main">
        <div className="brow-top">
          <strong>{b.serviceName}</strong>
          <span className={`kind k-${b.kind}`}>{b.kind === "pickup" ? "Pickup" : "Appointment"}</span>
        </div>
        <span>
          {niceDate(b.date)} at {b.time} · {b.customerName}
          {b.payerEmail ? ` · ${b.payerEmail}` : ""}
        </span>
        <span className="brow-fine">
          Ref {b.ref} · Paid {usd(b.amount)} · PayPal fee {usd(b.paypalFee)}
          {Number(b.platformFee) > 0 ? ` · Ordina fee ${usd(b.platformFee)}` : ""}
          {Number(b.refunded) > 0 ? ` · Refunded ${usd(b.refunded)}` : ""}
          {b.status === "cancelled" ? ` · Cancelled by ${b.cancelledBy === "business" ? "you" : "the customer"}` : ""}
        </span>
      </div>
      <div className="brow-side">
        <span className="brow-amt">{usd(b.businessGets)}</span>
        <span className={`payout p-${b.releaseStatus}`}>
          {b.releaseStatus === "held"
            ? `Held by PayPal, released ${when(b.releaseDueAt)}`
            : FLOW === "standard" && b.releaseStatus === "released"
              ? "Paid to your PayPal"
              : RELEASE_TEXT[b.releaseStatus]}
        </span>
        {b.releaseNote && <span className="brow-note">{b.releaseNote}</span>}
        {!mode && canMoney && (
          <div className="brow-actions">
            <button className="btn-line sm" onClick={() => open("refund")}>
              Refund
            </button>
            {b.status === "confirmed" && (
              <button className="btn-line sm" onClick={() => open("cancel")}>
                Cancel
              </button>
            )}
          </div>
        )}
        {!mode && !canMoney && Number(b.refunded) < Number(b.amount) && b.releaseStatus !== "releasing" && (
          <span className="brow-note">PayPal refunds close 180 days after payment. Settle anything later directly with the customer.</span>
        )}
      </div>
      {mode && (
        <div className="brow-form">
          <label className={`field inline ${amountTooBig ? "has-err" : ""}`}>
            <span className="field-label">{mode === "cancel" ? "Refund to the customer" : "Amount to refund"}</span>
            <div className="money-in">
              <span>$</span>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" autoFocus placeholder="0.00" />
            </div>
            <span className={amountTooBig ? "field-err" : "field-hint"}>
              {amountTooBig
                ? `At most $${b.refundable}.`
                : mode === "cancel"
                  ? `Up to $${b.refundable}. Enter 0 to keep it all, for example for a no-show.`
                  : FLOW === "standard"
                    ? `Up to $${b.refundable}. It comes out of your PayPal balance.`
                    : b.releaseStatus === "released"
                    ? `Up to $${b.refundable}. PayPal has released this payment, so the refund comes out of your PayPal balance.`
                    : `Up to $${b.refundable}. Comes out of the money PayPal holds for you.`}
            </span>
          </label>
          <div className="brow-form-actions">
            <button className="btn-ghost" onClick={() => setMode(null)}>
              Back
            </button>
            <button className={mode === "cancel" ? "btn-danger" : "btn-dark"} disabled={busy || amountMissing || amountTooBig} onClick={submit}>
              {busy ? "Working" : mode === "cancel" ? "Cancel booking" : "Refund"}
            </button>
          </div>
        </div>
      )}
      {msg && <p className={`brow-msg ${msg.bad ? "bad" : ""}`}>{msg.text}</p>}
    </div>
  );
}

// ---------- setup ----------
function Setup({ me, cities, onSaved, paypalNotice }: { me: Biz; cities: string[]; onSaved: (b: Biz) => void; paypalNotice: string | null }) {
  const errs = me.setupErrors;
  const checks = [
    { key: "items", label: "What you sell" },
    { key: "hours", label: "Opening hours" },
    { key: "cancelHours", label: "Cancellations" },
    { key: "paypal", label: "PayPal connected" },
  ];
  return (
    <div className="page">
      <div className="page-inner">
        <h2>Setup</h2>
        <p className="page-sub">Your Secretary learns everything here. Prices always come from this list, never from the AI.</p>
        <div className="checklist">
          {checks.map((c) => (
            <a key={c.key} href={`#${c.key}`} className={errs[c.key] ? "" : "done"}>
              <span className="tick" aria-hidden>
                {!errs[c.key] && <Icon d="M5 12l4 4L19 6" />}
              </span>
              {c.label}
            </a>
          ))}
        </div>
        <ProfileSection me={me} cities={cities} onSaved={onSaved} />
        <ItemsSection me={me} onSaved={onSaved} />
        <HoursSection me={me} onSaved={onSaved} />
        <CancelSection me={me} onSaved={onSaved} />
        <PaySection me={me} onSaved={onSaved} notice={paypalNotice} />
        <NotesSection me={me} onSaved={onSaved} />
      </div>
    </div>
  );
}

function useSave(onSaved: (b: Biz) => void) {
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<Record<number, string>>({});
  const [done, setDone] = useState(false);
  const save = async (url: string, body: unknown) => {
    setBusy(true);
    setFields({});
    setRows({});
    setDone(false);
    try {
      const r = await api<{ business: Biz }>(url, "PUT", body);
      onSaved(r.business);
      setDone(true);
      setTimeout(() => setDone(false), 1800);
    } catch (e) {
      const b = (e as ApiErr).body;
      if (b?.fields) setFields(b.fields);
      if (b?.rows) setRows(b.rows);
    } finally {
      setBusy(false);
    }
  };
  return { busy, fields, rows, done, save };
}

function Section({ id, title, sub, need, children }: { id: string; title: string; sub?: string; need?: string; children: ReactNode }) {
  return (
    <section className="set" id={id}>
      <div className="set-head">
        <h3>{title}</h3>
        {sub && <p>{sub}</p>}
        {need && <p className="set-need">{need}</p>}
      </div>
      {children}
    </section>
  );
}

function SaveBar({ disabled, busy, done, label = "Save" }: { disabled: boolean; busy: boolean; done: boolean; label?: string }) {
  return (
    <div className="savebar">
      {done && <span className="saved">Saved</span>}
      <button className="btn-dark" disabled={disabled || busy}>
        {busy ? "Saving" : label}
      </button>
    </div>
  );
}

function ProfileSection({ me, cities, onSaved }: { me: Biz; cities: string[]; onSaved: (b: Biz) => void }) {
  const [f, setF] = useState({ name: me.name, category: me.category, city: me.city, about: me.about });
  const s = useSave(onSaved);
  const changed = f.name !== me.name || f.category !== me.category || f.city !== me.city || f.about !== me.about;
  const local: Record<string, string> = {};
  if (f.name.trim().length < 2) local.name = "Enter your business name.";
  if (!f.category.trim()) local.category = "Say what kind of business it is.";
  return (
    <Section id="profile" title="Your business" sub="How customers' agents see you.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          s.save("/api/biz/profile", f);
        }}
      >
        <div className="grid2">
          <Field label="Business name" error={local.name ?? s.fields.name}>
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label="What kind of business" error={local.category ?? s.fields.category}>
            <input value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />
          </Field>
        </div>
        <Field label="City" error={s.fields.city} hint="Sets your time zone.">
          <select value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })}>
            {cities.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="About (optional)" hint="One or two sentences, for example where you are and what you're known for.">
          <textarea rows={2} value={f.about} maxLength={500} onChange={(e) => setF({ ...f, about: e.target.value })} />
        </Field>
        <SaveBar disabled={!changed || Object.keys(local).length > 0} busy={s.busy} done={s.done} />
      </form>
    </Section>
  );
}

function ItemsSection({ me, onSaved }: { me: Biz; onSaved: (b: Biz) => void }) {
  const fresh = (): Item => ({ kind: "appointment", name: "", minutes: 60, price: "", dailyLimit: "" });
  const [items, setItems] = useState<Item[]>(() =>
    me.services.length ? me.services.map((s) => ({ ...s, dailyLimit: s.dailyLimit ?? "" })) : [fresh()],
  );
  const s = useSave(onSaved);
  const set = (i: number, patch: Partial<Item>) => setItems(items.map((it, n) => (n === i ? { ...it, ...patch } : it)));
  const rowErr = (it: Item): string | undefined => {
    if (!it.name.trim()) return "Give it a name.";
    if (!/^\d{1,5}(\.\d{1,2})?$/.test(String(it.price).trim()) || Number(it.price) <= 0) return "Enter a price above zero.";
    if (it.kind === "appointment" && (!Number.isInteger(Number(it.minutes)) || Number(it.minutes) < 10 || Number(it.minutes) > 600))
      return "Length must be 10 to 600 minutes.";
    return undefined;
  };
  const anyErr = items.some((it) => rowErr(it));

  return (
    <Section
      id="items"
      title="What you sell"
      sub="Appointments take up time in your calendar. Pickup items are ordered ahead and collected at a time, up to a daily limit."
      need={me.setupErrors.items}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          s.save("/api/biz/items", { items });
        }}
      >
        {items.map((it, i) => (
          <div className="item-row" key={it.id ?? `new-${i}`}>
            <div className="seg-mini" role="radiogroup" aria-label="Kind">
              {(["appointment", "pickup"] as const).map((k) => (
                <button type="button" key={k} className={it.kind === k ? "on" : ""} onClick={() => set(i, { kind: k })} aria-pressed={it.kind === k}>
                  {k === "appointment" ? "Appointment" : "Pickup item"}
                </button>
              ))}
            </div>
            <div className="item-fields">
              <label className="field">
                <span className="field-label">Name</span>
                <input value={it.name} onChange={(e) => set(i, { name: e.target.value })} placeholder={it.kind === "pickup" ? "Celebration cake" : "Haircut"} />
              </label>
              <label className="field">
                <span className="field-label">Price (USD)</span>
                <div className="money-in">
                  <span>$</span>
                  <input value={it.price} onChange={(e) => set(i, { price: e.target.value })} inputMode="decimal" placeholder="25.00" />
                </div>
              </label>
              {it.kind === "appointment" ? (
                <label className="field">
                  <span className="field-label">Length (minutes)</span>
                  <input value={it.minutes} onChange={(e) => set(i, { minutes: e.target.value })} inputMode="numeric" />
                </label>
              ) : (
                <label className="field">
                  <span className="field-label">Daily limit (optional)</span>
                  <input value={it.dailyLimit ?? ""} onChange={(e) => set(i, { dailyLimit: e.target.value })} inputMode="numeric" placeholder="No limit" />
                </label>
              )}
              <button type="button" className="icon-btn show rm" aria-label="Remove" onClick={() => setItems(items.filter((_, n) => n !== i))}>
                <Icon d="M6 6l12 12M18 6L6 18" />
              </button>
            </div>
            {(s.rows[i] ?? (it.name || it.price ? rowErr(it) : undefined)) && <span className="field-err">{s.rows[i] ?? rowErr(it)}</span>}
          </div>
        ))}
        <button type="button" className="btn-line add" onClick={() => setItems([...items, fresh()])}>
          <Icon d="M12 5v14M5 12h14" /> Add another
        </button>
        <SaveBar disabled={items.length === 0 || anyErr} busy={s.busy} done={s.done} />
      </form>
    </Section>
  );
}

function HoursSection({ me, onSaved }: { me: Biz; onSaved: (b: Biz) => void }) {
  const [h, setH] = useState<Hours>(() => {
    const out: Hours = {};
    for (let d = 0; d < 7; d++) out[d] = me.hours[d] ?? null;
    return out;
  });
  const s = useSave(onSaved);
  const bad = Object.values(h).some((v) => v && !(v[0] < v[1]));
  const none = !Object.values(h).some(Boolean);
  return (
    <Section id="hours" title="Opening hours" sub={`In ${me.city} time.`} need={me.setupErrors.hours}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          s.save("/api/biz/profile", { hours: h });
        }}
      >
        <div className="hours">
          {ORDER.map((d) => {
            const v = h[d];
            return (
              <div className="hour-row" key={d}>
                <label className="switch">
                  <input type="checkbox" checked={!!v} onChange={(e) => setH({ ...h, [d]: e.target.checked ? ["09:00", "17:00"] : null })} />
                  <span>{DAYS[d]}</span>
                </label>
                {v ? (
                  <div className="hour-times">
                    <input type="time" value={v[0]} onChange={(e) => setH({ ...h, [d]: [e.target.value, v[1]] })} aria-label={`${DAYS[d]} opens`} />
                    <span>to</span>
                    <input type="time" value={v[1]} onChange={(e) => setH({ ...h, [d]: [v[0], e.target.value] })} aria-label={`${DAYS[d]} closes`} />
                    {!(v[0] < v[1]) && <span className="field-err">Closing must be after opening.</span>}
                  </div>
                ) : (
                  <span className="closed">Closed</span>
                )}
              </div>
            );
          })}
        </div>
        {(none || s.fields.hours) && <span className="field-err">{s.fields.hours ?? "Open at least one day a week."}</span>}
        <SaveBar disabled={bad || none} busy={s.busy} done={s.done} />
      </form>
    </Section>
  );
}

function CancelSection({ me, onSaved }: { me: Biz; onSaved: (b: Biz) => void }) {
  const [v, setV] = useState(me.cancelHours === null ? "" : String(me.cancelHours));
  const s = useSave(onSaved);
  const n = Number(v);
  const err = v.trim() === "" ? undefined : !Number.isInteger(n) || n < 0 || n > 168 ? "Enter whole hours from 0 to 168." : undefined;
  return (
    <Section
      id="cancelHours"
      title="Cancellations"
      sub="Customers can cancel for a full refund up to this many hours before. After that, it's your call: you can still refund any amount, for up to 180 days after payment."
      need={me.setupErrors.cancelHours}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          s.save("/api/biz/profile", { cancelHours: n });
        }}
      >
        <Field label="Free cancellation until (hours before)" error={err ?? s.fields.cancelHours}>
          <input value={v} onChange={(e) => setV(e.target.value)} inputMode="numeric" placeholder="24" className="short" />
        </Field>
        <SaveBar disabled={v.trim() === "" || !!err || String(me.cancelHours) === v} busy={s.busy} done={s.done} />
      </form>
    </Section>
  );
}

function PaySection({ me, onSaved, notice }: { me: Biz; onSaved: (b: Biz) => void; notice: string | null }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const p = me.paypal;
  const connected = !!p.merchantId && p.receivable && p.emailConfirmed;

  const connect = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ actionUrl: string }>("/api/biz/paypal/connect", "POST");
      location.href = r.actionUrl;
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  const checkAgain = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/biz/paypal/refresh", "POST");
      const r = await api<{ business: Biz }>("/api/biz/me");
      onSaved(r.business);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      id="paypal"
      title="Getting paid"
      sub="Customers pay straight into your own PayPal account. PayPal holds each payment until 24 hours after the booking or pickup, then releases it to you, so a refund is always possible before then. You pay PayPal's usual fee; Ordina takes no cut."
      need={me.setupErrors.paypal}
    >
      {notice === "cancelled" && !connected && <p className="pp-note">You left PayPal before connecting. Nothing changed.</p>}
      {connected ? (
        <div className="pp-row ok">
          <span className="pp-mark" aria-hidden>
            <b>P</b>
          </span>
          <div>
            <strong>Connected{notice === "connected" ? " just now" : ""}</strong>
            <span>{p.email}</span>
          </div>
          <button className="btn-line sm" onClick={checkAgain} disabled={busy}>
            {busy ? "Checking" : "Check with PayPal"}
          </button>
        </div>
      ) : p.merchantId ? (
        <div className="pp-row warn">
          <span className="pp-mark" aria-hidden>
            <b>P</b>
          </span>
          <div>
            <strong>Connected, but PayPal can't pay you yet</strong>
            <span>{me.setupErrors.paypal}</span>
          </div>
          <button className="btn-dark sm" onClick={checkAgain} disabled={busy}>
            {busy ? "Checking" : "Check again"}
          </button>
        </div>
      ) : (
        <div className="pp-row">
          <span className="pp-mark" aria-hidden>
            <b>P</b>
          </span>
          <div>
            <strong>Not connected</strong>
            <span>You'll sign in to PayPal (or create a free business account) and allow Ordina to take payments for you.</span>
          </div>
          <button className="pp-connect" onClick={connect} disabled={busy}>
            {busy ? "Opening PayPal" : "Connect PayPal"}
          </button>
        </div>
      )}
      {err && <p className="field-err">{err}</p>}
    </Section>
  );
}

function NotesSection({ me, onSaved }: { me: Biz; onSaved: (b: Biz) => void }) {
  const [v, setV] = useState(me.notes);
  const s = useSave(onSaved);
  return (
    <Section id="notes" title="Notes for your Secretary (optional)" sub="Anything it should tell customers or keep in mind.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          s.save("/api/biz/profile", { notes: v });
        }}
      >
        <textarea rows={3} value={v} maxLength={2000} onChange={(e) => setV(e.target.value)} placeholder="Parking is at the back. We don't do children's cuts." />
        <SaveBar disabled={v === me.notes} busy={s.busy} done={s.done} />
      </form>
    </Section>
  );
}

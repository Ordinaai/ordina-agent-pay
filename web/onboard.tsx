// A business's first visit: welcome, sign up, then one guided step at a time
// (what you sell, opening hours, cancellations, getting paid, go live).
// "What you sell" can be read from the business's own link: the server reads
// the page, the owner answers a few questions and checks every line before
// anything is saved.
import { useEffect, useRef, useState } from "react";
import { api, DAYS, Field, FLOW, ORDER, PaySection, type ApiErr, type Biz, type Hours, type Item } from "./business.tsx";
import { Icon, Mark, Pass, Seal } from "./ui.tsx";
import "./onboard.css";

type Demo = { id: string; name: string; category: string; city: string; link: string };
type ImportQ = { id: string; text: string; field: "price" | "minutes" | "cancelHours" | "note"; item?: number; hint?: string };
type ImportItem = { kind: Item["kind"]; name: string; price: string; minutes: number | ""; dailyLimit: null; original: string | null };
type ImportResult = {
  source: { url: string; title: string };
  business: { name: string | null; category: string | null; city: string | null; about: string | null };
  items: ImportItem[];
  hours: Hours | null;
  cancelHours: number | null;
  questions: ImportQ[];
};
type Draft = Item & { original?: string | null; fromLink?: boolean };

const PRICE = /^\d{1,5}(\.\d{1,2})?$/;
const rowError = (it: Draft): string | undefined => {
  if (!it.name.trim()) return "Give it a name.";
  if (!PRICE.test(String(it.price).trim()) || Number(it.price) <= 0) return "Enter a price above zero, in US dollars.";
  if (it.kind === "appointment") {
    const m = Number(it.minutes);
    if (String(it.minutes).trim() === "" || !Number.isInteger(m) || m < 10 || m > 600) return "Enter how long it takes, 10 to 600 minutes.";
  }
  if (it.kind === "pickup" && it.dailyLimit !== null && String(it.dailyLimit).trim() !== "") {
    const n = Number(it.dailyLimit);
    if (!Number.isInteger(n) || n < 1 || n > 1000) return "Daily limit must be 1 to 1000, or empty for no limit.";
  }
  return undefined;
};
// Which input a row's message belongs to, so the red edge lands on that field.
const rowErrorField = (msg: string | undefined): "name" | "price" | "extra" | undefined =>
  !msg ? undefined : msg.startsWith("Give it") ? "name" : msg.startsWith("Enter a price") ? "price" : "extra";
const blankItem = (): Draft => ({ kind: "appointment", name: "", minutes: 60, price: "", dailyLimit: "" });
const host = (u: string) => {
  try {
    return new URL(u).host.replace(/^www\./, "");
  } catch {
    return u;
  }
};
// Stagger for `.rise`: the row's place in the sequence.
const seq = (i: number) => ({ "--i": i }) as React.CSSProperties;

const IC = {
  link: "M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1",
  shield: "M12 3l7 4v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V7z",
  clock: "M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  check: "M5 12l4 4L19 6",
  next: "M9 6l6 6-6 6",
  back: "M15 6l-6 6 6 6",
  pen: "M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zM13.5 6.5l4 4",
  list: "M8 7h8M8 12h8M8 17h5M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z",
  plus: "M12 5v14M5 12h14",
  close: "M6 6l12 12M18 6L6 18",
  assistant: "M12 3a9 9 0 1 0 9 9M12 3v9l6-6",
};

// ---------- welcome, sign up, sign in ----------
export function Welcome({ onIn, demos }: { onIn: (b: Biz) => void; demos: Demo[] }) {
  const [mode, setMode] = useState<"home" | "signup" | "login" | "demo">("home");
  const [cities, setCities] = useState<string[]>([]);
  const [f, setF] = useState({ name: "", city: "", email: "", password: "" });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/biz/cities")
      .then((r) => r.json())
      .then((j) => setCities(j.cities ?? []))
      .catch(() => {});
  }, []);

  const go = (m: typeof mode) => {
    setMode(m);
    setErrs({});
    setMsg(null);
  };
  const missing = mode === "signup" ? !f.name.trim() || !f.city || !f.email.trim() || f.password.length < 8 : !f.email.trim() || !f.password;
  const submit = async () => {
    setBusy("form");
    setErrs({});
    setMsg(null);
    try {
      const r = await api<{ business: Biz }>(`/api/biz/${mode}`, "POST", mode === "signup" ? f : { email: f.email, password: f.password });
      onIn(r.business);
    } catch (e) {
      const body = (e as ApiErr).body;
      if (body?.fields) {
        setErrs(body.fields);
        // A message for a field this form does not show still needs saying.
        const shown = mode === "signup" ? ["name", "city", "email", "password"] : ["email", "password"];
        const other = Object.entries(body.fields).find(([k]) => !shown.includes(k));
        if (other) setMsg(other[1]);
      } else setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const openDemo = async (id: string) => {
    setBusy(id);
    setMsg(null);
    try {
      onIn((await api<{ business: Biz }>("/api/biz/demo", "POST", { businessId: id })).business);
    } catch (e) {
      setMsg((e as Error).message);
      setBusy(null);
    }
  };
  const field = (k: keyof typeof f) => ({
    value: f[k],
    onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value }),
  });

  // The three points and the proof sit in the night panel on a wide screen, and under the form on a phone.
  const points = (
    <ul className="wl-points">
      <li>
        <span className="wl-ic">
          <Icon d={IC.link} />
        </span>
        <span>
          <strong>Paste a link to your website or booking page.</strong> We read it and fill in what you sell. You check every price.
        </span>
      </li>
      <li>
        <span className="wl-ic">
          <Icon d={IC.shield} />
        </span>
        <span>
          <strong>Every booking is paid first.</strong> No unpaid no-shows, no double bookings, no agent can change your prices.
        </span>
      </li>
      <li>
        <span className="wl-ic">
          <Icon d={IC.clock} />
        </span>
        <span>
          <strong>About five minutes to set up.</strong> Ordina takes no cut of your sales; you pay PayPal's usual fee.
        </span>
      </li>
    </ul>
  );
  const proof = (
    <div className="wl-proof">
      <span className="eyebrow">A booking, as it arrives</span>
      <div className="wl-pass" style={{ "--pass-notch": "var(--night)" } as React.CSSProperties}>
        <Pass label="Booked by a customer's assistant" title="Silk press" place="Your business" when="Fri 13 Nov, 09:00" amount="35.00" state="paid" enter>
          <Seal title="Paid before it was booked" detail="PayPal confirmed · no unpaid no-shows" />
        </Pass>
      </div>
    </div>
  );
  const back = (
    <button type="button" className="btn-ghost wl-back" onClick={() => go("home")}>
      <Icon d={IC.back} /> Back
    </button>
  );

  return (
    <div className={`wl is-${mode}`}>
      <aside className="wl-night on-night">
        <span className="brand">
          <Mark light /> Ordina <em className="for">Agent Checkout</em>
        </span>
        <div className="wl-pitch">
          <span className="eyebrow">For businesses</span>
          <h1>Let AI assistants book and pay your business</h1>
          <p className="wl-lede">
            Your customers already ask ChatGPT, Claude and other assistants to find things. With Ordina, those assistants can book you too. Your own AI
            Secretary answers from your real prices and calendar, and the customer pays you through PayPal before the booking exists.
          </p>
          <p className="wl-line">Your own AI Secretary answers from your real prices and calendar. The customer pays you through PayPal before the booking exists.</p>
        </div>
        {/* stacked on a tall screen, side by side on a short one */}
        <div className="wl-lower">
          {points}
          {proof}
        </div>
      </aside>

      <main className="wl-form">
        <div className="wl-form-in" key={mode}>
          {mode === "home" && (
            <>
              <span className="eyebrow">Get started</span>
              <h2 className="wl-h">Set up in about five minutes</h2>
              <p className="wl-sub">Four details to start. Then paste a link to your website or booking page and check what we found.</p>
              <button className="btn-dark wide" onClick={() => go("signup")}>
                Set up my business
              </button>
              <div className="wl-row">
                <button className="btn-line" onClick={() => go("login")}>
                  Sign in
                </button>
                {demos.length > 0 && (
                  <button className="btn-line" onClick={() => go("demo")}>
                    Look around a demo business
                  </button>
                )}
              </div>
              <p className="wl-foot">
                <a className="linkish" href="/">
                  I am a customer
                </a>
              </p>
            </>
          )}

          {(mode === "signup" || mode === "login") && (
            <>
              {back}
              <h2 className="wl-h">{mode === "signup" ? "Set up your business" : "Welcome back"}</h2>
              <p className="wl-sub">
                {mode === "signup" ? "Four details to start. You can change any of them later." : "Sign in to see your bookings and what PayPal paid you."}
              </p>
              <form
                className="wl-fields"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!missing) submit();
                }}
              >
                {mode === "signup" && (
                  <>
                    <Field label="Business name" error={errs.name}>
                      <input {...field("name")} autoComplete="organization" placeholder="Kemi Braids Studio" autoFocus />
                    </Field>
                    <Field label="City" error={errs.city} hint="Sets your time zone, so bookings land at the right hour.">
                      <span className="wl-select">
                        <select {...field("city")}>
                          <option value="">Choose your city</option>
                          {cities.map((c) => (
                            <option key={c}>{c}</option>
                          ))}
                        </select>
                      </span>
                    </Field>
                  </>
                )}
                <Field label="Email" error={errs.email}>
                  <input {...field("email")} type="email" autoComplete="email" autoFocus={mode === "login"} />
                </Field>
                <Field label="Password" error={errs.password} hint={mode === "signup" ? "At least 8 characters." : undefined}>
                  <input {...field("password")} type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} />
                </Field>
                {msg && <p className="err">{msg}</p>}
                <button className="btn-dark wide" disabled={missing || !!busy}>
                  {busy ? "One moment" : mode === "signup" ? "Continue" : "Sign in"}
                </button>
              </form>
            </>
          )}

          {mode === "demo" && (
            <>
              {back}
              <h2 className="wl-h">Look around a demo business</h2>
              <p className="wl-sub">These businesses are simulated and take PayPal Sandbox payments. Open one to see its bookings, what PayPal paid, and refunds.</p>
              <div className="demo-list">
                {demos.map((d) => (
                  <button key={d.id} className="demo-biz" disabled={!!busy} onClick={() => openDemo(d.id)}>
                    <span className="me biz-me">{d.name.slice(0, 1)}</span>
                    <span className="demo-biz-text">
                      <strong>{d.name}</strong>
                      <span>
                        {d.category}, {d.city}
                      </span>
                    </span>
                    <Icon d={IC.next} />
                  </button>
                ))}
              </div>
              {msg && <p className="err">{msg}</p>}
            </>
          )}
        </div>
      </main>

      <aside className="wl-more on-night">
        {points}
        {proof}
      </aside>
    </div>
  );
}

// ---------- the guided setup ----------
type Step = "sell" | "review" | "hours" | "cancel" | "pay" | "live" | "done";
const STEPS: { key: Step; label: string }[] = [
  { key: "sell", label: "What you sell" },
  { key: "hours", label: "Opening hours" },
  { key: "cancel", label: "Cancellations" },
  { key: "pay", label: "Getting paid" },
  { key: "live", label: "Go live" },
];
const stepIndex = (s: Step) => (s === "review" ? 0 : s === "done" ? STEPS.length : STEPS.findIndex((x) => x.key === s));

function firstStep(me: Biz): Step {
  const e = me.setupErrors;
  if (me.status === "live") return "done";
  if (e.items) return "sell";
  if (e.hours) return "hours";
  if (e.cancelHours) return "cancel";
  if (e.paypal) return "pay";
  return "live";
}

export function Onboarding({ me, onSaved, onExit }: { me: Biz; onSaved: (b: Biz) => void; onExit: () => void }) {
  const [step, setStep] = useState<Step>(() => firstStep(me));
  const [found, setFound] = useState<ImportResult | null>(null);
  const [items, setItems] = useState<Draft[]>(() => (me.services.length ? me.services.map((s) => ({ ...s, dailyLimit: s.dailyLimit ?? "" })) : []));
  const [about, setAbout] = useState(me.about);
  const [category, setCategory] = useState(me.category);
  const [askCategory] = useState(!me.category); // sign-up does not ask; the review step does
  const [noteAnswers, setNoteAnswers] = useState<Record<string, string>>({});
  const [hours, setHours] = useState<Hours>(() => {
    const out: Hours = {};
    for (let d = 0; d < 7; d++) out[d] = me.hours[d] ?? null;
    return out;
  });
  const [cancel, setCancel] = useState(me.cancelHours === null ? "" : String(me.cancelHours));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async (url: string, body: unknown, method = "PUT") => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ business: Biz }>(url, method, body);
      onSaved(r.business);
      return r.business;
    } catch (e) {
      const b = (e as ApiErr).body;
      const first = b?.rows ? Object.values(b.rows)[0] : b?.fields ? Object.values(b.fields)[0] : undefined;
      setErr(first ?? (e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const applyImport = (r: ImportResult) => {
    setFound(r);
    setItems(r.items.length ? r.items.map((it) => ({ ...it, dailyLimit: "", fromLink: true })) : [blankItem()]);
    if (r.business.about && !me.about) setAbout(r.business.about);
    if (r.business.category && !me.category) setCategory(r.business.category.slice(0, 60));
    if (r.hours && Object.values(r.hours).some(Boolean)) setHours(r.hours);
    if (r.cancelHours !== null && me.cancelHours === null) setCancel(String(r.cancelHours));
    setStep("review");
  };

  const idx = stepIndex(step);
  return (
    <div className="ob">
      <header className="ob-top">
        <span className="brand">
          <Mark /> Ordina <em className="for">Agent Checkout</em>
        </span>
        {step !== "done" && (
          <ol className="ob-steps" aria-label="Setup steps">
            {STEPS.map((s, i) => (
              <li key={s.key} className={i < idx ? "done" : i === idx ? "on" : ""} aria-current={i === idx ? "step" : undefined}>
                <span className="ob-dot">{i < idx ? <Icon d={IC.check} /> : i + 1}</span>
                <span className="ob-step-label">{s.label}</span>
              </li>
            ))}
          </ol>
        )}
        <button className="linkish ob-exit" onClick={onExit}>
          {step === "done" ? "Open my dashboard" : "Finish later"}
        </button>
      </header>

      <main className="ob-main">
        {step === "sell" && <SellStep me={me} onFound={applyImport} onManual={() => { setFound(null); setItems(items.length ? items : [blankItem()]); setStep("review"); }} />}

        {step === "review" && (
          <ReviewStep
            found={found}
            items={items}
            setItems={setItems}
            about={about}
            setAbout={setAbout}
            category={category}
            setCategory={setCategory}
            askCategory={askCategory}
            cancel={cancel}
            setCancel={setCancel}
            noteAnswers={noteAnswers}
            setNoteAnswers={setNoteAnswers}
            busy={busy}
            err={err}
            onBack={() => setStep("sell")}
            onNext={async () => {
              const saved = await save("/api/biz/items", { items: items.map(({ original: _o, fromLink: _f, ...it }) => it) });
              if (!saved) return;
              const notes = Object.entries(noteAnswers)
                .filter(([, a]) => a.trim())
                .map(([id, a]) => `${found?.questions.find((q) => q.id === id)?.text ?? ""}\n${a.trim()}`)
                .join("\n\n");
              const patch: Record<string, unknown> = {};
              if (about !== me.about) patch.about = about;
              if (notes) patch.notes = [me.notes, notes].filter(Boolean).join("\n\n");
              if (category.trim() && category.trim() !== me.category) patch.category = category.trim();
              if (Object.keys(patch).length && !(await save("/api/biz/profile", patch))) return;
              setStep("hours");
            }}
          />
        )}

        {step === "hours" && (
          <HoursStep
            city={me.city}
            hours={hours}
            setHours={setHours}
            fromLink={!!found?.hours}
            busy={busy}
            err={err}
            onBack={() => setStep(found || items.length ? "review" : "sell")}
            onNext={async () => {
              if (await save("/api/biz/profile", { hours })) setStep("cancel");
            }}
          />
        )}

        {step === "cancel" && (
          <CancelStep
            value={cancel}
            setValue={setCancel}
            busy={busy}
            err={err}
            onBack={() => setStep("hours")}
            onNext={async () => {
              if (await save("/api/biz/profile", { cancelHours: Number(cancel) })) setStep("pay");
            }}
          />
        )}

        {step === "pay" && (
          <PayStep
            me={me}
            onSaved={onSaved}
            busy={busy}
            err={err}
            pickDemoSeller={() => save("/api/biz/payments/demo-seller", {}, "POST")}
            onBack={() => setStep("cancel")}
            onNext={() => setStep("live")}
          />
        )}

        {step === "live" && (
          <LiveStep
            me={me}
            busy={busy}
            err={err}
            onBack={() => setStep("pay")}
            onGoLive={async () => {
              if (await save("/api/biz/status", { status: "live" }, "POST")) setStep("done");
            }}
            goTo={setStep}
          />
        )}

        {step === "done" && <DoneStep me={me} onExit={onExit} />}
      </main>
    </div>
  );
}

// One step: the card, and on a wide screen a quiet note beside it that says why the step exists.
function StepCard({ n, title, sub, why, whyTitle = "Why we ask", children }: { n: number; title: string; sub?: string; why?: React.ReactNode; whyTitle?: string; children: React.ReactNode }) {
  return (
    <div className={`ob-stage ${why ? "has-why" : ""}`}>
      <section className="ob-card">
        <span className="eyebrow ob-count">
          Step {n} of {STEPS.length}
        </span>
        <h1>{title}</h1>
        {sub && <p className="ob-sub">{sub}</p>}
        {children}
      </section>
      {why && (
        <aside className="ob-why">
          <span className="eyebrow">{whyTitle}</span>
          {why}
        </aside>
      )}
    </div>
  );
}

function Nav({ onBack, onNext, disabled, busy, label = "Continue", err }: { onBack?: () => void; onNext: () => void; disabled?: boolean; busy?: boolean; label?: string; err?: string | null }) {
  return (
    <>
      {err && <p className="err ob-err">{err}</p>}
      <div className="ob-nav">
        {onBack ? (
          <button className="btn-ghost ob-back" onClick={onBack} disabled={busy}>
            <Icon d={IC.back} /> Back
          </button>
        ) : (
          <span />
        )}
        <button className="btn-dark" onClick={onNext} disabled={disabled || busy}>
          {busy ? "Saving" : label}
        </button>
      </div>
    </>
  );
}

// ---------- step 1: how to add what you sell ----------
const PLATFORMS = ["Ordina", "Square", "Fresha", "Booksy", "Shopify", "Calendly", "Acuity", "Vagaro"];
// What the owner sees while their page is read. The lines keep time on their own;
// the last one stays in progress until the answer arrives.
const READING = ["Opening your page", "Reading your services and prices", "Checking your opening hours", "Writing a few questions for you"];
const READING_GAP = 2500;

function SellStep({ me, onFound, onManual }: { me: Biz; onFound: (r: ImportResult) => void; onManual: () => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0); // presentational: drives the reading panel only
  const readBtn = useRef<HTMLButtonElement>(null);
  const clean = url.trim();
  const withScheme = clean && !/^https?:\/\//i.test(clean) ? `https://${clean}` : clean;
  const valid = (() => {
    try {
      const u = new URL(withScheme);
      return /^https?:$/.test(u.protocol) && u.hostname.includes(".");
    } catch {
      return false;
    }
  })();

  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed(Date.now() - started), 250);
    return () => clearInterval(t);
  }, [busy]);
  const line = Math.min(READING.length - 1, Math.floor(elapsed / READING_GAP));
  const secs = Math.floor(elapsed / 1000);

  const read = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ import: ImportResult }>("/api/biz/import", "POST", { url: withScheme });
      onFound(r.import);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepCard
      n={1}
      title={`What does ${me.name} sell?`}
      sub="Your Secretary only ever quotes what is on this list, at these prices. Choose how to fill it in."
      why={
        <>
          <p>Customers' AI assistants ask your Secretary what you offer and what it costs. It answers from this list and nothing else, so no agent can change your prices.</p>
          <p>Nothing is saved until you check it.</p>
        </>
      }
    >
      <div className={`ob-opts ${busy ? "is-reading" : ""}`}>
        <div className="ob-option primary">
          <div className="ob-option-head">
            <span className="ob-option-ic">
              <Icon d={IC.link} />
            </span>
            <div>
              <strong>Paste your link</strong>
              <span>Your website, booking page or price list. We read it, fill in your services and products, and ask about anything missing.</span>
            </div>
          </div>
          {busy ? (
            <div className="ob-read" role="status">
              <div className="ob-read-head">
                <span className="eyebrow">Reading</span>
                <code>{host(withScheme)}</code>
                <span className="num ob-read-time" aria-hidden>
                  {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}
                </span>
              </div>
              <div className="ob-read-bar" aria-hidden>
                <i />
              </div>
              <ol className="ob-read-lines">
                {READING.map((text, i) => (
                  <li key={text} className={i < line ? "done" : i === line ? "now" : "wait"} aria-hidden={i > line}>
                    <span className="ob-read-mark" aria-hidden>
                      {i < line ? (
                        <svg viewBox="0 0 16 16">
                          <path d="M3.5 8.5l3 3 6-7" />
                        </svg>
                      ) : (
                        <span className="spin" />
                      )}
                    </span>
                    <span>{text}</span>
                  </li>
                ))}
              </ol>
              <p className="field-hint">This can take up to 30 seconds. Nothing is saved until you check it.</p>
            </div>
          ) : (
            <form
              className="ob-link"
              onSubmit={(e) => {
                e.preventDefault();
                if (valid && !busy) read();
              }}
            >
              <label className={`field ${err ? "has-err" : ""}`}>
                <span className="field-label">Link</span>
                <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="kemibraids.com or your booking page" inputMode="url" autoFocus aria-describedby="ob-link-msg" />
              </label>
              <button className="btn-dark" disabled={!valid || busy} ref={readBtn}>
                Read my page
              </button>
              {err ? (
                <span className="field-err" id="ob-link-msg">
                  {err}
                </span>
              ) : (
                <span className="field-hint" id="ob-link-msg">
                  Nothing is saved until you check it.
                </span>
              )}
              <p className="ob-sample">
                No website to hand?{" "}
                <button
                  type="button"
                  className="linkish"
                  onClick={() => {
                    // Fills the link only; the owner still presses "Read my page".
                    setUrl(`${location.origin}/sample/kemi-braids.html`);
                    setTimeout(() => readBtn.current?.focus(), 0);
                  }}
                >
                  Use our sample salon page
                </button>
              </p>
            </form>
          )}
        </div>

        <button className="ob-option" onClick={onManual} disabled={busy}>
          <div className="ob-option-head">
            <span className="ob-option-ic">
              <Icon d={IC.pen} />
            </span>
            <div>
              <strong>Add them myself</strong>
              <span>Type in your services and products with their prices. Takes a minute or two.</span>
            </div>
            <Icon d={IC.next} />
          </div>
        </button>

        <div className="ob-option soon" aria-disabled>
          <div className="ob-option-head">
            <span className="ob-option-ic">
              <Icon d={IC.list} />
            </span>
            <div>
              <strong>Connect your booking system</strong>
              <span>Already on a booking or shop platform? Connect it once and your services, calendar and bookings stay in sync.</span>
            </div>
            <em className="soon-pill">Coming soon</em>
          </div>
          <div className="ob-platforms">
            {PLATFORMS.map((p) => (
              <span key={p}>{p}</span>
            ))}
          </div>
        </div>
      </div>
    </StepCard>
  );
}

// ---------- step 1b: check what we found, or add it yourself ----------
function ReviewStep(props: {
  found: ImportResult | null;
  items: Draft[];
  setItems: (v: Draft[]) => void;
  about: string;
  setAbout: (v: string) => void;
  category: string;
  setCategory: (v: string) => void;
  askCategory: boolean;
  cancel: string;
  setCancel: (v: string) => void;
  noteAnswers: Record<string, string>;
  setNoteAnswers: (v: Record<string, string>) => void;
  busy: boolean;
  err: string | null;
  onBack: () => void;
  onNext: () => void;
}) {
  const { found, items, setItems } = props;
  const set = (i: number, patch: Partial<Draft>) => setItems(items.map((it, n) => (n === i ? { ...it, ...patch } : it)));
  const questions = (found?.questions ?? []).filter((q) => q.field !== "price" && q.field !== "minutes" ? true : q.item !== undefined && items[q.item]);
  const categoryMissing = props.askCategory && !props.category.trim();
  const anyErr = items.length === 0 || items.some((it) => rowError(it)) || categoryMissing;
  // The found things arrive one after another: questions first, then each line.
  const lead = questions.length ? questions.length + 1 : 0;

  return (
    <StepCard
      n={1}
      title={found ? "Check what we found" : "Add what you sell"}
      sub={
        found
          ? `From ${found.source.title || host(found.source.url)}. We found ${found.items.length} ${found.items.length === 1 ? "thing" : "things"} you sell. Check each price; your Secretary will quote exactly these.`
          : "Appointments take time in your calendar. Pickup items are ordered ahead and collected, up to a daily limit."
      }
      whyTitle={found ? "Two kinds of thing" : "Why we ask"}
      why={
        found ? (
          <p>Appointments take time in your calendar. Pickup items are ordered ahead and collected, up to a daily limit.</p>
        ) : (
          <p>Your Secretary quotes exactly these prices, in US dollars. No agent can change them.</p>
        )
      }
    >
      {found && (
        <p className="ob-source">
          <Icon d={IC.link} />
          <code>{host(found.source.url)}</code>
        </p>
      )}

      {found && found.items.length === 0 && (
        <p className="ob-note">We could not find prices on that page. Add what you sell below; it only takes a minute.</p>
      )}

      {questions.length > 0 && (
        <div className="ob-qs rise">
          <h2>
            A few questions <span className="num">{questions.length}</span>
          </h2>
          {questions.map((q, n) => {
            if (q.field === "price" && q.item !== undefined) {
              const it = items[q.item];
              return (
                <QuestionRow key={q.id} q={q} n={n} error={it && String(it.price).trim() && rowError(it)?.startsWith("Enter a price") ? rowError(it) : undefined}>
                  <div className="money-in">
                    <span>$</span>
                    <input value={it.price} onChange={(e) => set(q.item!, { price: e.target.value })} inputMode="decimal" placeholder="25.00" />
                  </div>
                </QuestionRow>
              );
            }
            if (q.field === "minutes" && q.item !== undefined) {
              const it = items[q.item];
              return (
                <QuestionRow key={q.id} q={q} n={n}>
                  <input className="short" value={it.minutes} onChange={(e) => set(q.item!, { minutes: e.target.value })} inputMode="numeric" placeholder="60" />
                </QuestionRow>
              );
            }
            if (q.field === "cancelHours") {
              return (
                <QuestionRow key={q.id} q={q} n={n}>
                  <input className="short" value={props.cancel} onChange={(e) => props.setCancel(e.target.value)} inputMode="numeric" placeholder="24" />
                </QuestionRow>
              );
            }
            return (
              <QuestionRow key={q.id} q={q} n={n}>
                <input value={props.noteAnswers[q.id] ?? ""} onChange={(e) => props.setNoteAnswers({ ...props.noteAnswers, [q.id]: e.target.value })} placeholder="Optional" />
              </QuestionRow>
            );
          })}
        </div>
      )}

      {props.askCategory && (
        <Field label="What kind of business is it?" error={categoryMissing ? "Say what kind of business it is, for example hair salon or bakery." : undefined}>
          <input value={props.category} maxLength={60} onChange={(e) => props.setCategory(e.target.value)} placeholder="Hair salon, bakery, physio clinic" />
        </Field>
      )}

      <div className="ob-items">
        {found && <h2>What you sell</h2>}
        {items.length > 0 && (
          <div className="ob-items-head" aria-hidden>
            <span>Kind</span>
            <span>Name</span>
            <span>Price (USD)</span>
            <span>Length or daily limit</span>
          </div>
        )}
        {items.map((it, i) => {
          const e = rowError(it);
          const at = rowErrorField(e);
          return (
            <div className={`ob-item rise ${e ? "has-err" : ""}`} key={i} style={seq(Math.min(lead + i, 14))}>
              <div className="seg-mini" role="radiogroup" aria-label="Kind">
                {(["appointment", "pickup"] as const).map((k) => (
                  <button type="button" key={k} className={it.kind === k ? "on" : ""} onClick={() => set(i, { kind: k })} aria-pressed={it.kind === k}>
                    {k === "appointment" ? "Appointment" : "Pickup item"}
                  </button>
                ))}
              </div>
              <button type="button" className="icon-btn show rm" aria-label={`Remove ${it.name || "this item"}`} onClick={() => setItems(items.filter((_, n) => n !== i))}>
                <Icon d={IC.close} />
              </button>
              <label className={`field ob-f-name ${at === "name" ? "has-err" : ""}`}>
                <span className="field-label">Name</span>
                <input value={it.name} onChange={(ev) => set(i, { name: ev.target.value })} placeholder={it.kind === "pickup" ? "Celebration cake" : "Knotless braids"} />
              </label>
              <label className={`field ob-f-price ${at === "price" ? "has-err" : ""}`}>
                <span className="field-label">Price (USD)</span>
                <div className="money-in">
                  <span>$</span>
                  <input value={it.price} onChange={(ev) => set(i, { price: ev.target.value })} inputMode="decimal" placeholder="25.00" />
                </div>
              </label>
              {it.kind === "appointment" ? (
                <label className={`field ob-f-extra ${at === "extra" ? "has-err" : ""}`}>
                  <span className="field-label">Length (minutes)</span>
                  <div className="money-in ob-unit">
                    <input value={it.minutes} onChange={(ev) => set(i, { minutes: ev.target.value })} inputMode="numeric" placeholder="60" />
                    <span>min</span>
                  </div>
                </label>
              ) : (
                <label className={`field ob-f-extra ${at === "extra" ? "has-err" : ""}`}>
                  <span className="field-label">Daily limit</span>
                  <div className="money-in ob-unit">
                    <input value={it.dailyLimit ?? ""} onChange={(ev) => set(i, { dailyLimit: ev.target.value })} inputMode="numeric" placeholder="No limit" />
                    <span>a day</span>
                  </div>
                </label>
              )}
              {it.original && <span className="field-hint ob-item-msg">On your page: {it.original}. This build takes US dollars.</span>}
              {e && <span className={`field-err ob-item-msg at-${at}`}>{e}</span>}
            </div>
          );
        })}
        <button type="button" className="btn-line add" onClick={() => setItems([...items, blankItem()])}>
          <Icon d={IC.plus} /> Add another
        </button>
        {items.length === 0 && <span className="field-err">Add at least one thing you sell, with a price.</span>}
      </div>

      {found && (
        <Field label="About your business (optional)" hint="Your Secretary uses this to introduce you.">
          <textarea rows={2} value={props.about} maxLength={500} onChange={(e) => props.setAbout(e.target.value)} />
        </Field>
      )}

      <Nav onBack={props.onBack} onNext={props.onNext} disabled={anyErr} busy={props.busy} err={props.err} />
    </StepCard>
  );
}

function QuestionRow({ q, n, error, children }: { q: ImportQ; n: number; error?: string; children: React.ReactNode }) {
  return (
    <label className={`ob-q rise ${q.field === "note" ? "is-note" : ""} ${error ? "has-err" : ""}`} style={seq(n + 1)}>
      <span className="ob-q-text">{q.text}</span>
      <div className="ob-q-in">{children}</div>
      {error ? <span className="field-err">{error}</span> : q.hint ? <span className="field-hint">{q.hint}</span> : null}
    </label>
  );
}

// ---------- step 2: opening hours ----------
const PRESETS: { label: string; days: number[]; open: string; close: string }[] = [
  { label: "Weekdays, 9 to 5", days: [1, 2, 3, 4, 5], open: "09:00", close: "17:00" },
  { label: "Monday to Saturday, 9 to 6", days: [1, 2, 3, 4, 5, 6], open: "09:00", close: "18:00" },
  { label: "Every day, 10 to 8", days: [0, 1, 2, 3, 4, 5, 6], open: "10:00", close: "20:00" },
];

function HoursStep(props: { city: string; hours: Hours; setHours: (h: Hours) => void; fromLink: boolean; busy: boolean; err: string | null; onBack: () => void; onNext: () => void }) {
  const { hours: h, setHours } = props;
  const bad = Object.values(h).some((v) => v && !(v[0] < v[1]));
  const none = !Object.values(h).some(Boolean);
  return (
    <StepCard
      n={2}
      title="When are you open?"
      sub={`In ${props.city} time. Customers' agents can only book inside these hours.${props.fromLink ? " We filled these in from your page; check them." : ""}`}
      why={<p>Your city sets your time zone, so bookings land at the right hour. A day you switch off is never offered to anyone.</p>}
    >
      <div className="ob-chips" role="group" aria-label="Quick choices">
        <span className="eyebrow">Quick choices</span>
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            className="btn-line sm"
            onClick={() => {
              const out: Hours = {};
              for (let d = 0; d < 7; d++) out[d] = p.days.includes(d) ? [p.open, p.close] : null;
              setHours(out);
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="hours">
        {ORDER.map((d) => {
          const v = h[d];
          return (
            <div className={`hour-row ${v ? "" : "is-closed"}`} key={d}>
              <label className="switch">
                <input type="checkbox" checked={!!v} onChange={(e) => setHours({ ...h, [d]: e.target.checked ? ["09:00", "17:00"] : null })} />
                <span>{DAYS[d]}</span>
              </label>
              {v ? (
                <div className="hour-times">
                  <input type="time" value={v[0]} onChange={(e) => setHours({ ...h, [d]: [e.target.value, v[1]] })} aria-label={`${DAYS[d]} opens`} />
                  <span>to</span>
                  <input type="time" value={v[1]} onChange={(e) => setHours({ ...h, [d]: [v[0], e.target.value] })} aria-label={`${DAYS[d]} closes`} />
                  {!(v[0] < v[1]) && <span className="field-err">Closing must be after opening.</span>}
                </div>
              ) : (
                <span className="closed">Closed</span>
              )}
            </div>
          );
        })}
      </div>
      {none && <span className="field-err">Open at least one day a week.</span>}
      <Nav onBack={props.onBack} onNext={props.onNext} disabled={bad || none} busy={props.busy} err={props.err} />
    </StepCard>
  );
}

// ---------- step 3: cancellations ----------
function CancelStep(props: { value: string; setValue: (v: string) => void; busy: boolean; err: string | null; onBack: () => void; onNext: () => void }) {
  const v = props.value;
  const n = Number(v);
  const err = v.trim() === "" ? undefined : !Number.isInteger(n) || n < 0 || n > 168 ? "Enter whole hours from 0 to 168." : undefined;
  const choices = [
    { h: 24, label: "24 hours before" },
    { h: 48, label: "48 hours before" },
    { h: 12, label: "12 hours before" },
    { h: 0, label: "Any time before it starts" },
  ];
  return (
    <StepCard
      n={3}
      title="Until when can customers cancel for free?"
      sub="Up to this point, a customer can cancel and get a full refund through PayPal on their own. After it, refunds are your call: you can refund any amount for 180 days."
      why={<p>A clear cut-off means nobody has to ask. Before it, the customer cancels and PayPal refunds them in full. After it, the decision is yours.</p>}
    >
      <div className="ob-choices" role="radiogroup" aria-label="Free cancellation">
        {choices.map((c) => (
          <button key={c.h} type="button" className={v === String(c.h) ? "on" : ""} aria-pressed={v === String(c.h)} onClick={() => props.setValue(String(c.h))}>
            <span>{c.label}</span>
            <Icon d={IC.check} />
          </button>
        ))}
      </div>
      <div className="ob-manual">
        <Field label="Or enter the hours yourself" error={err}>
          <div className="money-in ob-unit">
            <input className="short" value={v} onChange={(e) => props.setValue(e.target.value)} inputMode="numeric" placeholder="24" />
            <span>hours before</span>
          </div>
        </Field>
        {v.trim() === "" && <span className="field-err">Choose how many hours before customers can cancel for free.</span>}
      </div>
      <Nav onBack={props.onBack} onNext={props.onNext} disabled={v.trim() === "" || !!err} busy={props.busy} err={props.err} />
    </StepCard>
  );
}

// ---------- step 4: getting paid ----------
function PayStep(props: { me: Biz; onSaved: (b: Biz) => void; busy: boolean; err: string | null; pickDemoSeller: () => Promise<Biz | null>; onBack: () => void; onNext: () => void }) {
  const p = props.me.paypal;
  const connected = !!p.merchantId && p.receivable && p.emailConfirmed;
  const why = <p>Every booking is paid first, so there are no unpaid no-shows. Ordina takes no cut of your sales; you pay PayPal's usual fee.</p>;
  if (FLOW !== "standard") {
    return (
      <StepCard n={4} title="Get paid into your PayPal" sub="Customers pay into your own PayPal account. PayPal checks your business, so there is nothing to upload here." why={why}>
        <PaySection me={props.me} onSaved={props.onSaved} notice={null} />
        <Nav onBack={props.onBack} onNext={props.onNext} disabled={!connected} />
      </StepCard>
    );
  }
  return (
    <StepCard n={4} title="Getting paid" sub="Customers pay through PayPal the moment they approve, by PayPal or by card. Nobody needs a PayPal account to pay you." why={why}>
      <div className={`pp-row ${connected ? "ok" : ""}`}>
        <span className="pp-mark" aria-hidden>
          <b>P</b>
        </span>
        <div>
          <strong>{connected ? "Ready to take payments" : "PayPal Sandbox test account"}</strong>
          <span>
            {connected
              ? "Payments in this demo go to Ordina's PayPal Sandbox account. No real money moves."
              : "This demo runs on PayPal's Sandbox, so payments go to Ordina's test account and no real money moves. With PayPal's marketplace approval, you will connect your own PayPal here instead and be paid straight into it."}
          </span>
        </div>
        {connected ? (
          <span className="badge ok ob-ready">
            <Icon d={IC.check} /> Ready
          </span>
        ) : (
          <button className="btn-dark sm" onClick={props.pickDemoSeller} disabled={props.busy}>
            {props.busy ? "Setting up" : "Use the test account"}
          </button>
        )}
      </div>
      {!connected && <span className="field-err ob-under">Choose how you get paid to continue.</span>}
      <Nav onBack={props.onBack} onNext={props.onNext} disabled={!connected} err={props.err} />
    </StepCard>
  );
}

// ---------- step 5: go live ----------
function LiveStep(props: { me: Biz; busy: boolean; err: string | null; onBack: () => void; onGoLive: () => void; goTo: (s: Step) => void }) {
  const { me } = props;
  const open = Object.entries(me.hours).filter(([, v]) => v).length;
  const rows: { label: string; value: string; step: Step; bad?: string }[] = [
    { label: "What you sell", value: `${me.services.length} ${me.services.length === 1 ? "item" : "items"}`, step: "review", bad: me.setupErrors.items },
    { label: "Opening hours", value: `${open} ${open === 1 ? "day" : "days"} a week, ${me.city} time`, step: "hours", bad: me.setupErrors.hours },
    { label: "Free cancellation", value: me.cancelHours === null ? "Not set" : me.cancelHours === 0 ? "Any time before it starts" : `Up to ${me.cancelHours} hours before`, step: "cancel", bad: me.setupErrors.cancelHours },
    { label: "Getting paid", value: FLOW === "standard" ? "PayPal Sandbox test account" : (me.paypal.email ?? "PayPal"), step: "pay", bad: me.setupErrors.paypal },
  ];
  const ready = Object.keys(me.setupErrors).length === 0;
  return (
    <StepCard
      n={5}
      title="Ready to go live?"
      sub="Once you are live, any customer's AI assistant can find you, and your own link starts taking bookings."
      whyTitle="Good to know"
      why={<p>Nothing here is final. You can change any of it later.</p>}
    >
      <div className="ob-summary">
        {rows.map((r, i) => (
          <div key={r.label} className={`ob-sum-row rise ${r.bad ? "bad" : ""}`} style={seq(i)}>
            <span className="tick" aria-hidden>
              {!r.bad && <Icon d={IC.check} />}
            </span>
            <div>
              <strong>{r.label}</strong>
              <span>{r.bad ?? r.value}</span>
            </div>
            <button className="linkish" onClick={() => props.goTo(r.step)}>
              Change
            </button>
          </div>
        ))}
      </div>
      <Nav onBack={props.onBack} onNext={props.onGoLive} disabled={!ready} busy={props.busy} label="Go live" err={props.err} />
    </StepCard>
  );
}

// ---------- done ----------
function DoneStep({ me, onExit }: { me: Biz; onExit: () => void }) {
  const link = `${location.origin}${me.link}`;
  const [copied, setCopied] = useState(false);
  return (
    <div className="ob-stage">
      <section className="ob-card ob-done">
        <div className="ob-done-head">
          <h1 className="rise">{me.name} is live</h1>
          <span className="badge ok live rise" style={seq(3)}>
            Live
          </span>
        </div>
        <p className="ob-sub rise" style={seq(1)}>
          Your Secretary is now answering customers' AI assistants with your prices and hours. Every booking arrives paid.
        </p>
        <div className="ob-done-link rise" style={seq(4)}>
          <span className="field-label">Your link</span>
          <div className="linkbox">
            <code>{link}</code>
            <button
              className="btn-line"
              onClick={() => {
                navigator.clipboard
                  .writeText(link)
                  .then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  })
                  .catch(() => {});
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <span className="field-hint">Put it in your Instagram bio, WhatsApp status or website. It opens a chat already talking to your Secretary.</span>
        </div>
        <div className="ob-where rise" style={seq(5)}>
          <h2>Where customers find you now</h2>
          <div>
            <span className="ob-where-ic">
              <Icon d={IC.assistant} />
            </span>
            <span>
              <strong>In their own AI assistant.</strong> Anyone who connects Claude or another assistant to Ordina can ask it to book you.
            </span>
          </div>
          <div>
            <span className="ob-where-ic">
              <Icon d={IC.link} />
            </span>
            <span>
              <strong>Through your link.</strong> Wherever you share it.
            </span>
          </div>
        </div>
        <div className="ob-nav rise" style={seq(6)}>
          <a className="btn-line" href={me.link} target="_blank" rel="noreferrer">
            Try it as a customer
          </a>
          <button className="btn-dark" onClick={onExit}>
            Open my dashboard
          </button>
        </div>
      </section>
    </div>
  );
}

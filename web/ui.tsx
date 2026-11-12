// ---------- shared UI pieces (styled in system.css) ----------
import { useEffect, useRef, useState, type ReactNode } from "react";

export function Icon({ d, className }: { d: string; className?: string }) {
  return (
    <svg className={`ic ${className ?? ""}`} viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Ordina's own mark (the ring from the logo). `light` is kept for older call sites. */
export function Mark({ big, small }: { big?: boolean; small?: boolean; light?: boolean }) {
  return (
    <span className={`mark ${big ? "big" : ""} ${small ? "small" : ""}`} aria-hidden>
      <img src="/brand/ordina-mark.png" alt="" width={48} height={48} decoding="async" />
    </span>
  );
}

/** The Secretary's soft four-point star (never a chat bubble, never a sparkle). */
export function SecretaryStar({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <path
        d="M12 2.6c.5 0 .9.3 1 .8.9 4.3 2.7 6.1 7 7 .5.1.8.5.8 1s-.3.9-.8 1c-4.3.9-6.1 2.700-7 7-.1.5-.5.8-1 .8s-.9-.3-1-.8c-.9-4.3-2.700-6.1-7-7-.5-.1-.8-.5-.8-1s.3-.9.8-1c4.3-.9 6.1-2.700 7-7 .1-.5.5-.8 1-.8Z"
        fill="currentColor"
      />
    </svg>
  );
}

/**
 * The pass: one payment offer. The same object on the front door, in the chat,
 * on the hosted pay page. `state` is "offer" while it waits for the customer,
 * "paid" once PayPal confirmed it, "expired" when the hold ran out.
 */
export function Pass(props: {
  label: string; // eyebrow, e.g. "Payment offer"
  title: string; // what is being bought
  place?: string; // the business
  when?: string; // "Fri 13 Nov, 09:00 Lagos time"
  amount: string; // "35.00"
  currency?: string;
  state?: "offer" | "paid" | "expired";
  status?: ReactNode; // right of the eyebrow: the hold countdown, or a badge
  note?: ReactNode; // small print under the actions
  children?: ReactNode; // the PayPal buttons, or a <Seal />
  enter?: boolean; // play the entrance
  className?: string;
}) {
  const { state = "offer", currency = "USD" } = props;
  return (
    <article className={`pass is-${state} ${props.enter ? "pass-enter" : ""} ${props.className ?? ""}`}>
      <header className="pass-top">
        <span className="eyebrow">{props.label}</span>
        {props.status}
      </header>
      <div className="pass-main">
        <div className="pass-what">
          <h3>{props.title}</h3>
          {props.place && <p>{props.place}</p>}
          {props.when && <p className="pass-when">{props.when}</p>}
        </div>
        <div className="pass-amt">
          <strong>${props.amount}</strong>
          <span>{currency}</span>
        </div>
      </div>
      <div className="pass-cut" aria-hidden />
      <div className="pass-foot">
        {props.children}
        {props.note && <p className="pass-note">{props.note}</p>}
      </div>
    </article>
  );
}

/** PayPal confirmed it: a ring and a check that draw themselves, then the words. */
export function Seal({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="seal" role="status">
      <svg className="seal-ring" viewBox="0 0 40 40" aria-hidden>
        <circle cx="20" cy="20" r="18" transform="rotate(-90 20 20)" />
        <path d="M12.5 20.5l5 5 10-11" />
      </svg>
      <div className="seal-text">
        <strong>{title}</strong>
        {detail && <span>{detail}</span>}
      </div>
    </div>
  );
}

/** Minutes and seconds left on a hold, as the pass shows it. */
export function HoldClock({ label }: { label: string }) {
  return (
    <span className="pass-hold">
      <i aria-hidden />
      {label}
    </span>
  );
}

/** A money figure that counts up once when it first appears, and again when it changes. */
export function CountUp({ value, prefix = "$" }: { value: string | null | undefined; prefix?: string }) {
  const target = Number(value ?? 0) || 0;
  const [shown, setShown] = useState(target);
  const from = useRef(0);
  useEffect(() => {
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || from.current === target) {
      from.current = target;
      setShown(target);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 700);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(a + (target - a) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else from.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return (
    <>
      {prefix}
      {shown.toFixed(2)}
    </>
  );
}

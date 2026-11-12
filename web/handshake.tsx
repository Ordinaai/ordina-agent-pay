// The handshake: one booking, start to finish, played as a live sequence on the front door.
// You ask; the two agents agree; the server checks; you approve in PayPal; it is booked.
// Presentational only: nothing here talks to the server.
import { useEffect, useRef, useState } from "react";
import { HoldClock, Icon, Pass, Seal, SecretaryStar } from "./ui.tsx";

const ASK = "Book me a silk press in Lagos tomorrow morning, up to $50.";
const PHASES = ["You ask", "Agents agree", "Checked", "You approve", "Booked"];

// Each beat: when it starts (ms into a run) and which phase it belongs to.
const BEATS = [
  { key: "ask", at: 500, phase: 0 },
  { key: "m1", at: 2700, phase: 1 },
  { key: "m2", at: 4100, phase: 1 },
  { key: "c1", at: 5500, phase: 2 },
  { key: "c2", at: 6100, phase: 2 },
  { key: "c3", at: 6700, phase: 2 },
  { key: "c4", at: 7300, phase: 2 },
  { key: "pass", at: 8200, phase: 3 },
  { key: "press", at: 10600, phase: 3 },
  { key: "paid", at: 11200, phase: 4 },
  { key: "leave", at: 16200, phase: 4 },
] as const;
type Beat = (typeof BEATS)[number]["key"];
const RUN_MS = 16800;

const CHECKS: { beat: Beat; by: "Server" | "PayPal"; text: string }[] = [
  { beat: "c1", by: "Server", text: "Price from the salon's own list" },
  { beat: "c2", by: "Server", text: "09:00 held for 15 minutes" },
  { beat: "c3", by: "Server", text: "Inside your $50 limit" },
  { beat: "c4", by: "PayPal", text: "Order created for $35.00" },
];

export function Handshake() {
  const [run, setRun] = useState(0);
  const [reached, setReached] = useState<Set<Beat>>(() => new Set());
  const [typed, setTyped] = useState(0);
  const [held, setHeld] = useState(0); // seconds since this run began
  const still = useRef(typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);

  useEffect(() => {
    if (still.current) {
      // No motion: show the finished booking.
      setReached(new Set(BEATS.map((b) => b.key).filter((k) => k !== "leave")));
      setTyped(ASK.length);
      return;
    }
    setReached(new Set());
    setTyped(0);
    setHeld(0);
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const b of BEATS) timers.push(setTimeout(() => setReached((prev) => new Set(prev).add(b.key)), b.at));
    timers.push(setTimeout(() => setRun((n) => n + 1), RUN_MS));
    let typing: ReturnType<typeof setInterval> | undefined;
    timers.push(
      setTimeout(() => {
        typing = setInterval(() => setTyped((n) => (n >= ASK.length ? n : n + 1)), 30);
      }, 500),
    );
    const clock = setInterval(() => setHeld((n) => n + 1), 1000);
    return () => {
      timers.forEach(clearTimeout);
      if (typing) clearInterval(typing);
      clearInterval(clock);
    };
  }, [run]);

  const on = (k: Beat) => reached.has(k);
  const phase = BEATS.reduce((p, b) => (reached.has(b.key) ? Math.max(p, b.phase) : p), -1);
  const paid = on("paid");
  const left = Math.max(0, 15 * 60 - 3 - Math.max(0, held - 8));
  const hold = `Held for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;

  return (
    <div
      className={`hs ${on("leave") ? "is-leaving" : ""}`}
      role="img"
      aria-label="An example booking. You ask your assistant for a silk press. It agrees a time and price with the salon's Secretary. The server checks the price, the hold and your spending limit. You approve one PayPal payment, and the booking exists once PayPal confirms it."
    >
      <div className="hs-head">
        <ol className="hs-phases" aria-hidden>
          {PHASES.map((p, i) => (
            <li key={p} className={i < phase ? "done" : i === phase ? "on" : ""}>
              <i />
              <span>{p}</span>
            </li>
          ))}
        </ol>
        <button className="hs-replay" onClick={() => setRun((n) => n + 1)} aria-label="Play the example again" title="Play again">
          <Icon d="M4 12a8 8 0 1 0 2.6-5.9M4 4v4.500h4.500" />
        </button>
      </div>

      <div className="hs-body" key={run} aria-hidden>
        <div className={`hs-ask ${on("ask") ? "on" : ""}`}>
          <span className="hs-you">You</span>
          <p>
            {on("ask") ? ASK.slice(0, typed) : ""}
            {!on("m1") && <i className="hs-caret" />}
          </p>
        </div>

        <div className={`hs-msg from-assistant ${on("m1") ? "on" : ""}`}>
          <span className="eyebrow">Your assistant</span>
          <p>Is a silk press free tomorrow morning? Up to $50.</p>
        </div>
        <div className={`hs-msg from-secretary ${on("m2") ? "on" : ""}`}>
          <span className="eyebrow">
            <SecretaryStar size={11} /> Lumen Hair Studio's Secretary
          </span>
          <p>09:00 is free. 90 minutes, $35.00.</p>
        </div>

        <div className={`hs-gate ${on("c1") ? "on" : ""}`}>
          <span className="eyebrow">Checked in code, not by an agent</span>
          <ul>
            {CHECKS.map((c) => (
              <li key={c.beat} className={on(c.beat) ? "on" : ""}>
                <svg viewBox="0 0 16 16" width="15" height="15">
                  <circle cx="8" cy="8" r="7" />
                  <path d="M5 8.3l2.1 2.1L11 6.2" />
                </svg>
                <b className={c.by === "PayPal" ? "by-paypal" : ""}>{c.by}</b>
                <span>{c.text}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="hs-pass">
          {on("pass") && (
            <Pass
              enter
              label="Payment offer"
              title="Silk press"
              place="Lumen Hair Studio, Lagos"
              when="Fri 13 Nov, 09:00"
              amount="35.00"
              state={paid ? "paid" : "offer"}
              status={paid ? <span className="badge ok">Booked</span> : <HoldClock label={hold} />}
              note={paid ? undefined : "Only you can approve it. Your assistant cannot."}
            >
              {paid ? (
                <Seal title="Paid and booked" detail="Ref 8FF272 · PayPal confirmed" />
              ) : (
                <span className={`hs-pp ${on("press") ? "is-pressed" : ""}`}>
                  <b>Pay</b>
                  <b>Pal</b>
                </span>
              )}
            </Pass>
          )}
        </div>
      </div>
    </div>
  );
}

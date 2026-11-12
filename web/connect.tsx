import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type RefObject } from "react";
import { Handshake } from "./handshake.tsx";
import { Icon, Mark } from "./ui.tsx";
import "./connect.css";

// The front door: customers keep the assistant they already use. They pick it,
// copy our MCP address and follow that assistant's own steps to add it.
// Facts per assistant come from each vendor's docs (12 Nov 2026); keep claims to these.

type AssistantId = "claude" | "chatgpt" | "gemini" | "lechat" | "perplexity" | "cursor" | "vscode" | "copilot" | "other";

type Assistant = {
  id: AssistantId;
  name: string;
  letter: string;
  tag: string;
  /** The primary button: where it goes and whether it opens a new tab. */
  open?: { label: string; href: (address: string) => string; newTab: boolean };
  /** Heading over the numbered steps (one-click installs show them as the by-hand route). */
  stepsTitle?: string;
  steps?: string[];
  note?: string;
};

const ASSISTANTS: Assistant[] = [
  {
    id: "claude",
    name: "Claude",
    letter: "C",
    tag: "Free and paid plans",
    open: { label: "Open Claude", href: () => "https://claude.ai/customize/connectors", newTab: true },
    steps: [
      "Copy the address.",
      "Open Claude's Connectors page.",
      "Click Add, then Add custom connector.",
      "Name it Ordina, paste the address, leave sign-in off, and add it.",
    ],
    note: "Works on every plan. The Free plan allows one custom connector. Add it on the web or desktop app; it then works on your phone too.",
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    letter: "C",
    tag: "Business and Enterprise",
    open: { label: "Open ChatGPT", href: () => "https://chatgpt.com/plugins", newTab: true },
    steps: [
      "Copy the address.",
      "Open Plugins.",
      "Click the plus button, then Add custom MCP server.",
      "Name it Ordina, paste the address, choose no authentication, accept the notice, and create it.",
    ],
    note: "Custom connectors that can book need a ChatGPT Business or Enterprise workspace, on the web. On Pro they can only read. If your workspace has an admin, they may need to add it.",
  },
  {
    id: "gemini",
    name: "Gemini",
    letter: "G",
    tag: "US, English",
    open: { label: "Open Gemini", href: () => "https://gemini.google.com", newTab: true },
    steps: [
      "Copy the address.",
      "In Gemini on the web, open Settings, then Connected Apps.",
      "Under Custom apps, choose Add a custom app and paste the address.",
    ],
    note: "Available for personal Google accounts in the US, in English. Google is still rolling this out, so it may not work for everyone yet.",
  },
  {
    id: "lechat",
    name: "Le Chat (Mistral)",
    letter: "L",
    tag: "Free and paid plans",
    open: { label: "Open Le Chat", href: () => "https://chat.mistral.ai", newTab: true },
    steps: [
      "Copy the address.",
      "Open Connectors in the sidebar.",
      "Click Add Connector, then the Custom MCP Connector tab.",
      "Paste the address, choose no authentication, and connect.",
    ],
    note: "Works on the Free plan too.",
  },
  {
    id: "perplexity",
    name: "Perplexity",
    letter: "P",
    tag: "Pro and Max",
    open: { label: "Open Perplexity", href: () => "https://www.perplexity.ai/computer/plugins", newTab: true },
    steps: [
      "Copy the address.",
      "Open Plugins.",
      "Choose Add custom, then Add MCP connector, then Remote.",
      "Paste the address, set authentication to None, and save.",
    ],
    note: "Needs Perplexity Pro or Max.",
  },
  {
    id: "cursor",
    name: "Cursor",
    letter: "C",
    tag: "One click",
    open: {
      label: "Add to Cursor",
      href: (address) =>
        "cursor://anysphere.cursor-deeplink/mcp/install?name=ordina&config=" + encodeURIComponent(btoa(JSON.stringify({ url: address }))),
      newTab: false,
    },
    stepsTitle: "If the button does not open Cursor:",
    steps: ["Copy the address.", "Open Cursor Settings, then MCP.", "Add a new server with the address."],
    note: "Opens Cursor and shows the server for you to confirm.",
  },
  {
    id: "vscode",
    name: "VS Code",
    letter: "V",
    tag: "One click",
    open: {
      label: "Add to VS Code",
      href: (address) =>
        "https://vscode.dev/redirect?url=" +
        encodeURIComponent("vscode:mcp/install?" + encodeURIComponent(JSON.stringify({ name: "ordina", type: "http", url: address }))),
      newTab: true,
    },
    stepsTitle: "If the button does not open VS Code:",
    steps: ["Copy the address.", "Open the Command Palette and run MCP: Add Server.", "Choose HTTP and paste the address."],
    note: "Needs GitHub Copilot in VS Code. You review it before it installs.",
  },
  { id: "copilot", name: "Microsoft Copilot", letter: "M", tag: "Not yet" },
  { id: "other", name: "Something else", letter: "+", tag: "Any MCP app" },
];

const EXAMPLES = ["Book me a silk press in Lagos tomorrow morning, up to $50.", "Order a celebration cake for pickup on Saturday."];

const DEFAULT_ID: AssistantId = "claude";

const ALIASES: Record<string, AssistantId> = { "le-chat": "lechat", mistral: "lechat", "vs-code": "vscode", "something-else": "other" };

function idFromHash(): AssistantId | null {
  const raw = decodeURIComponent(location.hash.replace(/^#/, "")).toLowerCase();
  const id = ALIASES[raw] ?? raw;
  return ASSISTANTS.some((a) => a.id === id) ? (id as AssistantId) : null;
}

// ---------- copy with a fallback for browsers without the clipboard API ----------
function selectContents(el: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

async function copyText(text: string, el: HTMLElement | null): Promise<"copied" | "selected"> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return "copied";
    }
  } catch {
    // fall through to selecting the text
  }
  if (!el) return "selected";
  selectContents(el);
  try {
    if (document.execCommand("copy")) return "copied";
  } catch {
    // the text stays selected so the person can copy it themselves
  }
  return "selected";
}

function CopyButton({ text, target, label }: { text: string; target: RefObject<HTMLElement | null>; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "selected">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const onClick = async () => {
    const result = await copyText(text, target.current);
    setState(result);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), result === "copied" ? 1600 : 4000);
  };
  return (
    <>
      <button type="button" className={`cx-copy ${state === "copied" ? "done" : ""}`} onClick={onClick} aria-label={label}>
        {state === "copied" ? (
          <>
            <Icon d="M5 12.5l4.5 4.5L19 7.5" /> Copied
          </>
        ) : state === "selected" ? (
          "Selected"
        ) : (
          <>
            <Icon d="M9 9h10v10H9zM5 15V5h10" /> Copy
          </>
        )}
      </button>
      <span className="cx-sr" aria-live="polite">
        {state === "copied" ? "Copied" : state === "selected" ? "Text selected. Copy it with your keyboard or menu." : ""}
      </span>
    </>
  );
}

// Let a long address wrap at its slashes on phones instead of mid-word (<wbr> adds no text when copied).
function breakable(text: string) {
  return text.split("/").map((part, i) => (
    <span key={i}>
      {i > 0 && "/"}
      {i > 0 && part && <wbr />}
      {part}
    </span>
  ));
}

function AddressBox({ address }: { address: string }) {
  const ref = useRef<HTMLElement>(null);
  return (
    <div className="cx-field">
      <span className="eyebrow cx-label" id="cx-addr-label">
        Ordina's address
      </span>
      <div className="cx-addr">
        <code ref={ref} aria-labelledby="cx-addr-label" onClick={(e) => selectContents(e.currentTarget)}>
          {breakable(address)}
        </code>
        <CopyButton text={address} target={ref} label="Copy the address" />
      </div>
    </div>
  );
}

function Example({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  return (
    <li className="cx-example">
      <p ref={ref}>{text}</p>
      <CopyButton text={text} target={ref} label={`Copy this example: ${text}`} />
    </li>
  );
}

function AskIt() {
  return (
    <div className="cx-ask">
      <h4 className="eyebrow cx-label">Then ask it</h4>
      <ul>
        {EXAMPLES.map((t) => (
          <Example key={t} text={t} />
        ))}
      </ul>
    </div>
  );
}

// ---------- the detail panel: the chosen assistant ----------
function Instructions({ a, address, onTry }: { a: Assistant; address: string; onTry?: () => void }) {
  if (a.id === "copilot") {
    return (
      <div className="cx-card">
        <div className="cx-block">
          <p className="cx-lead">Microsoft Copilot does not let you add your own tools yet. You can still book through a business's own link, or try it here.</p>
          <div className="cx-actions">
            {onTry ? (
              <button type="button" className="btn-dark" onClick={onTry}>
                Try it here <Icon d="M5 12h14M13 6l6 6-6 6" />
              </button>
            ) : (
              <a className="btn-dark" href="/try">
                Try it here <Icon d="M5 12h14M13 6l6 6-6 6" />
              </a>
            )}
          </div>
        </div>
      </div>
    );
  }
  if (a.id === "other") {
    return (
      <div className="cx-card">
        <div className="cx-block">
          <p className="cx-lead">
            If your assistant supports MCP connectors (sometimes called custom connectors or plugins), add this address. It needs no sign-in.
          </p>
          <AddressBox address={address} />
        </div>
        <div className="cx-block">
          <AskIt />
        </div>
      </div>
    );
  }
  return (
    <div className="cx-card">
      <div className="cx-block cx-connect-row">
        <AddressBox address={address} />
        {a.open && (
          <div className="cx-actions">
            <a
              className="btn-dark"
              href={a.open.href(address)}
              {...(a.open.newTab ? { target: "_blank", rel: "noreferrer" } : {})}
            >
              {a.open.label}
              <Icon d={a.open.newTab ? "M14 5h5v5M19 5l-8 8M18 14v5H5V6h5" : "M5 12h14M13 6l6 6-6 6"} />
            </a>
          </div>
        )}
      </div>
      <div className="cx-split">
        <div className="cx-block cx-how">
          {a.steps && (
            <div className="cx-steps">
              {a.stepsTitle ? <h4 className="cx-steps-t">{a.stepsTitle}</h4> : <h4 className="eyebrow cx-label">Steps</h4>}
              <ol>
                {a.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </div>
          )}
          {a.note && <p className="cx-note">{a.note}</p>}
        </div>
        <div className="cx-block">
          <AskIt />
        </div>
      </div>
    </div>
  );
}

// ---------- the picker (full page and the playground's compact view) ----------
export function ConnectPicker({ compact = false, onTry }: { compact?: boolean; onTry?: () => void }) {
  const address = `${location.origin}/mcp`;
  // Claude is chosen until the person picks, so the panel is useful at once.
  const [sel, setSel] = useState<AssistantId>(() => (compact ? DEFAULT_ID : (idFromHash() ?? DEFAULT_ID)));
  const stepTwo = useRef<HTMLElement>(null);
  const chosen = useRef(false);

  // "/#cursor" preselects Cursor, and later hash changes follow along (an unknown hash falls back to Claude).
  useEffect(() => {
    if (compact) return;
    const onHash = () => setSel(idFromHash() ?? DEFAULT_ID);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [compact]);

  // After a tap, bring step 2 into view when it starts below the fold (phones).
  useEffect(() => {
    if (!chosen.current || !stepTwo.current) return;
    chosen.current = false;
    const top = stepTwo.current.getBoundingClientRect().top;
    if (top > window.innerHeight * 0.7) {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      stepTwo.current.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    }
  }, [sel]);

  const choose = (id: AssistantId) => {
    chosen.current = true;
    setSel(id);
    if (!compact) history.replaceState(null, "", `#${id}`);
  };
  const a = ASSISTANTS.find((x) => x.id === sel) ?? ASSISTANTS[0];

  return (
    <div className={`cx-picker ${compact ? "compact" : ""}`}>
      <header className="cx-head">
        <div className="cx-head-t">
          {!compact && <span className="eyebrow">Connect your assistant</span>}
          <h2 id="cx-step-1">Which assistant do you use?</h2>
        </div>
        {!compact && <p className="cx-head-sub">Add Ordina to it once. Then ask it to book a haircut, a class or a cake.</p>}
      </header>

      <div className="cx-cols">
        <div className="cx-grid" role="group" aria-labelledby="cx-step-1">
          {ASSISTANTS.map((x) => (
            <button
              key={x.id}
              type="button"
              className={`cx-tile ${x.id === "copilot" ? "soon" : ""}`}
              aria-pressed={sel === x.id}
              onClick={() => choose(x.id)}
            >
              <span className="cx-av" aria-hidden>
                {x.letter}
              </span>
              <span className="cx-tile-t">
                <span className="cx-name">{x.name}</span>
                <span className="cx-tag">{x.tag}</span>
              </span>
              <Icon className="cx-chev" d="M9 6l6 6-6 6" />
            </button>
          ))}
        </div>

        <section className="cx-panel" aria-labelledby="cx-step-2" ref={stepTwo} key={a.id}>
          <header className="cx-panel-h">
            <span className="cx-av" aria-hidden>
              {a.letter}
            </span>
            <h3 id="cx-step-2">
              {a.id === "copilot" ? "Microsoft Copilot" : a.id === "other" ? "Add Ordina to your assistant" : `Add Ordina to ${a.name}`}
            </h3>
            <span className="badge">{a.tag}</span>
          </header>
          <Instructions a={a} address={address} onTry={onTry} />
        </section>
      </div>
    </div>
  );
}

// ---------- the front door ----------
const PICKER_ID = "cx-connect";
const REPO = "https://github.com/Ordinaai/ordina-agent-pay";

// The safety rules shown here keep their numbers from the README.
const RULES = [
  { n: "Rule 1", text: "Every price comes from the business's own list, never from what an agent writes." },
  { n: "Rule 3", text: "No agent can pay. Only you approve, in PayPal." },
  {
    n: "Rule 4",
    text: "A booking exists only when PayPal confirms the exact amount, paid to the right seller. Otherwise the money goes straight back.",
  },
];

const step = (i: number) => ({ "--i": i }) as CSSProperties;

function toPicker(smooth: boolean) {
  const el = document.getElementById(PICKER_ID);
  if (!el) return false;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: smooth && !reduce ? "smooth" : "auto", block: "start" });
  return true;
}

export function ConnectPage() {
  // A link that names the picker ("/#connect") or an assistant ("/#claude") opens at the picker.
  useEffect(() => {
    if (location.hash === "#connect" || idFromHash()) toPicker(false);
  }, []);

  // Scroll to the picker without touching the hash: the hash belongs to the chosen assistant.
  const onConnect = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (!toPicker(true)) return;
    e.preventDefault();
    document.getElementById(PICKER_ID)?.focus({ preventScroll: true });
  };

  return (
    <div className="cx">
      <main>
        <section className="cx-hero on-night" aria-labelledby="cx-h1">
          <div className="cx-bar">
            <a className="brand cx-brand rise" style={step(0)} href="/" aria-label="Ordina Agent Checkout, home">
              <Mark light /> Ordina <em className="for">Agent Checkout</em>
            </a>
            <nav className="cx-nav rise" style={step(0)} aria-label="Main">
              <a href="/try">Try the demo</a>
              <a href="/business">For businesses</a>
            </nav>
          </div>

          <div className="cx-hero-grid">
            <div className="cx-pitch">
              <p className="eyebrow rise" style={step(1)}>
                Agent checkout for real-world services
              </p>
              <h1 id="cx-h1" className="rise" style={step(2)}>
                <span>Your assistant books it.</span> <span className="cx-h1-b">You approve it.</span>
              </h1>
              <p className="cx-sub rise" style={step(3)}>
                Add Ordina to the AI assistant you already use. It finds the business, agrees the time and price with the business's own
                Secretary, and brings you one PayPal payment to approve. It can never pay for you.
              </p>
              <div className="cx-cta rise" style={step(4)}>
                <a className="btn-night" href="#connect" onClick={onConnect}>
                  Connect your assistant
                </a>
                <a className="cx-quiet" href="/try">
                  Try it without one <Icon d="M5 12h14M13 6l6 6-6 6" />
                </a>
              </div>
              <p className="cx-sandbox rise" style={step(5)}>
                PayPal Sandbox demo. No real money moves.
              </p>
            </div>
            <div className="cx-stage">
              <Handshake />
            </div>
          </div>
        </section>

        <section className="cx-sec cx-connect" id={PICKER_ID} tabIndex={-1} aria-labelledby="cx-step-1">
          <ConnectPicker />
        </section>

        <section className="cx-sec cx-safety" aria-labelledby="cx-safety-h">
          <header className="cx-sec-h">
            <span className="eyebrow">Enforced by the server</span>
            <h2 id="cx-safety-h">Safety is in the code, not the prompt</h2>
          </header>
          <ul className="cx-rules">
            {RULES.map((r) => (
              <li key={r.n}>
                <span className="eyebrow">{r.n}</span>
                <p>{r.text}</p>
              </li>
            ))}
          </ul>
          <p className="cx-more">
            <a className="linkish" href={`${REPO}#safety-is-in-the-code-not-the-prompt`} target="_blank" rel="noreferrer">
              See all ten rules and their tests
            </a>
          </p>
        </section>

        <section className="cx-band on-night" aria-labelledby="cx-biz-h">
          <div className="cx-band-l">
            <span className="eyebrow">For businesses</span>
            <h2 id="cx-biz-h">
              <span>Run a business?</span> <span>Let assistants book and pay you.</span>
            </h2>
          </div>
          <div className="cx-band-r">
            <p>
              Paste your website link. We fill in what you sell, you check the prices, and you are live in about five minutes. Every booking
              arrives paid.
            </p>
            <a className="btn-night" href="/business">
              Set up my business
            </a>
          </div>
        </section>
      </main>

      <footer className="cx-foot">
        <p>Ordina Agent Checkout. Open source under the MIT licence.</p>
        <nav aria-label="Footer">
          <a href={REPO} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a href="https://www.useordina.com" target="_blank" rel="noreferrer">
            Built by Ordina
          </a>
          <a href="/try">Try the demo</a>
        </nav>
      </footer>
    </div>
  );
}

// Reading an owner's own page: which addresses may be fetched (SSRF), how a page
// becomes text, the offline reader, and the draft and questions the owner reviews.
// Nothing here reaches the network: DNS is stubbed and the only server is local.
import dns from "node:dns";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildImport,
  checkUrl,
  extractFromPage,
  houseStyle,
  isPrivateAddress,
  NOT_PUBLIC,
  pageToText,
  parseUserUrl,
  safeFetchPage,
  safeLookup,
  type Findings,
} from "../server/import.ts";

const keys = ["ANTHROPIC_API_KEY", "CENCORI_API_KEY", "AI_GATEWAY", "MOCK_AI", "BUSINESS_SIGNUP", "PAYPAL_FLOW", "PAYPAL_CLIENT_ID"] as const;
const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of keys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("which addresses are public", () => {
  it("refuses every private, loopback, link-local, CGNAT, multicast and reserved IPv4 range", () => {
    for (const ip of [
      "127.0.0.1", "127.255.255.254", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.0.1",
      "169.254.169.254", "100.64.0.1", "100.127.255.255", "0.0.0.0", "0.1.2.3", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "192.169.0.1", "169.253.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("refuses private IPv6, including IPv4-mapped private addresses in either spelling", () => {
    for (const ip of [
      "::1", "::", "fc00::1", "fd12:3456:789a::1", "fe80::1", "fe80::1%eth0", "febf::1", "ff02::1",
      "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:192.168.1.1", "::ffff:a9fe:a9fe", "::127.0.0.1", "[::1]",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "::ffff:808:808"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("treats anything that is not an IP address as unsafe", () => {
    expect(isPrivateAddress("example.com")).toBe(true);
    expect(isPrivateAddress("")).toBe(true);
    expect(isPrivateAddress("1.2.3")).toBe(true);
  });
});

describe("which URLs may be fetched", () => {
  const refused = (u: string) => expect(() => parseUserUrl(u), u).toThrow();

  it("refuses literal private IP hosts, however they are written", () => {
    for (const u of [
      "http://127.0.0.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://2130706433/", "http://0x7f.1/",
      "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/", "http://[fd00::1]/", "http://0.0.0.0/", "http://localhost/", "http://app.localhost/",
    ]) {
      expect(() => parseUserUrl(u), u).toThrow(NOT_PUBLIC);
    }
  });

  it("refuses other schemes, credentials, odd ports and long addresses", () => {
    for (const u of ["file:///etc/passwd", "ftp://example.com/menu", "gopher://example.com/", "javascript:alert(1)", "data:text/html,hi", "ws://example.com/"]) refused(u);
    expect(() => parseUserUrl("https://user:pass@example.com/")).toThrow(/user name and password/);
    expect(() => parseUserUrl("https://user@example.com/")).toThrow(/user name and password/);
    expect(() => parseUserUrl("http://example.com:22/")).toThrow(NOT_PUBLIC);
    expect(() => parseUserUrl("http://example.com:6379/")).toThrow(NOT_PUBLIC);
    expect(() => parseUserUrl(`https://example.com/${"a".repeat(300)}`)).toThrow(/too long/);
  });

  it("accepts public pages on the usual ports, and adds https:// when it is missing", () => {
    expect(parseUserUrl("lumenhair.com").href).toBe("https://lumenhair.com/");
    expect(parseUserUrl("http://example.com:8080/menu").port).toBe("8080");
    expect(parseUserUrl("https://example.com:8443/").port).toBe("8443");
    expect(checkUrl(new URL("https://8.8.8.8/")).hostname).toBe("8.8.8.8");
  });
});

describe("the lookup every connection uses", () => {
  const stubDns = (answer: Array<{ address: string; family: number }>) =>
    vi.spyOn(dns, "lookup").mockImplementation(((_h: string, _o: unknown, cb: (e: null, a: unknown) => void) => cb(null, answer)) as never);

  const run = (all: boolean) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address: unknown; family?: number }>((ok) =>
      safeLookup("shop.example", { all }, (err, address, family) => ok({ err, address, family })),
    );

  it("refuses a name that resolves to a private address (DNS rebinding included)", async () => {
    stubDns([{ address: "10.0.0.5", family: 4 }]);
    const r = await run(false);
    expect(r.err?.code).toBe("ENOTPUBLIC");
  });

  it("refuses a name if any of its addresses is private", async () => {
    stubDns([
      { address: "93.184.216.34", family: 4 },
      { address: "::1", family: 6 },
    ]);
    expect((await run(true)).err?.code).toBe("ENOTPUBLIC");
  });

  it("passes public addresses through in the shape asked for", async () => {
    stubDns([{ address: "93.184.216.34", family: 4 }]);
    expect(await run(false)).toEqual({ err: null, address: "93.184.216.34", family: 4 });
    expect((await run(true)).address).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("stops a fetch before it connects when the name resolves privately", async () => {
    stubDns([{ address: "169.254.169.254", family: 4 }]);
    await expect(safeFetchPage("http://metadata.example/")).rejects.toThrow(NOT_PUBLIC);
    await expect(safeFetchPage("http://127.0.0.1:8080/")).rejects.toThrow(NOT_PUBLIC);
    await expect(safeFetchPage("file:///etc/passwd")).rejects.toThrow(/http/);
  });
});

describe("page to text", () => {
  const html = `<!doctype html><html><head>
    <title>Lumen Hair Studio | Lagos</title>
    <meta name="description" content="Silk presses &amp; braids in Lekki.">
    <meta property="og:title" content="Lumen Hair">
    <meta property="og:description" content="Book online">
    <style>body { color: red }</style>
    <script>var secret = "do not show";</script>
    <script type="application/ld+json">{"@type":"HairSalon","name":"Lumen"}</script>
  </head><body>
    <noscript>Turn on JavaScript</noscript>
    <svg><text>icon label</text></svg>
    <template><p>hidden template</p></template>
    <iframe src="x">frame text</iframe>
    <h1>Our   services</h1>
    <ul><li>Silk press - $35</li><li>Tom &amp; Jerry&#39;s &quot;cut&quot; &lt;b&gt; &#8358;5,000&nbsp;now</li></ul>
    <p>Line one<br>Line two</p>
    <table><tr><td>Wash and style</td><td>$20</td></tr></table>
    <!-- a comment -->
  </body></html>`;

  it("keeps the title, descriptions and JSON-LD, and drops scripts, styles and hidden parts", () => {
    const { title, text } = pageToText(html);
    expect(title).toBe("Lumen Hair Studio | Lagos");
    expect(text).toContain("Description: Silk presses & braids in Lekki.");
    expect(text).toContain("Title for sharing: Lumen Hair");
    expect(text).toContain("Description for sharing: Book online");
    expect(text).toContain('{"@type":"HairSalon","name":"Lumen"}');
    expect(text).toContain("Our services");
    expect(text).toContain("Silk press - $35");
    expect(text).toContain(`Tom & Jerry's "cut" <b> ₦5,000 now`);
    expect(text).toContain("Line one\nLine two");
    expect(text).toContain("Wash and style $20");
    for (const gone of ["secret", "color: red", "Turn on JavaScript", "icon label", "hidden template", "frame text", "a comment"]) {
      expect(text).not.toContain(gone);
    }
    expect(text.split("\n").every((l) => l.trim().length > 0)).toBe(true);
  });

  it("caps the text at 24000 characters", () => {
    const big = `<p>${"word ".repeat(20_000)}</p>`;
    expect(pageToText(big).text.length).toBeLessThanOrEqual(24_000);
  });
});

const findings = (over: Partial<Findings> = {}): Findings => ({
  business: { name: "Lumen Hair Studio", category: "Hair salon", city: "lagos", about: "Silk presses in Lekki." },
  currency: "USD",
  items: [],
  hours: null,
  cancelHours: null,
  questions: [],
  ...over,
});
const item = (name: string, price: number | null, minutes: number | null, kind: "appointment" | "pickup" = "appointment") => ({ name, kind, price, minutes, note: null });
const page = { finalUrl: "https://lumen.example/", title: "Lumen" };

describe("the draft the owner reviews", () => {
  it("asks for unknown prices, then lengths, then the cancellation window, then the model's own questions", () => {
    const d = buildImport(
      findings({
        items: [item("Silk press", 35, 90), item("Wash and style", null, 60), item("Braids", 80, null), item("Cake", 20, null, "pickup")],
        hours: [{ day: 1, open: "09:00", close: "18:00" }],
        questions: [
          "What's your deposit policy — if any?", // payment is in full up front: never asked
          "How long do braids usually take?", // the setup asks lengths itself, and the cancellation window
          "Is there parking — and where?",
        ],
      }),
      page,
    );
    expect(d.source).toEqual({ url: "https://lumen.example/", title: "Lumen" });
    expect(d.business.city).toBe("Lagos");
    expect(d.items).toEqual([
      { kind: "appointment", name: "Silk press", price: "35.00", minutes: 90, dailyLimit: null, original: null },
      { kind: "appointment", name: "Wash and style", price: "", minutes: 60, dailyLimit: null, original: null },
      { kind: "appointment", name: "Braids", price: "80.00", minutes: "", dailyLimit: null, original: null },
      { kind: "pickup", name: "Cake", price: "20.00", minutes: "", dailyLimit: null, original: null },
    ]);
    expect(d.hours).toEqual({ 0: null, 1: ["09:00", "18:00"], 2: null, 3: null, 4: null, 5: null, 6: null });
    expect(d.questions).toEqual([
      { id: "price-1", text: "What do you charge for Wash and style?", field: "price", item: 1 },
      { id: "minutes-2", text: "How long does Braids take, in minutes?", field: "minutes", item: 2 },
      { id: "cancelHours", text: "Up to how many hours before can customers cancel for a full refund?", field: "cancelHours" },
      // Only the question the setup does not already ask survives, in house style.
      { id: "note-0", text: "Is there parking, and where?", field: "note" },
    ]);
  });

  it("keeps prices in another currency for the owner to convert, and asks in US dollars", () => {
    const d = buildImport(findings({ currency: "NGN", items: [item("Silk press", 25000, 90)], cancelHours: 24 }), page);
    expect(d.items[0]).toMatchObject({ price: "", original: "NGN 25,000" });
    expect(d.cancelHours).toBe(24);
    expect(d.questions).toHaveLength(1);
    expect(d.questions[0]).toMatchObject({ id: "usd-0", field: "price", item: 0, text: "Silk press is NGN 25,000 on your page. What is it in US dollars?" });
    expect(d.questions[0].hint).toMatch(/US dollars/);
  });

  it("asks at most 8 questions, with no em dashes or contractions", () => {
    const many = Array.from({ length: 12 }, (_, i) => item(`Style ${i}`, null, null));
    const d = buildImport(findings({ items: many, questions: ["Don't you open on Sundays?"] }), page);
    expect(d.questions).toHaveLength(8);
    expect(d.questions.every((q) => q.field === "price")).toBe(true);
    for (const q of d.questions) expect(q.text).not.toMatch(/[—–]|n't|'s\b|'re\b/);
    expect(houseStyle("Don't you open on Sundays — it's busy?")).toBe("Do not you open on Sundays, it is busy?");
  });

  it("maps the city to a known city whatever its case, or leaves it empty", () => {
    expect(buildImport(findings({ business: { name: "X", category: null, city: "NEW YORK", about: null } }), page).business.city).toBe("New York");
    expect(buildImport(findings({ business: { name: "X", category: null, city: "London, UK", about: null } }), page).business.city).toBe("London");
    expect(buildImport(findings({ business: { name: "X", category: null, city: "Ibadan", about: null } }), page).business.city).toBe(null);
  });
});

describe("the offline reader (no AI key)", () => {
  it('finds "Silk press - $35" and a JSON-LD Offer', async () => {
    process.env.MOCK_AI = "1";
    const html = `<html><head><title>Lumen Hair Studio</title>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"HairSalon","name":"Lumen Hair Studio",
        "address":{"@type":"PostalAddress","addressLocality":"Lagos"},
        "makesOffer":[{"@type":"Offer","price":"20.00","priceCurrency":"USD","itemOffered":{"@type":"Service","name":"Wash and style"}}]}</script>
      </head><body><h2>Prices</h2><ul><li>Silk press - $35</li><li>Knotless braids (medium) ..... $80.00</li><li>Call us any time</li></ul></body></html>`;
    const { title, text } = pageToText(html);
    const f = await extractFromPage({ finalUrl: "https://lumen.example/", title, text });
    expect(f.currency).toBe("USD");
    expect(f.business).toMatchObject({ name: "Lumen Hair Studio", category: "Hair salon", city: "Lagos" });
    expect(f.items).toEqual([
      { name: "Wash and style", kind: "appointment", price: 20, minutes: null, note: null },
      { name: "Silk press", kind: "appointment", price: 35, minutes: null, note: null },
      { name: "Knotless braids (medium)", kind: "appointment", price: 80, minutes: null, note: null },
    ]);
    const d = buildImport(f, { finalUrl: "https://lumen.example/", title });
    expect(d.business.city).toBe("Lagos");
    expect(d.items.map((i) => i.price)).toEqual(["20.00", "35.00", "80.00"]);
  });

  it("marks a bakery's items as pickups and keeps naira prices as naira", async () => {
    const { title, text } = pageToText(
      "<title>Crumb &amp; Co Bakery</title><body><p>Celebration cake ₦25,000</p><p>Pastry box of 12 - ₦8,500</p></body>",
    );
    const f = await extractFromPage({ finalUrl: "https://crumb.example/", title, text }, { mode: "mock" });
    expect(f.currency).toBe("NGN");
    expect(f.items).toEqual([
      { name: "Celebration cake", kind: "pickup", price: 25000, minutes: null, note: null },
      { name: "Pastry box of 12", kind: "pickup", price: 8500, minutes: null, note: null },
    ]);
  });
});

describe("reading a page with Claude", () => {
  it("takes the one report_findings call and applies every limit", async () => {
    for (const k of ["ANTHROPIC_API_KEY", "AI_GATEWAY", "MOCK_AI"]) delete process.env[k];
    process.env.CENCORI_API_KEY = "csk_test";
    const report = {
      business: { name: "Lumen", category: "Hair salon", city: "Lagos", about: "x".repeat(400) },
      currency: "usd",
      items: Array.from({ length: 45 }, (_, i) => ({ name: `Style ${i}`, kind: "appointment", price: 30, minutes: 60.4, note: null })),
      hours: [{ day: 9, open: "09:00", close: "18:00" }, { day: 2, open: "09:00", close: "18:00" }],
      cancelHours: 24,
      questions: ["a?", "b?", "c?", "d?"],
    };
    const replies = [
      { content: "", toolCalls: [{ id: "toolu_1", function: { name: "report_findings", arguments: JSON.stringify(report) } }], finish_reason: "tool_calls" },
      { content: "Done.", finish_reason: "stop" },
    ];
    let n = 0;
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(replies[n++]), { status: 200 }));
    const f = await extractFromPage({ finalUrl: "https://lumen.example/", title: "Lumen", text: "Silk press $30" });
    expect(f.business.about).toHaveLength(300);
    expect(f.currency).toBe("USD");
    expect(f.items).toHaveLength(40);
    expect(f.items[0].minutes).toBe(60);
    expect(f.hours).toEqual([{ day: 2, open: "09:00", close: "18:00" }]);
    expect(f.questions).toEqual(["a?", "b?", "c?"]);
  });

  it("fails when the model never reports", async () => {
    for (const k of ["ANTHROPIC_API_KEY", "AI_GATEWAY", "MOCK_AI"]) delete process.env[k];
    process.env.CENCORI_API_KEY = "csk_test";
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ content: "Sorry.", finish_reason: "stop" }), { status: 200 }));
    await expect(extractFromPage({ finalUrl: "https://x.example/", title: "", text: "hi" })).rejects.toThrow();
  });
});

// ---------- the routes ----------
process.env.DATA_DIR = ":memory:";
let server: Server;
let base = "";
beforeAll(async () => {
  const express = (await import("express")).default;
  const { bizApi } = await import("../server/business-api.ts");
  const app = express();
  app.use(express.json());
  app.use("/api/biz", bizApi);
  server = await new Promise<Server>((ok) => {
    const s = app.listen(0, "127.0.0.1", () => ok(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server?.close());

describe("the import and demo seller routes", () => {
  // Real fetch, to the local test server only (tests above may stub it).
  const realFetch = globalThis.fetch;
  const call = (path: string, body: unknown, cookie = "") =>
    realFetch(`${base}/api/biz${path}`, { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify(body) });

  it("are refused while sign-up is off", async () => {
    delete process.env.BUSINESS_SIGNUP;
    expect((await call("/import", { url: "https://example.com/" })).status).toBe(403);
    expect((await call("/payments/demo-seller", {})).status).toBe(403);
  });

  it("sign up without a category, refuse a private page, and connect the demo seller", async () => {
    process.env.BUSINESS_SIGNUP = "1";
    delete process.env.PAYPAL_FLOW;
    delete process.env.PAYPAL_CLIENT_ID;
    const signup = await call("/signup", { name: "Test Salon", city: "Lagos", email: `import-${Date.now()}@example.com`, password: "longenough1" });
    expect(signup.status).toBe(200);
    expect((await signup.json()).business.category).toBe("");
    const cookie = signup.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

    expect((await call("/import", { url: "https://example.com/" })).status).toBe(401);
    const missing = await call("/import", {}, cookie);
    expect(missing.status).toBe(400);
    expect((await missing.json()).fields.url).toBeTruthy();
    const local = await call("/import", { url: "http://127.0.0.1:8787/api/health" }, cookie);
    expect(local.status).toBe(422);
    expect(await local.json()).toEqual({ error: NOT_PUBLIC });

    const seller = await call("/payments/demo-seller", {}, cookie);
    expect(seller.status).toBe(200);
    const b = (await seller.json()).business;
    expect(b.paypal).toMatchObject({ merchantId: "DEMO-SELLER", receivable: true, emailConfirmed: true });
    expect(b.setupErrors.paypal).toBeUndefined();
  });
});

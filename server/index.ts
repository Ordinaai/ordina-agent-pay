import express, { type Request, type Response } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterPayment, buyerTurn, BusyError } from "./agents/buyer.ts";
import { aiGateway, aiMode, MODEL } from "./agents/loop.ts";
import { bizApi } from "./business-api.ts";
import { cancelDeadline, captureAndConfirm, customerCancel, offerByPayToken, session, setBudget } from "./commerce.ts";
import { eventsFor, subscribe, type WireEvent } from "./events.ts";
import { allowTurn, validSession } from "./guard.ts";
import { mockApprove, paymentsMisconfigured, paypalClientId, paypalFlow, paypalMode, paypalSandboxBuyerCountry } from "./paypal.ts";
import { startReleaseClock } from "./payouts.ts";
import { startKeepAwake } from "./keep-awake.ts";
import { connectApi, mockPayPalPages } from "./paypal-connect.ts";
import { mcpRouter } from "./mcp.ts";
import { seedDemoBusinesses } from "./seed.ts";
import { bookableBusiness, bookableBusinesses } from "./providers/index.ts";
import { bookingsForSessions, getBusiness, getBusinessByHandle, type Booking } from "./store.ts";

seedDemoBusinesses();

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "64kb" }));

const ip = (req: Request) => req.ip ?? "unknown";

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/config", (_req, res) => {
  res.json({
    ai: aiMode(),
    model: aiMode() === "claude" ? MODEL : null,
    aiGateway: aiGateway(),
    paypal: paypalMode(),
    paypalClientId: paypalMode() === "mock" ? null : paypalClientId(),
    paypalBuyerCountry: paypalSandboxBuyerCountry(),
    paypalFlow: paypalFlow(),
    businesses: bookableBusinesses().map((b) => ({ id: b.id, handle: b.handle, name: b.name, city: b.city, timezone: b.timezone })),
  });
});

// ---------- a business's own link ----------
app.get("/api/b/:handle", (req, res) => {
  const b = getBusinessByHandle(req.params.handle);
  if (!b || b.status === "setup") {
    res.status(404).json({ error: "No business at this link." });
    return;
  }
  res.json({
    business: {
      id: b.id,
      name: b.name,
      category: b.category,
      city: b.city,
      about: b.about,
      live: !!bookableBusiness(b.id),
      sells: b.services.map((s) => ({ name: s.name, kind: s.kind, price: s.price, minutes: s.kind === "appointment" ? s.minutes : null })),
    },
  });
});

app.post("/api/pin", (req, res) => {
  const { session: sid, businessId } = req.body ?? {};
  const b = typeof businessId === "string" ? bookableBusiness(businessId) : undefined;
  if (!validSession(sid) || !b) {
    res.status(400).json({ error: "Bad request" });
    return;
  }
  session(sid).pinnedBusinessId = b.id;
  res.json({ ok: true });
});

// ---------- the customer's chat ----------
app.post("/api/budget", (req, res) => {
  const { session: sid, budget } = req.body ?? {};
  if (!validSession(sid) || typeof budget !== "number" || !Number.isFinite(budget)) {
    res.status(400).json({ error: "Bad request" });
    return;
  }
  res.json({ budget: setBudget(sid, budget).budget });
});

function sse(res: Response, backlog: WireEvent[], channel: `s:${string}`, req: Request) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  for (const e of backlog) res.write(`data: ${JSON.stringify(e)}\n\n`);
  const off = subscribe(channel, (e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
  const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
  req.on("close", () => {
    off();
    clearInterval(ping);
  });
}

app.get("/api/events", (req, res) => {
  const sid = req.query.session;
  if (!validSession(sid)) {
    res.status(400).end();
    return;
  }
  sse(res, eventsFor(sid), `s:${sid}`, req);
});

app.post("/api/chat", async (req, res) => {
  const { session: sid, text } = req.body ?? {};
  if (!validSession(sid) || typeof text !== "string" || !text.trim()) {
    res.status(400).json({ error: "Bad request" });
    return;
  }
  const gate = allowTurn(ip(req));
  if (!gate.ok) {
    res.status(429).json({ error: gate.reason });
    return;
  }
  try {
    res.json({ reply: await buyerTurn(sid, text.trim().slice(0, 2000)) });
  } catch (err) {
    if (err instanceof BusyError) {
      res.status(409).json({ error: err.message });
      return;
    }
    console.error("chat failed", err);
    res.status(502).json({ error: "Your agent could not answer just now. Please try again." });
  }
});

app.post("/api/pay/mock-approve", (req, res) => {
  const { session: sid, orderId } = req.body ?? {};
  if (paypalMode() !== "mock" || !validSession(sid) || typeof orderId !== "string") {
    res.status(400).json({ error: "Bad request" });
    return;
  }
  res.json({ approved: mockApprove(orderId) });
});

app.post("/api/pay/capture", async (req, res) => {
  const { session: sid, orderId } = req.body ?? {};
  if (!validSession(sid) || typeof orderId !== "string") {
    res.status(400).json({ error: "Bad request" });
    return;
  }
  try {
    const out = await captureAndConfirm(sid, orderId);
    if (!out.ok) {
      res.status(422).json({ error: out.reason });
      return;
    }
    const reply = await afterPayment(sid, out.booking);
    res.json({ booking: customerView(out.booking), reply });
  } catch (err) {
    console.error("capture failed", err);
    res.status(502).json({ error: "Could not reach PayPal. Nothing was booked." });
  }
});

// ---------- the hosted pay page (/pay/<token>): any agent can send a customer here ----------
const validToken = (t: unknown): t is string => typeof t === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(t);

app.get("/api/offers/:token", (req, res) => {
  const o = validToken(req.params.token) ? offerByPayToken(req.params.token) : null;
  if (!o) {
    res.status(404).json({ error: "This payment link is not valid or has expired." });
    return;
  }
  res.json({
    offer: o.view,
    paypal: paypalMode(),
    paypalClientId: paypalMode() === "mock" ? null : paypalClientId(),
    paypalBuyerCountry: paypalSandboxBuyerCountry(),
  });
});

app.post("/api/offers/:token/mock-approve", (req, res) => {
  const o = validToken(req.params.token) ? offerByPayToken(req.params.token) : null;
  if (!o || paypalMode() !== "mock") {
    res.status(400).json({ error: "Bad request" });
    return;
  }
  res.json({ approved: mockApprove(o.view.orderId) });
});

app.post("/api/offers/:token/capture", async (req, res) => {
  const o = validToken(req.params.token) ? offerByPayToken(req.params.token) : null;
  if (!o) {
    res.status(404).json({ error: "This payment link is not valid or has expired." });
    return;
  }
  try {
    const out = await captureAndConfirm(o.sessionId, o.view.orderId);
    if (!out.ok) {
      res.status(422).json({ error: out.reason });
      return;
    }
    await afterPayment(o.sessionId, out.booking);
    res.json({ booking: customerView(out.booking) });
  } catch (err) {
    console.error("capture failed", err);
    res.status(502).json({ error: "Could not reach PayPal. Nothing was booked." });
  }
});

// ---------- the customer's bookings, across their chats ----------
function sessionList(raw: unknown): string[] {
  const list = (Array.isArray(raw) ? raw : String(raw ?? "").split(",")).map(String);
  return list.filter(validSession).slice(0, 100);
}

function customerView(bk: Booking) {
  const b = getBusiness(bk.businessId)!;
  return {
    id: bk.id,
    ref: bk.ref,
    chatId: bk.sessionId,
    kind: bk.kind,
    serviceName: bk.serviceName,
    date: bk.date,
    time: bk.time,
    amount: bk.amount,
    currency: bk.currency,
    status: bk.status,
    cancelledBy: bk.cancelledBy,
    refunded: bk.refunded,
    paidAs: bk.payerEmail, // the customer, as PayPal verified them
    businessName: b.name,
    city: b.city,
    timezone: b.timezone,
    policy: b.policy,
    cancelUntil: cancelDeadline(bk),
    createdAt: bk.createdAt,
  };
}

app.get("/api/bookings", (req, res) => {
  res.json({ bookings: bookingsForSessions(sessionList(req.query.sessions)).map(customerView) });
});

app.post("/api/bookings/cancel", async (req, res) => {
  const { sessions, bookingId } = req.body ?? {};
  if (typeof bookingId !== "string") {
    res.status(400).json({ error: "Bad request" });
    return;
  }
  try {
    const out = await customerCancel(sessionList(sessions), bookingId);
    if (!out.ok) {
      res.status(422).json({ error: out.reason });
      return;
    }
    res.json({ booking: customerView(out.booking) });
  } catch (err) {
    console.error("cancel failed", err);
    res.status(502).json({ error: "Could not reach PayPal. Nothing changed." });
  }
});

// ---------- the business owner ----------
app.use("/mcp", mcpRouter);
app.use("/api/biz/paypal", connectApi);
app.use("/api/biz", bizApi);
app.use("/paypal-sandbox-mock", mockPayPalPages);

// ---------- the built web app ----------
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "../dist");
if (existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: "1h" }));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

if (process.env.NODE_ENV !== "test") {
  startReleaseClock();
  startKeepAwake(); // Render free plan: never idle long enough to sleep
}
const setupProblem = paymentsMisconfigured();
if (setupProblem) console.error(`PayPal payments are OFF: ${setupProblem} Set it to the Sandbox business account's Merchant ID.`);

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`ordina-agent-pay on :${port} (ai=${aiGateway() ?? "mock"}, paypal=${paypalMode()})`);
});

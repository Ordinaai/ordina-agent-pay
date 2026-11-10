import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterPayment, buyerTurn, BusyError } from "./agents/buyer.ts";
import { aiMode, MODEL } from "./agents/loop.ts";
import { cancelDeadline, captureAndConfirm, customerCancel, refundBooking, session, setBudget } from "./commerce.ts";
import { eventsFor, subscribe, type WireEvent } from "./events.ts";
import { allowTurn, validSession } from "./guard.ts";
import { mockApprove, paypalClientId, paypalMode } from "./paypal.ts";
import { BUSINESSES, bookingsForSessions, getBooking, getBusiness, listBookings } from "./store.ts";

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "32kb" }));

const ip = (req: Request) => req.ip ?? "unknown";

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/config", (_req, res) => {
  res.json({
    ai: aiMode(),
    model: aiMode() === "claude" ? MODEL : null,
    paypal: paypalMode(),
    paypalClientId: paypalMode() === "mock" ? null : paypalClientId(),
    businesses: BUSINESSES.map((b) => ({ id: b.id, name: b.name, category: b.category, city: b.city, timezone: b.timezone })),
  });
});

app.post("/api/session", (_req, res) => {
  const id = randomUUID();
  res.json({ session: id, budget: session(id).budget });
});

app.post("/api/budget", (req, res) => {
  const { session: sid, budget } = req.body ?? {};
  if (!validSession(sid) || typeof budget !== "number" || !Number.isFinite(budget)) {
    res.status(400).json({ error: "Bad request" });
    return;
  }
  res.json({ budget: setBudget(sid, budget).budget });
});

function sse(res: Response, backlog: WireEvent[], channel: `s:${string}` | `b:${string}`, req: Request) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // The owner's stream never carries session ids: a session id is what lets
  // a browser capture its own payment.
  const strip = (e: WireEvent) => (channel.startsWith("b:") ? { ...e, sessionId: "" } : e);
  for (const e of backlog) res.write(`data: ${JSON.stringify(strip(e))}\n\n`);
  const off = subscribe(channel, (e) => res.write(`data: ${JSON.stringify(strip(e))}\n\n`));
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
    const reply = await buyerTurn(sid, text.trim().slice(0, 2000));
    res.json({ reply });
  } catch (err) {
    if (err instanceof BusyError) {
      res.status(409).json({ error: err.message });
      return;
    }
    console.error("chat failed", err);
    res.status(502).json({ error: "The assistant could not answer just now. Please try again." });
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
    res.json({ booking: out.booking, reply });
  } catch (err) {
    console.error("capture failed", err);
    res.status(502).json({ error: "Could not reach PayPal. Nothing was booked." });
  }
});

// ---------- the customer's own bookings, across their chats ----------
function sessionList(raw: unknown): string[] {
  const list = (Array.isArray(raw) ? raw : String(raw ?? "").split(",")).map(String);
  return list.filter(validSession).slice(0, 100);
}

function customerView(bk: ReturnType<typeof bookingsForSessions>[number]) {
  const b = getBusiness(bk.businessId)!;
  const { sessionId: _s, ...rest } = bk;
  return {
    ...rest,
    chatId: bk.sessionId,
    businessName: b.name,
    city: b.city,
    timezone: b.timezone,
    policy: b.policy,
    cancelUntil: cancelDeadline(bk),
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

app.get("/api/owner/:businessId", (req, res) => {
  const b = getBusiness(req.params.businessId);
  if (!b) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({
    business: { id: b.id, name: b.name, city: b.city, timezone: b.timezone, services: b.services, policy: b.policy },
    bookings: listBookings(b.id).map(({ sessionId: _s, ...rest }) => rest),
  });
});

app.get("/api/owner/:businessId/events", (req, res) => {
  const b = getBusiness(req.params.businessId);
  if (!b) {
    res.status(404).end();
    return;
  }
  sse(res, [], `b:${b.id}`, req);
});

app.post("/api/owner/refund", async (req, res) => {
  const { bookingId, businessId } = req.body ?? {};
  const bk = typeof bookingId === "string" ? getBooking(bookingId) : undefined;
  if (!bk || bk.businessId !== businessId) {
    res.status(404).json({ error: "No such booking." });
    return;
  }
  try {
    const out = await refundBooking(bk.id);
    if (!out.ok) {
      res.status(422).json({ error: out.reason });
      return;
    }
    const { sessionId: _s, ...booking } = out.booking;
    res.json({ booking });
  } catch (err) {
    console.error("refund failed", err);
    res.status(502).json({ error: "Could not reach PayPal." });
  }
});

// The built web app.
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "../dist");
if (existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: "1h" }));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`ordina-agent-pay on :${port} (ai=${aiMode()}, paypal=${paypalMode()})`);
});

// The business owner's API (/api/biz). Every route but sign-up and sign-in
// needs the owner's session, and only ever touches that owner's business.
import express, { type Request, type Response } from "express";
import { allowAuthTry, checkPassword, endSession, hashPassword, ownerOf, startSession } from "./auth.ts";
import { CITIES } from "./cities.ts";
import { businessCancel, businessGetsCents, businessRefund, canRefund, refundableCents } from "./commerce.ts";
import { paypalFlow, paypalMode } from "./paypal.ts";
import { runReleases } from "./payouts.ts";
import { bookableBusinesses } from "./providers/index.ts";
import {
  createBusiness,
  fromCents,
  getBusiness,
  getBusinessByEmail,
  listBookings,
  refundsFor,
  saveItems,
  toCents,
  updateBusiness,
  type Booking,
  type Business,
  type Hours,
} from "./store.ts";

export const bizApi = express.Router();

/**
 * Sign-up and setup are off by default: the gateway serves businesses through
 * providers, and this demo's business view shows the simulated ones. Set
 * BUSINESS_SIGNUP=1 to open sign-up, sign-in and editing (self-serve businesses).
 */
export const signupOpen = () => process.env.BUSINESS_SIGNUP === "1";
const SELF_SERVE = new Set(["POST /signup", "POST /login", "PUT /profile", "PUT /items", "POST /status"]);
bizApi.use((req, res, next) => {
  if (!signupOpen() && SELF_SERVE.has(`${req.method} ${req.path}`)) {
    res.status(403).json({ error: "This demo shows simulated businesses only." });
    return;
  }
  next();
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const PRICE = /^\d{1,5}(\.\d{1,2})?$/;

/** Everything that must be in place before going live, as field -> message. */
export function setupErrors(b: Business): Record<string, string> {
  const e: Record<string, string> = {};
  if (!b.services.length) e.items = "Add at least one thing you sell, with a price.";
  if (!Object.values(b.hours).some(Boolean)) e.hours = "Open at least one day a week.";
  if (b.cancelHours === null) e.cancelHours = "Choose how many hours before customers can cancel for free.";
  if (!b.paypal.merchantId) e.paypal = "Connect your PayPal account so customers can pay you.";
  else if (!b.paypal.emailConfirmed) e.paypal = "Confirm your email address with PayPal, then check again.";
  else if (!b.paypal.receivable) e.paypal = "PayPal says this account can't receive payments yet. Finish setting it up at PayPal, then check again.";
  return e;
}

function ownerView(b: Business) {
  const { ownerEmail, ...rest } = b;
  return { ...rest, email: ownerEmail, setupErrors: setupErrors(b), link: `/b/${b.handle}` };
}

function bookingView(bk: Booking) {
  return {
    ...bk,
    sessionId: undefined,
    businessGets: fromCents(businessGetsCents(bk)),
    refundable: canRefund(bk) ? fromCents(refundableCents(bk)) : "0.00",
    refunds: refundsFor(bk.id),
  };
}

function need(req: Request, res: Response): Business | null {
  const id = ownerOf(req);
  const b = id ? getBusiness(id) : undefined;
  if (!b) {
    res.status(401).json({ error: "Please sign in." });
    return null;
  }
  return b;
}

const ip = (req: Request) => req.ip ?? "unknown";

bizApi.get("/cities", (_req, res) => {
  res.json({ cities: Object.keys(CITIES) });
});

// ---------- sign-up and sign-in ----------
bizApi.post("/signup", async (req, res) => {
  if (!allowAuthTry(ip(req))) {
    res.status(429).json({ error: "Too many tries. Wait a few minutes." });
    return;
  }
  const { name, category, city, email, password } = req.body ?? {};
  const fields: Record<string, string> = {};
  if (typeof name !== "string" || name.trim().length < 2) fields.name = "Enter your business name.";
  if (typeof category !== "string" || !category.trim()) fields.category = "Say what kind of business it is.";
  if (typeof city !== "string" || !CITIES[city]) fields.city = "Choose your city.";
  if (typeof email !== "string" || !EMAIL.test(email.trim())) fields.email = "Enter a valid email address.";
  if (typeof password !== "string" || password.length < 8) fields.password = "Use at least 8 characters.";
  if (!fields.email && getBusinessByEmail(email)) fields.email = "This email already has a business. Sign in instead.";
  if (Object.keys(fields).length) {
    res.status(400).json({ fields });
    return;
  }
  const b = createBusiness({
    name: name.trim().slice(0, 80),
    category: category.trim().slice(0, 60),
    city,
    timezone: CITIES[city],
    ownerEmail: email,
    passwordHash: await hashPassword(password),
  });
  startSession(res, b.id);
  res.json({ business: ownerView(b) });
});

bizApi.post("/login", async (req, res) => {
  if (!allowAuthTry(ip(req))) {
    res.status(429).json({ error: "Too many tries. Wait a few minutes." });
    return;
  }
  const { email, password } = req.body ?? {};
  const b = typeof email === "string" ? getBusinessByEmail(email) : undefined;
  if (!b || typeof password !== "string" || !(await checkPassword(password, b.passwordHash))) {
    res.status(401).json({ error: "That email and password don't match." });
    return;
  }
  startSession(res, b.id);
  res.json({ business: ownerView(getBusiness(b.id)!) });
});

// ---------- the simulated businesses, open to anyone trying the demo ----------
const demoBusinesses = () => bookableBusinesses().filter((b) => b.demo);

bizApi.get("/demos", (_req, res) => {
  res.json({
    signup: signupOpen(),
    businesses: demoBusinesses().map((b) => ({ id: b.id, name: b.name, category: b.category, city: b.city, link: `/b/${b.handle}` })),
  });
});

bizApi.post("/demo", (req, res) => {
  if (!allowAuthTry(ip(req))) {
    res.status(429).json({ error: "Too many tries. Wait a few minutes." });
    return;
  }
  const b = demoBusinesses().find((x) => x.id === req.body?.businessId);
  if (!b) {
    res.status(404).json({ error: "No such demo business." });
    return;
  }
  startSession(res, b.id);
  res.json({ business: ownerView(b) });
});

bizApi.post("/logout", (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});

bizApi.get("/me", (req, res) => {
  const b = need(req, res);
  if (b) res.json({ business: ownerView(b), cities: Object.keys(CITIES), demoPayouts: paypalMode() !== "live", selfServe: signupOpen(), flow: paypalFlow() });
});

// ---------- setup ----------
bizApi.put("/profile", (req, res) => {
  const b = need(req, res);
  if (!b) return;
  const body = req.body ?? {};
  const fields: Record<string, string> = {};
  const patch: Parameters<typeof updateBusiness>[1] = {};

  if ("name" in body) {
    if (typeof body.name !== "string" || body.name.trim().length < 2) fields.name = "Enter your business name.";
    else patch.name = body.name.trim().slice(0, 80);
  }
  if ("category" in body) {
    if (typeof body.category !== "string" || !body.category.trim()) fields.category = "Say what kind of business it is.";
    else patch.category = body.category.trim().slice(0, 60);
  }
  if ("city" in body) {
    if (!CITIES[body.city]) fields.city = "Choose your city.";
    else {
      patch.city = body.city;
      patch.timezone = CITIES[body.city];
    }
  }
  if ("about" in body) patch.about = String(body.about ?? "").slice(0, 500);
  if ("notes" in body) patch.notes = String(body.notes ?? "").slice(0, 2000);
  if ("cancelHours" in body) {
    const n = Number(body.cancelHours);
    if (!Number.isInteger(n) || n < 0 || n > 168) fields.cancelHours = "Enter whole hours from 0 to 168.";
    else patch.cancelHours = n;
  }
  if ("hours" in body) {
    const hours: Hours = {};
    for (let d = 0; d < 7; d++) {
      const h = body.hours?.[d];
      if (h === null || h === undefined) {
        hours[d] = null;
        continue;
      }
      if (!Array.isArray(h) || !TIME.test(h[0]) || !TIME.test(h[1]) || h[0] >= h[1]) {
        fields.hours = "Each open day needs an opening time before its closing time.";
        break;
      }
      hours[d] = [h[0], h[1]];
    }
    if (!fields.hours) patch.hours = hours;
  }
  if (Object.keys(fields).length) {
    res.status(400).json({ fields });
    return;
  }
  const updated = updateBusiness(b.id, patch);
  // Going live needs everything; if something required was removed, stop taking bookings.
  if (updated.status === "live" && Object.keys(setupErrors(updated)).length) updateBusiness(b.id, { status: "setup" });
  res.json({ business: ownerView(getBusiness(b.id)!) });
});

bizApi.put("/items", (req, res) => {
  const b = need(req, res);
  if (!b) return;
  const list = req.body?.items;
  if (!Array.isArray(list) || list.length > 50) {
    res.status(400).json({ error: "Bad request" });
    return;
  }
  const rows: Record<number, string> = {};
  const items = list.map((it: Record<string, unknown>, i: number) => {
    const kind = it.kind === "pickup" ? "pickup" : "appointment";
    const name = String(it.name ?? "").trim();
    const price = String(it.price ?? "").trim();
    const minutes = Number(it.minutes);
    const limit = it.dailyLimit === "" || it.dailyLimit === null || it.dailyLimit === undefined ? null : Number(it.dailyLimit);
    if (!name) rows[i] = "Give it a name.";
    else if (!PRICE.test(price) || toCents(price) <= 0) rows[i] = "Enter a price above zero, like 25 or 25.00.";
    else if (kind === "appointment" && (!Number.isInteger(minutes) || minutes < 10 || minutes > 600)) rows[i] = "Length must be 10 to 600 minutes.";
    else if (kind === "pickup" && limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) rows[i] = "Daily limit must be 1 to 1000, or empty for no limit.";
    return {
      id: typeof it.id === "string" ? it.id : undefined,
      kind: kind as "appointment" | "pickup",
      name: name.slice(0, 80),
      price: PRICE.test(price) ? fromCents(toCents(price)) : price,
      minutes: kind === "appointment" ? minutes : 30,
      dailyLimit: kind === "pickup" ? limit : null,
    };
  });
  if (Object.keys(rows).length) {
    res.status(400).json({ rows });
    return;
  }
  saveItems(b.id, items);
  const updated = getBusiness(b.id)!;
  if (updated.status === "live" && Object.keys(setupErrors(updated)).length) updateBusiness(b.id, { status: "setup" });
  res.json({ business: ownerView(getBusiness(b.id)!) });
});

bizApi.post("/status", (req, res) => {
  const b = need(req, res);
  if (!b) return;
  const want = req.body?.status;
  if (want !== "live" && want !== "paused") {
    res.status(400).json({ error: "Bad request" });
    return;
  }
  if (want === "live") {
    const errors = setupErrors(b);
    if (Object.keys(errors).length) {
      res.status(400).json({ fields: errors });
      return;
    }
  }
  res.json({ business: ownerView(updateBusiness(b.id, { status: want })) });
});

// ---------- bookings and money ----------
bizApi.get("/bookings", (req, res) => {
  const b = need(req, res);
  if (!b) return;
  const list = listBookings(b.id);
  const sum = (f: (bk: Booking) => number) => fromCents(list.reduce((n, bk) => n + f(bk), 0));
  res.json({
    bookings: list.map(bookingView),
    totals: {
      sales: sum((bk) => toCents(bk.amount)),
      refunded: sum((bk) => toCents(bk.refunded)),
      fees: sum((bk) => toCents(bk.paypalFee)),
      platformFees: sum((bk) => toCents(bk.platformFee)),
      held: sum((bk) => (bk.releaseStatus === "held" || bk.releaseStatus === "releasing" ? businessGetsCents(bk) : 0)),
      released: sum((bk) => (bk.releaseStatus === "released" ? businessGetsCents(bk) : 0)),
    },
  });
});

bizApi.post("/bookings/:id/cancel", async (req, res) => {
  const b = need(req, res);
  if (!b) return;
  const out = await businessCancel(b.id, req.params.id, String(req.body?.refund ?? "0"));
  if (!out.ok) {
    res.status(422).json({ error: out.reason });
    return;
  }
  res.json({ booking: bookingView(out.booking) });
});

bizApi.post("/bookings/:id/refund", async (req, res) => {
  const b = need(req, res);
  if (!b) return;
  const out = await businessRefund(b.id, req.params.id, String(req.body?.amount ?? ""));
  if (!out.ok) {
    res.status(422).json({ error: out.reason });
    return;
  }
  res.json({ booking: bookingView(out.booking) });
});

/** Sandbox and test mode only: release held money now, because nobody can wait a day in a demo. */
bizApi.post("/releases/run", async (req, res) => {
  const b = need(req, res);
  if (!b) return;
  if (paypalMode() === "live") {
    res.status(403).json({ error: "Releases run on their own schedule." });
    return;
  }
  res.json(await runReleases({ forceBusinessId: b.id }));
});

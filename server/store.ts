// Businesses, what they sell, and bookings, stored in SQLite (db.ts).
// Holds are short-lived (15 minutes) and stay in memory.
import { randomUUID } from "node:crypto";
import { all, one, run, tx, type Row } from "./db.ts";

// ---------- money ----------
export const toCents = (s: string) => {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s.trim());
  if (!m) throw new Error(`Bad amount ${s}`);
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
};
export const fromCents = (c: number) => `${Math.floor(c / 100)}.${String(Math.abs(c) % 100).padStart(2, "0")}`;

// ---------- types ----------
export type ItemKind = "appointment" | "pickup";
export type Service = {
  id: string;
  businessId: string;
  kind: ItemKind;
  name: string;
  minutes: number; // appointments: length; pickups: the pickup slot (30)
  price: string;
  dailyLimit: number | null; // pickups only
  active: boolean;
};
export type Hours = Record<number, [string, string] | null>; // 0 = Sunday
export type BusinessStatus = "setup" | "live" | "paused";
export type Business = {
  id: string;
  handle: string;
  name: string;
  category: string;
  city: string;
  timezone: string;
  currency: "USD";
  about: string;
  notes: string;
  cancelHours: number | null;
  policy: string;
  hours: Hours;
  paypal: {
    trackingId: string | null;
    merchantId: string | null;
    email: string | null;
    receivable: boolean;
    emailConfirmed: boolean;
    checkedAt: number | null;
  };
  status: BusinessStatus;
  demo: boolean;
  ownerEmail: string | null;
  services: Service[]; // active ones
  createdAt: number;
};

export type Hold = {
  id: string;
  businessId: string;
  serviceId: string;
  date: string;
  time: string;
  customerName: string;
  sessionId: string;
  createdAt: number;
  expiresAt: number;
  status: "held" | "paid" | "expired" | "released";
  orderId?: string;
  /** Unguessable token for the hosted pay page (/pay/<token>), given to the customer only. */
  payToken?: string;
};

/** held: PayPal holds it; releasing: asked PayPal; released: PayPal confirmed; none: nothing to release. */
export type ReleaseStatus = "held" | "releasing" | "released" | "failed" | "none";
export type Booking = {
  id: string;
  ref: string;
  businessId: string;
  serviceId: string;
  serviceName: string;
  kind: ItemKind;
  date: string;
  time: string;
  startsAt: number;
  minutes: number;
  customerName: string;
  sessionId: string;
  amount: string;
  currency: string;
  orderId: string;
  captureId: string;
  payeeMerchantId: string;
  paypalFee: string;
  platformFee: string;
  netAmount: string;
  payerId: string | null;
  payerName: string | null;
  payerEmail: string | null;
  status: "confirmed" | "cancelled";
  cancelledBy: "customer" | "business" | null;
  refunded: string;
  releaseDueAt: number;
  releaseStatus: ReleaseStatus;
  releaseItemId: string | null;
  releaseNote: string | null;
  releasedAt: number | null;
  createdAt: number;
};

export const HOLD_MINUTES = 15;
export const RELEASE_DELAY_MS = Number(process.env.RELEASE_DELAY_HOURS ?? process.env.PAYOUT_DELAY_HOURS ?? 24) * 3_600_000;
/** Ordina's fee on a sale, as a percentage taken by PayPal as a platform fee. 0 at launch. */
export const PLATFORM_FEE_PERCENT = Number(process.env.PLATFORM_FEE_PERCENT ?? 0);

/** True when PayPal itself says this business can be paid (rule 6). */
export const canBePaid = (b: Pick<Business, "paypal">) => !!b.paypal.merchantId && b.paypal.receivable && b.paypal.emailConfirmed;

export const policyText = (b: { cancelHours: number | null; services?: Service[] }) => {
  if (b.cancelHours === null) return "";
  const pickupOnly = (b.services ?? []).length > 0 && (b.services ?? []).every((s) => s.kind === "pickup");
  return b.cancelHours === 0
    ? "Cancel any time before it starts for a full refund."
    : `Free cancellation up to ${b.cancelHours} hours before ${pickupOnly ? "pickup" : "the appointment"}, full refund.`;
};

// ---------- row mapping ----------
function toService(r: Row): Service {
  return {
    id: String(r.id),
    businessId: String(r.business_id),
    kind: r.kind as ItemKind,
    name: String(r.name),
    minutes: Number(r.minutes),
    price: String(r.price),
    dailyLimit: r.daily_limit === null || r.daily_limit === undefined ? null : Number(r.daily_limit),
    active: Number(r.active) === 1,
  };
}

function toBusiness(r: Row): Business {
  const services = all("SELECT * FROM items WHERE business_id = ? AND active = 1 ORDER BY position, rowid", r.id).map(toService);
  const b: Business = {
    id: String(r.id),
    handle: String(r.handle),
    name: String(r.name),
    category: String(r.category),
    city: String(r.city),
    timezone: String(r.timezone),
    currency: "USD",
    about: String(r.about),
    notes: String(r.notes),
    cancelHours: r.cancel_hours === null ? null : Number(r.cancel_hours),
    policy: "",
    hours: JSON.parse(String(r.hours_json || "{}")),
    paypal: {
      trackingId: S(r.paypal_tracking_id),
      merchantId: S(r.paypal_merchant_id),
      email: S(r.paypal_email),
      receivable: Number(r.paypal_receivable) === 1,
      emailConfirmed: Number(r.paypal_email_confirmed) === 1,
      checkedAt: r.paypal_checked_at == null ? null : Number(r.paypal_checked_at),
    },
    status: r.status as BusinessStatus,
    demo: Number(r.demo) === 1,
    ownerEmail: (r.owner_email as string | null) ?? null,
    services,
    createdAt: Number(r.created_at),
  };
  b.policy = policyText(b);
  return b;
}

const S = (v: unknown) => (v === null || v === undefined ? null : String(v));
function toBooking(r: Row): Booking {
  return {
    id: String(r.id),
    ref: String(r.ref),
    businessId: String(r.business_id),
    serviceId: String(r.item_id),
    serviceName: String(r.item_name),
    kind: r.kind as ItemKind,
    date: String(r.date),
    time: String(r.time),
    startsAt: Number(r.starts_at),
    minutes: Number(r.minutes),
    customerName: String(r.customer_name),
    sessionId: String(r.session_id),
    amount: String(r.amount),
    currency: String(r.currency),
    orderId: String(r.order_id),
    captureId: String(r.capture_id),
    payeeMerchantId: String(r.payee_merchant_id),
    paypalFee: String(r.paypal_fee),
    platformFee: String(r.platform_fee),
    netAmount: String(r.net_amount),
    payerId: S(r.payer_id),
    payerName: S(r.payer_name),
    payerEmail: S(r.payer_email),
    status: r.status as Booking["status"],
    cancelledBy: (S(r.cancelled_by) as Booking["cancelledBy"]) ?? null,
    refunded: String(r.refunded),
    releaseDueAt: Number(r.release_due_at),
    releaseStatus: r.release_status as ReleaseStatus,
    releaseItemId: S(r.release_item_id),
    releaseNote: S(r.release_note),
    releasedAt: r.released_at == null ? null : Number(r.released_at),
    createdAt: Number(r.created_at),
  };
}

// ---------- businesses ----------
export function getBusiness(id: string): Business | undefined {
  const r = one("SELECT * FROM businesses WHERE id = ?", id);
  return r ? toBusiness(r) : undefined;
}
export function getBusinessByHandle(handle: string): Business | undefined {
  const r = one("SELECT * FROM businesses WHERE handle = ?", handle.toLowerCase());
  return r ? toBusiness(r) : undefined;
}
export function getBusinessByEmail(email: string): (Business & { passwordHash: string | null }) | undefined {
  const r = one("SELECT * FROM businesses WHERE owner_email = ?", email.trim().toLowerCase());
  return r ? { ...toBusiness(r), passwordHash: S(r.password_hash) } : undefined;
}
export function getBusinessByTracking(trackingId: string): Business | undefined {
  const r = one("SELECT * FROM businesses WHERE paypal_tracking_id = ?", trackingId);
  return r ? toBusiness(r) : undefined;
}
/** Businesses customers' agents can find: live and able to be paid. */
export function liveBusinesses(): Business[] {
  return all("SELECT * FROM businesses WHERE status = 'live' ORDER BY demo, created_at").map(toBusiness).filter(canBePaid);
}
export function getService(b: Business, serviceId: string): Service | undefined {
  return b.services.find((s) => s.id === serviceId);
}
/** Any item, even one switched off since, for bookings already made. */
export function getItemAnyState(id: string): Service | undefined {
  const r = one("SELECT * FROM items WHERE id = ?", id);
  return r ? toService(r) : undefined;
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "business"
  );
}
export function uniqueHandle(name: string): string {
  const base = slugify(name);
  let h = base;
  for (let i = 2; one("SELECT 1 FROM businesses WHERE handle = ?", h); i++) h = `${base}-${i}`;
  return h;
}

export function createBusiness(input: {
  name: string;
  category: string;
  city: string;
  timezone: string;
  ownerEmail?: string;
  passwordHash?: string;
  demo?: boolean;
  id?: string;
  handle?: string;
}): Business {
  const id = input.id ?? `biz_${randomUUID().slice(0, 12)}`;
  run(
    `INSERT INTO businesses (id, handle, name, category, city, timezone, owner_email, password_hash, demo, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.handle ?? uniqueHandle(input.name),
    input.name.trim(),
    input.category.trim(),
    input.city.trim(),
    input.timezone,
    input.ownerEmail?.trim().toLowerCase() ?? null,
    input.passwordHash ?? null,
    input.demo ? 1 : 0,
    Date.now(),
  );
  return getBusiness(id)!;
}

export function updateBusiness(
  id: string,
  patch: Partial<{
    name: string;
    category: string;
    city: string;
    timezone: string;
    about: string;
    notes: string;
    cancelHours: number | null;
    hours: Hours;
    status: BusinessStatus;
    paypalTrackingId: string | null;
    paypalMerchantId: string | null;
    paypalEmail: string | null;
    paypalReceivable: boolean;
    paypalEmailConfirmed: boolean;
    paypalCheckedAt: number;
  }>,
): Business {
  const cols: Record<string, unknown> = {
    name: patch.name,
    category: patch.category,
    city: patch.city,
    timezone: patch.timezone,
    about: patch.about,
    notes: patch.notes,
    cancel_hours: patch.cancelHours,
    hours_json: patch.hours === undefined ? undefined : JSON.stringify(patch.hours),
    status: patch.status,
    paypal_tracking_id: patch.paypalTrackingId,
    paypal_merchant_id: patch.paypalMerchantId,
    paypal_email: patch.paypalEmail,
    paypal_receivable: patch.paypalReceivable === undefined ? undefined : patch.paypalReceivable ? 1 : 0,
    paypal_email_confirmed: patch.paypalEmailConfirmed === undefined ? undefined : patch.paypalEmailConfirmed ? 1 : 0,
    paypal_checked_at: patch.paypalCheckedAt,
  };
  const set = Object.entries(cols).filter(([, v]) => v !== undefined);
  if (set.length) run(`UPDATE businesses SET ${set.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`, ...set.map(([, v]) => v), id);
  return getBusiness(id)!;
}

/** Replace the whole list of what a business sells. Old items are switched off, not deleted, so past bookings keep them. */
export function saveItems(
  businessId: string,
  items: Array<{ id?: string; kind: ItemKind; name: string; minutes: number; price: string; dailyLimit: number | null }>,
): Service[] {
  tx(() => {
    run("UPDATE items SET active = 0 WHERE business_id = ?", businessId);
    items.forEach((it, i) => {
      const existing = it.id ? one("SELECT id FROM items WHERE id = ? AND business_id = ?", it.id, businessId) : undefined;
      if (existing) {
        run(
          "UPDATE items SET kind = ?, name = ?, minutes = ?, price = ?, daily_limit = ?, active = 1, position = ? WHERE id = ?",
          it.kind,
          it.name,
          it.minutes,
          it.price,
          it.dailyLimit,
          i,
          it.id!,
        );
      } else {
        run(
          "INSERT INTO items (id, business_id, kind, name, minutes, price, daily_limit, active, position) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)",
          `item_${randomUUID().slice(0, 10)}`,
          businessId,
          it.kind,
          it.name,
          it.minutes,
          it.price,
          it.dailyLimit,
          i,
        );
      }
    });
  });
  return getBusiness(businessId)!.services;
}

// ---------- time ----------
export function localNow(timezone: string, now = new Date()): { date: string; time: string; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  return { date, time: `${hour}:${get("minute")}`, weekday: weekdayOf(date) };
}
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
/** The UTC instant of a business-local date and time. */
export function zonedToUtc(date: string, time: string, timezone: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asLocal = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return guess - (asLocal - guess);
}
const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const toHHMM = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

// ---------- holds (memory) ----------
const holds = new Map<string, Hold>();
function expireHolds(now = Date.now()) {
  for (const h of holds.values()) if (h.status === "held" && h.expiresAt <= now) h.status = "expired";
}

/** Appointment minutes already taken on a date (any appointment blocks the calendar). */
function busyAppointments(businessId: string, date: string): Array<[number, number]> {
  expireHolds();
  const out: Array<[number, number]> = [];
  for (const h of holds.values()) {
    if (h.businessId !== businessId || h.date !== date || h.status !== "held") continue;
    const s = getItemAnyState(h.serviceId);
    if (s?.kind === "appointment") out.push([toMin(h.time), toMin(h.time) + s.minutes]);
  }
  for (const r of all(
    "SELECT time, minutes FROM bookings WHERE business_id = ? AND date = ? AND status = 'confirmed' AND kind = 'appointment'",
    businessId,
    date,
  )) {
    out.push([toMin(String(r.time)), toMin(String(r.time)) + Number(r.minutes)]);
  }
  return out;
}

/** How many of a pickup item are already taken (paid or held) on a date. */
function pickupCount(itemId: string, date: string): number {
  expireHolds();
  let n = 0;
  for (const h of holds.values()) if (h.serviceId === itemId && h.date === date && h.status === "held") n++;
  const r = one("SELECT COUNT(*) AS n FROM bookings WHERE item_id = ? AND date = ? AND status = 'confirmed'", itemId, date);
  return n + Number(r?.n ?? 0);
}

/** Free start or pickup times (every 30 minutes) for one item on a business-local date. */
export function availability(businessId: string, serviceId: string, date: string, now = new Date()): string[] {
  const b = getBusiness(businessId);
  if (!b) return [];
  const s = getService(b, serviceId);
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  const today = localNow(b.timezone, now);
  if (date < today.date || date > addDays(today.date, 14)) return [];
  const hours = b.hours[weekdayOf(date)];
  if (!hours) return [];
  const [open, close] = hours.map(toMin);
  const earliest = date === today.date ? toMin(today.time) + 60 : 0; // an hour's notice
  if (s.kind === "pickup") {
    if (s.dailyLimit !== null && pickupCount(s.id, date) >= s.dailyLimit) return [];
    const slots: string[] = [];
    for (let t = open; t + 30 <= close; t += 30) if (t >= earliest) slots.push(toHHMM(t));
    return slots;
  }
  const taken = busyAppointments(businessId, date);
  const slots: string[] = [];
  for (let start = open; start + s.minutes <= close; start += 30) {
    if (start < earliest) continue;
    const end = start + s.minutes;
    if (taken.some(([a, z]) => start < z && a < end)) continue;
    slots.push(toHHMM(start));
  }
  return slots;
}

export function createHold(input: {
  businessId: string;
  serviceId: string;
  date: string;
  time: string;
  customerName: string;
  sessionId: string;
}): Hold | { error: string } {
  const b = getBusiness(input.businessId);
  if (!b) return { error: "Unknown business." };
  if (b.status !== "live" || !canBePaid(b)) return { error: `${b.name} is not taking bookings right now.` };
  const s = getService(b, input.serviceId);
  if (!s) return { error: "Unknown item." };
  const name = input.customerName.trim().slice(0, 80);
  if (!name) return { error: "A customer name is needed to hold a time." };
  if (!availability(b.id, s.id, input.date).includes(input.time)) {
    return { error: `${input.time} on ${input.date} is not available for ${s.name}.` };
  }
  for (const h of holds.values()) {
    if (h.sessionId === input.sessionId && h.businessId === b.id && h.status === "held") h.status = "released";
  }
  const now = Date.now();
  const hold: Hold = {
    id: `hold_${randomUUID().slice(0, 8)}`,
    businessId: b.id,
    serviceId: s.id,
    date: input.date,
    time: input.time,
    customerName: name,
    sessionId: input.sessionId,
    createdAt: now,
    expiresAt: now + HOLD_MINUTES * 60_000,
    status: "held",
  };
  holds.set(hold.id, hold);
  return hold;
}
export function getHold(id: string): Hold | undefined {
  expireHolds();
  return holds.get(id);
}
export function holdByPayToken(token: string): Hold | undefined {
  expireHolds();
  for (const h of holds.values()) if (h.payToken && h.payToken === token) return h;
  return undefined;
}
export function holdByOrder(orderId: string): Hold | undefined {
  expireHolds();
  for (const h of holds.values()) if (h.orderId === orderId) return h;
  return undefined;
}

// ---------- bookings ----------
export function confirmBooking(
  hold: Hold,
  pay: {
    orderId: string;
    captureId: string;
    amount: string;
    currency: string;
    payeeMerchantId: string;
    paypalFee: string;
    platformFee: string;
    netAmount: string;
    payerId?: string;
    payerName?: string;
    payerEmail?: string;
  },
): Booking {
  const b = getBusiness(hold.businessId)!;
  const s = getItemAnyState(hold.serviceId)!;
  hold.status = "paid";
  const id = `bk_${randomUUID().slice(0, 10)}`;
  const startsAt = zonedToUtc(hold.date, hold.time, b.timezone);
  const minutes = s.kind === "appointment" ? s.minutes : 30;
  run(
    `INSERT INTO bookings (id, ref, business_id, item_id, item_name, kind, date, time, starts_at, minutes, customer_name, session_id,
       amount, currency, order_id, capture_id, payee_merchant_id, paypal_fee, platform_fee, net_amount,
       payer_id, payer_name, payer_email, release_due_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    randomUUID().slice(0, 6).toUpperCase(),
    b.id,
    s.id,
    s.name,
    s.kind,
    hold.date,
    hold.time,
    startsAt,
    minutes,
    hold.customerName,
    hold.sessionId,
    pay.amount,
    pay.currency,
    pay.orderId,
    pay.captureId,
    pay.payeeMerchantId,
    pay.paypalFee,
    pay.platformFee,
    pay.netAmount,
    pay.payerId ?? null,
    pay.payerName ?? null,
    pay.payerEmail?.toLowerCase() ?? null,
    startsAt + minutes * 60_000 + RELEASE_DELAY_MS,
    Date.now(),
  );
  return getBooking(id)!;
}

export function getBooking(id: string): Booking | undefined {
  const r = one("SELECT * FROM bookings WHERE id = ?", id);
  return r ? toBooking(r) : undefined;
}
export function bookingByOrder(orderId: string): Booking | undefined {
  const r = one("SELECT * FROM bookings WHERE order_id = ?", orderId);
  return r ? toBooking(r) : undefined;
}
export function bookingsForSessions(sessionIds: string[]): Booking[] {
  if (!sessionIds.length) return [];
  return all(
    `SELECT * FROM bookings WHERE session_id IN (${sessionIds.map(() => "?").join(",")}) ORDER BY created_at DESC`,
    ...sessionIds,
  ).map(toBooking);
}
/** Every booking paid by one PayPal customer (their identity is the PayPal payer). */
export function bookingsForPayer(payerEmail: string): Booking[] {
  return all("SELECT * FROM bookings WHERE payer_email = ? ORDER BY created_at DESC", payerEmail.trim().toLowerCase()).map(toBooking);
}
export function listBookings(businessId: string): Booking[] {
  return all("SELECT * FROM bookings WHERE business_id = ? ORDER BY starts_at DESC", businessId).map(toBooking);
}
export function updateBooking(id: string, patch: Record<string, string | number | null>) {
  const set = Object.entries(patch);
  run(`UPDATE bookings SET ${set.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`, ...set.map(([, v]) => v), id);
  return getBooking(id)!;
}
export function addRefund(r: { id: string; bookingId: string; amount: string; status: string; by: string }) {
  run(
    "INSERT OR IGNORE INTO refunds (id, booking_id, amount, status, by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    r.id,
    r.bookingId,
    r.amount,
    r.status,
    r.by,
    Date.now(),
  );
}
export function refundsFor(bookingId: string) {
  return all("SELECT * FROM refunds WHERE booking_id = ? ORDER BY created_at", bookingId).map((r) => ({
    id: String(r.id),
    amount: String(r.amount),
    status: String(r.status),
    by: String(r.by),
    createdAt: Number(r.created_at),
  }));
}
/** Bookings whose money PayPal still holds and whose release time has come. */
export function releasesDue(now: number): Booking[] {
  return all("SELECT * FROM bookings WHERE release_status = 'held' AND release_due_at <= ? ORDER BY business_id", now).map(toBooking);
}
/** Releases PayPal accepted but has not finished. */
export function releasesInFlight(): Booking[] {
  return all("SELECT * FROM bookings WHERE release_status = 'releasing'").map(toBooking);
}

/** Test helper: empty bookings and holds, keep businesses. */
export function resetStore() {
  holds.clear();
  run("DELETE FROM refunds");
  run("DELETE FROM bookings");
}

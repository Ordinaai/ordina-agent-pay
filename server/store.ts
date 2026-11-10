// In-memory demo data. Everything resets when the server restarts, which is
// what a public hackathon demo wants: judges always start from a clean slate.
import { randomUUID } from "node:crypto";

export type Service = {
  id: string;
  name: string;
  minutes: number;
  price: string; // decimal string in the business currency, e.g. "35.00"
};

export type Business = {
  id: string;
  name: string;
  category: string;
  city: string;
  timezone: string;
  currency: "USD";
  about: string;
  policy: string;
  hours: Record<number, [string, string] | null>; // 0 = Sunday
  services: Service[];
};

export type Hold = {
  id: string;
  businessId: string;
  serviceId: string;
  date: string; // YYYY-MM-DD, business local
  time: string; // HH:mm, business local
  customerName: string;
  sessionId: string;
  createdAt: number;
  expiresAt: number;
  status: "held" | "paid" | "expired" | "released";
  orderId?: string;
};

export type Booking = {
  id: string;
  ref: string;
  holdId: string;
  businessId: string;
  serviceId: string;
  serviceName: string;
  date: string;
  time: string;
  customerName: string;
  sessionId: string;
  amount: string;
  currency: string;
  orderId: string;
  captureId: string;
  status: "confirmed" | "refund_pending" | "refunded";
  createdAt: number;
  refundedAt?: number;
  refundId?: string;
};

export const HOLD_MINUTES = 15;

const weekdays = (open: string, close: string): Business["hours"] => ({
  0: null,
  1: [open, close],
  2: [open, close],
  3: [open, close],
  4: [open, close],
  5: [open, close],
  6: ["10:00", "16:00"],
});

// Fictional businesses only: the video and the demo must not show real names.
export const BUSINESSES: Business[] = [
  {
    id: "lumen-hair",
    name: "Lumen Hair Studio",
    category: "Hair salon",
    city: "Lagos",
    timezone: "Africa/Lagos",
    currency: "USD",
    about: "Natural hair care, braids and silk presses in Lekki Phase 1.",
    policy: "Free cancellation up to 24 hours before the appointment, full refund.",
    hours: weekdays("09:00", "18:00"),
    services: [
      { id: "silk-press", name: "Silk press", minutes: 90, price: "35.00" },
      { id: "knotless-braids", name: "Knotless braids (medium)", minutes: 240, price: "80.00" },
      { id: "wash-style", name: "Wash and style", minutes: 60, price: "20.00" },
    ],
  },
  {
    id: "harbour-physio",
    name: "Harbour Physio",
    category: "Physiotherapy",
    city: "London",
    timezone: "Europe/London",
    currency: "USD",
    about: "Sports injuries and back pain, two chartered physiotherapists.",
    policy: "Cancel up to 12 hours before for a full refund.",
    hours: weekdays("08:00", "19:00"),
    services: [
      { id: "assessment", name: "Initial assessment", minutes: 45, price: "65.00" },
      { id: "follow-up", name: "Follow-up session", minutes: 30, price: "45.00" },
      { id: "sports-massage", name: "Sports massage", minutes: 60, price: "55.00" },
    ],
  },
  {
    id: "green-table",
    name: "Green Table Cooking School",
    category: "Cooking classes",
    city: "Nairobi",
    timezone: "Africa/Nairobi",
    currency: "USD",
    about: "Small group cooking classes, East African and plant-based menus.",
    policy: "Full refund up to 48 hours before the class.",
    hours: weekdays("11:00", "20:00"),
    services: [
      { id: "pilau-class", name: "Pilau and chapati class", minutes: 120, price: "40.00" },
      { id: "plant-based", name: "Plant-based weeknight class", minutes: 90, price: "30.00" },
    ],
  },
];

const holds = new Map<string, Hold>();
const bookings = new Map<string, Booking>();

export function getBusiness(id: string): Business | undefined {
  return BUSINESSES.find((b) => b.id === id);
}

export function getService(b: Business, serviceId: string): Service | undefined {
  return b.services.find((s) => s.id === serviceId);
}

/** Today's date (YYYY-MM-DD) and the current time (HH:mm) in a timezone. */
export function localNow(timezone: string, now = new Date()): { date: string; time: string; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
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
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const toHHMM = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

function expireHolds(now = Date.now()) {
  for (const h of holds.values()) {
    if (h.status === "held" && h.expiresAt <= now) h.status = "expired";
  }
}

/** Minutes [start, end) already taken on a date by live holds and bookings. */
function busy(businessId: string, date: string, exceptHoldId?: string): Array<[number, number]> {
  expireHolds();
  const b = getBusiness(businessId)!;
  const out: Array<[number, number]> = [];
  for (const h of holds.values()) {
    if (h.businessId !== businessId || h.date !== date || h.id === exceptHoldId) continue;
    if (h.status !== "held") continue;
    const s = getService(b, h.serviceId)!;
    out.push([toMin(h.time), toMin(h.time) + s.minutes]);
  }
  for (const bk of bookings.values()) {
    if (bk.businessId !== businessId || bk.date !== date || bk.status !== "confirmed") continue;
    const s = getService(b, bk.serviceId)!;
    out.push([toMin(bk.time), toMin(bk.time) + s.minutes]);
  }
  return out;
}

/** Free start times (every 30 minutes) for a service on a business-local date. */
export function availability(businessId: string, serviceId: string, date: string, now = new Date()): string[] {
  const b = getBusiness(businessId);
  if (!b) return [];
  const s = getService(b, serviceId);
  if (!s) return [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  const today = localNow(b.timezone, now);
  if (date < today.date || date > addDays(today.date, 14)) return [];
  const hours = b.hours[weekdayOf(date)];
  if (!hours) return [];
  const [open, close] = hours.map(toMin);
  const taken = busy(businessId, date);
  const earliest = date === today.date ? toMin(today.time) + 60 : 0; // at least an hour's notice
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
  const s = getService(b, input.serviceId);
  if (!s) return { error: "Unknown service." };
  const name = input.customerName.trim().slice(0, 80);
  if (!name) return { error: "A customer name is needed to hold a time." };
  if (!availability(b.id, s.id, input.date).includes(input.time)) {
    return { error: `${input.time} on ${input.date} is not free for ${s.name}.` };
  }
  // One live hold per conversation and business: a new hold replaces the old one.
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

export function holdByOrder(orderId: string): Hold | undefined {
  expireHolds();
  for (const h of holds.values()) if (h.orderId === orderId) return h;
  return undefined;
}

export function confirmBooking(hold: Hold, pay: { orderId: string; captureId: string; amount: string; currency: string }): Booking {
  const b = getBusiness(hold.businessId)!;
  const s = getService(b, hold.serviceId)!;
  hold.status = "paid";
  const booking: Booking = {
    id: `bk_${randomUUID().slice(0, 8)}`,
    ref: randomUUID().slice(0, 6).toUpperCase(),
    holdId: hold.id,
    businessId: b.id,
    serviceId: s.id,
    serviceName: s.name,
    date: hold.date,
    time: hold.time,
    customerName: hold.customerName,
    sessionId: hold.sessionId,
    amount: pay.amount,
    currency: pay.currency,
    orderId: pay.orderId,
    captureId: pay.captureId,
    status: "confirmed",
    createdAt: Date.now(),
  };
  bookings.set(booking.id, booking);
  return booking;
}

export function getBooking(id: string): Booking | undefined {
  return bookings.get(id);
}

export function bookingByOrder(orderId: string): Booking | undefined {
  for (const bk of bookings.values()) if (bk.orderId === orderId) return bk;
  return undefined;
}

export function listBookings(businessId?: string): Booking[] {
  return [...bookings.values()]
    .filter((b) => !businessId || b.businessId === businessId)
    .sort((a, z) => z.createdAt - a.createdAt);
}

/** Test helper. */
export function resetStore() {
  holds.clear();
  bookings.clear();
}

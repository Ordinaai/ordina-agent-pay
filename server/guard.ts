// Spend protection for a public demo whose AI key lives on the server.
const PER_IP_PER_HOUR = Number(process.env.TURNS_PER_IP_PER_HOUR ?? 30);
const PER_DAY = Number(process.env.DAILY_TURN_CAP ?? 400);

const ipHits = new Map<string, number[]>();
let day = new Date().toISOString().slice(0, 10);
let dayCount = 0;

export function allowTurn(ip: string, now = Date.now()): { ok: true } | { ok: false; reason: string } {
  const today = new Date(now).toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    dayCount = 0;
  }
  if (dayCount >= PER_DAY) return { ok: false, reason: "The demo has reached today's limit. Please come back tomorrow." };
  const hits = (ipHits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (hits.length >= PER_IP_PER_HOUR) return { ok: false, reason: "That's a lot of messages in an hour. Please wait a little." };
  hits.push(now);
  ipHits.set(ip, hits);
  dayCount++;
  return { ok: true };
}

export const validSession = (s: unknown): s is string => typeof s === "string" && /^[a-z0-9-]{8,64}$/.test(s);

// Business owner sign-in: email and password, scrypt hashes, and an opaque
// session token in an httpOnly cookie (only its SHA-256 is stored).
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Request, Response } from "express";
import { one, run } from "./db.ts";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const COOKIE = "ap_owner";
const DAYS_30 = 30 * 86_400_000;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function checkPassword(pw: string, stored: string | null): Promise<boolean> {
  if (!stored?.startsWith("scrypt$")) return false;
  const [, salt, key] = stored.split("$");
  const want = Buffer.from(key, "base64");
  const got = await scrypt(pw, Buffer.from(salt, "base64"), want.length);
  return timingSafeEqual(want, got);
}

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

export function startSession(res: Response, businessId: string) {
  const token = randomBytes(32).toString("base64url");
  run("INSERT INTO owner_sessions (token_hash, business_id, expires_at) VALUES (?, ?, ?)", sha(token), businessId, Date.now() + DAYS_30);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: DAYS_30,
    path: "/",
  });
}

export function endSession(req: Request, res: Response) {
  const t = readCookie(req);
  if (t) run("DELETE FROM owner_sessions WHERE token_hash = ?", sha(t));
  res.clearCookie(COOKIE, { path: "/" });
}

function readCookie(req: Request): string | null {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** The signed-in owner's business id, or null. */
export function ownerOf(req: Request): string | null {
  const t = readCookie(req);
  if (!t) return null;
  const r = one("SELECT business_id, expires_at FROM owner_sessions WHERE token_hash = ?", sha(t));
  if (!r || Number(r.expires_at) < Date.now()) return null;
  return String(r.business_id);
}

/** Small per-IP limiter for sign-in and sign-up. */
const tries = new Map<string, number[]>();
export function allowAuthTry(ip: string, now = Date.now()): boolean {
  const list = (tries.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
  if (list.length >= 20) return false;
  list.push(now);
  tries.set(ip, list);
  return true;
}

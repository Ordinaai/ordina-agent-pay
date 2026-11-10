// SQLite through Node's built-in driver. One file on the Render disk in
// production (DATA_DIR=/var/data); in memory for tests (DATA_DIR=:memory:).
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const dir = process.env.DATA_DIR ?? path.resolve(process.cwd(), "data");
const file = dir === ":memory:" ? ":memory:" : path.join(dir, "agentpay.db");
if (file !== ":memory:") mkdirSync(dir, { recursive: true });

export const db = new DatabaseSync(file);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");

db.exec(`
CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  about TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  cancel_hours INTEGER,
  hours_json TEXT NOT NULL DEFAULT '{}',
  payout_email TEXT,
  status TEXT NOT NULL DEFAULT 'setup',      -- setup | live | paused
  demo INTEGER NOT NULL DEFAULT 0,
  owner_email TEXT UNIQUE,
  password_hash TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                        -- appointment | pickup
  name TEXT NOT NULL,
  minutes INTEGER NOT NULL DEFAULT 30,
  price TEXT NOT NULL,                       -- "35.00"
  daily_limit INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  item_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  starts_at INTEGER NOT NULL,                -- UTC ms
  minutes INTEGER NOT NULL,
  customer_name TEXT NOT NULL,
  session_id TEXT NOT NULL,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  order_id TEXT NOT NULL UNIQUE,
  capture_id TEXT NOT NULL,
  paypal_fee TEXT NOT NULL DEFAULT '0.00',
  net_amount TEXT NOT NULL,                  -- what PayPal credited Ordina for this sale
  payer_name TEXT,
  payer_email TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed',  -- confirmed | cancelled
  cancelled_by TEXT,                         -- customer | business
  refunded TEXT NOT NULL DEFAULT '0.00',     -- gross refunded to the customer
  refund_debit TEXT NOT NULL DEFAULT '0.00', -- what PayPal took back from Ordina for those refunds
  payout_due_at INTEGER NOT NULL,
  payout_status TEXT NOT NULL DEFAULT 'waiting', -- waiting | sending | sent | paid | unclaimed | failed | none
  payout_amount TEXT,
  payout_batch_id TEXT,
  payout_item_id TEXT,
  payout_note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bookings_business ON bookings(business_id, starts_at);
CREATE INDEX IF NOT EXISTS bookings_session ON bookings(session_id);
CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,                       -- PayPal refund id
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  amount TEXT NOT NULL,
  debit TEXT NOT NULL,
  status TEXT NOT NULL,
  by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS owner_sessions (
  token_hash TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
`);

export type Row = Record<string, unknown>;
export const one = (sql: string, ...p: unknown[]) => db.prepare(sql).get(...(p as never[])) as Row | undefined;
export const all = (sql: string, ...p: unknown[]) => db.prepare(sql).all(...(p as never[])) as Row[];
export const run = (sql: string, ...p: unknown[]) => db.prepare(sql).run(...(p as never[]));

export function tx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

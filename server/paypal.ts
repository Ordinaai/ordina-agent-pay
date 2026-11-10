// PayPal over REST: Orders v2 (create, capture), Payments v2 (refund) and
// Payouts v1 (paying businesses). Every amount is set by our server from the
// business's own price list, never from anything a model wrote.
//
// With no PayPal credentials the module runs a local mock with the same
// shapes, so the app works offline. Mock fees imitate PayPal's (3.49% + $0.49)
// and are labelled as a mock in the UI; real fees are read from PayPal.
import { randomUUID } from "node:crypto";

export type CreatedOrder = { id: string; status: string; approveUrl?: string };
export type CaptureResult = {
  orderId: string;
  status: string; // order status, COMPLETED when the money moved
  captureId?: string;
  captureStatus?: string; // COMPLETED, PENDING, DECLINED ...
  amount?: string;
  currency?: string;
  paypalFee?: string; // seller_receivable_breakdown.paypal_fee
  netAmount?: string; // seller_receivable_breakdown.net_amount
  payerName?: string;
  payerEmail?: string;
};
export type RefundResult = { id: string; status: string; amount: string; debit: string };
export type PayoutItemInput = { senderItemId: string; email: string; amount: string; currency: string; note: string };
export type PayoutBatch = { batchId: string; status: string };
export type PayoutItemState = { senderItemId: string; payoutItemId: string; status: string; error?: string };

const MODE = process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET ? "api" : "mock";
const BASE = process.env.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

export const paypalMode = (): "sandbox" | "live" | "mock" =>
  MODE === "mock" ? "mock" : process.env.PAYPAL_ENV === "live" ? "live" : "sandbox";
export const paypalClientId = (): string | null => process.env.PAYPAL_CLIENT_ID ?? null;

export class PayPalError extends Error {
  constructor(
    public status: number,
    public issue: string,
    message: string,
    public debugId?: string,
  ) {
    super(`PayPal ${status} ${issue}: ${message}`);
  }
}

let token: { value: string; expiresAt: number } | null = null;
async function accessToken(): Promise<string> {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new PayPalError(res.status, "AUTH_FAILED", "PayPal credentials were refused");
  const json = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return token.value;
}

async function call<T>(path: string, init: { method: string; body?: unknown; requestId?: string }): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.requestId ? { "PayPal-Request-Id": init.requestId } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const issue = json?.details?.[0]?.issue ?? json?.name ?? "ERROR";
    throw new PayPalError(res.status, issue, json?.message ?? text.slice(0, 200), json?.debug_id);
  }
  return json as T;
}

// ---------- mock ----------
const cents = (s: string) => Math.round(Number(s) * 100);
const dollars = (c: number) => (c / 100).toFixed(2);
const mockFee = (amount: string) => Math.round(cents(amount) * 0.0349) + 49;
type MockOrder = {
  id: string;
  status: "CREATED" | "APPROVED" | "COMPLETED";
  amount: string;
  currency: string;
  captureId?: string;
  refunded: number;
};
const mockOrders = new Map<string, MockOrder>();
const mockBatches = new Map<string, { items: PayoutItemInput[]; polls: number }>();

/** Mock only: what the PayPal popup does when the buyer clicks Pay. */
export function mockApprove(orderId: string): boolean {
  const o = mockOrders.get(orderId);
  if (!o || o.status !== "CREATED") return false;
  o.status = "APPROVED";
  return true;
}

// ---------- orders ----------
export async function createOrder(input: {
  amount: string;
  currency: string;
  description: string;
  referenceId: string;
  brandName: string;
}): Promise<CreatedOrder> {
  if (!/^\d+\.\d{2}$/.test(input.amount)) throw new Error(`Bad amount ${input.amount}`);
  if (MODE === "mock") {
    const id = `MOCK${randomUUID().replace(/-/g, "").slice(0, 13).toUpperCase()}`;
    mockOrders.set(id, { id, status: "CREATED", amount: input.amount, currency: input.currency, refunded: 0 });
    return { id, status: "CREATED" };
  }
  const order = await call<{ id: string; status: string; links?: Array<{ rel: string; href: string }> }>("/v2/checkout/orders", {
    method: "POST",
    requestId: `create-${input.referenceId}`,
    body: {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: input.referenceId,
          custom_id: input.referenceId,
          description: input.description.slice(0, 127),
          soft_descriptor: "AGENTPAY",
          amount: { currency_code: input.currency, value: input.amount },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: input.brandName.slice(0, 127),
            shipping_preference: "NO_SHIPPING",
            user_action: "PAY_NOW",
          },
        },
      },
    },
  });
  const approveUrl = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
  return { id: order.id, status: order.status, approveUrl };
}

export async function captureOrder(orderId: string): Promise<CaptureResult> {
  if (MODE === "mock") {
    const o = mockOrders.get(orderId);
    if (!o) throw new PayPalError(404, "RESOURCE_NOT_FOUND", "No such order");
    if (o.status === "CREATED") throw new PayPalError(422, "ORDER_NOT_APPROVED", "The payer has not approved");
    if (o.status === "COMPLETED") throw new PayPalError(422, "ORDER_ALREADY_CAPTURED", "Already captured");
    o.status = "COMPLETED";
    o.captureId = `MOCKCAP${randomUUID().slice(0, 8).toUpperCase()}`;
    const fee = mockFee(o.amount);
    return {
      orderId,
      status: "COMPLETED",
      captureId: o.captureId,
      captureStatus: "COMPLETED",
      amount: o.amount,
      currency: o.currency,
      paypalFee: dollars(fee),
      netAmount: dollars(cents(o.amount) - fee),
      payerName: "Sandbox Buyer",
      payerEmail: "sandbox-buyer@example.com",
    };
  }
  type Money = { value: string; currency_code: string };
  type Cap = {
    id: string;
    status: string;
    payer?: { email_address?: string; name?: { given_name?: string; surname?: string } };
    purchase_units?: Array<{
      payments?: {
        captures?: Array<{
          id: string;
          status: string;
          amount: Money;
          seller_receivable_breakdown?: { paypal_fee?: Money; net_amount?: Money };
        }>;
      };
    }>;
  };
  const res = await call<Cap>(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: "POST",
    requestId: `capture-${orderId}`,
    body: {},
  });
  const cap = res.purchase_units?.[0]?.payments?.captures?.[0];
  const name = [res.payer?.name?.given_name, res.payer?.name?.surname].filter(Boolean).join(" ") || undefined;
  return {
    orderId: res.id,
    status: res.status,
    captureId: cap?.id,
    captureStatus: cap?.status,
    amount: cap?.amount.value,
    currency: cap?.amount.currency_code,
    paypalFee: cap?.seller_receivable_breakdown?.paypal_fee?.value,
    netAmount: cap?.seller_receivable_breakdown?.net_amount?.value,
    payerName: name,
    payerEmail: res.payer?.email_address,
  };
}

/** Refund part or all of a capture. `debit` is what PayPal takes back from us (refund minus any fee it returns). */
export async function refundCapture(
  captureId: string,
  input: { amount: string; currency: string; note: string; key: string },
): Promise<RefundResult> {
  if (MODE === "mock") {
    const o = [...mockOrders.values()].find((x) => x.captureId === captureId);
    if (!o) throw new PayPalError(404, "RESOURCE_NOT_FOUND", "No such capture");
    const want = cents(input.amount);
    if (o.refunded + want > cents(o.amount)) throw new PayPalError(422, "REFUND_AMOUNT_EXCEEDED", "More than is left");
    o.refunded += want;
    // PayPal keeps its fixed fee and returns the percentage part pro rata.
    const feeBack = Math.round(want * 0.0349);
    return { id: `MOCKREF${randomUUID().slice(0, 8).toUpperCase()}`, status: "COMPLETED", amount: input.amount, debit: dollars(want - feeBack) };
  }
  type Ref = {
    id: string;
    status: string;
    amount?: { value: string };
    seller_payable_breakdown?: { net_amount?: { value: string }; gross_amount?: { value: string } };
  };
  const res = await call<Ref>(`/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
    method: "POST",
    requestId: `refund-${input.key}`,
    body: { amount: { value: input.amount, currency_code: input.currency }, note_to_payer: input.note.slice(0, 255) },
  });
  return {
    id: res.id,
    status: res.status,
    amount: res.amount?.value ?? input.amount,
    debit: res.seller_payable_breakdown?.net_amount?.value ?? input.amount,
  };
}

// ---------- payouts ----------
export async function createPayout(batchKey: string, items: PayoutItemInput[]): Promise<PayoutBatch> {
  if (MODE === "mock") {
    const batchId = `MOCKBATCH${randomUUID().slice(0, 8).toUpperCase()}`;
    mockBatches.set(batchId, { items, polls: 0 });
    return { batchId, status: "PENDING" };
  }
  const res = await call<{ batch_header: { payout_batch_id: string; batch_status: string } }>("/v1/payments/payouts", {
    method: "POST",
    requestId: `payout-${batchKey}`,
    body: {
      sender_batch_header: {
        sender_batch_id: batchKey,
        email_subject: "You have been paid for bookings on Agent Pay",
        email_message: "Payment for bookings your AI Secretary took through Agent Pay.",
      },
      items: items.map((i) => ({
        recipient_type: "EMAIL",
        receiver: i.email,
        amount: { value: i.amount, currency: i.currency },
        note: i.note.slice(0, 4000),
        sender_item_id: i.senderItemId,
      })),
    },
  });
  return { batchId: res.batch_header.payout_batch_id, status: res.batch_header.batch_status };
}

export async function getPayout(batchId: string): Promise<PayoutItemState[]> {
  if (MODE === "mock") {
    const b = mockBatches.get(batchId);
    if (!b) throw new PayPalError(404, "RESOURCE_NOT_FOUND", "No such batch");
    b.polls++;
    return b.items.map((i, n) => ({
      senderItemId: i.senderItemId,
      payoutItemId: `${batchId}-${n}`,
      status: b.polls >= 1 ? (i.email.endsWith("@unclaimed.test") ? "UNCLAIMED" : "SUCCESS") : "PENDING",
    }));
  }
  const res = await call<{
    items?: Array<{ payout_item_id: string; transaction_status: string; payout_item: { sender_item_id: string }; errors?: { message?: string } }>;
  }>(`/v1/payments/payouts/${encodeURIComponent(batchId)}?page_size=1000`, { method: "GET" });
  return (res.items ?? []).map((i) => ({
    senderItemId: i.payout_item.sender_item_id,
    payoutItemId: i.payout_item_id,
    status: i.transaction_status,
    error: i.errors?.message,
  }));
}

/** Check that a set of PayPal keys works, without storing them. */
export async function verifyCredentials(): Promise<boolean> {
  if (MODE === "mock") return true;
  try {
    await accessToken();
    return true;
  } catch {
    return false;
  }
}

/** Test helper. */
export function resetMock() {
  mockOrders.clear();
  mockBatches.clear();
}

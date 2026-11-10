// PayPal Orders v2 and Payments v2, called directly over REST.
//
// The amount of every order is set here from the business's own price list,
// never from anything a model wrote. With no PayPal credentials the module
// runs a local mock with the same shapes, so the app works offline.
import { randomUUID } from "node:crypto";

export type CreatedOrder = { id: string; status: string; approveUrl?: string };
export type CaptureResult = {
  orderId: string;
  status: string; // order status, COMPLETED when the money moved
  captureId?: string;
  captureStatus?: string; // COMPLETED, PENDING, DECLINED ...
  amount?: string;
  currency?: string;
  payerEmail?: string;
};
export type RefundResult = { id: string; status: string };

const MODE = process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET ? "live-api" : "mock";
const BASE =
  process.env.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

export const paypalMode = (): "sandbox" | "live" | "mock" =>
  MODE === "mock" ? "mock" : process.env.PAYPAL_ENV === "live" ? "live" : "sandbox";

export const paypalClientId = (): string | null => process.env.PAYPAL_CLIENT_ID ?? null;

let token: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal auth failed (${res.status})`);
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

// ---------- mock ----------
type MockOrder = {
  id: string;
  status: "CREATED" | "APPROVED" | "COMPLETED";
  amount: string;
  currency: string;
  captureId?: string;
  refunded?: boolean;
};
const mockOrders = new Map<string, MockOrder>();

/** Mock only: what the PayPal popup does when the buyer clicks Pay. */
export function mockApprove(orderId: string): boolean {
  const o = mockOrders.get(orderId);
  if (!o || o.status !== "CREATED") return false;
  o.status = "APPROVED";
  return true;
}

// ---------- API ----------
export async function createOrder(input: {
  amount: string;
  currency: string;
  description: string;
  referenceId: string; // our hold id
  brandName: string;
}): Promise<CreatedOrder> {
  if (!/^\d+\.\d{2}$/.test(input.amount)) throw new Error(`Bad amount ${input.amount}`);
  if (MODE === "mock") {
    const id = `MOCK${randomUUID().replace(/-/g, "").slice(0, 13).toUpperCase()}`;
    mockOrders.set(id, { id, status: "CREATED", amount: input.amount, currency: input.currency });
    return { id, status: "CREATED" };
  }
  const order = await call<{ id: string; status: string; links?: Array<{ rel: string; href: string }> }>(
    "/v2/checkout/orders",
    {
      method: "POST",
      requestId: `create-${input.referenceId}`,
      body: {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: input.referenceId,
            custom_id: input.referenceId,
            description: input.description.slice(0, 127),
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
    },
  );
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
    return {
      orderId,
      status: "COMPLETED",
      captureId: o.captureId,
      captureStatus: "COMPLETED",
      amount: o.amount,
      currency: o.currency,
      payerEmail: "sandbox-buyer@example.com",
    };
  }
  type Cap = {
    id: string;
    status: string;
    payer?: { email_address?: string };
    purchase_units?: Array<{
      payments?: { captures?: Array<{ id: string; status: string; amount: { value: string; currency_code: string } }> };
    }>;
  };
  const res = await call<Cap>(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: "POST",
    requestId: `capture-${orderId}`,
    body: {},
  });
  const cap = res.purchase_units?.[0]?.payments?.captures?.[0];
  return {
    orderId: res.id,
    status: res.status,
    captureId: cap?.id,
    captureStatus: cap?.status,
    amount: cap?.amount.value,
    currency: cap?.amount.currency_code,
    payerEmail: res.payer?.email_address,
  };
}

export async function refundCapture(captureId: string, note: string): Promise<RefundResult> {
  if (MODE === "mock") {
    const o = [...mockOrders.values()].find((x) => x.captureId === captureId);
    if (!o) throw new PayPalError(404, "RESOURCE_NOT_FOUND", "No such capture");
    if (o.refunded) throw new PayPalError(422, "CAPTURE_FULLY_REFUNDED", "Already refunded");
    o.refunded = true;
    return { id: `MOCKREF${randomUUID().slice(0, 8).toUpperCase()}`, status: "COMPLETED" };
  }
  const res = await call<{ id: string; status: string }>(
    `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
    { method: "POST", requestId: `refund-${captureId}`, body: { note_to_payer: note.slice(0, 255) } },
  );
  return { id: res.id, status: res.status };
}

/** Test helper. */
export function resetMock() {
  mockOrders.clear();
}

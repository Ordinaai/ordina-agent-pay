// PayPal Multiparty (PayPal Complete Payments Platform), called over REST.
//
// Money never sits with Ordina. Each business connects its own PayPal account
// (Partner Referrals). Every order names the business as the payee, with
// DELAYED disbursement: PayPal holds the money after capture and Ordina asks
// PayPal to release it after the booking (Referenced Payouts). Ordina's own
// fee, when there is one, is a PayPal platform fee on the order.
//
// With no PayPal credentials the module runs a local mock with the same
// shapes, so the whole flow works offline. Mock fees imitate PayPal's
// (3.49% + $0.49) and the UI labels them as test mode.
import { randomUUID } from "node:crypto";

export type CreatedOrder = { id: string; status: string; approveUrl?: string };
export type CaptureResult = {
  orderId: string;
  status: string; // order status: COMPLETED when the money moved
  captureId?: string;
  captureStatus?: string; // COMPLETED, PENDING, DECLINED ...
  amount?: string;
  currency?: string;
  paypalFee?: string; // seller_receivable_breakdown.paypal_fee
  platformFee?: string; // seller_receivable_breakdown.platform_fees[0]
  netAmount?: string; // what the business receives
  payeeMerchantId?: string;
  disbursement?: string; // "HELD" until released
  payerName?: string;
  payerEmail?: string;
  payerId?: string;
};
export type RefundResult = { id: string; status: string; amount: string };
export type ReleaseResult = { status: "SUCCESS" | "PENDING" | "FAILED"; itemId?: string; reason?: string };
export type SellerStatus = {
  merchantId: string;
  paymentsReceivable: boolean;
  primaryEmailConfirmed: boolean;
  scopesGranted: boolean;
  email?: string;
};

const MODE = process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET ? "api" : "mock";
const BASE = process.env.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
const PARTNER_MERCHANT_ID = process.env.PAYPAL_PARTNER_MERCHANT_ID ?? "";
const BN_CODE = process.env.PAYPAL_BN_CODE ?? "";

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

// ---------- REST plumbing ----------
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

/** Acting for a connected seller: an unsigned JWT naming the seller (PayPal's documented format). */
function authAssertion(sellerMerchantId: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ iss: process.env.PAYPAL_CLIENT_ID, payer_id: sellerMerchantId })}.`;
}

async function call<T>(
  path: string,
  init: { method: string; body?: unknown; requestId?: string; seller?: string },
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(BN_CODE ? { "PayPal-Partner-Attribution-Id": BN_CODE } : {}),
      ...(init.seller ? { "PayPal-Auth-Assertion": authAssertion(init.seller) } : {}),
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

// ---------- mock state ----------
const cents = (s: string) => Math.round(Number(s) * 100);
const dollars = (c: number) => (c / 100).toFixed(2);
const mockFee = (amount: string) => Math.round(cents(amount) * 0.0349) + 49;
type MockOrder = {
  id: string;
  status: "CREATED" | "APPROVED" | "COMPLETED";
  amount: string;
  currency: string;
  payee: string;
  platformFee: string;
  captureId?: string;
  refunded: number;
  released: boolean;
};
const mockOrders = new Map<string, MockOrder>();
type MockSeller = { trackingId: string; merchantId?: string; email?: string; receivable: boolean; emailConfirmed: boolean };
const mockSellers = new Map<string, MockSeller>(); // by tracking id

// ---------- seller onboarding (Partner Referrals) ----------
/** Start connecting a business's PayPal. Returns the page the owner must visit. */
export async function createSellerReferral(input: { trackingId: string; returnUrl: string; email?: string }): Promise<{ actionUrl: string }> {
  if (MODE === "mock") {
    mockSellers.set(input.trackingId, { trackingId: input.trackingId, receivable: false, emailConfirmed: false });
    const q = new URLSearchParams({ tracking: input.trackingId, return: input.returnUrl });
    return { actionUrl: `/paypal-sandbox-mock/connect?${q}` };
  }
  const res = await call<{ links?: Array<{ rel: string; href: string }> }>("/v2/customer/partner-referrals", {
    method: "POST",
    body: {
      tracking_id: input.trackingId,
      email: input.email,
      operations: [
        {
          operation: "API_INTEGRATION",
          api_integration_preference: {
            rest_api_integration: {
              integration_method: "PAYPAL",
              integration_type: "THIRD_PARTY",
              third_party_details: { features: ["PAYMENT", "REFUND", "PARTNER_FEE", "DELAY_FUNDS_DISBURSEMENT"] },
            },
          },
        },
      ],
      products: ["EXPRESS_CHECKOUT"],
      legal_consents: [{ type: "SHARE_DATA_CONSENT", granted: true }],
      partner_config_override: { return_url: input.returnUrl },
    },
  });
  const actionUrl = res.links?.find((l) => l.rel === "action_url")?.href;
  if (!actionUrl) throw new PayPalError(502, "NO_ACTION_URL", "PayPal returned no onboarding link");
  return { actionUrl };
}

/** Mock only: what PayPal's consent screen does when the owner agrees. */
export function mockCompleteReferral(trackingId: string, email: string, opts: { confirmEmail?: boolean } = {}): string | null {
  const s = mockSellers.get(trackingId);
  if (!s) return null;
  s.merchantId = `MOCKMERCH${randomUUID().slice(0, 8).toUpperCase()}`;
  s.email = email;
  s.receivable = true;
  s.emailConfirmed = opts.confirmEmail ?? true;
  return s.merchantId;
}

/** The seller's real state at PayPal. Never trust the return URL alone. */
export async function getSellerStatus(merchantId: string): Promise<SellerStatus | null> {
  if (MODE === "mock") {
    const s = [...mockSellers.values()].find((x) => x.merchantId === merchantId);
    if (!s) return null;
    return { merchantId, paymentsReceivable: s.receivable, primaryEmailConfirmed: s.emailConfirmed, scopesGranted: true, email: s.email };
  }
  const res = await call<{
    merchant_id: string;
    payments_receivable?: boolean;
    primary_email_confirmed?: boolean;
    primary_email?: string;
    oauth_integrations?: Array<{ oauth_third_party?: Array<{ scopes?: string[] }> }>;
  }>(`/v1/customer/partners/${encodeURIComponent(PARTNER_MERCHANT_ID)}/merchant-integrations/${encodeURIComponent(merchantId)}`, {
    method: "GET",
  });
  const scopes = res.oauth_integrations?.flatMap((o) => o.oauth_third_party ?? []).flatMap((t) => t.scopes ?? []) ?? [];
  return {
    merchantId: res.merchant_id,
    paymentsReceivable: !!res.payments_receivable,
    primaryEmailConfirmed: !!res.primary_email_confirmed,
    scopesGranted: scopes.length > 0,
    email: res.primary_email,
  };
}

/** Mock only: find the merchant id PayPal gave a tracking id (real PayPal sends it on the return URL). */
export function mockMerchantFor(trackingId: string): string | undefined {
  return mockSellers.get(trackingId)?.merchantId;
}

// ---------- orders ----------
export async function createOrder(input: {
  amount: string;
  currency: string;
  description: string;
  referenceId: string;
  brandName: string;
  payeeMerchantId: string;
  platformFee: string; // "0.00" for none
}): Promise<CreatedOrder> {
  if (!/^\d+\.\d{2}$/.test(input.amount)) throw new Error(`Bad amount ${input.amount}`);
  if (MODE === "mock") {
    const id = `MOCK${randomUUID().replace(/-/g, "").slice(0, 13).toUpperCase()}`;
    mockOrders.set(id, {
      id,
      status: "CREATED",
      amount: input.amount,
      currency: input.currency,
      payee: input.payeeMerchantId,
      platformFee: input.platformFee,
      refunded: 0,
      released: false,
    });
    return { id, status: "CREATED" };
  }
  const fee = Number(input.platformFee) > 0 ? [{ amount: { currency_code: input.currency, value: input.platformFee } }] : undefined;
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
          amount: { currency_code: input.currency, value: input.amount },
          payee: { merchant_id: input.payeeMerchantId },
          payment_instruction: { disbursement_mode: "DELAYED", ...(fee ? { platform_fees: fee } : {}) },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: { brand_name: input.brandName.slice(0, 127), shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW" },
        },
      },
    },
  });
  return { id: order.id, status: order.status, approveUrl: order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href };
}

/** Mock only: what the PayPal popup does when the buyer clicks Pay. */
export function mockApprove(orderId: string): boolean {
  const o = mockOrders.get(orderId);
  if (!o || o.status !== "CREATED") return false;
  o.status = "APPROVED";
  return true;
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
      platformFee: o.platformFee,
      netAmount: dollars(cents(o.amount) - fee - cents(o.platformFee)),
      payeeMerchantId: o.payee,
      disbursement: "HELD",
      payerName: "Sandbox Buyer",
      payerEmail: "sandbox-buyer@example.com",
      payerId: "MOCKPAYER1",
    };
  }
  type Money = { value: string; currency_code: string };
  type Cap = {
    id: string;
    status: string;
    payer?: { email_address?: string; payer_id?: string; name?: { given_name?: string; surname?: string } };
    purchase_units?: Array<{
      payee?: { merchant_id?: string };
      payments?: {
        captures?: Array<{
          id: string;
          status: string;
          amount: Money;
          disbursement_mode?: string;
          seller_receivable_breakdown?: { paypal_fee?: Money; net_amount?: Money; platform_fees?: Array<{ amount: Money }> };
        }>;
      };
    }>;
  };
  const res = await call<Cap>(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: "POST",
    requestId: `capture-${orderId}`,
    body: {},
  });
  const unit = res.purchase_units?.[0];
  const cap = unit?.payments?.captures?.[0];
  const b = cap?.seller_receivable_breakdown;
  return {
    orderId: res.id,
    status: res.status,
    captureId: cap?.id,
    captureStatus: cap?.status,
    amount: cap?.amount.value,
    currency: cap?.amount.currency_code,
    paypalFee: b?.paypal_fee?.value,
    platformFee: b?.platform_fees?.[0]?.amount.value ?? "0.00",
    netAmount: b?.net_amount?.value,
    payeeMerchantId: unit?.payee?.merchant_id,
    disbursement: cap?.disbursement_mode === "DELAYED" ? "HELD" : cap?.disbursement_mode,
    payerName: [res.payer?.name?.given_name, res.payer?.name?.surname].filter(Boolean).join(" ") || undefined,
    payerEmail: res.payer?.email_address,
    payerId: res.payer?.payer_id,
  };
}

/** Refund part or all of a capture, acting for the business that was paid. */
export async function refundCapture(
  captureId: string,
  input: { sellerMerchantId: string; amount: string; currency: string; note: string; key: string },
): Promise<RefundResult> {
  if (MODE === "mock") {
    const o = [...mockOrders.values()].find((x) => x.captureId === captureId);
    if (!o) throw new PayPalError(404, "RESOURCE_NOT_FOUND", "No such capture");
    if (o.payee !== input.sellerMerchantId) throw new PayPalError(403, "PERMISSION_DENIED", "Not this seller's capture");
    const want = cents(input.amount);
    if (o.refunded + want > cents(o.amount)) throw new PayPalError(422, "REFUND_AMOUNT_EXCEEDED", "More than is left");
    o.refunded += want;
    return { id: `MOCKREF${randomUUID().slice(0, 8).toUpperCase()}`, status: "COMPLETED", amount: input.amount };
  }
  const res = await call<{ id: string; status: string; amount?: { value: string } }>(
    `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
    {
      method: "POST",
      seller: input.sellerMerchantId,
      requestId: `refund-${input.key}`,
      body: { amount: { value: input.amount, currency_code: input.currency }, note_to_payer: input.note.slice(0, 255) },
    },
  );
  return { id: res.id, status: res.status, amount: res.amount?.value ?? input.amount };
}

/** Release held money to the business (Referenced Payouts). */
export async function releaseFunds(captureId: string, key: string): Promise<ReleaseResult> {
  if (MODE === "mock") {
    const o = [...mockOrders.values()].find((x) => x.captureId === captureId);
    if (!o) return { status: "FAILED", reason: "No such capture" };
    if (cents(o.amount) - o.refunded <= 0) return { status: "FAILED", reason: "Nothing left to release" };
    o.released = true;
    return { status: "SUCCESS", itemId: `MOCKREL${randomUUID().slice(0, 8).toUpperCase()}` };
  }
  const res = await call<{ item_id?: string; processing_state?: { status?: string; reason?: string } }>(
    "/v1/payments/referenced-payouts-items",
    { method: "POST", requestId: `release-${key}`, body: { reference_id: captureId, reference_type: "TRANSACTION_ID" } },
  );
  const s = res.processing_state?.status;
  return {
    status: s === "SUCCESS" ? "SUCCESS" : s === "FAILED" ? "FAILED" : "PENDING",
    itemId: res.item_id,
    reason: res.processing_state?.reason,
  };
}

/** Test helper. */
export function resetMock() {
  mockOrders.clear();
  mockSellers.clear();
}

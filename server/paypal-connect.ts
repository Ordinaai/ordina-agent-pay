// Connecting a business's own PayPal account (PayPal Partner Referrals).
// The return from PayPal only says "come back"; the account counts as
// connected only when PayPal's own record says it can take payments.
import express from "express";
import { randomUUID } from "node:crypto";
import { ownerOf } from "./auth.ts";
import { createSellerReferral, getSellerStatus, mockCompleteReferral, mockMerchantFor, paypalMode } from "./paypal.ts";
import { getBusiness, getBusinessByTracking, updateBusiness, type Business } from "./store.ts";

export const connectApi = express.Router();

const origin = (req: express.Request) => `${req.protocol}://${req.get("host")}`;

/** Ask PayPal for this seller's real state and store it. */
export async function refreshSeller(b: Business, merchantId: string): Promise<Business> {
  const s = await getSellerStatus(merchantId);
  if (!s) return updateBusiness(b.id, { paypalCheckedAt: Date.now() });
  return updateBusiness(b.id, {
    paypalMerchantId: s.merchantId,
    paypalEmail: s.email ?? b.paypal.email,
    paypalReceivable: s.paymentsReceivable && s.scopesGranted,
    paypalEmailConfirmed: s.primaryEmailConfirmed,
    paypalCheckedAt: Date.now(),
  });
}

connectApi.post("/connect", async (req, res) => {
  const id = ownerOf(req);
  const b = id ? getBusiness(id) : undefined;
  if (!b) {
    res.status(401).json({ error: "Please sign in." });
    return;
  }
  const trackingId = `ord-${b.id}-${randomUUID().slice(0, 8)}`;
  updateBusiness(b.id, { paypalTrackingId: trackingId });
  try {
    const { actionUrl } = await createSellerReferral({
      trackingId,
      returnUrl: `${origin(req)}/api/biz/paypal/return?tracking=${encodeURIComponent(trackingId)}`,
      email: b.ownerEmail ?? undefined,
    });
    res.json({ actionUrl });
  } catch (err) {
    console.error("paypal connect", err);
    res.status(502).json({ error: "PayPal could not start the connection. Try again." });
  }
});

/** PayPal sends the owner back here (with merchantIdInPayPal when it went well). */
connectApi.get("/return", async (req, res) => {
  const trackingId = String(req.query.tracking ?? "");
  const b = trackingId ? getBusinessByTracking(trackingId) : undefined;
  if (!b) {
    res.redirect("/business?paypal=unknown");
    return;
  }
  const merchantId = String(req.query.merchantIdInPayPal ?? "") || mockMerchantFor(trackingId) || "";
  if (!merchantId) {
    res.redirect("/business?paypal=cancelled");
    return;
  }
  const updated = await refreshSeller(b, merchantId);
  const ok = updated.paypal.receivable && updated.paypal.emailConfirmed;
  res.redirect(`/business?paypal=${ok ? "connected" : "needs_attention"}`);
});

/** "Check again" after the owner fixed something at PayPal. */
connectApi.post("/refresh", async (req, res) => {
  const id = ownerOf(req);
  const b = id ? getBusiness(id) : undefined;
  if (!b?.paypal.merchantId) {
    res.status(400).json({ error: "Connect PayPal first." });
    return;
  }
  const updated = await refreshSeller(b, b.paypal.merchantId);
  res.json({ receivable: updated.paypal.receivable, emailConfirmed: updated.paypal.emailConfirmed });
});

// ---------- test mode: a stand-in for PayPal's own consent page ----------
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const mockPayPalPages = express.Router();

mockPayPalPages.get("/connect", (req, res) => {
  if (paypalMode() !== "mock") {
    res.status(404).end();
    return;
  }
  const tracking = String(req.query.tracking ?? "");
  const ret = String(req.query.return ?? "/business");
  const b = getBusinessByTracking(tracking);
  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PayPal (test mode)</title>
<style>body{font-family:system-ui,sans-serif;background:#f5f7fa;display:grid;place-items:center;min-height:100vh;margin:0}
.c{background:#fff;border-radius:16px;padding:28px;max-width:400px;box-shadow:0 10px 40px -20px #0003}
h1{font-size:20px;margin:0 0 8px;color:#003087}.t{font-size:12px;color:#8a6110;background:#fff4cf;padding:3px 8px;border-radius:99px;display:inline-block;margin-bottom:14px}
p{color:#444;font-size:14px;line-height:1.5}label{display:block;font-size:13px;margin:14px 0 6px}
input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #ccd;border-radius:8px;font:inherit}
.r{display:flex;gap:8px;align-items:center;font-size:13px;margin-top:12px}
button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:99px;background:#0070e0;color:#fff;font:inherit;font-weight:600;cursor:pointer}
a{display:block;text-align:center;margin-top:12px;font-size:13px;color:#555}</style></head><body>
<form class="c" method="post" action="/paypal-sandbox-mock/connect">
<span class="t">Test mode: this stands in for PayPal</span>
<h1>Connect your PayPal to Ordina</h1>
<p>${esc(b?.name ?? "Your business")} will get paid for bookings and orders into this PayPal account. Ordina can create payments, refund them for you, and release held payments to you.</p>
<input type="hidden" name="tracking" value="${esc(tracking)}"><input type="hidden" name="return" value="${esc(ret)}">
<label for="e">PayPal account email</label><input id="e" name="email" type="email" required value="${esc(b?.ownerEmail ?? "")}">
<label class="r"><input type="checkbox" name="unconfirmed" value="1" style="width:auto"> Simulate an email not yet confirmed at PayPal</label>
<button>Agree and connect</button><a href="/business?paypal=cancelled">Cancel and go back</a></form></body></html>`);
});

mockPayPalPages.post("/connect", express.urlencoded({ extended: false }), (req, res) => {
  if (paypalMode() !== "mock") {
    res.status(404).end();
    return;
  }
  const tracking = String(req.body?.tracking ?? "");
  const email = String(req.body?.email ?? "").trim();
  const merchant = mockCompleteReferral(tracking, email, { confirmEmail: req.body?.unconfirmed !== "1" });
  // Only ever send the owner back to our own return route, never to another site.
  let url: URL;
  try {
    url = new URL(String(req.body?.return ?? ""), "http://local");
  } catch {
    url = new URL("http://local/");
  }
  if (!merchant || url.pathname !== "/api/biz/paypal/return") {
    res.redirect("/business?paypal=cancelled");
    return;
  }
  url.searchParams.set("merchantIdInPayPal", merchant);
  res.redirect(url.pathname + url.search);
});

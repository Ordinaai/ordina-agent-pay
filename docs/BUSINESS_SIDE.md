# The business side: how it works

Decided with the founder on 11 November 2026. The hackathon build uses PayPal's standard checkout with
one Sandbox seller; PayPal's marketplace product (Multiparty) is built behind `PAYPAL_FLOW=multiparty`
for when PayPal approves Ordina as a partner.

## What a business sees (`/business`)

In this build there is no sign-up. The business view opens a list of the simulated businesses; each one
shows:

- **Overview:** sales, what PayPal paid to its PayPal account, PayPal's fees, refunds, what's coming up,
  and its own link.
- **Bookings:** upcoming, past and cancelled, each with what the customer paid, PayPal's fee, what the
  business keeps, and the customer as PayPal verified them.
- **Refund** any amount, or **Cancel** with a refund the owner chooses (0 for a no-show), for 180 days
  after payment.

Sign-up, setup and going live are built and can be switched on with `BUSINESS_SIGNUP=1` (see below).

## What a business sells

- **Appointment:** has a length in minutes, blocks the calendar, one at a time.
- **Pickup item:** has a pickup time and a daily limit set by the owner; any number per time slot, up to
  the limit.

Prices are in USD. A booking keeps the price it was paid at, whatever changes later.

## How customers find a business

- **Any AI assistant**, through the MCP server at `/mcp`.
- **The playground** at `/`, our own agent.
- **Its own link**, `/b/<handle>`, which opens the playground already talking to that business's
  Secretary.

## Money (standard checkout, the default)

- **The customer pays the business's seller account directly** at the business's listed price. PayPal
  pays the seller at capture; nothing is held and Ordina holds nothing.
- **A booking exists only** once PayPal reports a `COMPLETED` capture for the exact amount and currency,
  paid to that seller. If money moved but a check failed, it is refunded in full at once.
- **Fees:** the business pays PayPal's usual fee, read from PayPal's own capture record. Ordina takes
  nothing per sale today (`PLATFORM_FEE_PERCENT`, 0).
- **Customers** are identified by PayPal (the verified payer on the capture) and protected by PayPal's
  buyer protection.
- **Refunds, for 180 days after payment:**
  - the **customer** may cancel inside the business's free-cancellation window for a full refund;
  - the **owner** may cancel or refund any amount, up to what is left.
  Refunds come out of the seller's PayPal balance. After 180 days, refunds are settled directly.

## Multiparty (roadmap)

With `PAYPAL_FLOW=multiparty` each business connects its **own** PayPal account, and:

- **Connect PayPal** uses Partner Referrals; the account counts only when PayPal itself reports it can
  take payments and its email is confirmed. The return from PayPal is never trusted on its own.
- Each order names the business as payee with **delayed disbursement**: PayPal holds the money.
- **Release:** 24 hours after the appointment or pickup ends, the gateway asks PayPal to release it
  (Referenced Payouts). It counts as released only when PayPal says so. PayPal releases held money by
  itself after 28 days in any case.
- While PayPal holds the money, a refund comes out of it; after release, out of the business's own PayPal
  balance.
- Live use needs PayPal to approve Ordina as a Multiparty partner (BN code, partner merchant id, and the
  delayed-disbursement and partner-fee features). Which countries' businesses can receive is PayPal's
  list; a region PayPal doesn't cover is simply not offered.

## Self-serve businesses (`BUSINESS_SIGNUP=1`)

- A business signs up with its name, email and password, category and city (the city sets the time
  zone).
- It can't take bookings until **all** of these are done. **Go live** stays grey, and each missing item
  is named at its own field: something to sell with a price; at least one open day; a free-cancellation
  window; PayPal connected (Multiparty).
- The owner can write notes for its Secretary, **pause** at any time, and change prices and hours.

## Test mode

- With no PayPal keys, a mock with the same shapes runs everything, including a labelled stand-in for
  PayPal's consent page. The mock keeps payments in memory, so after a restart, refunds on older
  bookings fail; real Sandbox keeps them.
- Four fictional businesses are seeded on one seller account.

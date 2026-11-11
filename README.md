# Ordina Agent Checkout

**Your AI agent books it. You approve the payment.**

Two apps on one PayPal backbone:

- **For people:** an AI agent you chat with. Ask it to book a haircut or order a cake; it finds the business, agrees the details with that business's own AI Secretary, and brings back one PayPal payment for you to approve. Nothing is charged until you say yes.
- **For businesses:** sign up, list what you sell, connect your own PayPal, and your AI Secretary starts answering customers' agents. Customers pay straight into your PayPal; PayPal holds each payment until 24 hours after the booking, then releases it to you.

Built by [Ordina](https://www.useordina.com) for the PayPal AI Hackathon 2026. Ordina runs AI Secretaries for businesses; this is how other people's agents will book and pay them, safely.

> Live demo: _added once deployed_ · Video: _added once published_

![Ordina Agent Checkout: ask your agent, it agrees the booking with the business, you approve one PayPal payment](docs/screenshot.jpg)

## The customer app (`/`)

- **Chat with your agent** to book an appointment or order something for pickup. Chats stay in the sidebar.
- Under each answer, **"Worked with ..."** opens the steps your agent took: who it messaged, what the business checked and held, and every PayPal call.
- **Approve with PayPal** right in the chat. A held time lasts 15 minutes; nothing is charged unless you approve. You pay the business directly, with PayPal's buyer protection.
- **Bookings:** everything you paid for, and **Cancel** for a full refund while the business's free-cancellation window is open.
- **Spending limit:** the most your agent may ask you to pay at once. Anything above it is refused before it reaches you.

## The business app (`/business`)

- **Sign up** with your business name, kind, city, email and password.
- **Setup:** what you sell (appointments that block your calendar, or pickup items with a daily limit), opening hours, a free-cancellation window, and **Connect PayPal**. **Go live** stays grey until all four are done; each missing piece is named at its own field. PayPal itself must confirm your account can take payments.
- **Your link** (`/b/<handle>`): share it anywhere; it opens a customer's agent already talking to your Secretary. Live businesses are also found by every customer's agent.
- **Bookings:** what the customer paid, PayPal's fee, what you'll receive, and when PayPal releases it. **Refund** any amount, or **Cancel** with a refund you choose (0 for a no-show), for up to 180 days after payment: from the money PayPal holds, or after release from your own PayPal balance.
- **Overview:** sales, money PayPal holds for you, money released to your PayPal, refunds. **Pause** any time.

How the money works: [docs/BUSINESS_SIDE.md](docs/BUSINESS_SIDE.md).

## Safety is in the code, not the prompt

An agent that can spend money needs rules it cannot talk its way around. All of these are enforced by the server, whatever a model says, and each has a test in `test/flow.test.ts` (22 tests):

| # | Rule | Where |
|---|---|---|
| 1 | Every price comes from the business's own list, never from what an agent writes | `server/commerce.ts` `startPayment` |
| 2 | A payment above the customer's spending limit is refused before it is shown | `requestApproval` |
| 3 | No agent can pay; only the customer approves in PayPal | `server/agents/buyer.ts` (no paying tool) |
| 4 | A booking exists only on a `COMPLETED` capture for the exact amount and currency, **paid to this business's own PayPal** | `captureAndConfirm` |
| 5 | A hold that ran out is never charged; an offer is captured once, by its own conversation | `captureAndConfirm` |
| 6 | Only a live business that PayPal says can take payments can be found or booked | `store.ts` `canBePaid` |
| 7 | Money is released only after the booking plus 24 hours, and counted released only when PayPal confirms | `server/payouts.ts` |
| 8 | Only server objects are facts: the customer's agent acts on the **payment offer** the server hands it, never on what the Secretary writes | `agents/secretary.ts` `offer` |

## How PayPal is used (Multiparty)

- **Partner Referrals** `POST /v2/customer/partner-referrals` and `GET /v1/customer/partners/{partner}/merchant-integrations/{merchant}`: a business connects its own PayPal; the account counts only when PayPal reports it can take payments and its email is confirmed.
- **Orders v2** `POST /v2/checkout/orders` with `payee` = the business and `payment_instruction.disbursement_mode` = `DELAYED` (and an optional `platform_fees` entry): the payment goes to the business and PayPal holds it.
- **PayPal JS SDK buttons**: the customer approves the exact offer.
- **Orders v2 capture**: the fee, net and payee come from the capture record.
- **Payments v2 refund** with `PayPal-Auth-Assertion`: full or partial refunds on the business's behalf.
- **Referenced Payouts** `POST /v1/payments/referenced-payouts-items`: releases the held money to the business after the booking.

## How the agents are built

Two agents on the Claude API (`claude-opus-5-5`, low effort, server-side refusal fallback on), each a small tool loop (`server/agents/loop.ts`):

- **Your agent** (`buyer.ts`): `find_businesses`, `message_business`, `request_payment_approval`.
- **Each business's Secretary** (`secretary.ts`): `list_services`, `check_availability`, `hold_time`, `create_payment`, built from that business's setup and the owner's notes.

The agents talk to each other in plain language, but every fact that matters comes from the server: `message_business` returns the Secretary's reply **and** the server's payment offer, and the customer's agent approves only by the offer's id.

## Run it

```bash
npm install
npm run build
npm start            # http://localhost:8787
```

With no keys it runs fully offline: scripted agents drive the same tools, and PayPal (onboarding, delayed payments, refunds, releases) is mocked with the same shapes, including a labelled stand-in for PayPal's consent page. For the real thing, set in `.env` (see `.env.example`):

- `ANTHROPIC_API_KEY` for Claude.
- `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_PARTNER_MERCHANT_ID` and `PAYPAL_BN_CODE` from a PayPal Multiparty partner app.

Data is SQLite (Node's built-in `node:sqlite`, Node 24), in `./data` or `DATA_DIR`. Tests: `npm test`.

## Licence

MIT, see [LICENSE](./LICENSE).

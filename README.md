# Agent Pay

**Your AI agent books it. You approve the payment.**

Agent Pay is two apps on one PayPal backbone:

- **For people:** an AI agent you chat with. Ask it to book a haircut or order a cake; it finds the business, agrees the details with that business's own AI Secretary, and brings back one PayPal payment for you to approve. Nothing is charged until you say yes.
- **For businesses:** sign up, list what you sell, and your AI Secretary starts answering customers' agents. Every sale is paid through PayPal and paid out to your PayPal account, minus only PayPal's own fee.

Built by [Ordina](https://www.useordina.com) for the PayPal AI Hackathon 2026. Ordina runs AI Secretaries for service businesses; Agent Pay is how other people's agents will buy from them, safely.

> Live demo: _added once deployed_ · Video: _added once published_

![Agent Pay: ask your agent, it agrees the booking with the business, you approve one PayPal payment](docs/screenshot.jpg)

## The customer app (`/`)

- **Chat with your agent** to book an appointment or order something for pickup. Chats stay in the sidebar.
- Under each answer, **"Worked with ..."** opens the steps your agent took: who it messaged, what the business checked and held, and every PayPal call.
- **Approve with PayPal** right in the chat. A held time lasts 15 minutes; nothing is charged unless you approve.
- **Bookings:** everything you paid for, and **Cancel** for a full PayPal refund while the business's free-cancellation window is open.
- **Spending limit:** the most your agent may ask you to pay at once. Anything above it is refused before it reaches you.

## The business app (`/business`)

- **Sign up** with your business name, kind, city, email and password.
- **Setup:** what you sell (appointments that block your calendar, or pickup items with a daily limit), opening hours, a free-cancellation window, and the PayPal email to be paid to. **Go live** stays grey until all four are done; each missing piece is named at its own field.
- **Your link** (`/b/<handle>`): share it anywhere; it opens a customer's agent already talking to your Secretary. Live businesses are also found by every customer's agent.
- **Bookings:** each one with what the customer paid, PayPal's fee, and what you'll be paid. **Refund** any amount, or **Cancel** with a refund you choose (0 for a no-show), until you're paid out.
- **Overview:** sales, money waiting for you, on its way, and paid out. **Pause** any time.

How the money works is written down in [docs/BUSINESS_SIDE.md](docs/BUSINESS_SIDE.md).

## Safety is in the code, not the prompt

An agent that can spend money needs rules it cannot talk its way around. All of these are enforced by the server, whatever a model says:

| Rule | Where |
|---|---|
| Every PayPal order is priced from the business's own list, never from model output | `server/commerce.ts` `startPayment` |
| A payment above the customer's spending limit is refused before it is shown | `requestApproval` |
| Nothing is charged without the human approving in PayPal; agents have no tool that pays | `server/agents/buyer.ts` |
| A booking exists only after a capture that is `COMPLETED` for the exact amount and currency | `captureAndConfirm` |
| A hold that ran out is never charged; only the payment shown for approval can be captured, and only by its own chat | `captureAndConfirm` |
| The business is owed exactly the net PayPal reported, minus what PayPal took back for refunds | `payoutCents` |
| A booking counts as paid out only when PayPal reports the payout item `SUCCESS` | `server/payouts.ts` |
| No refunds through Agent Pay once a booking is paid out; a fully refunded booking is never paid out | `refund`, `runPayouts` |
| A business can't go live without items, hours, a cancellation window and a PayPal email | `setupErrors` |
| A public demo cannot run up the AI bill: per-IP and daily turn caps | `server/guard.ts` |

`test/flow.test.ts` checks each rule end to end (17 tests).

## How PayPal is used

- **Orders v2** `POST /v2/checkout/orders` (intent `CAPTURE`): the Secretary's `create_payment` tool, at the listed price.
- **PayPal JS SDK buttons**: the customer approves the exact order the agents agreed.
- **Orders v2** `POST /v2/checkout/orders/{id}/capture`: captured after approval; the fee and net come from `seller_receivable_breakdown`.
- **Payments v2** `POST /v2/payments/captures/{id}/refund`: full or partial refunds; the cost to the business comes from `seller_payable_breakdown`.
- **Payouts v1** `POST /v1/payments/payouts` and `GET /v1/payments/payouts/{id}`: each business is paid 24 hours after the booking, and the payout's real status is read back.

## How the agents are built

Two agents on the Claude API (`claude-opus-5-5`, low effort, server-side refusal fallback on), each a small tool loop (`server/agents/loop.ts`):

- **Your agent** (`buyer.ts`): `find_businesses`, `message_business`, `request_payment_approval`.
- **Each business's Secretary** (`secretary.ts`): `list_services`, `check_availability`, `hold_time`, `create_payment`, built from that business's setup and the owner's notes.

`message_business` runs the Secretary's own loop and returns its reply, so the two agents really talk to each other. Tool inputs are validated with zod before they run.

## Run it

```bash
npm install
npm run build
npm start            # http://localhost:8787
```

With no keys at all it runs fully offline: a scripted stand-in drives the same tools, and PayPal (including fees, refunds and payouts) is mocked with the same shapes. Add keys to `.env` (see `.env.example`) for the real thing:

- `ANTHROPIC_API_KEY` for Claude.
- `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` from a Sandbox REST app at developer.paypal.com, with Payouts enabled. Pay with a Sandbox personal account.

Data is SQLite (Node's built-in `node:sqlite`, Node 24), in `./data` by default or `DATA_DIR`. Development with hot reload: `npm run dev`. Tests: `npm test`.

## Deploy

`render.yaml` deploys one Render web service with a 1 GB disk for the database. Set `ANTHROPIC_API_KEY`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `DEMO_PAYOUT_EMAIL` (a Sandbox business account, for the demo businesses' payouts) in the Render dashboard.

## Notes

- Four fictional demo businesses are seeded so the directory is never empty.
- Prices are in USD so the PayPal Sandbox works everywhere.
- In Sandbox mode the business Overview has a **Run payouts now** button, because nobody can wait 24 hours in a demo.

## Licence

MIT, see [LICENSE](./LICENSE).

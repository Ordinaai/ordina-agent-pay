# Ordina Agent Checkout

**Let any AI assistant book and pay for real-world services. The customer approves in PayPal; the agent never can.**

AI assistants can already find a hair salon or a physio. They can't safely book it and take payment: prices get made up, times get double-booked, and nobody wants an agent holding their card. Ordina Agent Checkout is the open-source layer in between:

- An assistant (Claude, ChatGPT, or your own agent) asks for a service.
- The business's own AI Secretary answers from the business's real price list and calendar, and holds a time.
- The gateway turns that hold into **one PayPal payment offer**, checked against the customer's spending limit.
- The customer approves it on a PayPal page. Only when PayPal confirms the capture does the booking exist.

Built by [Ordina](https://www.useordina.com) for the PayPal AI Hackathon 2026. Ordina runs AI Secretaries for businesses; this is how other people's agents will book and pay them.

> Live demo: _added once deployed_ · Video: _added once published_

![Ordina Agent Checkout: ask your agent, it agrees the booking with the business, you approve one PayPal payment](docs/screenshot.jpg)

## Four doors

| Door | Who uses it | What it does |
|---|---|---|
| **`/mcp`** | Any MCP client (Claude, ChatGPT apps, other agents) | Three tools: `find_businesses`, `message_business`, `booking_status`. No tool can pay. |
| **`/pay/<token>`** | The customer | A hosted page showing exactly what they approve (item, business, time, price, policy) with PayPal's button. The link is unguessable and lasts as long as the 15-minute hold. |
| **`/`** | Anyone trying it | A playground chat with our own agent. "Worked with..." under each answer shows every message, check, hold and PayPal call. Also: bookings with cancel, a spending limit, and the MCP address. |
| **`/business`** | Business owners | Each simulated business's bookings, what PayPal paid it, PayPal's fee, and **Refund** or **Cancel** for 180 days. |

## Try it from Claude

1. Add a custom connector in Claude with the address `https://<your deploy>/mcp`.
2. Ask: *"Book me a silk press in Lagos tomorrow morning, my name is Ada, up to $50."*
3. Claude finds Lumen Hair Studio, agrees a time with its Secretary, and gives you a pay link. Open it, approve with a PayPal Sandbox buyer account, and ask Claude whether it's booked.

Without Claude: `node node_modules/tsx/dist/cli.mjs scripts/mcp-probe.mts` acts as an outside agent against a local server and prints the offer and pay link.

## Safety is in the code, not the prompt

An agent that can spend money needs rules it cannot talk its way around. All of these are enforced by the server, whatever a model says, and each has a test (40 tests in `test/`):

| # | Rule | Where |
|---|---|---|
| 1 | Every price comes from the business's own list, never from what an agent writes | `server/commerce.ts` `startPayment` |
| 2 | A payment above the customer's spending limit is refused before any pay link exists | `requestApproval` |
| 3 | No agent can pay; only the customer approves in PayPal | no paying tool in `server/agents/buyer.ts` or `server/mcp.ts` |
| 4 | A booking exists only on a `COMPLETED` capture for the exact amount and currency, paid to this business's seller account | `captureAndConfirm` |
| 5 | A hold that ran out is never charged; an offer is captured once, by its own conversation | `captureAndConfirm` |
| 6 | Only businesses PayPal can pay are found or booked | `store.ts` `canBePaid`, `server/providers` |
| 7 | Only server objects are facts: agents act on the **payment offer** the server returns, never on what the Secretary writes | `agents/secretary.ts` `offer` |
| 8 | Sandbox money never books a real business: only sandbox-safe providers are switched on unless PayPal is live | `server/providers/index.ts` |
| 9 | Money that can't become a booking goes straight back: a capture that fails a check, or a booking the business's system refuses, is refunded in full | `captureAndConfirm` |
| 10 | Refunds for 180 days after payment: the customer inside the business's free-cancellation window, the owner any amount | `refund`, `customerCancel`, `businessRefund` |

## How PayPal is used

**Standard checkout, the default.** One PayPal seller account receives each payment at capture.

- **Orders v2** `POST /v2/checkout/orders` (`intent: CAPTURE`) at the business's listed price, created by the Secretary's `create_payment` tool.
- **PayPal JS SDK buttons** on the hosted pay page: the customer approves that exact order.
- **Orders v2 capture**: amount, currency, payee, PayPal's fee and the net come from PayPal's capture record, and rule 4 checks them.
- **Payments v2 refund**: full or partial, for 180 days.
- Every call carries a `PayPal-Request-Id`, so a retry never charges or refunds twice.

**Multiparty, on the roadmap** (`PAYPAL_FLOW=multiparty`, built and tested, needs PayPal partner approval). Each business connects its own PayPal (Partner Referrals), the order names it as payee with delayed disbursement, PayPal holds the money until 24 hours after the booking, and Referenced Payouts releases it. See [docs/BUSINESS_SIDE.md](docs/BUSINESS_SIDE.md).

## Providers

The gateway owns the money; a **provider** owns a business's catalogue, calendar and booking records. The demo uses the **simulated provider** (four fictional businesses). **Ordina** is the first real integration, written as an adapter that is switched off here and refuses every hold, so a Sandbox payment can never create a real appointment. Adding a provider never touches the money code: [docs/PROVIDERS.md](docs/PROVIDERS.md).

## How the agents are built

Two agents on the Claude API (`claude-opus-5-5`, low effort, server-side fallback on), each a small tool loop (`server/agents/loop.ts`):

- **The customer's agent** (`buyer.ts`, used by the playground): `find_businesses`, `message_business`, `request_payment_approval`. Through MCP, the outside assistant plays this part.
- **Each business's Secretary** (`secretary.ts`): `list_services`, `check_availability`, `hold_time`, `create_payment`, built from that business's details and the owner's notes.

The agents talk in plain language, but every fact that matters comes from the server: `message_business` returns the Secretary's reply **and** the server's payment offer.

## Run it

```bash
npm install
npm run build
npm start            # http://localhost:8787
```

With no keys it runs fully offline: scripted agents drive the same tools and PayPal is mocked with the same shapes. Settings go in `.env` (see [.env.example](.env.example)).

**With PayPal Sandbox:**

1. At [developer.paypal.com](https://developer.paypal.com), Sandbox accounts: make sure the **business** account is in a country that can take card payments (United States works). PayPal creates the default accounts in your own country, and a business account from a country PayPal only lets send money (Nigeria, for one) cannot be paid, by card or by PayPal.
2. Apps & Credentials, Sandbox: create an app (type Merchant) on that business account. Copy its **Client ID** and **Secret** into `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
3. Copy the business account's **Merchant ID** (Account ID) into `PAYPAL_SELLER_MERCHANT_ID`. Without it the server refuses to create payments, because rule 4 could not check the payee.
4. Pay either way: **PayPal** (sign in with a Sandbox personal account), or **Debit or Credit Card** with no PayPal account, using a test card from PayPal's [card testing page](https://developer.paypal.com/tools/sandbox/card-testing/) (for example Visa 4012 8888 8888 1881, any future date, any CVV).

**No PayPal account needed.** Customers can pay by card through PayPal's own form (guest checkout) wherever PayPal offers it; PayPal decides which buttons to show from where the buyer is. In the Sandbox the buttons assume a US buyer (`PAYPAL_SANDBOX_BUYER_COUNTRY`, default `US`), so the card button can be tried from any country; live always uses the buyer's real location.

**With Claude:** set `ANTHROPIC_API_KEY`. Agent turns are limited per IP per hour and per day (`TURNS_PER_IP_PER_HOUR`, `DAILY_TURN_CAP`), for the chat and MCP alike.

Data is SQLite (Node's built-in `node:sqlite`, Node 24), in `./data` or `DATA_DIR`. Tests: `npm test`.

**Deploy:** [render.yaml](render.yaml) is a Render blueprint (a starter instance with a 1 GB disk for the database). Set the secrets in Render, and `PUBLIC_URL` to the public address so MCP pay links point at it.

## Licence

MIT, see [LICENSE](./LICENSE).

# Providers

A **provider** is the system a business already runs on: its catalogue, its calendar, and its own record of bookings. The gateway never owns those. It owns the money: the payment offer, the PayPal order and capture, the booking ledger, refunds, and the safety rules in the README.

## Who does what

1. **Provider:** what the business sells, at what price, and which times are free. It holds a time for 15 minutes.
2. **Gateway:** makes a payment offer at the provider's price and checks the customer's spending limit.
3. **PayPal:** the customer approves and pays (a `COMPLETED` capture).
4. **Gateway:** writes the booking to its ledger, then tells the provider (`recordBooking`).
5. On a cancellation, the gateway refunds through PayPal and tells the provider (`recordCancellation`).

A hold is the provider's promise. Once it has given one, it must accept the booking for it. If it refuses anyway, the gateway refunds the customer in full and cancels the booking; the customer never pays for a booking that doesn't exist.

## The interface

`server/providers/types.ts`:

| Member | Meaning |
|---|---|
| `id`, `label` | Short id and a human name |
| `sandboxSafe` | May its businesses be booked with PayPal Sandbox money? Only simulated ones. |
| `businesses()` | Businesses that can be booked and paid now |
| `business(id)` | One business, or undefined if it isn't this provider's |
| `availability(businessId, serviceId, date)` | Free start or pickup times, in the business's local time |
| `hold(request)` | Hold one free time for 15 minutes, or say why not |
| `recordBooking(booking)` | PayPal confirmed the payment: write the booking into the provider's system |
| `recordCancellation(booking)` | The booking was cancelled in the gateway |

Everything that reads businesses (each business's Secretary, the playground's agent, the MCP server, the web API) goes through the registry in `server/providers/index.ts`. The money code calls only `recordBooking` and `recordCancellation`.

## The providers in this repo

**Simulated** (`simulated.ts`): four fictional businesses with real catalogues, opening hours and calendars, kept in the gateway's own database. The only provider switched on with Sandbox or mock money.

**Ordina** (`ordina.ts`): the first real integration, **not connected in this build**. Ordina's businesses are real and take real money, so the adapter lists no businesses and refuses every hold. While PayPal runs in Sandbox, the registry leaves out every provider that isn't sandbox-safe, so even a connected adapter would not be offered.

Once connected, it maps:

| Provider call | In Ordina |
|---|---|
| `businesses()` | Businesses in Ordina's public directory that opted in to agent bookings |
| `availability()` | The availability on the business's booking page |
| `hold()` | A short hold on that slot in Ordina's calendar |
| `recordBooking()` | The booking appears in the owner's Ordina dashboard |
| `recordCancellation()` | The slot frees up in Ordina |

## Adding a provider

1. Implement `Provider` in `server/providers/<name>.ts`, mapping the business's catalogue onto the `Business` and `Service` shapes in `server/store.ts` (prices in USD as strings, like `"35.00"`).
2. Set `sandboxSafe: false` unless every business it lists is fictional.
3. Add it to the list in `server/providers/index.ts`.
4. Add tests next to `test/providers.test.ts`: a refused hold, a refused booking (it must end in a full refund), and search.

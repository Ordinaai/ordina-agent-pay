# The business side: how it works

Decided with the founder, 11 November 2026.

## Sign-up and setup

- A business signs up with its name, email and password, category and city. The city sets the time zone.
- It cannot take agent bookings until **all** of these are done. **Go live** stays grey, and each missing item is named at its own field:
  1. at least one thing to sell, with a price;
  2. opening hours (at least one open day);
  3. a free-cancellation window in hours;
  4. a PayPal email address to be paid out to.
- What a business sells is one of two kinds:
  - **Appointment**: has a length in minutes, blocks the calendar, one at a time.
  - **Pickup item**: has a pickup time and a daily limit set by the owner; any number per time slot, up to the limit.
- The owner can write notes for its Secretary ("parking at the back", "no children's cuts").
- The owner can **pause** at any time. A paused business is hidden from customers' agents and its Secretary takes no bookings.
- Prices and hours can change at any time. Bookings already paid keep their price.

## How customers find a business

- **Directory**: every live business is searchable by every customer's agent, by what it sells, its category and its city.
- **Own link**: `/b/<handle>` opens the customer app with the agent already talking to that business, to share on Instagram or WhatsApp.

## Money

- **Ordina collects.** Every customer payment is a PayPal order on Ordina's PayPal account, at the business's listed price.
- **Fees:** the business gets the price minus exactly the fee PayPal charged, as PayPal reports it on the capture (`seller_receivable_breakdown`). Ordina takes nothing per sale; it earns from a subscription.
- **Payout time:** 24 hours after the appointment or pickup time, Ordina sends the business its net amount through **PayPal Payouts** to its PayPal email. A booking counts as paid out only when PayPal reports the payout item `SUCCESS`; until then it shows what PayPal said (pending, unclaimed, failed).
- **Refunds before payout:**
  - The **customer** may cancel inside the business's free-cancellation window for a full refund.
  - The **owner** may cancel or refund any booking for an amount they choose, from nothing up to what is left of the payment. What PayPal takes back from Ordina for each refund (its `seller_payable_breakdown`) comes off the business's payout.
- **After payout:** no refunds through Agent Pay. The Refund button goes away; anything later is between the owner and the customer. Ordina is never owed money by a business.
- A booking fully refunded before its payout time is never paid out.

## For the hackathon demo

- PayPal Sandbox for payments, refunds and payouts.
- Because a judge cannot wait 24 hours, a **Run payouts now** button exists only outside live mode; it treats every confirmed booking as due.
- The four demo businesses stay as seed data so the directory is never empty.

## Later, before real money

- Identity checks (KYC) for businesses, because Ordina holds their money until payout.
- PayPal's partner onboarding instead of a typed PayPal email.
- Email or WhatsApp notices to owners and customers.

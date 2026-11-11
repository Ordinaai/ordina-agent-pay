# The business side: how it works

Decided with the founder on 11 November 2026. Revised the same day: money moves through PayPal's
marketplace product (Multiparty) instead of through Ordina's own PayPal account.

## Sign-up and setup

- A business signs up with its name, email and password, category and city. The city sets the time zone.
- It cannot take agent bookings until **all** of these are done. **Go live** stays grey, and each missing
  item is named at its own field:
  1. at least one thing to sell, with a price;
  2. opening hours (at least one open day);
  3. a free-cancellation window in hours;
  4. **PayPal connected**: the owner connects their own PayPal account (PayPal Partner Referrals), and PayPal
     itself confirms the account can take payments and its email is confirmed. The return from PayPal is
     never trusted on its own; Ordina reads the account's state from PayPal.
- What a business sells is one of two kinds:
  - **Appointment**: has a length in minutes, blocks the calendar, one at a time.
  - **Pickup item**: has a pickup time and a daily limit set by the owner; any number per time slot, up to the limit.
- The owner can write notes for its Secretary, **pause** at any time (hidden from customers' agents, no
  bookings), and change prices and hours at any time (bookings already paid keep their price).

## How customers find a business

- **Directory**: every live business PayPal can pay is searchable by every customer's agent.
- **Own link**: `/b/<handle>` opens the customer app with the agent already talking to that business.

## Money: PayPal holds, then pays

- **Customers pay the business, not Ordina.** Every PayPal order names the business's own PayPal account as
  the payee, at the business's listed price, with **delayed disbursement**: after capture, PayPal holds the
  money.
- **Release:** 24 hours after the appointment or pickup ends, Ordina asks PayPal to release the money to the
  business (Referenced Payouts). It counts as released only when PayPal says so.
- **Fees:** the business pays PayPal's usual fee, read from PayPal's own capture record. Ordina takes nothing
  per sale today; a fee would be a PayPal platform fee on the order (`PLATFORM_FEE_PERCENT`, 0).
- **Customers:** identified by PayPal (the verified payer on the capture), and protected by PayPal's buyer
  protection.
- **Refunds while PayPal holds the money:**
  - the **customer** may cancel inside the business's free-cancellation window for a full refund;
  - the **owner** may cancel or refund any amount they choose, up to what is left.
  Refunds are made on the business's behalf, on the business's own PayPal capture.
- **After release:** no refunds through Ordina; anything later is between the owner and the customer.
- A booking fully refunded before release has nothing to release.

## Why this way

- Ordina never holds customer money, so it is not on the hook for chargebacks, money-transmission
  licences or paying sellers; PayPal checks each business's identity when it connects.
- The business sees its own money in its own PayPal from the moment the customer pays.

## Test mode and the demo

- With no PayPal keys, a mock with the same shapes runs everything, including a labelled stand-in for
  PayPal's consent page.
- **Release now** (Overview) exists only outside live mode, because nobody can wait 24 hours in a demo.
- Four fictional demo businesses are seeded, connected to one demo PayPal seller.

## For live use

- PayPal must approve Ordina as a Multiparty partner (BN code, partner merchant id, the
  DELAY_FUNDS_DISBURSEMENT and PARTNER_FEE features).
- Notices to owners and customers (email, WhatsApp).

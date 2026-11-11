// A provider is the system a business already runs on: its catalogue, its
// calendar, and its own record of bookings. The gateway never owns those. It
// owns the money: the payment offer, the PayPal order and capture, the
// booking ledger, refunds, and the eight rules.
//
// The split, step by step:
//   provider  -> what is sold, at what price, which times are free, hold a time
//   gateway   -> offer at the provider's price, the customer's limit, PayPal
//   PayPal    -> the customer approves and pays (COMPLETED capture)
//   gateway   -> booking in the ledger, then tells the provider (recordBooking)
//
// A hold is the provider's promise: once it has given one, it must accept the
// booking for it when the gateway reports a confirmed payment.
import type { Booking, Business, Hold } from "../store.ts";

export type HoldRequest = {
  businessId: string;
  serviceId: string;
  date: string; // YYYY-MM-DD, business local time
  time: string; // HH:mm, business local time
  customerName: string;
  sessionId: string;
};

export interface Provider {
  /** Short id, e.g. "simulated" or "ordina". */
  readonly id: string;
  /** Shown in docs and logs. */
  readonly label: string;
  /**
   * Whether this provider's businesses may be booked with PayPal Sandbox money.
   * Only simulated businesses are. A provider of real businesses is false: a
   * Sandbox payment must never create a real appointment.
   */
  readonly sandboxSafe: boolean;

  /** Businesses that can be booked and paid right now. */
  businesses(): Business[];
  /** One business by id, or undefined if it is not this provider's. */
  business(id: string): Business | undefined;
  /** Free start or pickup times for one item on one date (business local time). */
  availability(businessId: string, serviceId: string, date: string): string[];
  /** Hold one free time for 15 minutes while the customer pays. */
  hold(req: HoldRequest): Hold | { error: string };
  /** PayPal confirmed the payment: write the booking into the provider's system. */
  recordBooking(booking: Booking): Promise<{ ok: true; providerRef: string } | { ok: false; reason: string }>;
  /** The booking was cancelled in the gateway (with or without a refund). */
  recordCancellation(booking: Booking): Promise<void>;
}

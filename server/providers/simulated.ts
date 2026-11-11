// The simulated provider: fictional businesses with a real catalogue, opening
// hours and a calendar, kept in this gateway's own database. It is the only
// provider whose businesses may be booked with PayPal Sandbox money.
import { availability, createHold, getBusiness, liveBusinesses } from "../store.ts";
import type { Provider } from "./types.ts";

export const simulatedProvider: Provider = {
  id: "simulated",
  label: "Simulated businesses (demo data, Sandbox money)",
  sandboxSafe: true,
  businesses: () => liveBusinesses(),
  business: (id) => getBusiness(id),
  availability: (businessId, serviceId, date) => availability(businessId, serviceId, date),
  hold: (req) => createHold(req),
  // The calendar is this database: the booking row the gateway just wrote is the record.
  recordBooking: async (booking) => ({ ok: true, providerRef: booking.ref }),
  // Cancelling frees the time in availability() already (it only counts confirmed bookings).
  recordCancellation: async () => {},
};

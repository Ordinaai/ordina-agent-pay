// Ordina as a provider: the first real integration, NOT switched on in this
// build. Ordina's businesses are real and take real money, so this adapter
// lists no businesses and refuses every hold while PayPal runs in Sandbox.
//
// What it will do once connected (roadmap, see docs/PROVIDERS.md):
//   businesses()       -> Ordina's public directory, businesses that opted in
//   availability()     -> the business's booking page availability
//   hold()             -> a short hold on that slot in Ordina's calendar
//   recordBooking()    -> the booking appears in the owner's Ordina dashboard
//   recordCancellation -> the slot frees up in Ordina
import type { Provider } from "./types.ts";

const REFUSAL = "Ordina businesses are real and are never booked with PayPal Sandbox money. This adapter is not connected in this build.";

export const ordinaProvider: Provider = {
  id: "ordina",
  label: "Ordina (real businesses, not connected)",
  sandboxSafe: false,
  businesses: () => [],
  business: () => undefined,
  availability: () => [],
  hold: () => ({ error: REFUSAL }),
  recordBooking: async () => ({ ok: false, reason: REFUSAL }),
  recordCancellation: async () => {},
};

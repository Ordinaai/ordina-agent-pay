// The provider registry. Every place that reads businesses, times or holds
// (the Secretary, the playground's agent, the MCP server, the web API) goes
// through here, so adding a provider never touches the money code.
import { paypalMode } from "../paypal.ts";
import type { Business } from "../store.ts";
import { ordinaProvider } from "./ordina.ts";
import { simulatedProvider } from "./simulated.ts";
import type { Provider } from "./types.ts";

export type { HoldRequest, Provider } from "./types.ts";

const ALL: Provider[] = [simulatedProvider, ordinaProvider];

/** Providers in use. With Sandbox or mock money, only sandbox-safe ones: real businesses are never offered. */
export function providers(): Provider[] {
  const live = paypalMode() === "live";
  return ALL.filter((p) => live || p.sandboxSafe);
}

/** The provider a business belongs to, if any provider in use has it. */
export function providerFor(businessId: string): Provider | undefined {
  return providers().find((p) => p.business(businessId));
}

/** Every business that can be booked and paid now, across providers. */
export function bookableBusinesses(): Business[] {
  return providers().flatMap((p) => p.businesses());
}

/** A bookable business by id. */
export function bookableBusiness(id: string): Business | undefined {
  return bookableBusinesses().find((b) => b.id === id);
}

/**
 * Search by what the person wants. A word matches a business word when one
 * starts the other ("haircut" finds "hair", "cakes" finds "cake"). When nothing
 * matches, everything is returned rather than nothing, so an agent never reads
 * an empty list as "no such business". `pinned` floats one business to the top.
 */
export function searchBusinesses(query: string, pinned?: string): Business[] {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const close = (q: string, h: string) => h.length > 2 && (h.startsWith(q) || (h.length > 3 && q.startsWith(h)));
  const scored = bookableBusinesses().map((b) => {
    const hay = [b.name, b.category, b.city, b.about, ...b.services.map((s) => s.name)].join(" ").toLowerCase().split(/[^a-z0-9]+/);
    const score = words.filter((q) => hay.some((h) => close(q, h))).length + (b.id === pinned ? 100 : 0);
    return { b, score };
  });
  const hits = scored.filter((x) => x.score > 0);
  return (hits.length ? hits : scored).sort((a, z) => z.score - a.score).map((x) => x.b);
}

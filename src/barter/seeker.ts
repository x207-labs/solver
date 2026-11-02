import { planOffer, type Listing, type ListingSide, type Offer, type OfferPlan } from "@x207/core";
import { openListing, satisfies, type OpenListing } from "./match.js";

/** An agent the seeker may visit. Only `optIn` agents that are `discoverable` and idle ever get an offer (SV-016). */
export interface SeekerAgent {
  account: string;
  /** The agent asked to be found (its listing says `discoverable`). */
  discoverable: boolean;
  /** The agent agreed to receive offers from seekers. */
  optIn: boolean;
  /** No open negotiation or bundle right now. */
  idle: boolean;
  /** What the agent can hand over. */
  offers: ListingSide[];
  /** The agent can pay credit instead of handing over goods. */
  canPay: boolean;
}

export interface SeekerConfig {
  /** Account that earns the seeker share. */
  seeker: string;
  /** Seeker share in bps of the listing value; never above the discount of the listing. */
  searcherShareBps: number;
  epoch: number;
  /** Unix seconds. */
  now: number;
  /** Offers per agent in one period (SV-016). */
  maxOffersPerAgent: number;
  /** Length of a period in seconds. */
  periodSeconds: number;
  deliverIn?: number;
}

export interface SeekerOffer {
  to: string;
  listingHash: string;
  offer: Offer;
  /** Legs and amounts the offer would produce, with the seeker share as a leg. */
  plan: OfferPlan;
}

/**
 * Remembers what the seeker already sent: offers per agent per period and offers that an agent refused (SV-016).
 * In memory; a caller that wants it across runs persists `snapshot()`.
 */
export class OfferLedger {
  private sent = new Map<string, number[]>();
  private refused = new Set<string>();
  /** `agent\0listing` -> time of the last offer, so the same pair is not offered again within a period. */
  private pairs = new Map<string, number>();

  constructor(snapshot?: { sent: Record<string, number[]>; refused: string[]; pairs?: Record<string, number> }) {
    if (snapshot) {
      this.sent = new Map(Object.entries(snapshot.sent));
      this.refused = new Set(snapshot.refused);
      this.pairs = new Map(Object.entries(snapshot.pairs ?? {}));
    }
  }

  /** The pair got an offer less than `periodSeconds` before `now`. */
  recentlyOffered(agent: string, listingHash: string, now: number, periodSeconds: number): boolean {
    const at = this.pairs.get(`${agent}\u0000${listingHash}`);
    return at !== undefined && at > now - periodSeconds;
  }

  countInPeriod(agent: string, now: number, periodSeconds: number): number {
    return (this.sent.get(agent) ?? []).filter((t) => t > now - periodSeconds).length;
  }

  record(agent: string, now: number, listingHash?: string): void {
    this.sent.set(agent, [...(this.sent.get(agent) ?? []), now]);
    if (listingHash !== undefined) this.pairs.set(`${agent}\u0000${listingHash}`, now);
  }

  /** The agent refused `listingHash`; the seeker never offers that pair again. */
  refuse(agent: string, listingHash: string): void {
    this.refused.add(`${agent}\u0000${listingHash}`);
  }

  wasRefused(agent: string, listingHash: string): boolean {
    return this.refused.has(`${agent}\u0000${listingHash}`);
  }

  snapshot(): { sent: Record<string, number[]>; refused: string[]; pairs: Record<string, number> } {
    return { sent: Object.fromEntries(this.sent), refused: [...this.refused], pairs: Object.fromEntries(this.pairs) };
  }
}

/**
 * The autonomous seeker (SV-015, F9): for every discount listing it finds idle, discoverable, opt-in agents that can
 * fill the `want` of the listing and prepares an offer, `pay` when the listing accepts payment and the agent can pay,
 * otherwise `barter`. The seeker share is a leg of the bundle that `planOffer` produces. Spam guards (SV-016): no offer
 * without opt-in, at most `maxOffersPerAgent` per agent per period, never again a refused pair. The result is
 * deterministic and does not send anything; the caller delivers the offers to the agents and calls `ledger.record`.
 */
export function planSeekerOffers(listings: readonly Listing[], agents: readonly SeekerAgent[], ledger: OfferLedger, config: SeekerConfig): SeekerOffer[] {
  const book: OpenListing[] = listings
    .filter((l) => l.discount_bps > 0 && l.expires_at > config.now)
    .map(openListing)
    .sort((a, b) => (a.hash < b.hash ? -1 : 1));
  const planned = new Map<string, number>();
  const out: SeekerOffer[] = [];
  for (const agent of [...agents].sort((a, b) => (a.account < b.account ? -1 : 1))) {
    if (!agent.optIn || !agent.discoverable || !agent.idle) continue;
    for (const { listing, hash } of book) {
      if (listing.account === agent.account || ledger.wasRefused(agent.account, hash) || ledger.recentlyOffered(agent.account, hash, config.now, config.periodSeconds)) continue;
      const used = ledger.countInPeriod(agent.account, config.now, config.periodSeconds) + (planned.get(agent.account) ?? 0);
      if (used >= config.maxOffersPerAgent) break;
      const mode = listing.accept_payment && agent.canPay ? "pay" : "barter";
      if (mode === "barter" && !agent.offers.some((side) => satisfies(side, listing.want))) continue;
      const offer: Offer = {
        circle: listing.circle,
        listing_hash: hash,
        proposer: agent.account,
        round: 1,
        mode,
        value: listing.offer.value,
        quantity: listing.offer.quantity,
        deliver_by: config.now + (config.deliverIn ?? 3600),
      };
      const plan = planOffer({ listing, offer, epoch: config.epoch, searcher: config.seeker, searcherShareBps: config.searcherShareBps });
      out.push({ to: agent.account, listingHash: hash, offer, plan });
      planned.set(agent.account, (planned.get(agent.account) ?? 0) + 1);
    }
  }
  return out;
}

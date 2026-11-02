import { listingHash, planOffer, type BundleTerms, type Listing, type ListingSide, type OfferPlan } from "@x207/core";
import { findRings } from "./cycles.js";

/** A listing of the book with its hash. */
export interface OpenListing {
  listing: Listing;
  hash: string;
}

export const openListing = (listing: Listing): OpenListing => ({ listing, hash: listingHash(listing) });

/** `have` can be handed over for `want`: same asset type and class, at least the quantity wanted. Value is for the legs, not for matching. */
export const satisfies = (have: ListingSide, want: ListingSide): boolean =>
  have.asset_type === want.asset_type && have.asset_class === want.asset_class && have.quantity >= want.quantity;

const alive = (l: OpenListing, nowSeconds: number) => l.listing.expires_at > nowSeconds;

export interface BarterProposal {
  terms: BundleTerms;
  /** Hashes of the listings that make the bundle, in payment order. */
  listings: string[];
}

export interface MatchOptions {
  circle: string;
  epoch: number;
  /** Unix seconds; listings that expire at or before it are ignored. */
  now: number;
  /** Seconds after `now` by which the goods are due (`Offer.deliver_by` of the planned offer). */
  deliverIn?: number;
}

const byHash = (a: OpenListing, b: OpenListing) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0);

/**
 * Two-party matches (SV-013, F9): A's `offer` fills B's `want` and the other way round. The listing with the larger
 * discount is the seller (ties: the smaller hash), so a discount listing gets its cashback leg from the same
 * `planOffer` that the backend uses to recompute `terms_hash`. A listing is matched once; the result does not depend
 * on the order of the input.
 */
export function matchListings(listings: readonly OpenListing[], options: MatchOptions): BarterProposal[] {
  const open = listings.filter((l) => alive(l, options.now)).sort(byHash);
  const taken = new Set<string>();
  const out: BarterProposal[] = [];
  for (const a of open) {
    if (taken.has(a.hash)) continue;
    const b = open.find(
      (c) => c.hash !== a.hash && !taken.has(c.hash) && c.listing.account !== a.listing.account && satisfies(a.listing.offer, c.listing.want) && satisfies(c.listing.offer, a.listing.want),
    );
    if (!b) continue;
    const seller = a.listing.discount_bps >= b.listing.discount_bps ? a : b;
    const buyer = seller === a ? b : a;
    const plan = planOffer({
      listing: seller.listing,
      offer: {
        circle: seller.listing.circle,
        listing_hash: seller.hash,
        proposer: buyer.listing.account,
        round: 1,
        mode: "barter",
        value: seller.listing.offer.value,
        quantity: seller.listing.offer.quantity,
        deliver_by: options.now + (options.deliverIn ?? 3600),
      },
      epoch: options.epoch,
    });
    if (plan.kind !== "bundle") continue;
    taken.add(a.hash).add(b.hash);
    out.push({ terms: plan.terms, listings: [seller.hash, buyer.hash] });
  }
  return out;
}

/**
 * Rings A -> B -> C -> A of listings without a direct partner (SV-014, F9): each listing's `offer` fills the `want` of
 * the one that pays it. Run it on the listings that `matchListings` left over. Every payer pays the listed value of
 * what it receives.
 */
export function matchListingRings(listings: readonly OpenListing[], options: MatchOptions & { maxLength?: number }): BarterProposal[] {
  const open = listings.filter((l) => alive(l, options.now));
  const rings = findRings(open, {
    key: (l) => l.hash,
    account: (l) => l.listing.account,
    // `from` receives what `to` offers
    edge: (from, to) => satisfies(to.listing.offer, from.listing.want),
    minLength: 3,
    maxLength: options.maxLength,
  });
  return rings.map((ring) => ({
    terms: {
      circle: options.circle,
      epoch: options.epoch,
      legs: ring.map((l, i) => {
        const next = ring[(i + 1) % ring.length]!;
        return { payer: l.listing.account, payee: next.listing.account, max_amount: next.listing.offer.value };
      }),
    },
    listings: ring.map((l) => l.hash),
  }));
}

export type { OfferPlan };

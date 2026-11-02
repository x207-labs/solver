import { describe, expect, it } from "vitest";
import { generateVoucherKeypair, signBundle, termsHash, type Listing, type ListingSide } from "@x207/core";
import {
  collectBundleSignatures, cycleTerms, findIntentCycles, fullyClearedLegs, matchListingRings, matchListings, OfferLedger, openListing,
  planSeekerOffers, withBundleLegs, type OpenIntent, type SeekerAgent,
} from "../src/barter/index.js";
import { buildGraph } from "../src/graph/index.js";
import { solveClearing } from "../src/mincostflow/index.js";

const CIRCLE = "x207-circle.near";
const side = (service: string, value = "1000000", calls = 10) => ({ service, calls, value });
const intent = (account: string, offer: string, need: string, value = "1000000"): OpenIntent => ({ account, offer: side(offer, value), need: side(need, value) });

describe("SV-010 balanced rings of intents", () => {
  const a = intent("a.near", "translate", "summarize");
  const b = intent("b.near", "summarize", "scrape");
  const c = intent("c.near", "scrape", "translate");

  it("three complementary intents give one ring A -> B -> C -> A with balanced legs", () => {
    const rings = findIntentCycles([c, a, b]);
    expect(rings).toHaveLength(1);
    expect(rings[0]!.members.map((m) => m.account)).toEqual(["a.near", "b.near", "c.near"]);
    expect(rings[0]!.legs).toEqual([
      { payer: "a.near", payee: "b.near", max_amount: "1000000" },
      { payer: "b.near", payee: "c.near", max_amount: "1000000" },
      { payer: "c.near", payee: "a.near", max_amount: "1000000" },
    ]);
  });

  it("does not depend on the input order and the terms hash is reproducible", () => {
    const one = cycleTerms(findIntentCycles([a, b, c])[0]!, CIRCLE, 7);
    const two = cycleTerms(findIntentCycles([b, c, a])[0]!, CIRCLE, 7);
    expect(one.termsHash).toBe(two.termsHash);
    expect(one.termsHash).toBe(termsHash(one.terms));
  });

  it("an intent whose need is not offered exactly (value, calls, service) makes no ring", () => {
    expect(findIntentCycles([a, b, intent("c.near", "scrape", "translate", "999999")])).toEqual([]);
    expect(findIntentCycles([a, b])).toEqual([]);
  });

  it("two parties are a ring, an intent is used once, one account is not twice in a ring", () => {
    const x = intent("x.near", "summarize", "translate");
    const rings = findIntentCycles([a, x, intent("y.near", "summarize", "translate")]);
    expect(rings).toHaveLength(1);
    expect(rings[0]!.members.map((m) => m.account)).toEqual(["a.near", "x.near"]);
    const sameAccount = findIntentCycles([a, { ...b, account: "a.near" }, c]);
    expect(sameAccount).toEqual([]);
  });
});

describe("SV-011 signatures over terms_hash", () => {
  const keys = { "a.near": generateVoucherKeypair(), "b.near": generateVoucherKeypair(), "c.near": generateVoucherKeypair() } as const;
  const pubkeys = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v.publicKey]));
  const ring = cycleTerms(findIntentCycles([intent("a.near", "t", "s"), intent("b.near", "s", "x"), intent("c.near", "x", "t")])[0]!, CIRCLE, 1);

  it("holds three valid signatures when everyone agrees", async () => {
    const got = await collectBundleSignatures(ring.terms, pubkeys, async (account, terms) => signBundle(terms, account, keys[account as keyof typeof keys].secretKey));
    expect(got?.signatures.map((s) => s.account).sort()).toEqual(["a.near", "b.near", "c.near"]);
  });

  it("sends nothing when one participant stays silent, refuses, throws or signs with another key", async () => {
    const sign = (account: string, terms: typeof ring.terms, as = account) => signBundle(terms, account, keys[as as keyof typeof keys].secretKey);
    for (const bad of [async () => null, async () => { throw new Error("down"); }, async (account: string, terms: typeof ring.terms) => sign(account, terms, "a.near")]) {
      const got = await collectBundleSignatures(ring.terms, pubkeys, async (account, terms) => (account === "c.near" ? bad(account, terms) : sign(account, terms)));
      expect(got).toBeNull();
    }
  });
});

describe("SV-012 bundle legs in the clearing graph", () => {
  const legs = [
    { payer: "a.near", payee: "b.near", amount: 1_000_000n },
    { payer: "b.near", payee: "c.near", amount: 1_000_000n },
    { payer: "c.near", payee: "a.near", amount: 1_000_000n },
  ];

  it("a ring of fully delivered balanced legs is cleared completely", () => {
    const empty = buildGraph(CIRCLE, 1, []);
    const result = solveClearing(withBundleLegs(empty, legs));
    expect(result.clearedTotal).toBe(3_000_000n);
    expect(fullyClearedLegs(result, legs)).toHaveLength(3);
  });

  it("does not count a pair twice and keeps other obligations", () => {
    const graph = buildGraph(CIRCLE, 1, [{ debtor: "a.near", creditor: "b.near", amount: 1_000_000n }, { debtor: "d.near", creditor: "a.near", amount: 5n }]);
    const merged = withBundleLegs(graph, legs);
    expect(merged.edges.find((e) => e.debtor === "a.near" && e.creditor === "b.near")!.amount).toBe(1_000_000n);
    expect(merged.edges).toHaveLength(4);
  });

  it("an under-delivered leg is not fully cleared", () => {
    const short = [legs[0]!, legs[1]!, { ...legs[2]!, amount: 400_000n }];
    const result = solveClearing(withBundleLegs(buildGraph(CIRCLE, 1, []), short));
    expect(fullyClearedLegs(result, short).map((l) => l.payer)).toEqual(["c.near"]);
  });
});

const listing = (account: string, offer: ListingSide, want: ListingSide, extra: Partial<Listing> = {}): Listing => ({
  circle: CIRCLE, account, offer, want, terms: "t", detail: "d", expires_at: 2_000_000_000, discount_bps: 0, accept_payment: false, discoverable: true, nonce: account.replace(".", "-"), ...extra,
});
const thing = (asset_type: string, value = "100000000", quantity = 1, asset_class: ListingSide["asset_class"] = "A"): ListingSide => ({ asset_type, asset_class, quantity, value });
const NOW = 1_700_000_000;
const options = { circle: CIRCLE, epoch: 3, now: NOW };

describe("SV-013 two-party listing match", () => {
  it("A offers what B wants and the other way round: one reproducible bundle", () => {
    const a = openListing(listing("andi.near", thing("compute.gpu"), thing("data.set")));
    const b = openListing(listing("budi.near", thing("data.set"), thing("compute.gpu")));
    const first = matchListings([a, b], options);
    const second = matchListings([b, a], options);
    expect(first).toHaveLength(1);
    expect(first[0]).toEqual(second[0]);
    expect(first[0]!.terms.legs.map((l) => [l.payer, l.payee, l.max_amount])).toEqual(expect.arrayContaining([["andi.near", "budi.near", "100000000"], ["budi.near", "andi.near", "100000000"]]));
  });

  it("a discount listing adds the cashback leg (no seeker: the whole discount 10 is cashback, 110 and 100)", () => {
    const seller = openListing(listing("andi.near", thing("compute.gpu"), thing("data.set"), { discount_bps: 1000 }));
    const buyer = openListing(listing("budi.near", thing("data.set"), thing("compute.gpu")));
    const [proposal] = matchListings([buyer, seller], options);
    const legs = Object.fromEntries(proposal!.terms.legs.map((l) => [`${l.payer}>${l.payee}`, l.max_amount]));
    expect(legs["andi.near>budi.near"]).toBe("110000000");
    expect(legs["budi.near>andi.near"]).toBe("100000000");
    expect(proposal!.listings[0]).toBe(seller.hash);
  });

  it("no match on a different asset, class, short quantity, expiry or the same account", () => {
    const a = openListing(listing("andi.near", thing("compute.gpu"), thing("data.set")));
    expect(matchListings([a, openListing(listing("budi.near", thing("data.set"), thing("compute.cpu")))], options)).toEqual([]);
    expect(matchListings([a, openListing(listing("budi.near", thing("data.set", "1", 1, "B"), thing("compute.gpu")))], options)).toEqual([]);
    expect(matchListings([a, openListing(listing("budi.near", thing("data.set"), thing("compute.gpu", "1", 5)))], options)).toEqual([]);
    expect(matchListings([a, openListing(listing("budi.near", thing("data.set"), thing("compute.gpu"), { expires_at: NOW }))], options)).toEqual([]);
    expect(matchListings([a, openListing(listing("andi.near", thing("data.set"), thing("compute.gpu"), { nonce: "other" }))], options)).toEqual([]);
  });
});

describe("SV-014 rings of listings", () => {
  const a = openListing(listing("a.near", thing("x"), thing("y")));
  const b = openListing(listing("b.near", thing("y"), thing("z")));
  const c = openListing(listing("c.near", thing("z"), thing("x")));

  it("three listings without a direct pair give one ring", () => {
    expect(matchListings([a, b, c], options)).toEqual([]);
    const rings = matchListingRings([c, b, a], options);
    expect(rings).toHaveLength(1);
    expect([...rings[0]!.terms.legs].sort((p, q) => (p.payer < q.payer ? -1 : 1))).toEqual([
      { payer: "a.near", payee: "b.near", max_amount: "100000000" },
      { payer: "b.near", payee: "c.near", max_amount: "100000000" },
      { payer: "c.near", payee: "a.near", max_amount: "100000000" },
    ]);
    expect(rings[0]!.listings).toHaveLength(3);
    expect(matchListingRings([a, b, c], options)[0]!.terms).toEqual(rings[0]!.terms);
  });

  it("an expired listing breaks the ring", () => {
    expect(matchListingRings([a, b, { ...c, listing: { ...c.listing, expires_at: NOW - 1 } }], options)).toEqual([]);
  });
});

describe("SV-015 and SV-016 autonomous seeker", () => {
  const discount = listing("andi.near", thing("compute.gpu"), thing("data.set"), { discount_bps: 1000, accept_payment: true });
  const agent = (account: string, over: Partial<SeekerAgent> = {}): SeekerAgent => ({ account, discoverable: true, optIn: true, idle: true, offers: [thing("data.set")], canPay: false, ...over });
  const config = { seeker: "finder.near", searcherShareBps: 300, epoch: 3, now: NOW, maxOffersPerAgent: 2, periodSeconds: 3600 };

  it("an idle, discoverable, opt-in agent gets a barter offer whose bundle has the seeker share as a leg", () => {
    const [offer] = planSeekerOffers([discount], [agent("budi.near")], new OfferLedger(), config);
    expect(offer).toMatchObject({ to: "budi.near", offer: { mode: "barter", proposer: "budi.near" } });
    expect(offer!.plan.kind).toBe("bundle");
    if (offer!.plan.kind === "bundle") {
      const legs = Object.fromEntries(offer!.plan.terms.legs.map((l) => [`${l.payer}>${l.payee}`, l.max_amount]));
      expect(legs).toEqual({ "andi.near>budi.near": "107000000", "budi.near>andi.near": "100000000", "andi.near>finder.near": "3000000" });
    }
  });

  it("an agent that can pay gets a pay offer when the listing accepts payment: 93 split as 90 and 3", () => {
    const [offer] = planSeekerOffers([discount], [agent("budi.near", { canPay: true, offers: [] })], new OfferLedger(), config);
    expect(offer!.offer.mode).toBe("pay");
    if (offer!.plan.kind === "bundle") {
      const legs = Object.fromEntries(offer!.plan.terms.legs.map((l) => [`${l.payer}>${l.payee}`, l.max_amount]));
      expect(legs).toEqual({ "budi.near>andi.near": "90000000", "budi.near>finder.near": "3000000" });
    }
  });

  it("SV-016: no offer without opt-in, discoverable or idle, and none for a listing without discount", () => {
    const agents = [agent("a.near", { optIn: false }), agent("b.near", { discoverable: false }), agent("c.near", { idle: false })];
    expect(planSeekerOffers([discount], agents, new OfferLedger(), config)).toEqual([]);
    expect(planSeekerOffers([{ ...discount, discount_bps: 0 }], [agent("d.near")], new OfferLedger(), config)).toEqual([]);
  });

  it("SV-016: at most N offers per agent per period, counted across calls, and the window moves on", () => {
    const l2 = { ...discount, nonce: "n2" };
    const l3 = { ...discount, nonce: "n3" };
    const ledger = new OfferLedger();
    const first = planSeekerOffers([discount, l2, l3], [agent("budi.near")], ledger, config);
    expect(first).toHaveLength(2);
    first.forEach(() => ledger.record("budi.near", NOW));
    expect(planSeekerOffers([discount, l2, l3], [agent("budi.near")], ledger, config)).toEqual([]);
    expect(planSeekerOffers([discount, l2, l3], [agent("budi.near")], ledger, { ...config, now: NOW + 3601 })).toHaveLength(2);
  });

  it("SV-016: a refused offer is not made again, even after a restart from the snapshot", () => {
    const ledger = new OfferLedger();
    const [offer] = planSeekerOffers([discount], [agent("budi.near")], ledger, config);
    ledger.refuse("budi.near", offer!.listingHash);
    expect(planSeekerOffers([discount], [agent("budi.near")], ledger, config)).toEqual([]);
    const restored = new OfferLedger(ledger.snapshot());
    expect(planSeekerOffers([discount], [agent("budi.near")], restored, config)).toEqual([]);
    expect(planSeekerOffers([discount], [agent("other.near")], restored, config)).toHaveLength(1);
  });
});

describe("loaders of the intent and listing books", () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it("loadOpenIntents pages through the read API and skips what is not open", async () => {
    const { loadOpenIntents } = await import("../src/barter/index.js");
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      return url.includes("cursor=c2")
        ? json({ items: [{ intentHash: "h2", account: "b.near", offer: side("s"), need: side("x"), status: "open" }], nextCursor: null })
        : json({ items: [{ intentHash: "h1", account: "a.near", offer: side("t"), need: side("s"), status: "open" }, { intentHash: "h0", account: "z.near", offer: side("t"), need: side("s"), status: "expired" }], nextCursor: "c2" });
    }) as unknown as typeof fetch;
    const got = await loadOpenIntents({ readApiUrl: "http://api/", circle: CIRCLE, fetch: fetchFn });
    expect(got.map((i) => i.intentHash)).toEqual(["h1", "h2"]);
    expect(urls[0]).toBe(`http://api/x207/circles/${CIRCLE}/intents?status=open&limit=100`);
  });

  it("loadOpenListings rebuilds the signed shape, so the hash equals the hash the backend stored", async () => {
    const { loadOpenListings } = await import("../src/barter/index.js");
    const original = listing("andi.near", thing("compute.gpu"), thing("data.set"), { discount_bps: 500, accept_payment: true });
    const item = {
      account: original.account, offer: { assetType: "compute.gpu", assetClass: "A", quantity: 1, value: "100000000" }, want: { assetType: "data.set", assetClass: "A", quantity: 1, value: "100000000" },
      terms: original.terms, detail: original.detail, expiresAt: new Date(original.expires_at * 1000).toISOString(), discountBps: 500, acceptPayment: true, discoverable: true, nonce: original.nonce, status: "open",
    };
    const fetchFn = (async () => json({ items: [item], nextCursor: null })) as unknown as typeof fetch;
    const [got] = await loadOpenListings({ readApiUrl: "http://api", circle: CIRCLE, fetch: fetchFn });
    expect(got!.hash).toBe(openListing(original).hash);
  });

  it("a read API error is an error, not an empty book", async () => {
    const { loadOpenIntents } = await import("../src/barter/index.js");
    const fetchFn = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(loadOpenIntents({ readApiUrl: "http://api", circle: CIRCLE, fetch: fetchFn })).rejects.toThrow(/500/);
  });
});

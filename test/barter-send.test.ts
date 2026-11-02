import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateVoucherKeypair, referralHash, termsHash, verifyReferralSignature, type Listing, type ListingSide } from "@x207/core";
import { commitBundleArgs, postBundleProposal, readyProposals, referralOf, runBarterCli, sendReferrals, OfferLedger, planSeekerOffers, type ProposalView, type SeekerAgent } from "../src/barter/index.js";

const CIRCLE = "x207-circle.near";
const NOW = 1_700_000_000;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const thing = (asset_type: string, value = "100000000"): ListingSide => ({ asset_type, asset_class: "A", quantity: 1, value });
const listing: Listing = { circle: CIRCLE, account: "andi.near", offer: thing("compute.gpu"), want: thing("data.set"), terms: "t", detail: "d", expires_at: 2_000_000_000, discount_bps: 1000, accept_payment: false, discoverable: true, nonce: "n1" };
const agent: SeekerAgent = { account: "budi.near", discoverable: true, optIn: true, idle: true, offers: [thing("data.set")], canPay: false };
const terms = { circle: CIRCLE, epoch: 4, legs: [{ payer: "a.near", payee: "b.near", max_amount: "5" }, { payer: "b.near", payee: "a.near", max_amount: "5" }] };

describe("SV-011 proposals to the book and commit_bundle", () => {
  it("postBundleProposal sends terms and hash, and tells new from existing", async () => {
    const seen: any[] = [];
    const fetchFn = (async (url: string, init: any) => {
      seen.push({ url, body: JSON.parse(init.body) });
      return json({ termsHash: "h", status: "proposed", epoch: 4, terms, participants: ["a.near", "b.near"], signatures: [], missing: ["a.near", "b.near"] }, seen.length === 1 ? 201 : 200);
    }) as unknown as typeof fetch;
    const api = { readApiUrl: "http://api", circle: "agents-main", fetch: fetchFn };
    expect((await postBundleProposal(api, terms, termsHash(terms))).created).toBe(true);
    expect((await postBundleProposal(api, terms, termsHash(terms))).created).toBe(false);
    expect(seen[0].url).toBe("http://api/x207/circles/agents-main/bundle-proposals");
    expect(seen[0].body).toEqual({ terms, termsHash: termsHash(terms) });
  });

  it("a refusal of the book is an error with the code", async () => {
    const fetchFn = (async () => json({ error: { code: "epoch_not_open" } }, 409)) as unknown as typeof fetch;
    await expect(postBundleProposal({ readApiUrl: "http://api", circle: "c", fetch: fetchFn }, terms, "x")).rejects.toThrow(/409: epoch_not_open/);
  });

  it("commitBundleArgs needs a complete proposal and renames the signature field", () => {
    const ready: ProposalView = { termsHash: "h", status: "ready", epoch: 4, terms, participants: ["a.near", "b.near"], signatures: [{ account: "a.near", signature: "ed25519:s1" }, { account: "b.near", signature: "ed25519:s2" }], missing: [] };
    expect(commitBundleArgs(ready)).toEqual({ bundle: { epoch: 4, legs: terms.legs }, signatures: [{ account_id: "a.near", signature: "ed25519:s1" }, { account_id: "b.near", signature: "ed25519:s2" }] });
    expect(() => commitBundleArgs({ ...ready, status: "proposed", missing: ["b.near"] })).toThrow(/belum lengkap/);
  });

  it("commit sends commit_bundle for every ready proposal of the epoch and reports a refusal", async () => {
    const ready = (hash: string, epoch: number): ProposalView => ({ termsHash: hash, status: "ready", epoch, terms, participants: ["a.near", "b.near"], signatures: [{ account: "a.near", signature: "ed25519:s1" }, { account: "b.near", signature: "ed25519:s2" }], missing: [] });
    const fetchFn = (async () => json({ items: [ready("h1", 4), ready("h2", 4), ready("h3", 5)] })) as unknown as typeof fetch;
    const sent: any[] = [];
    const out: string[] = [];
    const commit = async (args: any) => {
      sent.push(args);
      return sent.length === 1 ? ({ ok: true, txHash: "tx1" } as const) : ({ ok: false, error: "ERR_BUNDLE_EXISTS: x" } as const);
    };
    const code = await runBarterCli(["commit", "--epoch", "4"], { env: { X207_READ_API_URL: "http://api" }, fetch: fetchFn, commit, out: (l) => out.push(l), err: () => {} });
    expect(sent).toHaveLength(2);
    expect(code).toBe(1);
    expect(JSON.parse(out[0]!).committed).toEqual([{ termsHash: "h1", ok: true, txHash: "tx1" }, { termsHash: "h2", ok: false, error: "ERR_BUNDLE_EXISTS: x" }]);
  });

  it("rings --send posts every proposal", async () => {
    const posts: string[] = [];
    const sideOf = (service: string) => ({ service, calls: 10, value: "1000000" });
    const fetchFn = (async (url: string, init?: any) => {
      if (init?.method === "POST") {
        posts.push(JSON.parse(init.body).termsHash);
        return json({ termsHash: "h", status: "proposed", epoch: 4, terms, participants: [], signatures: [], missing: [] }, 201);
      }
      return json(url.includes("/intents")
        ? { items: [
            { intentHash: "h1", account: "a.near", offer: sideOf("t"), need: sideOf("s"), status: "open" },
            { intentHash: "h2", account: "b.near", offer: sideOf("s"), need: sideOf("t"), status: "open" }], nextCursor: null }
        : { items: [], nextCursor: null });
    }) as unknown as typeof fetch;
    const out: string[] = [];
    await runBarterCli(["rings", "--epoch", "4", "--send"], { env: { X207_READ_API_URL: "http://api", X207_CONTRACT_ID: CIRCLE }, fetch: fetchFn, now: () => NOW * 1000, out: (l) => out.push(l), err: () => {} });
    expect(posts).toHaveLength(1);
    expect(JSON.parse(out[0]!).sent).toEqual([{ termsHash: posts[0], created: true }]);
  });
});

const key = generateVoucherKeypair();

describe("SV-015 referrals to the agent inbox", () => {
  const config = { seeker: "finder.near", secretKey: key.secretKey, circle: CIRCLE, now: NOW, ttlSeconds: 600, searcherShareBps: 300 };
  const offers = () => planSeekerOffers([listing], [agent], new OfferLedger(), { seeker: "finder.near", searcherShareBps: 300, epoch: 4, now: NOW, maxOffersPerAgent: 3, periodSeconds: 3600 });

  it("a referral copies the prepared offer, expires after the ttl and carries a unique nonce", () => {
    const [offer] = offers();
    const r = referralOf(offer!, 2, config);
    expect(r).toMatchObject({ circle: CIRCLE, seeker: "finder.near", to: "budi.near", listing_hash: offer!.listingHash, mode: "barter", value: "100000000", quantity: 1, searcher_share_bps: 300, expires_at: NOW + 600, nonce: `r${NOW}-2` });
  });

  it("sendReferrals signs with the seeker key and posts to the book; refused and rejected are told apart", async () => {
    const posted: any[] = [];
    const replies = [json({ ok: true }, 201), json({ error: { code: "referral_refused" } }, 409), json({ error: { code: "member_not_active" } }, 403)];
    const fetchFn = (async (_url: string, init: any) => {
      posted.push(JSON.parse(init.body));
      return replies[posted.length - 1]!;
    }) as unknown as typeof fetch;
    const base = offers()[0]!;
    const three = [base, { ...base, to: "cici.near" }, { ...base, to: "dedi.near" }];
    const outcomes = await sendReferrals({ readApiUrl: "http://api", circle: "agents-main", fetch: fetchFn }, three, config);
    expect(outcomes.map((o) => o.status)).toEqual(["sent", "refused", "rejected"]);
    expect(outcomes[2]!.code).toBe("member_not_active");
    for (const p of posted) expect(verifyReferralSignature(p.referral, p.signature, key.publicKey)).toBe(true);
    expect(new Set(posted.map((p) => referralHash(p.referral))).size).toBe(3);
  });

  it("seek --send needs the seeker key, records only what was sent and remembers a refusal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "barter-send-"));
    const agents = join(dir, "agents.json");
    writeFileSync(agents, JSON.stringify([agent, { ...agent, account: "cici.near" }]));
    const item = { account: "andi.near", offer: { assetType: "compute.gpu", assetClass: "A", quantity: 1, value: "100000000" }, want: { assetType: "data.set", assetClass: "A", quantity: 1, value: "100000000" }, terms: "t", detail: "d", expiresAt: new Date(2_000_000_000 * 1000).toISOString(), discountBps: 1000, acceptPayment: false, discoverable: true, nonce: "n1", status: "open" };
    const fetchFn = (async (_url: string, init?: any) => {
      if (init?.method !== "POST") return json({ items: [item], nextCursor: null });
      return JSON.parse(init.body).referral.to === "cici.near" ? json({ error: { code: "referral_refused" } }, 409) : json({ ok: true }, 201);
    }) as unknown as typeof fetch;
    const ledger = join(dir, "ledger.json");
    const argv = ["seek", "--epoch", "4", "--agents", agents, "--seeker", "finder.near", "--ledger", ledger, "--record", "--send"];
    const io = { env: { X207_READ_API_URL: "http://api", X207_CONTRACT_ID: CIRCLE } as NodeJS.ProcessEnv, fetch: fetchFn, now: () => NOW * 1000, out: () => {}, err: () => {} };
    await expect(runBarterCli(argv, io)).rejects.toThrow(/SEEKER_PRIVATE_KEY/);
    const out: string[] = [];
    await runBarterCli(argv, { ...io, env: { ...io.env, SEEKER_PRIVATE_KEY: key.secretKey }, out: (l) => out.push(l) });
    expect(JSON.parse(out[0]!).sent.map((o: any) => `${o.to}:${o.status}`)).toEqual(["budi.near:sent", "cici.near:refused"]);
    const saved = JSON.parse(readFileSync(ledger, "utf8"));
    expect(Object.keys(saved.sent)).toEqual(["budi.near"]);
    expect(saved.refused).toHaveLength(1);
    const again: string[] = [];
    await runBarterCli(argv, { ...io, env: { ...io.env, SEEKER_PRIVATE_KEY: key.secretKey }, out: (l) => again.push(l) });
    expect(JSON.parse(again[0]!).sent ?? []).toEqual([]);
  });
});

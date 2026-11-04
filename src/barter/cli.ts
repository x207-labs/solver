import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { termsHash } from "@x207/core";
import { BUNDLE_GAS_TGAS, readSubmitConfig, UsageError } from "../config.js";
import { NearRpcChain, parseSecretKey, type SubmitOutcome } from "../submit/index.js";
import { cycleTerms, findIntentCycles } from "./cycles.js";
import { loadOpenIntents, loadOpenListings } from "./load.js";
import { matchListingRings, matchListings } from "./match.js";
import { checkSeekerAdmission } from "./admission.js";
import { OfferLedger, planSeekerOffers, type SeekerAgent } from "./seeker.js";
import { commitBundleArgs, postBundleProposal, readyProposals, sendReferrals } from "./send.js";

export interface BarterCliIo {
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Sends `commit_bundle` to the contract; the default signs with `SOLVER_*` through `NearRpcChain`. */
  commit?: (args: unknown) => Promise<SubmitOutcome>;
}

const USAGE = `usage: x207-barter rings --epoch <n> [--send]
       x207-barter commit --epoch <n>
       x207-barter seek --epoch <n> --agents <file.json> --seeker <account> [--share-bps <n>] [--max-offers <n>] [--period <seconds>] [--ledger <file.json>] [--record] [--send] [--ttl <seconds>] [--min-stake <units>]`;

/**
 * `x207-barter` (SV-011, SV-015). `rings` reads the open intents and listings from the read API and prints the bundle
 * proposals (terms and `terms_hash`) for the agents to sign. `seek` prepares offers of the autonomous seeker for the
 * agents in a file and prints them; `--record` stores what was prepared in the ledger file so the limits hold across runs.
 * Neither command sends anything: the channel that carries proposals and offers to the agents is a backend job.
 */
export async function runBarterCli(argv: string[], io: BarterCliIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== "rings" && command !== "seek" && command !== "commit") throw new UsageError(USAGE);
  const { values } = parseArgs({
    args: rest,
    options: {
      epoch: { type: "string" }, agents: { type: "string" }, seeker: { type: "string" }, "share-bps": { type: "string" },
      "max-offers": { type: "string" }, period: { type: "string" }, ledger: { type: "string" }, record: { type: "boolean" },
      send: { type: "boolean" }, ttl: { type: "string" }, "min-stake": { type: "string" },
    },
  });
  const int = (name: string, raw: string | undefined, fallback?: number): number => {
    if (raw === undefined) {
      if (fallback === undefined) throw new UsageError(`--${name} is required\n${USAGE}`);
      return fallback;
    }
    if (!/^\d+$/.test(raw)) throw new UsageError(`--${name} must be an integer >= 0, got "${raw}"`);
    return Number(raw);
  };
  const epoch = int("epoch", values.epoch);
  const readApiUrl = io.env.X207_READ_API_URL;
  if (!readApiUrl) throw new UsageError("X207_READ_API_URL is required (see .env.example)");
  const circle = io.env.X207_CIRCLE_ID || "agents-main";
  const contract = io.env.X207_CONTRACT_ID || circle;
  const book = { readApiUrl, circle, contractId: contract, ...(io.fetch ? { fetch: io.fetch } : {}) };
  const nowSeconds = Math.floor((io.now ?? Date.now)() / 1000);

  if (command === "rings") {
    const intents = await loadOpenIntents(book);
    const listings = await loadOpenListings(book);
    const options = { circle: contract, epoch, now: nowSeconds };
    const pairs = matchListings(listings, options);
    const matched = new Set(pairs.flatMap((p) => p.listings));
    const rings = matchListingRings(listings.filter((l) => !matched.has(l.hash)), options);
    const intentRings = findIntentCycles(intents).map((ring) => ({ ...cycleTerms(ring, contract, epoch), members: ring.members.map((m) => m.account) }));
    const sent: { termsHash: string; created: boolean }[] = [];
    if (values.send === true) {
      const proposals = [...intentRings.map((r) => r.terms), ...pairs.map((p) => p.terms), ...rings.map((r) => r.terms)];
      for (const terms of proposals) {
        const hash = intentRings.find((r) => r.terms === terms)?.termsHash ?? termsHash(terms);
        const { created } = await postBundleProposal({ readApiUrl, circle, ...(io.fetch ? { fetch: io.fetch } : {}) }, terms, hash);
        sent.push({ termsHash: hash, created });
      }
    }
    io.out(JSON.stringify({ epoch, intentRings, listingPairs: pairs, listingRings: rings, ...(values.send === true ? { sent } : {}) }));
    io.err(`x207-barter: ${intentRings.length} cincin intent, ${pairs.length} pasangan listing, ${rings.length} cincin listing`);
    return 0;
  }

  if (command === "commit") {
    const ready = await readyProposals({ readApiUrl, circle, ...(io.fetch ? { fetch: io.fetch } : {}) }, epoch);
    const send =
      io.commit ??
      (async (args: unknown) => {
        const submit = readSubmitConfig(io.env);
        if (submit === null) throw new UsageError("commit needs NEAR_RPC_URL, X207_CONTRACT_ID, SOLVER_ACCOUNT_ID and SOLVER_PRIVATE_KEY");
        const chain = new NearRpcChain({
          rpcUrl: submit.rpcUrl, contractId: submit.contractId, signerId: submit.signerId, key: parseSecretKey(submit.secretKey), gasTgas: submit.gasExplicit ? submit.gasTgas : BUNDLE_GAS_TGAS,
          ...(submit.gasKeyNonceIndex === undefined ? {} : { gasKeyNonceIndex: submit.gasKeyNonceIndex }),
        });
        return chain.call("commit_bundle", args);
      });
    let failed = 0;
    const results: { termsHash: string; ok: boolean; txHash?: string; error?: string }[] = [];
    for (const proposal of ready) {
      const outcome = await send(commitBundleArgs(proposal));
      if (!outcome.ok) failed += 1;
      results.push({ termsHash: proposal.termsHash, ok: outcome.ok, ...(outcome.ok ? { txHash: outcome.txHash } : { error: outcome.error }) });
    }
    io.out(JSON.stringify({ epoch, committed: results }));
    io.err(`x207-barter: ${ready.length} complete proposals, ${ready.length - failed} commit_bundle accepted`);
    return failed === 0 ? 0 : 1;
  }

  const agentsFile = values.agents;
  const seeker = values.seeker;
  if (!agentsFile || !seeker) throw new UsageError(`--agents and --seeker are required\n${USAGE}`);
  const agents = JSON.parse(readFileSync(agentsFile, "utf8")) as SeekerAgent[];
  const ledgerFile = values.ledger;
  const ledger = new OfferLedger(ledgerFile && existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, "utf8")) : undefined);
  const listings = (await loadOpenListings(book)).map((l) => l.listing);
  const offers = planSeekerOffers(listings, agents, ledger, {
    seeker, epoch, now: nowSeconds, searcherShareBps: int("share-bps", values["share-bps"], 300),
    maxOffersPerAgent: int("max-offers", values["max-offers"], 3), periodSeconds: int("period", values.period, 86_400),
  });
  let outcomes: Awaited<ReturnType<typeof sendReferrals>> | undefined;
  if (values.send === true) {
    const key = io.env.SEEKER_PRIVATE_KEY;
    if (!key || !key.startsWith("ed25519:")) throw new UsageError("--send needs SEEKER_PRIVATE_KEY (ed25519:<base58>, voucher key of the seeker account)");
    const minStake = BigInt(int("min-stake", values["min-stake"] ?? io.env.X207_SEEKER_MIN_STAKE, 1));
    const admission = await checkSeekerAdmission(book, seeker, minStake);
    if (!admission.ok) {
      io.out(JSON.stringify({ epoch, seeker, offers: [], refused: admission.reason }));
      io.err(`x207-barter: seeker refused (${admission.reason}): ${admission.detail}`);
      return 1;
    }
    outcomes = await sendReferrals({ readApiUrl, circle, ...(io.fetch ? { fetch: io.fetch } : {}) }, offers, {
      seeker, secretKey: key as `ed25519:${string}`, circle: contract, now: nowSeconds, ttlSeconds: int("ttl", values.ttl, 3600),
      searcherShareBps: int("share-bps", values["share-bps"], 300),
    });
    for (const o of outcomes) if (o.status === "refused") ledger.refuse(o.to, o.listingHash);
  }
  if (values.record === true) {
    if (!ledgerFile) throw new UsageError("--record butuh --ledger");
    const sentTo = new Set((outcomes ?? offers.map((o) => ({ to: o.to, listingHash: o.listingHash, status: "sent" as const }))).filter((o) => o.status === "sent").map((o) => `${o.to}\u0000${o.listingHash}`));
    for (const o of offers) if (sentTo.has(`${o.to}\u0000${o.listingHash}`)) ledger.record(o.to, nowSeconds, o.listingHash);
  }
  if (ledgerFile && (values.record === true || (outcomes ?? []).some((o) => o.status === "refused"))) writeFileSync(ledgerFile, JSON.stringify(ledger.snapshot()));
  io.out(JSON.stringify({ epoch, seeker, offers, ...(outcomes ? { sent: outcomes } : {}) }));
  io.err(`x207-barter: ${offers.length} offers prepared${outcomes ? `, ${outcomes.filter((o) => o.status === "sent").length} sent` : ""}${values.record ? ", recorded" : ""}`);
  return 0;
}

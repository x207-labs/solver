import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { UsageError } from "../config.js";
import { cycleTerms, findIntentCycles } from "./cycles.js";
import { loadOpenIntents, loadOpenListings } from "./load.js";
import { matchListingRings, matchListings } from "./match.js";
import { OfferLedger, planSeekerOffers, type SeekerAgent } from "./seeker.js";

export interface BarterCliIo {
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE = `usage: x207-barter rings --epoch <n>
       x207-barter seek --epoch <n> --agents <file.json> --seeker <account> [--share-bps <n>] [--max-offers <n>] [--period <seconds>] [--ledger <file.json>] [--record]`;

/**
 * `x207-barter` (SV-011, SV-015). `rings` reads the open intents and listings from the read API and prints the bundle
 * proposals (terms and `terms_hash`) for the agents to sign. `seek` prepares offers of the autonomous seeker for the
 * agents in a file and prints them; `--record` stores what was prepared in the ledger file so the limits hold across runs.
 * Neither command sends anything: the channel that carries proposals and offers to the agents is a backend job.
 */
export async function runBarterCli(argv: string[], io: BarterCliIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== "rings" && command !== "seek") throw new UsageError(USAGE);
  const { values } = parseArgs({
    args: rest,
    options: {
      epoch: { type: "string" }, agents: { type: "string" }, seeker: { type: "string" }, "share-bps": { type: "string" },
      "max-offers": { type: "string" }, period: { type: "string" }, ledger: { type: "string" }, record: { type: "boolean" },
    },
  });
  const int = (name: string, raw: string | undefined, fallback?: number): number => {
    if (raw === undefined) {
      if (fallback === undefined) throw new UsageError(`--${name} wajib diisi\n${USAGE}`);
      return fallback;
    }
    if (!/^\d+$/.test(raw)) throw new UsageError(`--${name} harus bilangan bulat >= 0, diterima "${raw}"`);
    return Number(raw);
  };
  const epoch = int("epoch", values.epoch);
  const readApiUrl = io.env.X207_READ_API_URL;
  if (!readApiUrl) throw new UsageError("X207_READ_API_URL wajib diisi (lihat .env.example)");
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
    io.out(JSON.stringify({ epoch, intentRings, listingPairs: pairs, listingRings: rings }));
    io.err(`x207-barter: ${intentRings.length} cincin intent, ${pairs.length} pasangan listing, ${rings.length} cincin listing`);
    return 0;
  }

  const agentsFile = values.agents;
  const seeker = values.seeker;
  if (!agentsFile || !seeker) throw new UsageError(`--agents dan --seeker wajib diisi\n${USAGE}`);
  const agents = JSON.parse(readFileSync(agentsFile, "utf8")) as SeekerAgent[];
  const ledgerFile = values.ledger;
  const ledger = new OfferLedger(ledgerFile && existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, "utf8")) : undefined);
  const listings = (await loadOpenListings(book)).map((l) => l.listing);
  const offers = planSeekerOffers(listings, agents, ledger, {
    seeker, epoch, now: nowSeconds, searcherShareBps: int("share-bps", values["share-bps"], 300),
    maxOffersPerAgent: int("max-offers", values["max-offers"], 3), periodSeconds: int("period", values.period, 86_400),
  });
  if (values.record === true) {
    if (!ledgerFile) throw new UsageError("--record butuh --ledger");
    for (const o of offers) ledger.record(o.to, nowSeconds);
    writeFileSync(ledgerFile, JSON.stringify(ledger.snapshot()));
  }
  io.out(JSON.stringify({ epoch, seeker, offers }));
  io.err(`x207-barter: ${offers.length} tawaran disiapkan${values.record ? " dan dicatat" : ""}`);
  return 0;
}

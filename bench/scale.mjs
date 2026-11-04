#!/usr/bin/env node
// SV-021: the solver at the size a judge asks about: random graphs of 50, 200 and 1000 members, densities 0.01 to 0.5, amounts that differ by three orders of magnitude.
//   npm run bench:solver                      (from the root of the umbrella or from solver/; it builds first)
//   node bench/scale.mjs [--write] [--timeout 60] [--repeat 3] [--seed 20261104] [--only 200,1000]
// For each graph: the time of `solveClearing` with no cut of the edges (median of --repeat runs while a run is quick), the share of the debt that is cleared, the number of edges of the optimum against the
// 300 edges that `submit_clearing` takes (MAX_EDGES_PER_TX), what one proposal of 300 edges clears (whole cycles dropped), what more rounds (one proposal each epoch) would clear, and the size in bytes of the
// edges as JSON against 16 KiB (the limit of one log message of NEAR). A case runs in its own process and is stopped at --timeout seconds.
// --write puts the tables between the markers `<!-- sv021:start -->` and `<!-- sv021:end -->` of docs/benchmark.md. The graphs come from a seeded generator: every column except the times is the same on every run.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, dflt) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : dflt);
const SEED = Number(flag("seed", 20261104));
const TIMEOUT_S = Number(flag("timeout", 120));
const REPEAT = Number(flag("repeat", 3));
const LOG_LIMIT = 16384; // bytes of one log message
const MAX_EDGES = 300; // MAX_EDGES_PER_TX of the contract
const ROUNDS = 6;
const SIZES = [50, 200, 1000];
const DENSITIES = (flag("p", null)?.split(",").map(Number)) ?? [0.01, 0.05, 0.1, 0.25, 0.5];
const CREDIT = 1_000_000n;

/** mulberry32: a small deterministic generator. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** An amount of 1 to 1000 credit, spread evenly on a log scale (a few large, many small), with the cents of a real price. */
const amount = (r) => BigInt(Math.max(1, Math.round(10 ** (r() * 3) * 100))) * (CREDIT / 100n);
const name = (i, width) => `m${String(i).padStart(4, "0")}.${"x".repeat(Math.max(0, width - 5 - ".near".length))}.near`.slice(0, width);

/** Edges of a directed random graph; each ordered pair has an obligation with probability p. */
function randomEdges(n, p, seed, width) {
  const r = rng(seed);
  const edges = [];
  for (let a = 0; a < n; a += 1) for (let b = 0; b < n; b += 1) if (a !== b && r() < p) edges.push({ debtor: name(a, width), creditor: name(b, width), amount: amount(r) });
  return edges;
}

const ms = (x) => (x < 10 ? x.toFixed(1) : String(Math.round(x)));
const pct = (num, den) => (den === 0n ? 0 : Number((num * 10000n) / den) / 100);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// ---- worker: one case in its own process -----------------------------------------------------------------------------------------------------------------------------------------
if (argv[0] === "--case") {
  const { n, p } = JSON.parse(argv[1]);
  const { buildGraph } = await import("../dist/graph/index.js");
  const { decomposeCycles, solveClearing } = await import("../dist/mincostflow/index.js");
  const seed = SEED + n * 7 + Math.round(p * 1000);
  const raw = randomEdges(n, p, seed, 22); // names as long as m0001.x207-v013.testnet (22)
  const graph = buildGraph("bench.near", 1, raw);
  const total = graph.totalObligation;
  const times = [];
  let result;
  for (let i = 0; i < REPEAT; i += 1) {
    const t0 = performance.now();
    result = solveClearing(graph, { maxEdges: Number.MAX_SAFE_INTEGER });
    times.push(performance.now() - t0);
    if (times[0] > 5000) break; // a slow case is measured once
  }
  const optimal = result.proposal.edges;
  const bytes = (width) => {
    const edges = optimal.map((e) => ({ debtor: name(Number(/^m(\d+)/.exec(e.debtor)[1]), width), creditor: name(Number(/^m(\d+)/.exec(e.creditor)[1]), width), cleared: e.cleared }));
    return Buffer.byteLength(JSON.stringify(edges));
  };
  const perEdge22 = optimal.length === 0 ? 0 : bytes(22) / optimal.length;
  const perEdge64 = optimal.length === 0 ? 0 : bytes(64) / optimal.length;
  const head = {
    n, p, members: graph.members.length, obligations: graph.edges.length, ms: median(times), runs: times.length, seed,
    optimumEdges: optimal.length, clearedPct: pct(result.clearedTotal, total), ceilingPct: pct(result.clearedTotal, total - result.nid),
    cycles: decomposeCycles(optimal).length, longest: decomposeCycles(optimal).reduce((m, y) => Math.max(m, y.edges.length), 0),
    bytes22: Math.round(perEdge22 * optimal.length), bytes64: Math.round(perEdge64 * optimal.length), perEdge22: Math.round(perEdge22), perEdge64: Math.round(perEdge64),
    fit22: perEdge22 === 0 ? null : Math.floor(LOG_LIMIT / perEdge22), fit64: perEdge64 === 0 ? null : Math.floor(LOG_LIMIT / perEdge64),
  };
  // the first result goes out at once: if the rounds below take longer than the limit of the case, the time and the shares of the optimum are still there
  process.stdout.write(`${JSON.stringify({ ...head, rounds: null, rss: Math.round(process.memoryUsage().rss / 1048576) })}\n`);
  // rounds: one proposal of at most 300 edges each epoch; what it clears comes off the debts, and the next epoch solves the rest
  let current = graph;
  let cumulative = 0n;
  const rounds = [];
  const t1 = performance.now();
  for (let k = 0; k < ROUNDS; k += 1) {
    const round = solveClearing(current, { maxEdges: MAX_EDGES });
    if (round.status !== "ok") break;
    cumulative += round.clearedTotal;
    rounds.push({ edges: round.proposal.edges.length, clearedPct: pct(cumulative, total) });
    const cleared = new Map(round.proposal.edges.map((e) => [`${e.debtor}>${e.creditor}`, BigInt(e.cleared)]));
    current = buildGraph("bench.near", 1, current.edges.map((e) => ({ ...e, amount: e.amount - (cleared.get(`${e.debtor}>${e.creditor}`) ?? 0n) })));
    if (round.proposal.edges.length < MAX_EDGES && !round.pruned) break; // nothing was cut: the optimum of the rest is the rest
  }
  const roundsMs = performance.now() - t1;
  process.stdout.write(
    JSON.stringify({
      n, p, members: graph.members.length, obligations: graph.edges.length, ms: median(times), runs: times.length, seed,
      optimumEdges: optimal.length, clearedPct: pct(result.clearedTotal, total), ceilingPct: pct(result.clearedTotal, total - result.nid),
      cycles: decomposeCycles(optimal).length, longest: decomposeCycles(optimal).reduce((m, y) => Math.max(m, y.edges.length), 0),
      bytes22: Math.round(perEdge22 * optimal.length), bytes64: Math.round(perEdge64 * optimal.length), perEdge22: Math.round(perEdge22), perEdge64: Math.round(perEdge64),
      fit22: perEdge22 === 0 ? null : Math.floor(LOG_LIMIT / perEdge22), fit64: perEdge64 === 0 ? null : Math.floor(LOG_LIMIT / perEdge64),
      rounds, roundsMs, rss: Math.round(process.memoryUsage().rss / 1048576),
    }),
  );
  process.exit(0);
}

// ---- driver ------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const only = flag("only", null)?.split(",").map(Number);
const rows = [];
for (const n of SIZES) {
  if (only && !only.includes(n)) continue;
  for (const p of DENSITIES) {
    const started = performance.now();
    const run = spawnSync(process.execPath, ["--max-old-space-size=8192", fileURLToPath(import.meta.url), "--case", JSON.stringify({ n, p }), "--seed", String(SEED), "--repeat", String(REPEAT)], {
      encoding: "utf8", timeout: TIMEOUT_S * 1000, maxBuffer: 64 * 1024 * 1024,
    });
    // the worker prints the solve first and the rounds after: the last complete line is the most it got to
    const lines = (run.stdout || "").split("\n").filter((l) => l.startsWith("{") && l.endsWith("}"));
    if (lines.length > 0) {
      const row = JSON.parse(lines.at(-1));
      if (row.rounds === null) row.unfinished = run.error?.code === "ETIMEDOUT" ? `rounds not finished in ${TIMEOUT_S} s` : "rounds not finished";
      rows.push(row);
    } else {
      const why = run.error?.code === "ETIMEDOUT" ? `stopped after ${TIMEOUT_S} s` : run.signal ? `killed (${run.signal})` : `failed (${(run.stderr || "").trim().split("\n")[0]?.slice(0, 80)})`;
      rows.push({ n, p, stopped: why, obligations: Math.round(n * (n - 1) * p) });
    }
    process.stderr.write(`n=${n} p=${p}: ${rows.at(-1).stopped ?? `${ms(rows.at(-1).ms)} ms`} (${Math.round((performance.now() - started) / 100) / 10} s)\n`);
  }
}

// ---- tables ------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const machine = `${os.cpus()[0]?.model ?? "unknown CPU"}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GiB, ${os.platform()} ${os.arch()} (${os.release()})`;
let commit = "unknown";
try {
  commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: here, encoding: "utf8" }).trim();
} catch {
  /* not a checkout */
}
const pkg = JSON.parse(readFileSync(join(here, "../package.json"), "utf8"));
const num = (x) => x.toLocaleString("en-US");
const t1 = [
  "| members | density | obligations | solver time, ms | cleared, % of the debt | % of the ceiling | edges of the optimum | cycles | longest cycle |",
  "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...rows.map((r) => (r.stopped ? `| ${r.n} | ${r.p} | about ${num(r.obligations)} | **${r.stopped}** | | | | | |` : `| ${r.n} | ${r.p} | ${num(r.obligations)} | ${ms(r.ms)}${r.runs === 1 ? " (one run)" : ""} | ${r.clearedPct.toFixed(1)} | ${r.ceilingPct.toFixed(1)} | ${num(r.optimumEdges)} | ${num(r.cycles)} | ${r.longest} |`)),
];
const t2 = [
  "| members | density | edges of the optimum | proposals of at most 300 edges (epochs) to clear it all | cleared by epoch 1 | by epoch 2 | by epoch 3 | by epoch 6 | optimum as JSON, 22 character names, KiB | 64 character names, KiB | edges that fit 16 KiB (22 / 64 characters) |",
  "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...rows.filter((r) => !r.stopped).map((r) => {
    if (!r.rounds) return `| ${r.n} | ${r.p} | ${num(r.optimumEdges)} | **${r.unfinished}** | | | | | ${(r.bytes22 / 1024).toFixed(1)} | ${(r.bytes64 / 1024).toFixed(1)} | ${r.fit22 === null ? "-" : `${r.fit22} / ${r.fit64}`} |`;
    const at = (k) => (r.rounds[k - 1] ? `${r.rounds[k - 1].clearedPct.toFixed(1)}` : r.rounds.length ? `${r.rounds.at(-1).clearedPct.toFixed(1)}` : "0.0");
    const done = r.optimumEdges <= MAX_EDGES ? "1" : r.rounds.length >= ROUNDS ? `more than ${ROUNDS}` : String(r.rounds.length);
    return `| ${r.n} | ${r.p} | ${num(r.optimumEdges)} | ${r.optimumEdges === 0 ? "0" : done} | ${at(1)} | ${at(2)} | ${at(3)} | ${at(6)} | ${(r.bytes22 / 1024).toFixed(1)} | ${(r.bytes64 / 1024).toFixed(1)} | ${r.fit22 === null ? "-" : `${r.fit22} / ${r.fit64}`} |`;
  }),
];
const section = [
  "<!-- sv021:start -->",
  `Measured by \`npm run bench:solver\`. Machine: ${machine}. Node ${process.version}. Solver \`${pkg.name}@${pkg.version}\` at commit \`${commit}\`. Seed ${SEED} (graph seed = seed + 7 n + 1000 p), ${REPEAT} runs per case (median; a case slower than 5 s runs once), a case is stopped after ${TIMEOUT_S} s. Account names of 22 characters for the time; the byte sizes are given for 22 and for 64 characters (the longest NEAR name). Amounts are 1 to 1000 credit, spread evenly on a log scale.`,
  "",
  "#### Time and cleared share (no cut of the edges)",
  "",
  ...t1,
  "",
  "#### Edges against the limits (300 edges per transaction, 16 KiB per log message)",
  "",
  "Epochs: the contract takes ONE proposal per epoch (`submit_clearing`, at most 300 edges); what it clears comes off the debts and the next epoch solves the rest. \"Cleared by epoch k\" is the cumulative share of the original debt, each proposal cut to whole cycles of at most 300 edges (`selectCycles`).",
  "",
  ...t2,
  "<!-- sv021:end -->",
].join("\n");

if (argv.includes("--write")) {
  const file = join(here, "../docs/benchmark.md");
  const text = readFileSync(file, "utf8");
  const a = text.indexOf("<!-- sv021:start -->");
  const b = text.indexOf("<!-- sv021:end -->");
  if (a < 0 || b < 0) throw new Error("docs/benchmark.md has no sv021 markers");
  writeFileSync(file, text.slice(0, a) + section + text.slice(b + "<!-- sv021:end -->".length));
  process.stderr.write("docs/benchmark.md updated\n");
} else console.log(section);

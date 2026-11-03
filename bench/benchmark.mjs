#!/usr/bin/env node
// SV-019: benchmark of the clearing solver on dense and star shaped circles. Deterministic: the graphs come from a fixed seed, only the times differ between runs.
//   npm run build && node bench/benchmark.mjs [--json] [--repeat 5]
// For each graph: the time of `solveClearing` (median of --repeat runs, milliseconds), the number of cycles of the unpruned optimum, the share of the debt that clearing removes
// (cleared / total obligation) and the share of what could be removed at best (everything except the net imbalance, nid), the number of edges of the solution against
// DEFAULT_MAX_EDGES_PER_TX (300) and the cycles that fit a bundle of 64 legs (the barter path, CT-063).
import { performance } from "node:perf_hooks";
import { buildGraph } from "../dist/graph/index.js";
import { decomposeCycles, solveClearing, DEFAULT_MAX_EDGES_PER_TX } from "../dist/mincostflow/index.js";

const BUNDLE_LEGS = 64;
const args = process.argv.slice(2);
const json = args.includes("--json");
const repeat = Number(args[args.indexOf("--repeat") + 1]) || 5;

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
const name = (i) => `m${String(i).padStart(3, "0")}.x207.near`;
const CREDIT = 1_000_000n;
const edge = (a, b, credits) => ({ debtor: name(a), creditor: name(b), amount: BigInt(credits) * CREDIT });

/** Directed random graph: each ordered pair has an obligation with probability p, of 1 to 1000 credit. */
function random(n, p, seed) {
  const r = rng(seed);
  const edges = [];
  for (let a = 0; a < n; a += 1) for (let b = 0; b < n; b += 1) if (a !== b && r() < p) edges.push(edge(a, b, 1 + Math.floor(r() * 1000)));
  return edges;
}
/** One hub, `n - 1` leaves. Each leaf owes the hub (it buys from it). `back` is the share of leaves that the hub owes in return (it buys from them). */
function star(n, back, seed) {
  const r = rng(seed);
  const edges = [];
  for (let i = 1; i < n; i += 1) {
    edges.push(edge(i, 0, 1 + Math.floor(r() * 1000)));
    if (r() < back) edges.push(edge(0, i, 1 + Math.floor(r() * 1000)));
  }
  return edges;
}
/** `hubs` hubs; every leaf trades with one or two hubs, paying them; hubs owe each other and some leaves. */
function stars(n, hubs, back, seed) {
  const r = rng(seed);
  const edges = [];
  const seen = new Set();
  const add = (a, b, c) => {
    if (a !== b && !seen.has(`${a}>${b}`)) {
      seen.add(`${a}>${b}`);
      edges.push(edge(a, b, c));
    }
  };
  for (let i = hubs; i < n; i += 1) {
    add(i, Math.floor(r() * hubs), 1 + Math.floor(r() * 1000));
    if (r() < 0.5) add(i, Math.floor(r() * hubs), 1 + Math.floor(r() * 1000));
    if (r() < back) add(Math.floor(r() * hubs), i, 1 + Math.floor(r() * 1000));
  }
  for (let a = 0; a < hubs; a += 1) for (let b = 0; b < hubs; b += 1) if (r() < 0.5) add(a, b, 1 + Math.floor(r() * 1000));
  return edges;
}
/** A ring of `n` members with one obligation each, plus `chords` random extra ones. */
function ring(n, chords, seed) {
  const r = rng(seed);
  const edges = [];
  const seen = new Set();
  for (let i = 0; i < n; i += 1) {
    seen.add(`${i}>${(i + 1) % n}`);
    edges.push(edge(i, (i + 1) % n, 1 + Math.floor(r() * 1000)));
  }
  for (let k = 0; k < chords; k += 1) {
    const a = Math.floor(r() * n);
    const b = Math.floor(r() * n);
    if (a !== b && !seen.has(`${a}>${b}`)) {
      seen.add(`${a}>${b}`);
      edges.push(edge(a, b, 1 + Math.floor(r() * 1000)));
    }
  }
  return edges;
}

const cases = [];
for (const n of [20, 50, 100, 200]) for (const p of [0.02, 0.05, 0.1, 0.3]) cases.push({ family: "random", label: `random n=${n} p=${p}`, n, make: () => random(n, p, 1000 + n + Math.round(p * 1000)) });
for (const n of [20, 50, 100, 200]) for (const back of [0, 0.2, 0.5, 1]) cases.push({ family: "star", label: `star n=${n} hub pays back ${back * 100}% of leaves`, n, make: () => star(n, back, 2000 + n + Math.round(back * 100)) });
for (const n of [50, 200]) for (const hubs of [3, 8]) cases.push({ family: "stars", label: `${hubs} hubs n=${n}`, n, make: () => stars(n, hubs, 0.3, 3000 + n + hubs) });
for (const n of [20, 100, 200]) cases.push({ family: "ring", label: `ring n=${n} plus ${n} chords`, n, make: () => ring(n, n, 4000 + n) });

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const rows = [];
for (const c of cases) {
  const graph = buildGraph("bench.near", 1, c.make());
  let result;
  const times = [];
  for (let i = 0; i < repeat; i += 1) {
    const t0 = performance.now();
    result = solveClearing(graph, { maxEdges: Number.MAX_SAFE_INTEGER });
    times.push(performance.now() - t0);
  }
  const optimal = result.proposal.edges;
  const cycles = decomposeCycles(optimal);
  const total = graph.totalObligation;
  const cleared = result.clearedTotal;
  const best = total - result.nid; // an upper bound on what a cycle can remove: the net imbalance stays
  const pruned = solveClearing(graph, { maxEdges: DEFAULT_MAX_EDGES_PER_TX });
  rows.push({
    case: c.label, family: c.family, members: graph.members.length, edges: graph.edges.length, ms: median(times),
    cycles: cycles.length, longest: cycles.reduce((m, y) => Math.max(m, y.edges.length), 0), fitBundle: cycles.filter((y) => y.edges.length <= BUNDLE_LEGS).length,
    solutionEdges: optimal.length, clearedPct: total === 0n ? 0 : Number((cleared * 10000n) / total) / 100, shareOfBestPct: best === 0n ? 0 : Number((cleared * 10000n) / best) / 100,
    prunedAt300: result.proposal.edges.length > DEFAULT_MAX_EDGES_PER_TX, clearedPctAfterPrune: total === 0n ? 0 : Number((pruned.clearedTotal * 10000n) / total) / 100,
  });
}
if (json) console.log(JSON.stringify(rows, null, 2));
else {
  console.log("case | members | edges | ms | cycles | longest | cycles <=64 legs | solution edges | cleared % of debt | cleared % of the best | cleared % after the 300 edge cut");
  for (const r of rows) console.log([r.case, r.members, r.edges, r.ms.toFixed(1), r.cycles, r.longest, r.fitBundle, r.solutionEdges, r.clearedPct.toFixed(1), r.shareOfBestPct.toFixed(1), r.clearedPctAfterPrune.toFixed(1)].join(" | "));
}

import { compareEdges, type ObligationEdge, type ObligationGraph } from "../src/graph/index.js";
import type { Proposal } from "../src/mincostflow/index.js";

/** Obligations left after applying a proposal, without the fully cleared edges. */
export function residualEdges(graph: ObligationGraph, proposal: Proposal): ObligationEdge[] {
  return graph.edges
    .map((edge) => {
      const applied = proposal.edges.find((item) => compareEdges(item, edge) === 0);
      return { ...edge, amount: edge.amount - BigInt(applied?.cleared ?? 0) };
    })
    .filter((edge) => edge.amount > 0n);
}

export function hasCycle(edges: { debtor: string; creditor: string }[]): boolean {
  const next = new Map<string, string[]>();
  for (const edge of edges) next.set(edge.debtor, [...(next.get(edge.debtor) ?? []), edge.creditor]);
  const done = new Set<string>();
  const onPath = new Set<string>();
  const visit = (node: string): boolean => {
    if (onPath.has(node)) return true;
    if (done.has(node)) return false;
    onPath.add(node);
    const found = (next.get(node) ?? []).some(visit);
    onPath.delete(node);
    done.add(node);
    return found;
  };
  return [...next.keys()].some(visit);
}

/** Exact best integer circulation: max total cleared, then fewest cleared edges. Small graphs only. */
export function bruteForceBest(graph: ObligationGraph): { total: bigint; edgeCount: number } {
  const edges = graph.edges;
  const lastUse = new Map<string, number>();
  edges.forEach((edge, i) => lastUse.set(edge.debtor, i).set(edge.creditor, i));
  const balance = new Map(graph.members.map((member) => [member, 0n]));
  let best = { total: 0n, edgeCount: 0 };

  const assign = (i: number, total: bigint, edgeCount: number): void => {
    if (i === edges.length) {
      if (total > best.total || (total === best.total && edgeCount < best.edgeCount)) {
        best = { total, edgeCount };
      }
      return;
    }
    const edge = edges[i]!;
    for (let cleared = 0n; cleared <= edge.amount; cleared++) {
      balance.set(edge.debtor, balance.get(edge.debtor)! - cleared);
      balance.set(edge.creditor, balance.get(edge.creditor)! + cleared);
      // A member with no edges left must already balance. This prunes nearly everything.
      const settled = [edge.debtor, edge.creditor].every(
        (member) => lastUse.get(member) !== i || balance.get(member) === 0n,
      );
      if (settled) assign(i + 1, total + cleared, edgeCount + (cleared > 0n ? 1 : 0));
      balance.set(edge.debtor, balance.get(edge.debtor)! + cleared);
      balance.set(edge.creditor, balance.get(edge.creditor)! - cleared);
    }
  };
  assign(0, 0n, 0);
  return best;
}

/** Greedy baseline: repeatedly cancel a shortest cycle by its bottleneck. */
export function greedyPerCycle(graph: ObligationGraph): bigint {
  const left = graph.edges.map((edge) => ({ ...edge }));
  let total = 0n;
  for (;;) {
    const cycle = shortestCycle(left);
    if (cycle === undefined) return total;
    const amount = cycle.reduce((min, edge) => (edge.amount < min ? edge.amount : min), cycle[0]!.amount);
    for (const edge of cycle) edge.amount -= amount;
    total += amount * BigInt(cycle.length);
  }
}

function shortestCycle(edges: ObligationEdge[]): ObligationEdge[] | undefined {
  let best: ObligationEdge[] | undefined;
  for (const first of edges) {
    if (first.amount === 0n) continue;
    // BFS back from first.creditor to first.debtor closes the shortest cycle through first.
    const via = new Map<string, ObligationEdge | null>([[first.creditor, null]]);
    const queue = [first.creditor];
    for (const node of queue) {
      for (const edge of edges) {
        if (edge.debtor !== node || edge.amount === 0n || via.has(edge.creditor)) continue;
        via.set(edge.creditor, edge);
        queue.push(edge.creditor);
      }
    }
    if (!via.has(first.debtor)) continue;
    const cycle = [first];
    for (let step = via.get(first.debtor); step; step = via.get(step.debtor)) cycle.push(step);
    if (best === undefined || cycle.length < best.length) best = cycle;
  }
  return best;
}

export type Random = () => number;

/** mulberry32: small seeded generator so a failing graph can be replayed from its seed. */
export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (random: Random, low: number, high: number): number =>
  low + Math.floor(random() * (high - low + 1));

export interface RandomGraphOptions {
  maxMembers: number;
  maxEdges: number;
  /** Largest edge value, in the same unit as the amounts. */
  maxAmount: number;
  acyclic?: boolean;
}

export function randomEdges(random: Random, options: RandomGraphOptions): ObligationEdge[] {
  const memberCount = int(random, 2, options.maxMembers);
  const pairs = new Set<string>();
  const edges: ObligationEdge[] = [];
  const edgeTarget = int(random, 1, options.maxEdges);
  for (let tries = 0; edges.length < edgeTarget && tries < edgeTarget * 4; tries++) {
    let from = int(random, 0, memberCount - 1);
    let to = int(random, 0, memberCount - 1);
    if (from === to) continue;
    if (options.acyclic && from > to) [from, to] = [to, from];
    const key = `${from}:${to}`;
    if (pairs.has(key)) continue;
    pairs.add(key);
    edges.push({
      debtor: `m${from}.near`,
      creditor: `m${to}.near`,
      amount: BigInt(int(random, 1, options.maxAmount)),
    });
  }
  return edges;
}

import { compareEdges, type ObligationGraph } from "../graph/index.js";
import { minCostFlow } from "./flow.js";

/** A-SV-01: the largest graph (edges) and the most trials the edge-count pass takes on; above this the optimum of `minCostFlow` is used as it is (the choice stays deterministic: no clock). */
export const EDGE_PASS_MAX_GRAPH_EDGES = 1000;
export const EDGE_PASS_MAX_TRIALS = 150;

/**
 * Spec 4.3: on an equal `cleared_total` the contract keeps the proposal with FEWER edges, so a rival that finds one edge fewer replaces ours.
 * `minCostFlow` maximises the cleared value but is blind to the number of cleared edges. This pass keeps the total and lowers the count:
 * an edge counts as cleared when its flow is below its obligation, so "one cleared edge fewer" means "one more edge with flow = obligation" (a saturated edge).
 *
 * Greedy: for each cleared edge (smallest cleared first) fix its flow at the full obligation, solve the min-cost flow of the rest, and keep the change only if the
 * total flow stays the optimum (the cleared total stays the same). Fixing a set S of edges leaves the rest graph with the net positions of the graph without S,
 * which is exactly what `minCostFlow` of that rest graph solves. A refusal can turn into an acceptance after another edge changed, so the candidates are tried again
 * until a round changes nothing or the trials are used up. Not a proof of the fewest edges (the exact problem is NP-hard), but it never raises the count or lowers the total.
 *
 * `flows` is the flow per edge of `graph.edges` (obligation left after clearing); returns the same shape.
 */
export function minimizeClearedEdges(graph: ObligationGraph, flows: bigint[]): bigint[] {
  if (graph.edges.length > EDGE_PASS_MAX_GRAPH_EDGES) return flows;
  const edges = graph.edges;
  const optimum = flows.reduce((sum, flow) => sum + flow, 0n);
  let current = [...flows];
  const saturated = new Set<number>();
  const absorbSaturated = (): void => {
    edges.forEach((edge, k) => {
      if (current[k]! === edge.amount) saturated.add(k);
    });
  };
  absorbSaturated();

  /** Fixes edge `i` (and every edge saturated so far) at the full obligation; keeps the result only if the total flow is still the optimum. */
  const tryFix = (i: number): boolean => {
    const fixed = new Set(saturated).add(i);
    const restIndexes = edges.map((_, k) => k).filter((k) => !fixed.has(k));
    const restFlows = minCostFlow({ ...graph, edges: restIndexes.map((k) => edges[k]!) });
    let total = 0n;
    for (const k of fixed) total += edges[k]!.amount;
    for (const flow of restFlows) total += flow;
    if (total !== optimum) return false; // fixing this edge would cost cleared value
    const next = edges.map((): bigint => 0n);
    for (const k of fixed) next[k] = edges[k]!.amount;
    restIndexes.forEach((k, position) => {
      next[k] = restFlows[position]!;
    });
    current = next;
    absorbSaturated(); // the new flow can saturate further edges as a side effect
    return true;
  };

  const tried = new Set<string>();
  let trials = 0;
  for (let progress = true; progress && trials < EDGE_PASS_MAX_TRIALS; ) {
    progress = false;
    const candidates = edges
      .map((edge, i) => ({ i, edge, cleared: edge.amount - current[i]! }))
      .filter((item) => item.cleared > 0n)
      .sort((a, b) => (a.cleared === b.cleared ? 0 : a.cleared < b.cleared ? -1 : 1) || compareEdges(a.edge, b.edge));
    for (const { i } of candidates) {
      if (trials >= EDGE_PASS_MAX_TRIALS) break;
      if (saturated.has(i)) continue;
      const stateKey = `${i}:${[...saturated].sort((a, b) => a - b).join(",")}`;
      if (tried.has(stateKey)) continue; // same edge, same fixed set: same answer
      tried.add(stateKey);
      trials++;
      if (tryFix(i)) progress = true;
    }
  }
  return current;
}

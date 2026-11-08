// A-SV-01: at an equal cleared_total the contract keeps the proposal with FEWER edges (spec 4.3), so the solver must not leave an edge that a rival can drop.
import { describe, expect, it } from "vitest";
import { buildGraph, type ObligationEdge } from "../src/graph/index.js";
import { checkProposal, minCostFlow, netPositions, solveClearing } from "../src/mincostflow/index.js";
import { bruteForceBest, randomEdges, seededRandom, type RandomGraphOptions } from "./graph-utils.js";

const E = (d: string, c: string, a: number): ObligationEdge => ({ debtor: `${d}.near`, creditor: `${c}.near`, amount: BigInt(a) });
const SMALL: RandomGraphOptions = { maxMembers: 5, maxEdges: 9, maxAmount: 3 };

// the witness found by the audit (seed 66): 4 members, 8 edges; the old solver proposed 8 edges at total 12, a 7-edge proposal with total 12 exists
const WITNESS = [E("m0", "m1", 2), E("m0", "m2", 1), E("m0", "m3", 2), E("m1", "m0", 3), E("m1", "m2", 3), E("m2", "m0", 1), E("m2", "m3", 3), E("m3", "m0", 3)];

describe("A-SV-01 fewest edges at the optimal total", () => {
  it("TC-SV-006-01 the audit witness: total 12 with 7 edges, accepted by the local check", () => {
    const graph = buildGraph("c", 66, WITNESS);
    const result = solveClearing(graph);
    const best = bruteForceBest(graph);
    expect(result.clearedTotal).toBe(best.total);
    expect(result.proposal.edges).toHaveLength(best.edgeCount);
    expect(result.proposal.edges).toHaveLength(7);
    expect(checkProposal(graph, result.proposal, 300).ok).toBe(true);
  });

  it("TC-SV-006-02 400 small random graphs: the total is the exact optimum and the edge count never rises above what min-cost flow alone gives; it reaches the exact minimum on almost all", () => {
    let aboveExact = 0;
    let improved = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const graph = buildGraph("agents-main", seed, randomEdges(seededRandom(seed), SMALL));
      const result = solveClearing(graph);
      const best = bruteForceBest(graph);
      const plain = minCostFlow(graph).filter((flow, i) => graph.edges[i]!.amount - flow > 0n).length;
      expect(result.clearedTotal, `seed ${seed}`).toBe(best.total);
      expect(result.proposal.edges.length, `seed ${seed}`).toBeGreaterThanOrEqual(best.edgeCount);
      expect(result.proposal.edges.length, `seed ${seed}`).toBeLessThanOrEqual(plain);
      if (result.proposal.edges.length < plain) improved++;
      if (result.proposal.edges.length > best.edgeCount) aboveExact++;
    }
    // The exact minimum is NP-hard; the greedy pass is a local optimum. Seed 88 is the known case that needs two edges to change at once (5 edges, the exact minimum is 4).
    expect(aboveExact, `improved ${improved}, above exact ${aboveExact}`).toBeLessThanOrEqual(2); // measured on these 400: min-cost flow alone is above the exact minimum on 3, with the pass on 1 (seed 88 area); improved on 2
    expect(improved, `improved ${improved}, above exact ${aboveExact}`).toBeGreaterThan(0);
  });

  it("TC-SV-006-03 conservation stays: net positions unchanged and cleared never above an obligation, on 300 larger graphs", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const graph = buildGraph("agents-main", seed, randomEdges(seededRandom(seed), { maxMembers: 12, maxEdges: 40, maxAmount: 1000 }));
      const result = solveClearing(graph);
      if (result.proposal.edges.length > 0) expect(checkProposal(graph, result.proposal, 300).ok, `seed ${seed}`).toBe(true);
      const left = new Map(graph.members.map((m) => [m, 0n]));
      const cleared = new Map(result.proposal.edges.map((e) => [`${e.debtor}|${e.creditor}`, BigInt(e.cleared)]));
      for (const edge of graph.edges) {
        const rest = edge.amount - (cleared.get(`${edge.debtor}|${edge.creditor}`) ?? 0n);
        expect(rest >= 0n, `seed ${seed}`).toBe(true);
        left.set(edge.creditor, left.get(edge.creditor)! + rest);
        left.set(edge.debtor, left.get(edge.debtor)! - rest);
      }
      expect([...left.entries()], `seed ${seed}`).toEqual([...netPositions(graph).entries()]);
    }
  });

  it("TC-SV-006-04 the proposal does not depend on the order of the input edges", () => {
    const base = solveClearing(buildGraph("c", 66, WITNESS)).proposal;
    const shuffled = solveClearing(buildGraph("c", 66, [...WITNESS].reverse())).proposal;
    expect(shuffled).toEqual(base);
  });
});

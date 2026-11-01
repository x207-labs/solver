import { describe, expect, it } from "vitest";
import { buildGraph, type ObligationGraph } from "../src/graph/index.js";
import { checkProposal, netPositions, solveClearing, type Proposal } from "../src/mincostflow/index.js";
import {
  bruteForceBest,
  greedyPerCycle,
  hasCycle,
  randomEdges,
  residualEdges,
  seededRandom,
  type RandomGraphOptions,
} from "./graph-utils.js";
import { CREDIT, FX_E42_EDGES } from "./fixtures.js";

const LARGE: RandomGraphOptions = { maxMembers: 64, maxEdges: 300, maxAmount: 1e12 };
const SMALL: RandomGraphOptions = { maxMembers: 6, maxEdges: 10, maxAmount: 5 };

function graphAt(seed: number, options: RandomGraphOptions): ObligationGraph {
  return buildGraph("agents-main", seed, randomEdges(seededRandom(seed), options));
}

/** Runs a check per seeded graph and names the seed on failure (TC-SV-005-11). */
function forEachGraph(
  count: number,
  options: RandomGraphOptions,
  check: (graph: ObligationGraph, seed: number) => void,
): void {
  for (let seed = 1; seed <= count; seed++) {
    const graph = graphAt(seed, options);
    try {
      check(graph, seed);
    } catch (error) {
      (error as Error).message = `seed ${seed}: ${(error as Error).message}`;
      throw error;
    }
  }
}

function expectBalanced(proposal: Proposal): void {
  const balance = new Map<string, bigint>();
  for (const edge of proposal.edges) {
    balance.set(edge.creditor, (balance.get(edge.creditor) ?? 0n) + BigInt(edge.cleared));
    balance.set(edge.debtor, (balance.get(edge.debtor) ?? 0n) - BigInt(edge.cleared));
  }
  for (const net of balance.values()) expect(net).toBe(0n);
}

describe("SV-005 properties over large random graphs", () => {
  it("TC-SV-005-01..04, 08 hold on 1000 graphs", () => {
    forEachGraph(1000, LARGE, (graph) => {
      const first = solveClearing(graph, { maxEdges: Number.MAX_SAFE_INTEGER });
      const { proposal } = first;

      // 01 net position of every member is unchanged
      const before = netPositions(graph);
      const residual = residualEdges(graph, proposal);
      const after = netPositions(buildGraph("agents-main", graph.epoch, residual));
      for (const [member, position] of before) expect(after.get(member) ?? 0n).toBe(position);

      // 02 0 < cleared <= obligation
      for (const edge of proposal.edges) {
        const obligation = graph.edges.find(
          (item) => item.debtor === edge.debtor && item.creditor === edge.creditor,
        );
        expect(BigInt(edge.cleared)).toBeGreaterThan(0n);
        expect(BigInt(edge.cleared)).toBeLessThanOrEqual(obligation!.amount);
      }

      // 03 balanced per member
      expectBalanced(proposal);

      // 04 acyclic residual graph
      expect(hasCycle(residual)).toBe(false);

      // 08 determinism
      const second = solveClearing(graph, { maxEdges: Number.MAX_SAFE_INTEGER });
      expect(JSON.stringify(second.proposal)).toBe(JSON.stringify(proposal));
    });
  }, 300_000);

  it("TC-SV-005-10 respects the edge limit and stays balanced", () => {
    forEachGraph(1000, LARGE, (graph) => {
      const { proposal } = solveClearing(graph, { maxEdges: 30 });
      expect(proposal.edges.length).toBeLessThanOrEqual(30);
      expectBalanced(proposal);
      if (proposal.edges.length > 0) {
        expect(checkProposal(graph, proposal, 30)).toEqual({ ok: true });
      }
    });
  }, 300_000);
});

describe("SV-005 optimality", () => {
  it("TC-SV-005-05 matches brute force on 500 small graphs", () => {
    forEachGraph(500, SMALL, (graph) => {
      expect(solveClearing(graph).clearedTotal).toBe(bruteForceBest(graph).total);
    });
  }, 300_000);

  it("TC-SV-005-06 is at least greedy per-cycle", () => {
    forEachGraph(500, SMALL, (graph) => {
      expect(solveClearing(graph).clearedTotal).toBeGreaterThanOrEqual(greedyPerCycle(graph));
    });
    const fxGreedy = buildGraph(
      "agents-main",
      42,
      ([["A", "B", 10n], ["B", "C", 10n], ["C", "A", 10n], ["B", "A", 5n]] as const).map(
        ([debtor, creditor, amount]) => ({ debtor, creditor, amount: amount * CREDIT }),
      ),
    );
    expect(solveClearing(fxGreedy).clearedTotal).toBe(30n * CREDIT);
    expect(greedyPerCycle(fxGreedy)).toBe(25n * CREDIT);
  }, 300_000);

  it("TC-SV-005-07 clears the A-B-C-A triangle", () => {
    const triangle = buildGraph("agents-main", 42, [
      { debtor: "A", creditor: "B", amount: 10n },
      { debtor: "B", creditor: "C", amount: 10n },
      { debtor: "C", creditor: "A", amount: 10n },
    ]);
    expect(solveClearing(triangle).clearedTotal).toBe(30n);

    const e42 = buildGraph(
      "agents-main",
      42,
      FX_E42_EDGES.map(({ debtor, creditor, amount }) => ({ debtor, creditor, amount: BigInt(amount) })),
    );
    const cleared = solveClearing(e42).proposal.edges.filter((edge) =>
      /^(translator|summarizer|image)\./.test(edge.debtor),
    );
    expect(cleared.map((edge) => edge.cleared)).toEqual(["30000000", "30000000", "30000000"]);
  });

  it("TC-SV-005-09 clears nothing on 200 random DAGs", () => {
    forEachGraph(200, { ...LARGE, acyclic: true }, (graph) => {
      const result = solveClearing(graph);
      expect(result.clearedTotal).toBe(0n);
      expect(result.proposal.edges).toEqual([]);
    });
  }, 300_000);
});

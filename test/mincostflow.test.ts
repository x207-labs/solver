import { describe, expect, it } from "vitest";
import { buildGraph, type ObligationGraph } from "../src/graph/index.js";
import {
  checkProposal,
  decomposeCycles,
  netPositions,
  solveClearing,
  type Proposal,
} from "../src/mincostflow/index.js";
import { CREDIT, FX_E42_EDGES, e42 } from "./fixtures.js";
import { hasCycle, residualEdges } from "./graph-utils.js";

type Spec = [debtor: string, creditor: string, credits: number];

const graphOf = (specs: Spec[], epoch = 42): ObligationGraph =>
  buildGraph(
    "agents-main",
    epoch,
    specs.map(([debtor, creditor, credits]) => ({
      debtor,
      creditor,
      amount: BigInt(credits) * CREDIT,
    })),
  );

const FX_E42 = buildGraph(
  "agents-main",
  42,
  FX_E42_EDGES.map(({ debtor, creditor, amount }) => ({ debtor, creditor, amount: BigInt(amount) })),
);
const FX_GREEDY = graphOf([["A", "B", 10], ["B", "C", 10], ["C", "A", 10], ["B", "A", 5]]);
const FX_TIE = graphOf([["A", "B", 10], ["B", "D", 10], ["A", "C", 10], ["C", "D", 10], ["D", "A", 10]]);
const FX_DAG = graphOf([["A", "B", 10], ["B", "C", 5], ["A", "C", 7]]);
const FX_TAIL = graphOf([["A", "B", 10], ["B", "C", 10], ["C", "A", 10], ["C", "D", 20]]);
const FX_RING6 = graphOf([["A", "B", 10], ["B", "C", 10], ["C", "D", 10], ["D", "E", 10], ["E", "F", 10], ["F", "A", 10]]);
const FX_2CYC = graphOf([["A", "B", 10], ["B", "A", 4]]);
const FX_BIG = graphOf(
  Array.from({ length: 40 }, (_, i) => {
    const k = i + 1;
    return [[`x${k}`, `y${k}`, k], [`y${k}`, `z${k}`, k], [`z${k}`, `x${k}`, k]] as Spec[];
  }).flat(),
);
const SMALL_GRAPHS = { FX_GREEDY, FX_TIE, FX_DAG, FX_TAIL, FX_RING6, FX_2CYC };

const clearedOf = (proposal: Proposal, debtor: string, creditor: string): string | undefined =>
  proposal.edges.find((edge) => edge.debtor === debtor && edge.creditor === creditor)?.cleared;

const c = (credits: number): bigint => BigInt(credits) * CREDIT;

describe("SV-003 MTCS clearing", () => {
  const e42Result = solveClearing(FX_E42);

  it("TC-SV-003-01 computes net positions and NID", () => {
    const b = netPositions(FX_E42);
    expect(b.get(e42.translator)).toBe(0n);
    expect(b.get(e42.summarizer)).toBe(0n);
    expect(b.get(e42.image)).toBe(0n);
    expect(b.get(e42.scraper)).toBe(-35000000n);
    expect(b.get(e42.cleaner)).toBe(-10000000n);
    expect(b.get(e42.gpu)).toBe(45000000n);
    expect([...b.values()].reduce((sum, value) => sum + value, 0n)).toBe(0n);
    expect(e42Result.nid).toBe(45000000n);
  });

  it("TC-SV-003-02 routes min-cost flow over E4 and E7 only", () => {
    const flows = e42Result.allocations.filter((edge) => edge.flow > 0n);
    expect(flows.map((edge) => [edge.debtor, edge.creditor, edge.flow])).toEqual([
      [e42.cleaner, e42.gpu, 10000000n],
      [e42.scraper, e42.gpu, 35000000n],
    ]);
  });

  it("TC-SV-003-03 cleared equals obligation minus flow", () => {
    const expected: [string, string, string][] = [
      [e42.translator, e42.summarizer, "30000000"],
      [e42.summarizer, e42.image, "30000000"],
      [e42.image, e42.translator, "30000000"],
      [e42.scraper, e42.gpu, "15000000"],
      [e42.gpu, e42.cleaner, "20000000"],
      [e42.cleaner, e42.scraper, "15000000"],
      [e42.cleaner, e42.gpu, "5000000"],
    ];
    for (const [debtor, creditor, cleared] of expected) {
      expect(clearedOf(e42Result.proposal, debtor, creditor)).toBe(cleared);
    }
    expect(e42Result.clearedTotal).toBe(145000000n);
  });

  it("TC-SV-003-04 clears the A-B-C-A cycle in full", () => {
    for (const [debtor, creditor] of [
      [e42.translator, e42.summarizer],
      [e42.summarizer, e42.image],
      [e42.image, e42.translator],
    ] as const) {
      const allocation = e42Result.allocations.find(
        (edge) => edge.debtor === debtor && edge.creditor === creditor,
      );
      expect(allocation?.cleared).toBe(30000000n);
      expect(allocation?.flow).toBe(0n);
    }
  });

  it("TC-SV-003-05 keeps 0 <= cleared <= obligation", () => {
    for (const graph of [FX_E42, ...Object.values(SMALL_GRAPHS)]) {
      for (const edge of solveClearing(graph).allocations) {
        expect(edge.cleared).toBeGreaterThanOrEqual(0n);
        expect(edge.cleared).toBeLessThanOrEqual(edge.amount);
      }
    }
  });

  it("TC-SV-003-06 balances cleared in and out per member", () => {
    const expected = new Map([
      [e42.scraper, 15000000n],
      [e42.cleaner, 20000000n],
      [e42.gpu, 20000000n],
      [e42.translator, 30000000n],
      [e42.summarizer, 30000000n],
      [e42.image, 30000000n],
    ]);
    for (const [member, volume] of expected) {
      const sum = (key: "debtor" | "creditor") =>
        e42Result.proposal.edges
          .filter((edge) => edge[key] === member)
          .reduce((total, edge) => total + BigInt(edge.cleared), 0n);
      expect(sum("debtor")).toBe(volume);
      expect(sum("creditor")).toBe(volume);
    }
  });

  it("TC-SV-003-07 leaves net positions unchanged", () => {
    const residual = buildGraph("agents-main", 42, residualEdges(FX_E42, e42Result.proposal));
    const before = netPositions(FX_E42);
    const after = netPositions(residual);
    for (const [member, position] of before) {
      expect(after.get(member) ?? 0n).toBe(position);
    }
  });

  it("TC-SV-003-08 leaves an acyclic residual graph", () => {
    const residual = residualEdges(FX_E42, e42Result.proposal);
    expect(residual.map((edge) => edge.amount).sort()).toEqual([10000000n, 35000000n].sort());
    expect(hasCycle(residual)).toBe(false);
  });

  it("TC-SV-003-09 reports nothing to clear on a DAG", () => {
    const result = solveClearing(FX_DAG);
    expect(result.clearedTotal).toBe(0n);
    expect(result.proposal.edges).toEqual([]);
    expect(result.status).toBe("nothing_to_clear");
  });

  it("TC-SV-003-10 clears cycles only, never a path", () => {
    const { proposal, clearedTotal } = solveClearing(FX_TAIL);
    expect(clearedOf(proposal, "A", "B")).toBe(c(10).toString());
    expect(clearedOf(proposal, "B", "C")).toBe(c(10).toString());
    expect(clearedOf(proposal, "C", "A")).toBe(c(10).toString());
    expect(clearedOf(proposal, "C", "D")).toBeUndefined();
    expect(clearedTotal).toBe(c(30));
    expect(decomposeCycles(proposal.edges).map((cycle) => cycle.amount)).toEqual([c(10)]);
  });

  it("TC-SV-003-11 beats greedy per-cycle", () => {
    const { proposal, clearedTotal } = solveClearing(FX_GREEDY);
    expect(clearedTotal).toBe(c(30));
    expect(clearedOf(proposal, "B", "A")).toBeUndefined();
  });

  it("TC-SV-003-12 has no cycle length limit", () => {
    const { proposal, clearedTotal } = solveClearing(FX_RING6);
    expect(proposal.edges).toHaveLength(6);
    expect(clearedTotal).toBe(c(60));
  });

  it("TC-SV-003-13 clears invoices partially", () => {
    expect(clearedOf(e42Result.proposal, e42.scraper, e42.gpu)).toBe("15000000");
    const { proposal, clearedTotal } = solveClearing(FX_2CYC);
    expect(clearedOf(proposal, "A", "B")).toBe(c(4).toString());
    expect(clearedOf(proposal, "B", "A")).toBe(c(4).toString());
    expect(clearedTotal).toBe(c(8));
  });

  it("TC-SV-003-14 emits the ABI proposal shape", () => {
    const { proposal } = e42Result;
    expect(Object.keys(proposal)).toEqual(["epoch", "edges"]);
    expect(proposal.epoch).toBe(42);
    const pairs = proposal.edges.map((edge) => `${edge.debtor}|${edge.creditor}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(pairs).toEqual([...pairs].sort());
    for (const edge of proposal.edges) {
      expect(Object.keys(edge)).toEqual(["debtor", "creditor", "cleared"]);
      expect(edge.cleared).toMatch(/^[1-9]\d*$/);
    }
    expect(solveClearing(FX_2CYC).proposal.edges.every((edge) => BigInt(edge.cleared) > 0n)).toBe(true);
  });

  describe("TC-SV-003-15 local check", () => {
    const valid = e42Result.proposal;
    const tamper = (index: number, cleared: string): Proposal => ({
      ...valid,
      edges: valid.edges.map((edge, i) => (i === index ? { ...edge, cleared } : edge)),
    });

    it("passes the real proposal", () => {
      expect(checkProposal(FX_E42, valid, 300)).toEqual({ ok: true });
    });

    it("names the edge when cleared exceeds the obligation", () => {
      const index = valid.edges.findIndex((edge) => edge.debtor === e42.gpu);
      const check = checkProposal(FX_E42, tamper(index, "20000001"), 300);
      expect(check).toEqual({
        ok: false,
        reason: expect.stringMatching(/^ERR_CLEARED_EXCEEDS_OBLIGATION: .*gpu.*cleaner/),
      });
    });

    it("names the member when the proposal is unbalanced", () => {
      const index = valid.edges.findIndex((edge) => edge.debtor === e42.scraper);
      const check = checkProposal(FX_E42, tamper(index, "14000000"), 300);
      expect(check).toEqual({
        ok: false,
        reason: expect.stringMatching(/^ERR_UNBALANCED_MEMBER: /),
      });
    });

    it.each<[string, Proposal, string]>([
      ["zero cleared", tamper(0, "0"), "ERR_ZERO_CLEARED"],
      ["unknown edge", { ...valid, edges: [{ debtor: "x", creditor: "y", cleared: "1" }] }, "ERR_EDGE_NOT_IN_SNAPSHOT"],
      ["duplicate edge", { ...valid, edges: [valid.edges[0]!, valid.edges[0]!] }, "ERR_DUPLICATE_EDGE"],
    ])("rejects %s", (_name, proposal, code) => {
      expect(checkProposal(FX_E42, proposal, 300)).toEqual({
        ok: false,
        reason: expect.stringContaining(code),
      });
    });

    it("rejects too many edges and empty proposals", () => {
      expect(checkProposal(FX_E42, valid, 3)).toEqual({
        ok: false,
        reason: expect.stringContaining("ERR_TOO_MANY_EDGES"),
      });
      expect(checkProposal(FX_E42, { ...valid, edges: [] }, 300)).toEqual({
        ok: false,
        reason: expect.stringContaining("ERR_EMPTY_PROPOSAL"),
      });
    });
  });

  it("TC-SV-003-16 prunes a big graph to the largest whole cycles", () => {
    const free = solveClearing(FX_BIG, { maxEdges: 300 });
    expect(free.proposal.edges).toHaveLength(120);
    expect(free.pruned).toBe(false);

    const capped = solveClearing(FX_BIG, { maxEdges: 30 });
    expect(capped.pruned).toBe(true);
    expect(capped.proposal.edges).toHaveLength(30);
    expect(capped.clearedTotal).toBe(c(1065));
    expect(checkProposal(FX_BIG, capped.proposal, 30)).toEqual({ ok: true });
    const kept = new Set(capped.proposal.edges.map((edge) => Number(edge.debtor.slice(1))));
    expect(Math.min(...kept)).toBe(31);
    expect(Math.max(...kept)).toBe(40);
  });

  it("TC-SV-003-17 prunes FX-E42 with a small limit", () => {
    const six = solveClearing(FX_E42, { maxEdges: 6 });
    expect(six.proposal.edges).toHaveLength(6);
    expect(six.clearedTotal).toBe(135000000n);
    expect(checkProposal(FX_E42, six.proposal, 6)).toEqual({ ok: true });

    const three = solveClearing(FX_E42, { maxEdges: 3 });
    expect(three.proposal.edges).toHaveLength(3);
    expect(three.clearedTotal).toBe(90000000n);
    expect(clearedOf(three.proposal, e42.translator, e42.summarizer)).toBe("30000000");
  });

  it("K-44 skips a cycle that does not fit and keeps filling", () => {
    // C2 needs 3 more edges, C3 needs 2: 3 + 2 = 5 fits, 3 + 3 = 6 does not.
    const five = solveClearing(FX_E42, { maxEdges: 5 });
    expect(five.proposal.edges).toHaveLength(5);
    expect(five.clearedTotal).toBe(100000000n);
    expect(checkProposal(FX_E42, five.proposal, 5)).toEqual({ ok: true });
  });

  it("TC-SV-003-18 does not prune under the limit", () => {
    for (const maxEdges of [7, 300]) {
      const result = solveClearing(FX_E42, { maxEdges });
      expect(result.pruned).toBe(false);
      expect(result.proposal.edges).toHaveLength(7);
      expect(result.clearedTotal).toBe(145000000n);
    }
  });

  it("decomposes FX-E42 into the three documented cycles", () => {
    const cycles = decomposeCycles(e42Result.proposal.edges);
    const summary = cycles
      .map((cycle) => [cycle.amount, cycle.edges.length, cycle.value])
      .sort((a, b) => Number(BigInt(b[2]!) - BigInt(a[2]!)));
    expect(summary).toEqual([
      [30000000n, 3, 90000000n],
      [15000000n, 3, 45000000n],
      [5000000n, 2, 10000000n],
    ]);
  });

  it("uses a limit below any cycle as nothing to clear", () => {
    const result = solveClearing(FX_RING6, { maxEdges: 5 });
    expect(result.proposal.edges).toEqual([]);
    expect(result.status).toBe("nothing_to_clear");
  });
});

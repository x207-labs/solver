import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGraph, type ObligationEdge } from "../src/graph/index.js";
import { seedFromEpoch, solveClearing } from "../src/mincostflow/index.js";
import { CREDIT, FX_E42, FX_E42_EDGES } from "./fixtures.js";
import { startReadApi, type MockReadApi } from "./mock-read-api.js";
import { runCli } from "./run-cli.js";

const specs = (list: [string, string, number][]): ObligationEdge[] =>
  list.map(([debtor, creditor, credits]) => ({ debtor, creditor, amount: BigInt(credits) * CREDIT }));

const TIE_EDGES = specs([["A", "B", 10], ["B", "D", 10], ["A", "C", 10], ["C", "D", 10], ["D", "A", 10]]);
const E42_EDGES: ObligationEdge[] = FX_E42_EDGES.map(({ debtor, creditor, amount }) => ({
  debtor,
  creditor,
  amount: BigInt(amount),
}));

const solve = (edges: ObligationEdge[], epoch = 42) =>
  JSON.stringify(solveClearing(buildGraph("agents-main", epoch, edges)).proposal);

function shuffled<T>(items: T[], seed: number): T[] {
  const copy = [...items];
  let state = seed;
  for (let i = copy.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

describe("SV-004 deterministic tie-break", () => {
  let api: MockReadApi | undefined;
  afterEach(async () => {
    await api?.close();
    api = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("TC-SV-004-01 two separate processes print identical bytes", async () => {
    api = await startReadApi(200, FX_E42);
    const env = { X207_READ_API_URL: api.url };
    const first = await runCli(["--epoch", "42"], env);
    const second = await runCli(["--epoch", "42"], env);
    expect(first.code).toBe(0);
    expect(first.stdout.length).toBeGreaterThan(0);
    expect(second.stdout).toBe(first.stdout);
  });

  it("TC-SV-004-02 picks the same FX-TIE solution 20 times", () => {
    const runs = new Set(Array.from({ length: 20 }, () => solve(TIE_EDGES)));
    expect(runs.size).toBe(1);
    const result = solveClearing(buildGraph("agents-main", 42, TIE_EDGES));
    expect(result.clearedTotal).toBe(30n * CREDIT);
  });

  it.each([
    ["FX-TIE", TIE_EDGES],
    ["FX-E42", E42_EDGES],
  ])("TC-SV-004-03 %s ignores input order", (_name, edges) => {
    const expected = solve(edges);
    for (let seed = 1; seed <= 10; seed++) {
      expect(solve(shuffled(edges, seed))).toBe(expected);
    }
  });

  it("TC-SV-004-04 derives the seed from sha256 of circle:epoch", () => {
    // First 8 bytes from `printf 'agents-main:42' | shasum -a 256`.
    expect(seedFromEpoch("agents-main", 42)).toBe(0x2d08a6e9b9ce88e3n);
    expect(seedFromEpoch("agents-main", 43)).toBe(0x3b91d6ce16977445n);
    for (const epoch of [42, 43]) {
      const result = solveClearing(buildGraph("agents-main", epoch, TIE_EDGES));
      expect(result.clearedTotal).toBe(30n * CREDIT);
    }
  });

  it("TC-SV-004-04 the seed really steers the route", () => {
    const routes = new Set<string>();
    for (let epoch = 0; epoch < 64; epoch++) {
      const { edges } = solveClearing(buildGraph("agents-main", epoch, TIE_EDGES)).proposal;
      routes.add(JSON.stringify(edges));
    }
    expect(routes.size).toBe(2);
  });

  it("TC-SV-004-05 prefers fewer edges at equal total", () => {
    for (let epoch = 0; epoch < 64; epoch++) {
      const result = solveClearing(buildGraph("agents-main", epoch, TIE_EDGES));
      expect(result.proposal.edges).toHaveLength(3);
    }
  });

  it("TC-SV-004-06 uses no clock or Math.random", () => {
    const expected = solve(TIE_EDGES);
    vi.useFakeTimers({ now: new Date("2031-01-01T00:00:00Z") });
    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random must not be used");
    });
    expect(solve(TIE_EDGES)).toBe(expected);
  });

  it("TC-SV-004-07 reproduces the recorded proposal", async () => {
    // Hand-built recording. The real demo recording replaces it once BE-015 runs.
    api = await startReadApi(200, FX_E42);
    const result = await runCli(["--epoch", "42"], { X207_READ_API_URL: api.url });
    const expected = {
      epoch: 42,
      edges: [
        ["cleaner", "gpu", "5000000"],
        ["cleaner", "scraper", "15000000"],
        ["gpu", "cleaner", "20000000"],
        ["image", "translator", "30000000"],
        ["scraper", "gpu", "15000000"],
        ["summarizer", "image", "30000000"],
        ["translator", "summarizer", "30000000"],
      ].map(([debtor, creditor, cleared]) => ({
        debtor: `${debtor}.x207-circle.near`,
        creditor: `${creditor}.x207-circle.near`,
        cleared,
      })),
    };
    expect(result.stdout).toBe(`${JSON.stringify(expected)}\n`);
  });
});

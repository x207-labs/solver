import { describe, expect, it } from "vitest";
import { base58Decode, base58Encode } from "../src/submit/base58.js";
import {
  NearRpcChain,
  parseSecretKey,
  signTransaction,
  submitProposal,
  type ClearingChain,
  type Simulation,
  type StoredProposal,
  type SubmitOutcome,
} from "../src/submit/index.js";
import type { Proposal } from "../src/mincostflow/index.js";
import { readSubmitConfig, UsageError } from "../src/config.js";
import { REFERENCE_TX } from "./fixtures-tx.js";

const EDGES = [
  { debtor: "a.test.near", creditor: "b.test.near", cleared: "50000000" },
  { debtor: "b.test.near", creditor: "a.test.near", cleared: "50000000" },
];
const PROPOSAL: Proposal = { epoch: 42, edges: EDGES };

const ok = (over: Partial<Simulation> = {}): Simulation => ({
  valid: true,
  cleared_total: "145000000",
  edge_count: 7,
  better_than_current: true,
  reason: null,
  ...over,
});

class FakeChain implements ClearingChain {
  calls: string[] = [];
  constructor(
    private readonly config: {
      phase?: string | null;
      stored?: StoredProposal | null;
      simulation?: Simulation | Error;
      outcome?: SubmitOutcome | Error;
    } = {},
  ) {}
  async getEpoch(epoch: number) {
    this.calls.push(`get_epoch(${epoch})`);
    const phase = this.config.phase === undefined ? "clearing" : this.config.phase;
    return phase === null ? null : { epoch, phase };
  }
  async getProposal(epoch: number) {
    this.calls.push(`get_clearing_proposal(${epoch})`);
    return this.config.stored ?? null;
  }
  async simulate(epoch: number, edges: unknown[]) {
    this.calls.push(`simulate_clearing(${epoch},${edges.length})`);
    const result = this.config.simulation ?? ok();
    if (result instanceof Error) throw result;
    return result;
  }
  async submit(epoch: number, edges: unknown[]) {
    this.calls.push(`submit_clearing(${epoch},${edges.length})`);
    const result = this.config.outcome ?? { ok: true as const, txHash: "TXHASH" };
    if (result instanceof Error) throw result;
    return result;
  }
}

async function run(chain: FakeChain, proposal: Proposal = PROPOSAL) {
  const lines: string[] = [];
  const result = await submitProposal(chain, proposal, (line) => lines.push(line));
  return { result, lines, text: lines.join("\n") };
}

describe("SV-006 submit", () => {
  // TC-SV-006-01
  it("simulates before it submits and logs the simulation before the tx hash", async () => {
    const chain = new FakeChain();
    const { result, lines } = await run(chain);
    expect(chain.calls.filter((c) => c.startsWith("simulate") || c.startsWith("submit"))).toEqual([
      "simulate_clearing(42,2)",
      "submit_clearing(42,2)",
    ]);
    expect(result).toMatchObject({ status: "submitted", exitCode: 0, txHash: "TXHASH" });
    const simulated = lines.findIndex((l) => l.includes("simulate_clearing valid=true cleared_total=145000000"));
    const sent = lines.findIndex((l) => l.includes("TXHASH"));
    expect(simulated).toBeGreaterThanOrEqual(0);
    expect(sent).toBeGreaterThan(simulated);
  });

  // TC-SV-006-02
  it("does not submit a proposal the simulation rejects, and exits 1", async () => {
    const chain = new FakeChain({ simulation: ok({ valid: false, reason: "ERR_UNBALANCED_MEMBER: scraper" }) });
    const { result, text } = await run(chain);
    expect(chain.calls.some((c) => c.startsWith("submit"))).toBe(false);
    expect(result).toMatchObject({ status: "invalid", exitCode: 1 });
    expect(text).toContain("ERR_UNBALANCED_MEMBER: scraper");
  });

  // TC-SV-006-03
  it("logs the proposal it replaces", async () => {
    const stored = { solver: "solver-a.near", cleared_total: "120000000", edge_count: 6, committed: false };
    const { result, text } = await run(new FakeChain({ stored }));
    expect(result.status).toBe("submitted");
    expect(text).toContain("solver-a.near 120000000");
  });

  // TC-SV-006-04, TC-SV-006-06
  it.each([
    ["a bigger stored proposal", { solver: "solver-b.near", cleared_total: "145000000", edge_count: 7, committed: false }],
    ["an equal stored proposal", { solver: "solver-b.near", cleared_total: "30000000", edge_count: 3, committed: false }],
  ])("does not submit against %s", async (_label, stored) => {
    const chain = new FakeChain({ stored, simulation: ok({ better_than_current: false }) });
    const { result, text } = await run(chain);
    expect(chain.calls.some((c) => c.startsWith("submit"))).toBe(false);
    expect(result).toMatchObject({ status: "not_better", exitCode: 0 });
    expect(text).toContain(`${stored.solver} ${stored.cleared_total}`);
  });

  // TC-SV-006-05: same total, fewer edges: the contract says better, the solver submits
  it("submits when the contract says the proposal is better on edge count", async () => {
    const stored = { solver: "solver-a.near", cleared_total: "30000000", edge_count: 5, committed: false };
    const chain = new FakeChain({ stored, simulation: ok({ cleared_total: "30000000", edge_count: 3 }) });
    expect((await run(chain)).result.status).toBe("submitted");
  });

  // TC-SV-006-07, TC-SV-006-09
  it.each(["ERR_PROPOSAL_NOT_BETTER", "ERR_PROPOSAL_WINDOW_CLOSED"])("logs %s and does not retry", async (code) => {
    const chain = new FakeChain({ outcome: { ok: false, txHash: "TX2", error: `${code}: detail` } });
    const { result, text } = await run(chain);
    expect(chain.calls.filter((c) => c.startsWith("submit"))).toHaveLength(1);
    expect(result.exitCode).toBe(0);
    expect(text).toContain(code);
  });

  // TC-SV-006-08
  it("does nothing when the proposal window has closed", async () => {
    const chain = new FakeChain({ phase: "commit" });
    const { result, text } = await run(chain);
    expect(chain.calls).toEqual(["get_epoch(42)"]);
    expect(result).toMatchObject({ status: "window_closed", exitCode: 0 });
    expect(text).toContain("jendela proposal tertutup");
  });

  // TC-SV-006-10
  it.each(["open", "cutoff", "payment_window", "finalized"])("stops in phase %s without simulating", async (phase) => {
    const chain = new FakeChain({ phase });
    const { result, text } = await run(chain);
    expect(chain.calls).toEqual(["get_epoch(42)"]);
    expect(result).toMatchObject({ status: "wrong_phase", exitCode: 1 });
    expect(text).toContain(phase);
  });

  it("stops when the epoch is unknown", async () => {
    const chain = new FakeChain({ phase: null });
    expect((await run(chain)).result.exitCode).toBe(1);
    expect(chain.calls).toEqual(["get_epoch(42)"]);
  });

  // TC-SV-006-11
  it("never sends an empty proposal", async () => {
    const chain = new FakeChain();
    const { result } = await run(chain, { epoch: 42, edges: [] });
    expect(chain.calls).toEqual([]);
    expect(result.status).toBe("no_proposal");
  });

  // TC-SV-006-12
  it("does not submit when the simulation reports too many edges", async () => {
    const chain = new FakeChain({ simulation: ok({ valid: false, reason: "ERR_TOO_MANY_EDGES: 301" }) });
    const { result } = await run(chain);
    expect(chain.calls.some((c) => c.startsWith("submit"))).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  // TC-SV-006-13
  it("does not submit when the simulation cannot be reached", async () => {
    const chain = new FakeChain({ simulation: new Error("timeout") });
    const { result, text } = await run(chain);
    expect(chain.calls.some((c) => c.startsWith("submit"))).toBe(false);
    expect(result).toMatchObject({ status: "chain_error", exitCode: 1 });
    expect(text).toContain("timeout");
  });

  it("exits 1 on a failure that is not a lost race", async () => {
    const chain = new FakeChain({ outcome: { ok: false, error: "ERR_UNKNOWN_EPOCH: 42" } });
    expect((await run(chain)).result).toMatchObject({ status: "chain_error", exitCode: 1 });
  });
});

describe("SV-006 transaction", () => {
  const key = parseSecretKey(REFERENCE_TX.secretKey);
  const tx = {
    signerId: REFERENCE_TX.signer,
    receiverId: REFERENCE_TX.receiver,
    nonce: REFERENCE_TX.nonce,
    blockHash: REFERENCE_TX.blockHash,
    methodName: "submit_clearing",
    args: REFERENCE_TX.args,
    gas: REFERENCE_TX.gas,
    deposit: 0n,
  };

  // TC-SV-006-14: bytes equal what near-api-js 7.4.0 produces for the same transaction
  it("builds the same transaction bytes and signature as near-api-js", () => {
    expect(key.publicKey).toBe(REFERENCE_TX.publicKey);
    const signed = signTransaction(tx, key);
    expect(signed.bytes.toString("hex")).toBe(REFERENCE_TX.signedHex);
    expect(signed.bytes.toString("hex").startsWith(REFERENCE_TX.txHex)).toBe(true);
  });

  it("carries epoch and string amounts, no deposit", () => {
    const body = Buffer.from(signTransaction(tx, key).bytes).toString("utf8");
    expect(body).toContain('"epoch":42');
    expect(body).toContain('"cleared":"1000000"');
  });

  it("rejects malformed keys without echoing them", () => {
    for (const bad of ["", "secp256k1:abc", "ed25519:0OIl", "ed25519:1111"]) {
      expect(() => parseSecretKey(bad)).toThrow(/SOLVER_PRIVATE_KEY/);
      try {
        parseSecretKey(bad);
      } catch (error) {
        if (bad.length > 4) expect((error as Error).message).not.toContain(bad);
      }
    }
  });

  it("base58 round trips including leading zeros", () => {
    for (const hex of ["00", "0000ff", "ff00", "0102030405060708090a"]) {
      const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
      expect(Buffer.from(base58Decode(base58Encode(bytes))).toString("hex")).toBe(hex);
    }
  });
});

describe("SV-006 RPC", () => {
  function fakeRpc(handlers: Record<string, (params: any) => unknown>) {
    const seen: { url: string; method: string; params: any }[] = [];
    const fetchFn = (async (url: string, init: { body: string }) => {
      const { method, params } = JSON.parse(init.body);
      seen.push({ url, method, params });
      const reply = handlers[method === "query" ? `query:${params.request_type}` : method]?.(params);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result: reply }), { status: 200 });
    }) as unknown as typeof fetch;
    return { fetchFn, seen };
  }
  const options = (fetchFn: typeof fetch) => ({
    rpcUrl: "http://rpc.test",
    contractId: REFERENCE_TX.receiver,
    signerId: REFERENCE_TX.signer,
    key: parseSecretKey(REFERENCE_TX.secretKey),
    gasTgas: 300,
    fetch: fetchFn,
  });
  const bytesOf = (value: unknown) => [...Buffer.from(JSON.stringify(value))];

  // TC-SV-006-15: views and the transaction go to the NEAR RPC, nowhere else
  it("sends views and the transaction to the NEAR RPC", async () => {
    const { fetchFn, seen } = fakeRpc({
      "query:call_function": (p) =>
        ({ result: bytesOf(p.method_name === "simulate_clearing" ? ok() : p.method_name === "get_epoch" ? { epoch: 42, phase: "clearing" } : null) }),
      "query:view_access_key": () => ({ nonce: 4, block_hash: base58Encode(REFERENCE_TX.blockHash) }),
      send_tx: () => ({ status: { SuccessValue: "" } }),
    });
    const chain = new NearRpcChain(options(fetchFn));
    const { result } = await run(chain as unknown as FakeChain, PROPOSAL);
    expect(result.status).toBe("submitted");
    expect(new Set(seen.map((s) => s.url))).toEqual(new Set(["http://rpc.test"]));
    const send = seen.find((s) => s.method === "send_tx")!;
    expect(send.params.wait_until).toBe("FINAL");
    const views = seen.filter((s) => s.params.request_type === "call_function").map((s) => s.params.method_name);
    expect(views).toEqual(["get_epoch", "get_clearing_proposal", "simulate_clearing"]);
    expect(seen.find((s) => s.params.method_name === "simulate_clearing")!.params.account_id).toBe(REFERENCE_TX.receiver);
  });

  it("turns a contract panic into a failed outcome with the ERR code", async () => {
    const { fetchFn } = fakeRpc({
      "query:view_access_key": () => ({ nonce: 4, block_hash: base58Encode(REFERENCE_TX.blockHash) }),
      send_tx: () => ({
        status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: ERR_PROPOSAL_NOT_BETTER: stored 145000000" } } } } },
      }),
    });
    const outcome = await new NearRpcChain(options(fetchFn)).submit(42, EDGES);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toBe("ERR_PROPOSAL_NOT_BETTER: stored 145000000");
  });

  it("reports an RPC error instead of a partial answer", async () => {
    const fetchFn = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    await expect(new NearRpcChain(options(fetchFn)).simulate(42, EDGES)).rejects.toThrow(/503/);
  });
});

describe("SV-006 configuration", () => {
  it("is off when no submit variable is set", () => {
    expect(readSubmitConfig({})).toBeNull();
  });

  it("refuses a partial set and names what is missing", () => {
    expect(() => readSubmitConfig({ NEAR_RPC_URL: "http://rpc" })).toThrow(UsageError);
    expect(() => readSubmitConfig({ NEAR_RPC_URL: "http://rpc" })).toThrow(/X207_CONTRACT_ID, SOLVER_ACCOUNT_ID, SOLVER_PRIVATE_KEY/);
  });

  it("reads a full set with the default gas", () => {
    const config = readSubmitConfig({
      NEAR_RPC_URL: "http://rpc",
      X207_CONTRACT_ID: "circle.near",
      SOLVER_ACCOUNT_ID: "solver.near",
      SOLVER_PRIVATE_KEY: "ed25519:x",
    });
    // SV-020: 60 Tgas by default, the barter command uses its own default unless the variable is set
    expect(config).toMatchObject({ rpcUrl: "http://rpc", contractId: "circle.near", gasTgas: 60, gasExplicit: false });
    expect(readSubmitConfig({ NEAR_RPC_URL: "u", X207_CONTRACT_ID: "c", SOLVER_ACCOUNT_ID: "s", SOLVER_PRIVATE_KEY: "k", SUBMIT_GAS_TGAS: "100" })).toMatchObject({ gasTgas: 100, gasExplicit: true });
  });

  it.each(["0", "301", "abc", "1.5"])("rejects SUBMIT_GAS_TGAS %s", (gas) => {
    expect(() =>
      readSubmitConfig({ NEAR_RPC_URL: "u", X207_CONTRACT_ID: "c", SOLVER_ACCOUNT_ID: "s", SOLVER_PRIVATE_KEY: "k", SUBMIT_GAS_TGAS: gas }),
    ).toThrow(UsageError);
  });
});

import { describe, expect, it } from "vitest";
import { NearRpcChain, parseSecretKey, reserveOf, RpcError } from "../src/submit/index.js";
import { base58Encode } from "../src/submit/base58.js";
import { REFERENCE_TX } from "./fixtures-tx.js";

// SV-020: a transaction reserves prepaid gas times the gas price from the balance of the signer. CT-100 on testnet: 250 Tgas reserved 0.25 NEAR for a call of 28 Tgas.
const NEAR = 10n ** 24n;
const key = parseSecretKey(REFERENCE_TX.secretKey);

function chainWith(balance: bigint, gasTgas: number, seen: string[]) {
  const fetchFn = (async (_url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body);
    seen.push(method);
    let result: unknown = null;
    if (params?.request_type === "view_account") result = { amount: balance.toString() };
    if (method === "gas_price") result = { gas_price: "100000000" };
    if (params?.request_type === "view_access_key") result = { nonce: 41, block_hash: base58Encode(REFERENCE_TX.blockHash) };
    if (method === "send_tx") result = { status: { SuccessValue: "" } };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result }), { status: 200 });
  }) as unknown as typeof fetch;
  return new NearRpcChain({ rpcUrl: "http://rpc.test", contractId: REFERENCE_TX.receiver, signerId: REFERENCE_TX.signer, key, gasTgas, fetch: fetchFn });
}

describe("SV-020 prepaid gas and the balance of the signer", () => {
  it("the reserve repeats the measurement of CT-100: 250 Tgas at the price 1e8 reserve about 0.25 NEAR, and it grows faster than the gas", () => {
    const near = (v: bigint) => Number(v / 10n ** 18n) / 1_000_000;
    expect(near(reserveOf(250, 100_000_000n))).toBeGreaterThan(0.2509); // never below the measured reserve
    expect(near(reserveOf(250, 100_000_000n))).toBeLessThan(0.28);
    expect(near(reserveOf(60, 100_000_000n))).toBeLessThan(0.012);
    expect(near(reserveOf(150, 100_000_000n))).toBeLessThan(0.07);
    expect(reserveOf(300, 100_000_000n)).toBeGreaterThan(8n * reserveOf(150, 100_000_000n));
  });

  it("a signer with 0.24 NEAR cannot send 250 Tgas (the node reserves 0.2509 NEAR at a gas price of 1e8): the call says so and nothing is sent", async () => {
    const seen: string[] = [];
    const chain = chainWith((24n * NEAR) / 100n, 250, seen);
    await expect(chain.submit(42, REFERENCE_TX.args.edges)).rejects.toThrow(RpcError);
    await expect(chain.submit(42, REFERENCE_TX.args.edges)).rejects.toThrow(/kurang dari 0\.25\d* NEAR yang dicadangkan untuk 250 Tgas/);
    expect(seen).not.toContain("send_tx");
  });

  it("the same signer sends 60 Tgas (it reserves about 0.01 NEAR)", async () => {
    const seen: string[] = [];
    const outcome = await chainWith((24n * NEAR) / 100n, 60, seen).submit(42, REFERENCE_TX.args.edges);
    expect(outcome.ok).toBe(true);
    expect(seen).toContain("send_tx");
  });

  it("an answer that the check does not understand does not stop the call", async () => {
    const fetchFn = (async (_url: string, init: { body: string }) => {
      const { method, params } = JSON.parse(init.body);
      let result: unknown = null;
      if (params?.request_type === "view_access_key") result = { nonce: 41, block_hash: base58Encode(REFERENCE_TX.blockHash) };
      if (method === "send_tx") result = { status: { SuccessValue: "" } };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result }), { status: 200 });
    }) as unknown as typeof fetch;
    const chain = new NearRpcChain({ rpcUrl: "http://rpc.test", contractId: REFERENCE_TX.receiver, signerId: REFERENCE_TX.signer, key, gasTgas: 250, fetch: fetchFn });
    expect((await chain.submit(42, REFERENCE_TX.args.edges)).ok).toBe(true);
  });
});

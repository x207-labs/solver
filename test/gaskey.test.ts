import { describe, expect, it } from "vitest";
import { readSubmitConfig, UsageError } from "../src/config.js";
import { NearRpcChain, parseSecretKey, signTransaction } from "../src/submit/index.js";
import { base58Encode } from "../src/submit/base58.js";
import { REFERENCE_GAS_KEY_TX, REFERENCE_TX } from "./fixtures-tx.js";

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

describe("SV-009 gas key (NEP-611)", () => {
  const key = parseSecretKey(REFERENCE_TX.secretKey);

  it("encodes Transaction::V1 byte for byte like near-api-js 7.4.0 and signs it", () => {
    const signed = signTransaction({ ...tx, nonceIndex: REFERENCE_GAS_KEY_TX.nonceIndex }, key);
    const hex = signed.bytes.toString("hex");
    expect(hex.startsWith(REFERENCE_GAS_KEY_TX.txHex)).toBe(true);
    expect(hex).toBe(REFERENCE_GAS_KEY_TX.txHex + "00" + REFERENCE_GAS_KEY_TX.signatureHex);
  });

  it("without nonceIndex the plain transaction is unchanged", () => {
    expect(signTransaction(tx, key).bytes.toString("hex")).toBe(REFERENCE_TX.signedHex);
  });

  it("refuses a lane outside 0..1023", () => {
    expect(() => signTransaction({ ...tx, nonceIndex: 1024 }, key)).toThrow(/0..1023/);
    expect(() => signTransaction({ ...tx, nonceIndex: -1 }, key)).toThrow(/0..1023/);
  });

  const env = { NEAR_RPC_URL: "http://rpc", X207_CONTRACT_ID: "c.near", SOLVER_ACCOUNT_ID: "s.near", SOLVER_PRIVATE_KEY: REFERENCE_TX.secretKey };

  it("SOLVER_GAS_KEY_NONCE_INDEX is optional and validated", () => {
    expect(readSubmitConfig(env)?.gasKeyNonceIndex).toBeUndefined();
    expect(readSubmitConfig({ ...env, SOLVER_GAS_KEY_NONCE_INDEX: "" })?.gasKeyNonceIndex).toBeUndefined();
    expect(readSubmitConfig({ ...env, SOLVER_GAS_KEY_NONCE_INDEX: "0" })?.gasKeyNonceIndex).toBe(0);
    expect(readSubmitConfig({ ...env, SOLVER_GAS_KEY_NONCE_INDEX: "1023" })?.gasKeyNonceIndex).toBe(1023);
    for (const bad of ["1024", "-1", "x", "1.5"]) {
      expect(() => readSubmitConfig({ ...env, SOLVER_GAS_KEY_NONCE_INDEX: bad })).toThrow(UsageError);
    }
  });

  it("submit reads the nonce of the chosen lane and sends a V1 transaction", async () => {
    const seen: { method: string; params: any }[] = [];
    const fetchFn = (async (_url: string, init: { body: string }) => {
      const { method, params } = JSON.parse(init.body);
      seen.push({ method, params });
      let result: unknown = null;
      if (params?.request_type === "view_gas_key_nonces") result = { nonces: [0, 0, 41, 0], block_hash: base58Encode(REFERENCE_TX.blockHash) };
      if (method === "send_tx") result = { status: { SuccessValue: "" } };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result }), { status: 200 });
    }) as unknown as typeof fetch;
    const chain = new NearRpcChain({ rpcUrl: "http://rpc.test", contractId: tx.receiverId, signerId: tx.signerId, key, gasTgas: 300, gasKeyNonceIndex: 2, fetch: fetchFn });
    const outcome = await chain.submit(42, REFERENCE_TX.args.edges);
    expect(outcome.ok).toBe(true);
    expect(seen.some((s) => s.params?.request_type === "view_access_key")).toBe(false);
    const sent = Buffer.from(seen.find((s) => s.method === "send_tx")!.params.signed_tx_base64, "base64");
    // 0x01 prefix, nonce enum 1, nonce 42 (= 41 + 1), nonce_index 2
    const head = sent.toString("hex");
    expect(head.startsWith("01")).toBe(true);
    expect(head).toContain("01" + "2a00000000000000" + "0200");
  });

  it("a lane the key does not have is an RPC error and nothing is sent", async () => {
    const seen: string[] = [];
    const fetchFn = (async (_url: string, init: { body: string }) => {
      const { method, params } = JSON.parse(init.body);
      seen.push(method);
      const result = params?.request_type === "view_gas_key_nonces" ? { nonces: [0], block_hash: base58Encode(REFERENCE_TX.blockHash) } : null;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result }), { status: 200 });
    }) as unknown as typeof fetch;
    const chain = new NearRpcChain({ rpcUrl: "http://rpc.test", contractId: tx.receiverId, signerId: tx.signerId, key, gasTgas: 300, gasKeyNonceIndex: 5, fetch: fetchFn });
    await expect(chain.submit(42, REFERENCE_TX.args.edges)).rejects.toThrow(/nonce lane 5/);
    expect(seen).not.toContain("send_tx");
  });
});

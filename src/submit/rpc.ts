import { base58Decode } from "./base58.js";
import type { ClearingChain, EpochInfo, Simulation, StoredProposal, SubmitOutcome } from "./index.js";
import { signTransaction, type SolverKey } from "./tx.js";
import type { ClearingEdge } from "../mincostflow/index.js";

const DEFAULT_TIMEOUT_MS = 20_000;

export interface NearRpcOptions {
  rpcUrl: string;
  contractId: string;
  signerId: string;
  key: SolverKey;
  /** Gas attached to `submit_clearing`, in Tgas. */
  gasTgas: number;
  /** Nonce lane of a gas key (NEP-611); `undefined` signs with a plain access key. */
  gasKeyNonceIndex?: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Any failure to talk to the NEAR RPC. The solver stops without submitting (K-45). */
export class RpcError extends Error {}

/**
 * `ClearingChain` over plain JSON-RPC: view calls and one signed FunctionCall transaction. Views and
 * the nonce read the latest block (`optimistic`), not the last final one: a proposal that landed a few
 * seconds ago must be visible, or the solver simulates against stale state in the very race it is for.
 */
export class NearRpcChain implements ClearingChain {
  constructor(private readonly options: NearRpcOptions) {}

  private async rpc(method: string, params: unknown): Promise<any> {
    const { rpcUrl, fetch: fetchFn = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = this.options;
    let response: Response;
    try {
      response = await fetchFn(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "x207-solver", method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new RpcError(`RPC ${method} tidak terjangkau: ${(error as Error).message}`);
    }
    if (!response.ok) throw new RpcError(`RPC ${method} menjawab HTTP ${response.status}`);
    const body = (await response.json()) as { result?: unknown; error?: unknown };
    if (body.error !== undefined) throw new RpcError(`RPC ${method} gagal: ${JSON.stringify(body.error)}`);
    return body.result;
  }

  private async view<T>(method: string, args: unknown): Promise<T> {
    const result = await this.rpc("query", {
      request_type: "call_function",
      finality: "optimistic",
      account_id: this.options.contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    if (typeof result?.error === "string") throw new RpcError(`view ${method} gagal: ${result.error}`);
    return JSON.parse(Buffer.from(result.result).toString("utf8")) as T;
  }

  async getEpoch(epoch: number): Promise<EpochInfo | null> {
    return this.view<EpochInfo | null>("get_epoch", { epoch });
  }

  async getProposal(epoch: number): Promise<StoredProposal | null> {
    return this.view<StoredProposal | null>("get_clearing_proposal", { epoch });
  }

  async simulate(epoch: number, edges: ClearingEdge[]): Promise<Simulation> {
    return this.view<Simulation>("simulate_clearing", { epoch, edges });
  }

  async submit(epoch: number, edges: ClearingEdge[]): Promise<SubmitOutcome> {
    const { contractId, signerId, key, gasTgas, gasKeyNonceIndex } = this.options;
    let nonce: bigint;
    let blockHash: string;
    if (gasKeyNonceIndex === undefined) {
      const access = await this.rpc("query", {
        request_type: "view_access_key",
        finality: "optimistic",
        account_id: signerId,
        public_key: key.publicKey,
      });
      if (typeof access?.nonce !== "number" && typeof access?.nonce !== "string") {
        throw new RpcError(`kunci ${key.publicKey} tidak terdaftar di ${signerId}`);
      }
      nonce = BigInt(access.nonce) + 1n;
      blockHash = access.block_hash;
    } else {
      // NEP-611: every lane of the gas key has its own nonce.
      const lanes = await this.rpc("query", {
        request_type: "view_gas_key_nonces",
        finality: "optimistic",
        account_id: signerId,
        public_key: key.publicKey,
      });
      const lane = lanes?.nonces?.[gasKeyNonceIndex];
      if (typeof lane !== "number" && typeof lane !== "string") {
        throw new RpcError(`gas key ${key.publicKey} di ${signerId} tidak punya jalur nonce ${gasKeyNonceIndex}`);
      }
      nonce = BigInt(lane) + 1n;
      blockHash = lanes.block_hash;
    }
    const signed = signTransaction(
      {
        signerId,
        receiverId: contractId,
        nonce,
        ...(gasKeyNonceIndex === undefined ? {} : { nonceIndex: gasKeyNonceIndex }),
        blockHash: base58Decode(blockHash),
        methodName: "submit_clearing",
        args: { epoch, edges },
        gas: BigInt(gasTgas) * 1_000_000_000_000n,
        deposit: 0n,
      },
      key,
    );
    const result = await this.rpc("send_tx", { signed_tx_base64: signed.bytes.toString("base64"), wait_until: "FINAL" });
    const failure = result?.status?.Failure;
    if (failure !== undefined) return { ok: false, txHash: signed.hash, error: failureText(failure) };
    return { ok: true, txHash: signed.hash };
  }
}

/** `ERR_...: detail` of a contract panic, or the raw failure JSON. */
export function failureText(failure: unknown): string {
  const text = JSON.stringify(failure);
  const panic = /Smart contract panicked: ([^"\\]*)/.exec(text);
  return panic?.[1] ?? text;
}

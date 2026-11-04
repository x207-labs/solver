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
    return this.call("submit_clearing", { epoch, edges });
  }

  /**
   * SV-020: a transaction reserves its prepaid gas from the balance of the signer and refunds what is not burnt, so a signer with less than the reserve is refused by the node
   * (`NotEnoughBalanceError`) even if the call itself costs a hundredth of it. The node reserves at ten times the gas price (the price of burnt gas on testnet is 1e8
   * yoctoNEAR, the reserve is 1e9), plus the fixed fees of the transaction (about 0.9 Tgas). Measured on testnet with a signer of 0.236 NEAR (CT-100 and the probe of 2026-11-04): the
   * node refused 250, 245, 240 Tgas with costs of 0.2509, 0.2459, 0.2409 NEAR and 100 Tgas with 0.1009 NEAR, and accepted 235 Tgas (0.2359) and, with 0.0647 NEAR, 60 Tgas (0.0609).
   * `reserveOf` repeats that. A gas key pays from its own balance and is not checked here.
   */
  private async ensureBalance(gasTgas: number): Promise<void> {
    const { signerId } = this.options;
    const account = await this.rpc("query", { request_type: "view_account", finality: "optimistic", account_id: signerId });
    const price = await this.rpc("gas_price", [null]);
    if (typeof account?.amount !== "string" || typeof price?.gas_price !== "string") return; // an answer that this check does not understand does not stop the call
    const reserved = reserveOf(gasTgas, BigInt(price.gas_price));
    const balance = BigInt(account.amount);
    if (balance < reserved) {
      const near = (v: bigint) => (Number(v / 10n ** 20n) / 10_000).toString();
      throw new RpcError(
        `saldo ${near(balance)} NEAR di ${signerId} kurang dari ${near(reserved)} NEAR yang dicadangkan untuk ${gasTgas} Tgas gas: isi saldo atau turunkan SUBMIT_GAS_TGAS (submit_clearing memakai sekitar 28 Tgas untuk 210 edge)`,
      );
    }
  }

  /** One signed FunctionCall to the circle contract (`submit_clearing`, `commit_bundle`). */
  async call(methodName: string, args: unknown): Promise<SubmitOutcome> {
    const { contractId, signerId, key, gasTgas, gasKeyNonceIndex } = this.options;
    if (gasKeyNonceIndex === undefined) await this.ensureBalance(gasTgas);
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
        methodName,
        args,
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

/** The node reserves ten times the gas price (measured, see `ensureBalance`) and adds about 0.9 Tgas of fixed fees. */
const RESERVE_PRICE_FACTOR = 10n;
const FIXED_FEES_GAS = 900_000_000_000n;

/** yoctoNEAR that a transaction with `gasTgas` of prepaid gas reserves when the burn price is `gasPrice` (yoctoNEAR per gas). */
export function reserveOf(gasTgas: number, gasPrice: bigint): bigint {
  return (BigInt(gasTgas) * 1_000_000_000_000n + FIXED_FEES_GAS) * gasPrice * RESERVE_PRICE_FACTOR;
}

/** `ERR_...: detail` of a contract panic, or the raw failure JSON. */
export function failureText(failure: unknown): string {
  const text = JSON.stringify(failure);
  const panic = /Smart contract panicked: ([^"\\]*)/.exec(text);
  return panic?.[1] ?? text;
}

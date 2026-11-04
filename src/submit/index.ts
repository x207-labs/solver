import type { ClearingEdge, Proposal } from "../mincostflow/index.js";

export { NearRpcChain, RpcError, failureText, reserveOf, type NearRpcOptions } from "./rpc.js";
export { parseSecretKey, signTransaction, encodeTransaction, type SolverKey, type FunctionCallTx } from "./tx.js";

/** `get_epoch` fields the solver needs. `phase` is derived from the clock (spec section 8). */
export interface EpochInfo {
  epoch: number;
  phase: string;
}

/** `get_clearing_proposal` fields the solver logs. */
export interface StoredProposal {
  solver: string;
  cleared_total: string;
  edge_count: number;
  committed: boolean;
}

/** `simulate_clearing` result (spec section 5). */
export interface Simulation {
  valid: boolean;
  cleared_total: string;
  edge_count: number;
  better_than_current: boolean;
  reason: string | null;
}

export type SubmitOutcome = { ok: true; txHash: string } | { ok: false; txHash?: string; error: string };

/** The four contract calls the solver makes, straight to the NEAR RPC and never through the backend. */
export interface ClearingChain {
  getEpoch(epoch: number): Promise<EpochInfo | null>;
  getProposal(epoch: number): Promise<StoredProposal | null>;
  simulate(epoch: number, edges: ClearingEdge[]): Promise<Simulation>;
  submit(epoch: number, edges: ClearingEdge[]): Promise<SubmitOutcome>;
}

export type SubmitStatus =
  | "submitted"
  | "not_better"
  | "invalid"
  | "window_closed"
  | "wrong_phase"
  | "lost_race"
  | "no_proposal"
  | "chain_error";

export interface SubmitResult {
  status: SubmitStatus;
  /** Process exit code: 0 for outcomes that are normal in a permissionless race, 1 for errors (K-45). */
  exitCode: 0 | 1;
  txHash?: string;
}

export type Log = (line: string) => void;

// Errors a late or beaten solver gets back from submit_clearing; logged and never retried.
const RACE_ERRORS = ["ERR_PROPOSAL_NOT_BETTER", "ERR_PROPOSAL_WINDOW_CLOSED"];

/**
 * Simulate first, submit only a valid proposal that beats the stored one, inside the proposal window
 * (SV-006, ADR-21, ADR-25). Nothing is retried: a lost race is a normal outcome.
 */
export async function submitProposal(chain: ClearingChain, proposal: Proposal, log: Log): Promise<SubmitResult> {
  const { epoch, edges } = proposal;
  if (edges.length === 0) {
    log("x207-solver: empty proposal, not sent");
    return { status: "no_proposal", exitCode: 0 };
  }
  try {
    const info = await chain.getEpoch(epoch);
    if (info === null) {
      log(`x207-solver: epoch ${epoch} not found on the contract`);
      return { status: "wrong_phase", exitCode: 1 };
    }
    if (info.phase === "commit") {
      log(`x207-solver: proposal window closed (fase commit), epoch ${epoch} not sent`);
      return { status: "window_closed", exitCode: 0 };
    }
    if (info.phase !== "clearing") {
      log(`x207-solver: epoch ${epoch} is in phase ${info.phase}, not clearing; not sent`);
      return { status: "wrong_phase", exitCode: 1 };
    }

    const stored = await chain.getProposal(epoch);
    const simulation = await chain.simulate(epoch, edges);
    log(
      `x207-solver: simulate_clearing valid=${simulation.valid} cleared_total=${simulation.cleared_total} ` +
        `edge_count=${simulation.edge_count} better_than_current=${simulation.better_than_current}`,
    );
    if (!simulation.valid) {
      log(`x207-solver: simulation refused the proposal: ${simulation.reason ?? "no reason"}`);
      return { status: "invalid", exitCode: 1 };
    }
    if (!simulation.better_than_current) {
      const holder = stored === null ? "none" : `${stored.solver} ${stored.cleared_total} (${stored.edge_count} edge)`;
      log(`x207-solver: stored proposal is not beaten (${holder}); not sent`);
      return { status: "not_better", exitCode: 0 };
    }

    const outcome = await chain.submit(epoch, edges);
    if (outcome.ok) {
      const replaced = stored === null ? "none" : `${stored.solver} ${stored.cleared_total}`;
      log(`x207-solver: submit_clearing accepted, tx ${outcome.txHash}; menggantikan proposal: ${replaced}`);
      return { status: "submitted", exitCode: 0, txHash: outcome.txHash };
    }
    log(`x207-solver: submit_clearing failed${outcome.txHash ? ` (tx ${outcome.txHash})` : ""}: ${outcome.error}`);
    const race = RACE_ERRORS.some((code) => outcome.error.includes(code));
    return {
      status: outcome.error.includes("ERR_PROPOSAL_WINDOW_CLOSED") ? "window_closed" : race ? "lost_race" : "chain_error",
      exitCode: race ? 0 : 1,
      txHash: outcome.txHash,
    };
  } catch (error) {
    log(`x207-solver: contract unreachable, not sent: ${(error as Error).message}`);
    return { status: "chain_error", exitCode: 1 };
  }
}

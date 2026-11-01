import type { ObligationEdge, ObligationGraph } from "../graph/index.js";
import { checkProposal, ProposalCheckError } from "./check.js";
import { decomposeCycles, selectCycles } from "./cycles.js";
import { minCostFlow, netPositions } from "./flow.js";

/** Default of MAX_EDGES_PER_TX (spec 3.6, K-44). */
export const DEFAULT_MAX_EDGES_PER_TX = 300;

/** ABI struct ClearingEdge. cleared is a U128 string. */
export interface ClearingEdge {
  debtor: string;
  creditor: string;
  cleared: string;
}

/** Arguments of simulate_clearing and submit_clearing. */
export interface Proposal {
  epoch: number;
  edges: ClearingEdge[];
}

export interface Allocation extends ObligationEdge {
  flow: bigint;
  cleared: bigint;
}

export interface ClearingResult {
  status: "ok" | "nothing_to_clear";
  proposal: Proposal;
  clearedTotal: bigint;
  /** Unpruned optimum per snapshot edge, including edges with cleared 0. */
  allocations: Allocation[];
  nid: bigint;
  /** True when the optimum exceeded maxEdges and whole cycles were dropped. */
  pruned: boolean;
}

export interface SolveOptions {
  maxEdges?: number;
}

export function solveClearing(graph: ObligationGraph, options: SolveOptions = {}): ClearingResult {
  const maxEdges = options.maxEdges ?? DEFAULT_MAX_EDGES_PER_TX;
  const flows = minCostFlow(graph);
  const allocations = graph.edges.map((edge, i) => ({
    ...edge,
    flow: flows[i]!,
    cleared: edge.amount - flows[i]!,
  }));

  const optimal: ClearingEdge[] = allocations
    .filter((edge) => edge.cleared > 0n)
    .map(({ debtor, creditor, cleared }) => ({ debtor, creditor, cleared: cleared.toString() }));
  const pruned = optimal.length > maxEdges;
  const edges = pruned ? selectCycles(decomposeCycles(optimal), maxEdges) : optimal;
  const proposal: Proposal = { epoch: graph.epoch, edges };

  if (edges.length > 0) {
    const check = checkProposal(graph, proposal, maxEdges);
    if (!check.ok) throw new ProposalCheckError(`cek lokal gagal: ${check.reason}`);
  }

  let nid = 0n;
  for (const position of netPositions(graph).values()) if (position > 0n) nid += position;

  return {
    status: edges.length > 0 ? "ok" : "nothing_to_clear",
    proposal,
    clearedTotal: edges.reduce((sum, edge) => sum + BigInt(edge.cleared), 0n),
    allocations,
    nid,
    pruned,
  };
}

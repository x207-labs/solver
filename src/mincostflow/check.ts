import { compareEdges, type ObligationGraph } from "../graph/index.js";
import type { Proposal } from "./solve.js";

export type ProposalCheck = { ok: true } | { ok: false; reason: string };

/** The solver built a proposal its own check rejects, so it must not reach simulate_clearing. */
export class ProposalCheckError extends Error {}

/** Local copy of the contract verifier: same rules, same order, same codes (spec 3.6, 4.7). */
export function checkProposal(
  graph: ObligationGraph,
  proposal: Proposal,
  maxEdges: number,
): ProposalCheck {
  const fail = (reason: string): ProposalCheck => ({ ok: false, reason });
  if (proposal.edges.length === 0) return fail("ERR_EMPTY_PROPOSAL: empty proposal");
  if (proposal.edges.length > maxEdges) {
    return fail(`ERR_TOO_MANY_EDGES: ${proposal.edges.length} > ${maxEdges}`);
  }

  const seen = new Set<string>();
  const balance = new Map<string, bigint>();
  for (const edge of proposal.edges) {
    const label = `${edge.debtor} -> ${edge.creditor}`;
    const cleared = BigInt(edge.cleared);
    if (cleared <= 0n) return fail(`ERR_ZERO_CLEARED: ${label}`);
    const pair = JSON.stringify([edge.debtor, edge.creditor]);
    if (seen.has(pair)) return fail(`ERR_DUPLICATE_EDGE: ${label}`);
    seen.add(pair);
    const obligation = graph.edges.find((item) => compareEdges(item, edge) === 0);
    if (obligation === undefined) return fail(`ERR_EDGE_NOT_IN_SNAPSHOT: ${label}`);
    if (cleared > obligation.amount) {
      return fail(`ERR_CLEARED_EXCEEDS_OBLIGATION: ${label}: ${cleared} > ${obligation.amount}`);
    }
    balance.set(edge.creditor, (balance.get(edge.creditor) ?? 0n) + cleared);
    balance.set(edge.debtor, (balance.get(edge.debtor) ?? 0n) - cleared);
  }

  for (const member of [...balance.keys()].sort()) {
    const net = balance.get(member)!;
    if (net !== 0n) return fail(`ERR_UNBALANCED_MEMBER: ${member}: selisih ${net}`);
  }
  return { ok: true };
}

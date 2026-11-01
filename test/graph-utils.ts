import { compareEdges, type ObligationEdge, type ObligationGraph } from "../src/graph/index.js";
import type { Proposal } from "../src/mincostflow/index.js";

/** Obligations left after applying a proposal, without the fully cleared edges. */
export function residualEdges(graph: ObligationGraph, proposal: Proposal): ObligationEdge[] {
  return graph.edges
    .map((edge) => {
      const applied = proposal.edges.find((item) => compareEdges(item, edge) === 0);
      return { ...edge, amount: edge.amount - BigInt(applied?.cleared ?? 0) };
    })
    .filter((edge) => edge.amount > 0n);
}

export function hasCycle(edges: { debtor: string; creditor: string }[]): boolean {
  const next = new Map<string, string[]>();
  for (const edge of edges) next.set(edge.debtor, [...(next.get(edge.debtor) ?? []), edge.creditor]);
  const done = new Set<string>();
  const onPath = new Set<string>();
  const visit = (node: string): boolean => {
    if (onPath.has(node)) return true;
    if (done.has(node)) return false;
    onPath.add(node);
    const found = (next.get(node) ?? []).some(visit);
    onPath.delete(node);
    done.add(node);
    return found;
  };
  return [...next.keys()].some(visit);
}

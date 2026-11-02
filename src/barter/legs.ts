import { buildGraph, type ObligationGraph } from "../graph/index.js";
import type { ClearingResult } from "../mincostflow/index.js";

export interface LegObligation {
  payer: string;
  payee: string;
  /** Obligation registered against the leg (credit, smallest unit). */
  amount: bigint;
}

/**
 * Adds the obligations that bundle legs registered to the obligations of a snapshot (SV-012, F5). A leg is registered
 * as an ordinary voucher obligation, so the cutoff snapshot already holds it; this merges legs that the snapshot does
 * not show yet and never counts a pair twice: where both have the pair, the larger amount wins.
 */
export function withBundleLegs(graph: ObligationGraph, legs: readonly LegObligation[]): ObligationGraph {
  const amounts = new Map<string, { debtor: string; creditor: string; amount: bigint }>();
  for (const e of graph.edges) amounts.set(`${e.debtor}\u0000${e.creditor}`, { ...e });
  for (const l of legs) {
    if (l.amount <= 0n) continue;
    const k = `${l.payer}\u0000${l.payee}`;
    const had = amounts.get(k);
    if (!had || had.amount < l.amount) amounts.set(k, { debtor: l.payer, creditor: l.payee, amount: l.amount });
  }
  return buildGraph(graph.circle, graph.epoch, [...amounts.values()]);
}

/** Legs of `legs` that the clearing removes completely. */
export function fullyClearedLegs(result: ClearingResult, legs: readonly LegObligation[]): LegObligation[] {
  const cleared = new Map(result.allocations.map((a) => [`${a.debtor}\u0000${a.creditor}`, a.cleared]));
  return legs.filter((l) => l.amount > 0n && (cleared.get(`${l.payer}\u0000${l.payee}`) ?? 0n) >= l.amount);
}

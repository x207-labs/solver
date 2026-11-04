import { compareEdges, compareText } from "../graph/index.js";
import type { ClearingEdge } from "./solve.js";

export interface Cycle {
  /** Value cleared on each edge of the cycle. */
  amount: bigint;
  edges: { debtor: string; creditor: string }[];
  /** Contribution to cleared_total: amount x edge count. */
  value: bigint;
}

const pairKey = (edge: { debtor: string; creditor: string }): string =>
  JSON.stringify([edge.debtor, edge.creditor]);

/**
 * Splits a balanced clearing into simple cycles (K-44). Walks from the smallest
 * member along the largest remaining outgoing edge, so large cycles peel first.
 * Input must be balanced per member, otherwise a walk can get stuck.
 */
export function decomposeCycles(input: ClearingEdge[]): Cycle[] {
  const outgoing = new Map<string, { creditor: string; left: bigint }[]>();
  for (const edge of [...input].sort(compareEdges)) {
    const list = outgoing.get(edge.debtor) ?? [];
    list.push({ creditor: edge.creditor, left: BigInt(edge.cleared) });
    outgoing.set(edge.debtor, list);
  }
  const largest = (member: string) => {
    let best: { creditor: string; left: bigint } | undefined;
    for (const item of outgoing.get(member) ?? []) {
      if (item.left > 0n && (best === undefined || item.left > best.left)) best = item;
    }
    return best;
  };

  const cycles: Cycle[] = [];
  for (const start of [...outgoing.keys()].sort(compareText)) {
    while (largest(start) !== undefined) {
      const path: string[] = [start];
      const position = new Map([[start, 0]]);
      let node = start;
      for (;;) {
        const step = largest(node);
        if (step === undefined) throw new Error(`clearing unbalanced at ${node}`);
        node = step.creditor;
        const seenAt = position.get(node);
        if (seenAt !== undefined) {
          cycles.push(extract(path.slice(seenAt), outgoing));
          break;
        }
        position.set(node, path.length);
        path.push(node);
      }
    }
  }
  return cycles;
}

function extract(
  nodes: string[],
  outgoing: Map<string, { creditor: string; left: bigint }[]>,
): Cycle {
  const legs = nodes.map((debtor, i) => {
    const creditor = nodes[(i + 1) % nodes.length]!;
    return { debtor, creditor, item: outgoing.get(debtor)!.find((o) => o.creditor === creditor)! };
  });
  const amount = legs.reduce((min, leg) => (leg.item.left < min ? leg.item.left : min), legs[0]!.item.left);
  for (const leg of legs) leg.item.left -= amount;
  return {
    amount,
    edges: legs.map(({ debtor, creditor }) => ({ debtor, creditor })),
    value: amount * BigInt(legs.length),
  };
}

/**
 * Keeps whole cycles by largest value while distinct edges fit the limit (K-44).
 * A cycle that does not fit is skipped, and smaller ones may still use the room.
 */
export function selectCycles(cycles: Cycle[], maxEdges: number): ClearingEdge[] {
  const ranked = [...cycles].sort(
    (a, b) =>
      (a.value === b.value ? 0 : a.value > b.value ? -1 : 1) ||
      a.edges.length - b.edges.length ||
      compareText(JSON.stringify(canonical(a)), JSON.stringify(canonical(b))),
  );
  const picked = new Map<string, { debtor: string; creditor: string; cleared: bigint }>();
  for (const cycle of ranked) {
    const added = cycle.edges.filter((edge) => !picked.has(pairKey(edge))).length;
    if (picked.size + added > maxEdges) continue;
    for (const edge of cycle.edges) {
      const key = pairKey(edge);
      const entry = picked.get(key) ?? { ...edge, cleared: 0n };
      entry.cleared += cycle.amount;
      picked.set(key, entry);
    }
  }
  return [...picked.values()]
    .sort(compareEdges)
    .map(({ debtor, creditor, cleared }) => ({ debtor, creditor, cleared: cleared.toString() }));
}

const canonical = (cycle: Cycle) => [...cycle.edges].sort(compareEdges);

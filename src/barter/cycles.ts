import { termsHash, type BundleLeg, type BundleTerms } from "@x207/core";

/** Open barter intent (Spec: `sdk/spec/barter-format.md`); amounts are credit in the smallest unit as decimal strings. */
export interface OpenIntent {
  account: string;
  offer: { service: string; calls: number; value: string };
  need: { service: string; calls: number; value: string };
  /** Hash of the signed intent, when known; breaks ties between intents of the same account. */
  intentHash?: string;
}

export interface IntentCycle {
  /** In payment order: member i pays member i+1 (the last pays the first) for what the next one offers. */
  members: OpenIntent[];
  legs: BundleLeg[];
}

export interface CycleOptions {
  /** Longest ring searched. */
  maxLength?: number;
}

const sameSide = (a: OpenIntent["need"], b: OpenIntent["offer"]) => a.service === b.service && a.calls === b.calls && a.value === b.value;
const key = (i: OpenIntent) => `${i.account}\u0000${i.intentHash ?? ""}`;
const text = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface RingSpec<T> {
  /** Unique, stable key of a node; also the sort key. */
  key(node: T): string;
  /** Account of a node; an account appears at most once in a ring. */
  account(node: T): string;
  /** `true` when `from` pays `to` (the next node in payment order). */
  edge(from: T, to: T): boolean;
  minLength?: number;
  maxLength?: number;
}

/**
 * Rings in a directed graph, shortest first, each node in at most one ring, independent of the input order: nodes are
 * sorted by key, a ring starts at its smallest node, rings are taken by length and then by their keys.
 */
export function findRings<T>(input: readonly T[], spec: RingSpec<T>): T[][] {
  const minLength = spec.minLength ?? 2;
  const maxLength = spec.maxLength ?? 5;
  const nodes = [...input].sort((a, b) => text(spec.key(a), spec.key(b)));
  const next = nodes.map((from) => nodes.map((to, j) => (spec.account(to) !== spec.account(from) && spec.edge(from, to) ? j : -1)).filter((j) => j >= 0));
  const found: number[][] = [];
  const path: number[] = [];
  const walk = (start: number, at: number) => {
    path.push(at);
    for (const to of next[at]!) {
      if (to === start) {
        if (path.length >= minLength) found.push([...path]);
      } else if (to > start && path.length < maxLength && !path.some((p) => spec.account(nodes[p]!) === spec.account(nodes[to]!))) {
        walk(start, to);
      }
    }
    path.pop();
  };
  nodes.forEach((_, start) => walk(start, start));
  const keyOf = (ring: number[]) => ring.map((i) => spec.key(nodes[i]!)).join("|");
  found.sort((a, b) => a.length - b.length || text(keyOf(a), keyOf(b)));
  const used = new Set<number>();
  const rings: T[][] = [];
  for (const ring of found) {
    if (ring.some((i) => used.has(i))) continue;
    ring.forEach((i) => used.add(i));
    rings.push(ring.map((i) => nodes[i]!));
  }
  return rings;
}

/**
 * Rings of intents where what each one needs is exactly what the next one offers (same service, calls and value,
 * so every leg is balanced): A pays B for B's offer, B pays C, C pays A (SV-010, F5). Every intent is used in at most
 * one ring, an account appears at most once in a ring, and the result does not depend on the input order.
 */
export function findIntentCycles(intents: readonly OpenIntent[], options: CycleOptions = {}): IntentCycle[] {
  const rings = findRings(intents, { key, account: (i) => i.account, edge: (from, to) => sameSide(from.need, to.offer), maxLength: options.maxLength });
  return rings.map((members) => ({
    members,
    legs: members.map((m, i) => ({ payer: m.account, payee: members[(i + 1) % members.length]!.account, max_amount: members[(i + 1) % members.length]!.offer.value })),
  }));
}

/** `BundleTerms` of a ring for `circle` and `epoch`, with its `terms_hash`. */
export function cycleTerms(cycle: IntentCycle, circle: string, epoch: number): { terms: BundleTerms; termsHash: string } {
  const terms: BundleTerms = { circle, epoch, legs: cycle.legs };
  return { terms, termsHash: termsHash(terms) };
}

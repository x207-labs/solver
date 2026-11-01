// Shared fixtures from "x207 - Test Case solver" section 1.2.
const account = (name: string): string => `${name}.x207-circle.near`;

export const CREDIT = 1_000_000n;

export interface RawEdge {
  debtor: string;
  creditor: string;
  amount: string;
  seq: number;
  cleared: string | null;
  remaining: string | null;
}

export const e42 = {
  translator: account("translator"),
  summarizer: account("summarizer"),
  image: account("image"),
  scraper: account("scraper"),
  gpu: account("gpu"),
  cleaner: account("cleaner"),
};

const rawEdge = (debtor: string, creditor: string, amount: string, seq: number): RawEdge => ({
  debtor,
  creditor,
  amount,
  seq,
  cleared: null,
  remaining: null,
});

export const FX_E42_EDGES: RawEdge[] = [
  rawEdge(e42.translator, e42.summarizer, "30000000", 12),
  rawEdge(e42.summarizer, e42.image, "30000000", 8),
  rawEdge(e42.image, e42.translator, "30000000", 10),
  rawEdge(e42.scraper, e42.gpu, "50000000", 20),
  rawEdge(e42.gpu, e42.cleaner, "20000000", 5),
  rawEdge(e42.cleaner, e42.scraper, "15000000", 3),
  rawEdge(e42.cleaner, e42.gpu, "15000000", 2),
];

export function snapshot(edges: RawEdge[] = FX_E42_EDGES, overrides: Record<string, unknown> = {}) {
  return {
    circle: "agents-main",
    epoch: 42,
    phase: "clearing",
    stage: "cutoff",
    unit: "credit",
    decimals: 6,
    edgeCount: edges.length,
    totalObligation: edges.reduce((sum, edge) => sum + BigInt(edge.amount), 0n).toString(),
    edges,
    ...overrides,
  };
}

export const FX_E42 = snapshot();

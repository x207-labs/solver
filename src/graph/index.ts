const U128_MAX = (1n << 128n) - 1n;
const PHASES = new Set(["open", "cutoff", "clearing", "commit", "payment_window", "finalized"]);
const DEFAULT_TIMEOUT_MS = 10_000;

export interface ObligationEdge {
  debtor: string;
  creditor: string;
  amount: bigint;
}

/** Edges have amount > 0, no duplicate pair, and are sorted by (debtor, creditor). */
export interface ObligationGraph {
  circle: string;
  epoch: number;
  members: string[];
  edges: ObligationEdge[];
  totalObligation: bigint;
}

/** Any reason the snapshot cannot be trusted. The solver stops without submitting (K-45). */
export class SnapshotError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

// Plain code unit order: stable across machines and locales, unlike localeCompare.
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareEdges(
  a: { debtor: string; creditor: string },
  b: { debtor: string; creditor: string },
): number {
  return compareText(a.debtor, b.debtor) || compareText(a.creditor, b.creditor);
}

export function buildGraph(circle: string, epoch: number, input: ObligationEdge[]): ObligationGraph {
  const seen = new Set<string>();
  const members = new Set<string>();
  const edges: ObligationEdge[] = [];
  let totalObligation = 0n;
  for (const edge of input) {
    const label = `${edge.debtor} -> ${edge.creditor}`;
    if (edge.debtor === edge.creditor) throw invalid(`edge ke diri sendiri: ${label}`);
    const pair = JSON.stringify([edge.debtor, edge.creditor]);
    if (seen.has(pair)) throw invalid(`pasangan ganda: ${label}`);
    seen.add(pair);
    if (edge.amount === 0n) continue;
    members.add(edge.debtor).add(edge.creditor);
    edges.push(edge);
    totalObligation += edge.amount;
  }
  edges.sort(compareEdges);
  return { circle, epoch, members: [...members].sort(compareText), edges, totalObligation };
}

const invalid = (message: string) => new SnapshotError("invalid_snapshot", message);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAmount(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw invalid(`${label} is not an integer string: ${JSON.stringify(value)}`);
  }
  const amount = BigInt(value);
  if (amount > U128_MAX) throw invalid(`${label} exceeds u128: ${value}`);
  return amount;
}

function parseEdge(value: unknown, index: number): ObligationEdge {
  if (!isRecord(value)) throw invalid(`edges[${index}] is not an object`);
  const { debtor, creditor, amount, seq, cleared, remaining } = value;
  if (typeof debtor !== "string" || debtor === "") throw invalid(`edges[${index}].debtor is invalid`);
  if (typeof creditor !== "string" || creditor === "") {
    throw invalid(`edges[${index}].creditor is invalid`);
  }
  if (!Number.isSafeInteger(seq)) throw invalid(`edges[${index}].seq is invalid`);
  for (const [name, field] of [["cleared", cleared], ["remaining", remaining]] as const) {
    if (field !== null && typeof field !== "string") {
      throw invalid(`edges[${index}].${name} must be a string or null`);
    }
  }
  return { debtor, creditor, amount: parseAmount(amount, `edges[${index}].amount`) };
}

/** Validates a spec section 3.3 response body and checks it against its own header. */
export function parseSnapshot(body: unknown, circle: string, epoch: number): ObligationGraph {
  if (!isRecord(body)) throw invalid("respons is not an object");
  if (body.circle !== circle) throw invalid(`circle ${String(body.circle)}, diminta ${circle}`);
  if (body.epoch !== epoch) throw invalid(`epoch ${String(body.epoch)}, diminta ${epoch}`);
  if (body.stage !== "cutoff") throw invalid(`stage ${String(body.stage)}, diminta cutoff`);
  if (typeof body.phase !== "string" || !PHASES.has(body.phase)) {
    throw invalid(`phase unknown: ${String(body.phase)}`);
  }
  if (body.unit !== "credit" || body.decimals !== 6) {
    throw invalid(`satuan ${String(body.unit)}/${String(body.decimals)}, diminta credit/6`);
  }
  if (!Array.isArray(body.edges)) throw invalid("edges is not an array");
  if (!Number.isSafeInteger(body.edgeCount)) throw invalid("edgeCount is invalid");
  const declaredTotal = parseAmount(body.totalObligation, "totalObligation");

  const parsed = body.edges.map(parseEdge);
  const graph = buildGraph(circle, epoch, parsed);
  if (body.edgeCount !== parsed.length) {
    throw new SnapshotError(
      "snapshot_mismatch",
      `edgeCount ${String(body.edgeCount)}, edges holds ${parsed.length}`,
    );
  }
  if (declaredTotal !== graph.totalObligation) {
    throw new SnapshotError(
      "snapshot_mismatch",
      `totalObligation ${declaredTotal}, sum of edges ${graph.totalObligation}`,
    );
  }
  return graph;
}

export interface LoadOptions {
  readApiUrl: string;
  circle: string;
  epoch: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Loads epoch obligations from the read API. Throws SnapshotError instead of returning partial data. */
export async function loadObligationGraph(options: LoadOptions): Promise<ObligationGraph> {
  const { readApiUrl, circle, epoch } = options;
  const base = readApiUrl.replace(/\/+$/, "");
  const url = `${base}/x207/circles/${encodeURIComponent(circle)}/epochs/${epoch}/obligations?stage=cutoff`;

  let response: Response;
  let text: string;
  try {
    response = await (options.fetch ?? fetch)(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    text = await response.text();
  } catch (error) {
    throw new SnapshotError("read_api_unreachable", `${url}: ${(error as Error).message}`);
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    const detail = isRecord(body) && isRecord(body.error) ? body.error : undefined;
    const code = typeof detail?.code === "string" ? detail.code : `http_${response.status}`;
    const message = typeof detail?.message === "string" ? detail.message : `HTTP ${response.status}`;
    throw new SnapshotError(code, message);
  }
  if (body === undefined) throw invalid("respons is not JSON");
  return parseSnapshot(body, circle, epoch);
}

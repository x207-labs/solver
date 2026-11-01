import { createHash } from "node:crypto";
import { compareText, type ObligationEdge, type ObligationGraph } from "../graph/index.js";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest();

/** Tie-break seed: first 8 bytes of sha256("<circleId>:<epoch>") as big-endian u64 (K-43). */
export function seedFromEpoch(circle: string, epoch: number): bigint {
  return sha256(`${circle}:${epoch}`).readBigUInt64BE(0);
}

/**
 * Edge scan order for path search. Equal-cost routes are resolved by whichever
 * edge is scanned first, so this order alone decides among optimal solutions.
 */
function seededOrder(graph: ObligationGraph): ObligationEdge[] {
  const seed = seedFromEpoch(graph.circle, graph.epoch);
  const rank = new Map(
    graph.edges.map((edge) => [
      edge,
      sha256(JSON.stringify([seed.toString(), edge.debtor, edge.creditor])).toString("hex"),
    ]),
  );
  return [...graph.edges].sort((a, b) => compareText(rank.get(a)!, rank.get(b)!));
}

/** Net position b_i per member: inflow minus outflow. */
export function netPositions(graph: ObligationGraph): Map<string, bigint> {
  const positions = new Map(graph.members.map((member) => [member, 0n]));
  for (const edge of graph.edges) {
    positions.set(edge.creditor, (positions.get(edge.creditor) ?? 0n) + edge.amount);
    positions.set(edge.debtor, (positions.get(edge.debtor) ?? 0n) - edge.amount);
  }
  return positions;
}

/**
 * Min-cost flow of NID from net debtors to net creditors over the obligation
 * edges (capacity = obligation, cost 1 per unit per edge), by successive
 * shortest paths. Whatever this flow does not use is the optimal cycle-only
 * clearing: minimising flow maximises cleared value, and a minimum flow cannot
 * contain a cycle, so the residual graph is acyclic.
 *
 * Returns the flow per edge, aligned with graph.edges.
 */
export function minCostFlow(graph: ObligationGraph): bigint[] {
  const index = new Map(graph.members.map((member, i) => [member, i]));
  const source = graph.members.length;
  const sink = source + 1;
  const nodeCount = sink + 1;

  // Arcs come in pairs: arc a and its reverse a ^ 1.
  const from: number[] = [];
  const to: number[] = [];
  const capacity: bigint[] = [];
  const weight: number[] = [];
  // Path length breaks ties between equal cost paths, which keeps augmenting
  // paths short. Weighting by arc count makes cost always dominate length.
  const costUnit = 2 * (graph.edges.length + 2 * graph.members.length) + 1;
  const addArc = (tail: number, head: number, cap: bigint, cost: number): void => {
    from.push(tail, head);
    to.push(head, tail);
    capacity.push(cap, 0n);
    weight.push(cost * costUnit + 1, -cost * costUnit + 1);
  };

  const order = seededOrder(graph);
  for (const edge of order) {
    addArc(index.get(edge.debtor)!, index.get(edge.creditor)!, edge.amount, 1);
  }
  let demand = 0n;
  for (const [member, position] of netPositions(graph)) {
    const node = index.get(member)!;
    if (position < 0n) {
      addArc(source, node, -position, 0);
      demand += -position;
    } else if (position > 0n) {
      addArc(node, sink, position, 0);
    }
  }

  // Bellman-Ford: residual arcs have negative cost, and no negative cycle can
  // appear while every augmentation follows a shortest path.
  const parent = new Int32Array(nodeCount);
  const dist = new Float64Array(nodeCount);
  const findPath = (): boolean => {
    dist.fill(Infinity);
    parent.fill(-1);
    dist[source] = 0;
    for (let changed = true; changed; ) {
      changed = false;
      for (let arc = 0; arc < from.length; arc++) {
        if (capacity[arc]! === 0n) continue;
        const tail = dist[from[arc]!]!;
        if (tail === Infinity) continue;
        const candidate = tail + weight[arc]!;
        if (candidate < dist[to[arc]!]!) {
          dist[to[arc]!] = candidate;
          parent[to[arc]!] = arc;
          changed = true;
        }
      }
    }
    return dist[sink] !== Infinity;
  };

  while (demand > 0n) {
    // Sending every obligation in full is feasible, so a path always exists.
    if (!findPath()) throw new Error("min-cost flow: demand tidak terpenuhi");
    let bottleneck = demand;
    for (let node = sink; node !== source; node = from[parent[node]!]!) {
      const available = capacity[parent[node]!]!;
      if (available < bottleneck) bottleneck = available;
    }
    for (let node = sink; node !== source; node = from[parent[node]!]!) {
      const arc = parent[node]!;
      capacity[arc]! -= bottleneck;
      capacity[arc ^ 1]! += bottleneck;
    }
    demand -= bottleneck;
  }

  const arcOf = new Map(order.map((edge, i) => [edge, 2 * i]));
  return graph.edges.map((edge) => capacity[arcOf.get(edge)! + 1]!);
}

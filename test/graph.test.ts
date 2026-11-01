import { afterEach, describe, expect, it, vi } from "vitest";
import { loadObligationGraph, SnapshotError } from "../src/graph/index.js";
import { FX_E42, FX_E42_EDGES, e42, snapshot, type RawEdge } from "./fixtures.js";
import { startReadApi, type MockReadApi } from "./mock-read-api.js";
import { runCli } from "./run-cli.js";

const BASE = "http://read-api.test";

const respond = (status: number, body: unknown) =>
  vi.fn(async (_url: string | URL | Request) => Response.json(body, { status }));

const load = (fetchImpl: typeof fetch, epoch = 42) =>
  loadObligationGraph({ readApiUrl: BASE, circle: "agents-main", epoch, fetch: fetchImpl });

const edge = (debtor: string, creditor: string, amount: string): RawEdge => ({
  debtor,
  creditor,
  amount,
  seq: 1,
  cleared: null,
  remaining: null,
});

async function failure(promise: Promise<unknown>): Promise<SnapshotError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(SnapshotError);
  return error as SnapshotError;
}

describe("SV-002 obligation graph loader", () => {
  it("TC-SV-002-01 loads the cutoff snapshot", async () => {
    const fetchMock = respond(200, FX_E42);
    const graph = await load(fetchMock);
    expect(graph.edges).toHaveLength(7);
    expect(graph.members).toHaveLength(6);
    expect(graph.totalObligation).toBe(190000000n);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${BASE}/x207/circles/agents-main/epochs/42/obligations?stage=cutoff`,
    );
  });

  it("TC-SV-002-02 accepts a matching header", async () => {
    await expect(load(respond(200, snapshot()))).resolves.toBeDefined();
  });

  it.each([
    ["edgeCount", { edgeCount: 8 }],
    ["totalObligation", { totalObligation: "191000000" }],
  ])("TC-SV-002-03 rejects a mismatching %s", async (_name, overrides) => {
    const error = await failure(load(respond(200, snapshot(FX_E42_EDGES, overrides))));
    expect(error.code).toBe("snapshot_mismatch");
  });

  it("TC-SV-002-04 returns an empty graph for empty edges", async () => {
    const graph = await load(respond(200, snapshot([])));
    expect(graph.edges).toEqual([]);
  });

  it("TC-SV-002-05 stops on epoch_not_closed", async () => {
    const body = { error: { code: "epoch_not_closed", message: "open" } };
    expect((await failure(load(respond(409, body)))).code).toBe("epoch_not_closed");
  });

  it("TC-SV-002-06 stops on epoch_not_found", async () => {
    const body = { error: { code: "epoch_not_found", message: "none" } };
    expect((await failure(load(respond(404, body)))).code).toBe("epoch_not_found");
  });

  it("TC-SV-002-07 stops on an unhealthy read API", async () => {
    const unavailable = { error: { code: "indexer_unavailable", message: "boot" } };
    expect((await failure(load(respond(503, unavailable)))).code).toBe("indexer_unavailable");

    const broken = vi.fn(async () => new Response("<html>oops</html>", { status: 500 }));
    expect((await failure(load(broken))).code).toBe("http_500");

    const timeout = vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    expect((await failure(load(timeout))).code).toBe("read_api_unreachable");

    // Partial data with an unreadable body must not be used.
    const truncated = vi.fn(async () => new Response('{"edges":[', { status: 200 }));
    expect((await failure(load(truncated))).code).toBe("invalid_snapshot");
  });

  it("TC-SV-002-08 keeps amounts above 2^53 exact", async () => {
    const raw = [edge("a.near", "b.near", "9007199254740993")];
    const graph = await load(respond(200, snapshot(raw)));
    expect(graph.edges[0]?.amount).toBe(9007199254740993n);
  });

  it.each<[string, RawEdge[]]>([
    ["duplicate pair", [edge("a.near", "b.near", "1"), edge("a.near", "b.near", "2")]],
    ["self edge", [edge("a.near", "a.near", "1")]],
    ["negative amount", [edge("a.near", "b.near", "-1")]],
    ["non-numeric amount", [edge("a.near", "b.near", "1.5")]],
    ["amount above u128", [edge("a.near", "b.near", (1n << 128n).toString())]],
  ])("TC-SV-002-09 rejects %s", async (_name, raw) => {
    const body = { ...snapshot([]), edges: raw, edgeCount: raw.length };
    expect((await failure(load(respond(200, body)))).code).toBe("invalid_snapshot");
  });

  it("TC-SV-002-10 ignores zero amount edges", async () => {
    const raw = [edge("a.near", "b.near", "0"), edge("b.near", "a.near", "5")];
    const graph = await load(respond(200, snapshot(raw)));
    expect(graph.edges.map((e) => e.debtor)).toEqual(["b.near"]);
    expect(graph.totalObligation).toBe(5n);
  });

  it("TC-SV-002-11 accepts the spec section 3.3 response shape", async () => {
    // Spec sample, epoch in payment_window: cleared and remaining are filled there.
    const body = {
      circle: "agents-main",
      epoch: 42,
      phase: "payment_window",
      stage: "cutoff",
      unit: "credit",
      decimals: 6,
      edgeCount: 2,
      totalObligation: "412740000",
      edges: [
        {
          debtor: "translator.x207-circle.near",
          creditor: "summarizer.x207-circle.near",
          amount: "2740000",
          seq: 137,
          cleared: "2740000",
          remaining: "0",
        },
        {
          debtor: "scraper.x207-circle.near",
          creditor: "gpu.x207-circle.near",
          amount: "410000000",
          seq: 96,
          cleared: "375000000",
          remaining: "35000000",
        },
      ],
    };
    expect((await load(respond(200, body))).edges).toHaveLength(2);
  });

  it.each([
    ["missing field", { unit: undefined }],
    ["other stage", { stage: "live" }],
    ["other circle", { circle: "other" }],
    ["other epoch", { epoch: 41 }],
    ["other decimals", { decimals: 18 }],
    ["unknown phase", { phase: "paused" }],
  ])("TC-SV-002-11 rejects %s", async (_name, overrides) => {
    const body = snapshot(FX_E42_EDGES, overrides);
    expect((await failure(load(respond(200, body)))).code).toBe("invalid_snapshot");
  });

  it("accepts a base URL with a trailing slash", async () => {
    const fetchMock = respond(200, FX_E42);
    await loadObligationGraph({
      readApiUrl: `${BASE}/`,
      circle: "agents-main",
      epoch: 42,
      fetch: fetchMock,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`${BASE}/x207/circles/`);
  });

  it("sorts edges canonically regardless of input order", async () => {
    const graph = await load(respond(200, snapshot([...FX_E42_EDGES].reverse())));
    expect(graph.edges[0]?.debtor).toBe(e42.cleaner);
    expect(graph.edges[0]?.creditor).toBe(e42.gpu);
  });
});

describe("SV-002 through the CLI", () => {
  let api: MockReadApi | undefined;
  afterEach(() => api?.close());

  const env = (url: string) => ({ X207_READ_API_URL: url, X207_CIRCLE_ID: "agents-main" });

  it("TC-SV-002-12 uses the URL from the environment", async () => {
    api = await startReadApi(200, FX_E42);
    const result = await runCli(["--epoch", "42"], env(api.url));
    expect(result.code).toBe(0);
    expect(api.requests[0]?.url).toBe("/x207/circles/agents-main/epochs/42/obligations?stage=cutoff");
  });

  it("TC-SV-002-12 refuses to run without the URL", async () => {
    const result = await runCli(["--epoch", "42"], { X207_READ_API_URL: "" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("X207_READ_API_URL");
  });

  it("SV-003 prints the proposal and respects MAX_EDGES_PER_TX", async () => {
    api = await startReadApi(200, FX_E42);
    const full = await runCli(["--epoch", "42"], env(api.url));
    expect(full.code).toBe(0);
    expect(JSON.parse(full.stdout).edges).toHaveLength(7);
    expect(full.stderr).toContain("cleared_total 145000000");

    const capped = await runCli(["--epoch", "42"], { ...env(api.url), MAX_EDGES_PER_TX: "3" });
    expect(JSON.parse(capped.stdout).edges).toHaveLength(3);
    expect(capped.stderr).toContain("cleared_total 90000000");
  });

  it("SV-003 rejects an invalid MAX_EDGES_PER_TX", async () => {
    const result = await runCli(["--epoch", "42"], {
      X207_READ_API_URL: "http://127.0.0.1:1",
      MAX_EDGES_PER_TX: "0",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("MAX_EDGES_PER_TX");
  });

  it("TC-SV-003-09 logs nothing to clear on a DAG and sends nothing", async () => {
    const edges = [
      { debtor: "a", creditor: "b", amount: "5", seq: 1, cleared: null, remaining: null },
      { debtor: "b", creditor: "c", amount: "5", seq: 2, cleared: null, remaining: null },
    ];
    api = await startReadApi(200, snapshot(edges));
    const result = await runCli(["--epoch", "42"], env(api.url));
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("tidak ada yang dikliring");
    expect(result.stdout).toBe("");
  });

  it("TC-SV-002-03 exits 1 on a mismatching header", async () => {
    api = await startReadApi(200, snapshot(FX_E42_EDGES, { edgeCount: 8 }));
    const result = await runCli(["--epoch", "42"], env(api.url));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("snapshot_mismatch");
    expect(result.stdout).toBe("");
  });

  it("TC-SV-002-04 stops and logs on an empty snapshot", async () => {
    api = await startReadApi(200, snapshot([]));
    const result = await runCli(["--epoch", "42"], env(api.url));
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("tidak ada kewajiban");
    expect(result.stdout).toBe("");
  });

  it("TC-SV-002-05 logs the error code", async () => {
    api = await startReadApi(409, { error: { code: "epoch_not_closed", message: "open" } });
    const result = await runCli(["--epoch", "42"], env(api.url));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("epoch_not_closed");
  });
});

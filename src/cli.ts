#!/usr/bin/env node
import { existsSync } from "node:fs";
import { parseCliArgs, readConfig, readSubmitConfig, UsageError } from "./config.js";
import { bundleLegReport, loadActiveBundles } from "./barter/index.js";
import { loadObligationGraph, SnapshotError } from "./graph/index.js";
import { ProposalCheckError, solveClearing } from "./mincostflow/index.js";
import { NearRpcChain, parseSecretKey, submitProposal } from "./submit/index.js";

/** SV-012: says how many legs of the bundles of this epoch the proposal clears completely. Information only; a read error is not fatal. */
async function reportBundleLegs(result: Parameters<typeof bundleLegReport>[0], readApiUrl: string, circle: string, epoch: number): Promise<void> {
  try {
    const bundles = await loadActiveBundles({ readApiUrl, circle, epoch, timeoutMs: 5_000 });
    for (const b of bundleLegReport(result, bundles)) console.error(`x207-solver: bundle ${b.bundleId}: ${b.cleared} of ${b.legs} legs fully cleared`);
  } catch (error) {
    console.error(`x207-solver: bundle unreadable, leg report skipped: ${(error as Error).message}`);
  }
}

async function main(argv: string[]): Promise<number> {
  const { epoch, noSubmit } = parseCliArgs(argv);
  if (existsSync(".env")) process.loadEnvFile(".env");
  const { readApiUrl, circle, maxEdges } = readConfig(process.env);
  const submit = noSubmit ? null : readSubmitConfig(process.env);

  console.error(`x207-solver: ${circle} epoch ${epoch}`);
  const graph = await loadObligationGraph({ readApiUrl, circle, epoch });
  if (graph.edges.length === 0) {
    console.error("x207-solver: no obligations, nothing sent");
    return 0;
  }
  console.error(`x207-solver: ${graph.edges.length} edge, total ${graph.totalObligation}`);

  const result = solveClearing(graph, { maxEdges });
  if (result.status === "nothing_to_clear") {
    console.error("x207-solver: nothing cleared, nothing sent");
    return 0;
  }
  console.error(
    `x207-solver: proposal ${result.proposal.edges.length} edge, cleared_total ${result.clearedTotal}, ` +
      `dipangkas ${result.pruned}`,
  );
  await reportBundleLegs(result, readApiUrl, circle, epoch);
  console.log(JSON.stringify(result.proposal));
  if (submit === null) {
    console.error("x207-solver: no submit configuration or --no-submit, proposal only printed");
    return 0;
  }
  const chain = new NearRpcChain({
    rpcUrl: submit.rpcUrl,
    contractId: submit.contractId,
    signerId: submit.signerId,
    key: parseSecretKey(submit.secretKey),
    gasTgas: submit.gasTgas,
    ...(submit.gasKeyNonceIndex === undefined ? {} : { gasKeyNonceIndex: submit.gasKeyNonceIndex }),
  });
  return (await submitProposal(chain, result.proposal, (line) => console.error(line))).exitCode;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const known =
    error instanceof UsageError ||
    (error instanceof Error && error.message.startsWith("SOLVER_PRIVATE_KEY")) ||
    error instanceof SnapshotError ||
    error instanceof ProposalCheckError;
  if (!known) throw error;
  console.error(`x207-solver: ${error.message}`);
  process.exitCode = 1;
}

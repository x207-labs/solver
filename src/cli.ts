#!/usr/bin/env node
import { existsSync } from "node:fs";
import { parseCliArgs, readConfig, readSubmitConfig, UsageError } from "./config.js";
import { loadObligationGraph, SnapshotError } from "./graph/index.js";
import { ProposalCheckError, solveClearing } from "./mincostflow/index.js";
import { NearRpcChain, parseSecretKey, submitProposal } from "./submit/index.js";

async function main(argv: string[]): Promise<number> {
  const { epoch, noSubmit } = parseCliArgs(argv);
  if (existsSync(".env")) process.loadEnvFile(".env");
  const { readApiUrl, circle, maxEdges } = readConfig(process.env);
  const submit = noSubmit ? null : readSubmitConfig(process.env);

  console.error(`x207-solver: ${circle} epoch ${epoch}`);
  const graph = await loadObligationGraph({ readApiUrl, circle, epoch });
  if (graph.edges.length === 0) {
    console.error("x207-solver: tidak ada kewajiban, tidak ada yang dikirim");
    return 0;
  }
  console.error(`x207-solver: ${graph.edges.length} edge, total ${graph.totalObligation}`);

  const result = solveClearing(graph, { maxEdges });
  if (result.status === "nothing_to_clear") {
    console.error("x207-solver: tidak ada yang dikliring, tidak ada yang dikirim");
    return 0;
  }
  console.error(
    `x207-solver: proposal ${result.proposal.edges.length} edge, cleared_total ${result.clearedTotal}, ` +
      `dipangkas ${result.pruned}`,
  );
  console.log(JSON.stringify(result.proposal));
  if (submit === null) {
    console.error("x207-solver: tidak ada konfigurasi submit atau --no-submit, proposal hanya dicetak");
    return 0;
  }
  const chain = new NearRpcChain({
    rpcUrl: submit.rpcUrl,
    contractId: submit.contractId,
    signerId: submit.signerId,
    key: parseSecretKey(submit.secretKey),
    gasTgas: submit.gasTgas,
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

#!/usr/bin/env node
import { parseCliArgs, UsageError } from "./config.js";

function main(argv: string[]): number {
  const { epoch } = parseCliArgs(argv);
  console.error(`x207-solver: epoch ${epoch}`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
}

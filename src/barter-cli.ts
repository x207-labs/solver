#!/usr/bin/env node
import { existsSync } from "node:fs";
import { UsageError } from "./config.js";
import { runBarterCli } from "./barter/cli.js";

try {
  if (existsSync(".env")) process.loadEnvFile(".env");
  process.exitCode = await runBarterCli(process.argv.slice(2), { env: process.env, out: (l) => console.log(l), err: (l) => console.error(l) });
} catch (error) {
  if (!(error instanceof UsageError) && !(error instanceof TypeError && String(error.message).includes("Unknown option"))) throw error;
  console.error(`x207-barter: ${(error as Error).message}`);
  process.exitCode = 1;
}

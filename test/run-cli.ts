import { execFile } from "node:child_process";
import { resolve } from "node:path";

const CLI = resolve("dist/cli.js");

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Runs from an empty cwd by default so a developer's .env never leaks into a test.
export function runCli(
  args: string[],
  env: Record<string, string> = {},
  cwd: string = resolve("test"),
): Promise<CliResult> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { PATH: process.env.PATH ?? "", ...env }, cwd },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
        done({ code, stdout, stderr });
      },
    );
  });
}

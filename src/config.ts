import { parseArgs } from "node:util";

export class UsageError extends Error {}

export interface CliArgs {
  epoch: number;
}

export interface Config {
  readApiUrl: string;
  circle: string;
}

const USAGE = "usage: x207-solver --epoch <n>";

export function parseCliArgs(argv: string[]): CliArgs {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { epoch: { type: "string" } } }));
  } catch (error) {
    throw new UsageError(`${(error as Error).message}\n${USAGE}`);
  }
  if (values.epoch === undefined) throw new UsageError(`--epoch wajib diisi\n${USAGE}`);
  const epoch = Number(values.epoch);
  if (!/^\d+$/.test(values.epoch) || !Number.isSafeInteger(epoch)) {
    throw new UsageError(`--epoch harus bilangan bulat >= 0, diterima "${values.epoch}"\n${USAGE}`);
  }
  return { epoch };
}

export function readConfig(env: NodeJS.ProcessEnv): Config {
  const readApiUrl = env.X207_READ_API_URL;
  if (!readApiUrl) throw new UsageError("X207_READ_API_URL wajib diisi (lihat .env.example)");
  return { readApiUrl, circle: env.X207_CIRCLE_ID || "agents-main" };
}

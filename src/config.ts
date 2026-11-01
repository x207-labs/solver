import { parseArgs } from "node:util";

export class UsageError extends Error {}

export interface CliArgs {
  epoch: number;
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

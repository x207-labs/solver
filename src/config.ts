import { parseArgs } from "node:util";
import { DEFAULT_MAX_EDGES_PER_TX } from "./mincostflow/index.js";

export class UsageError extends Error {}

export interface CliArgs {
  epoch: number;
  /** `--no-submit`: print the proposal and send nothing, even when the submit variables are set. */
  noSubmit: boolean;
}

export interface SubmitConfig {
  rpcUrl: string;
  contractId: string;
  signerId: string;
  secretKey: string;
  gasTgas: number;
  /** `SOLVER_GAS_KEY_NONCE_INDEX`: the key is a gas key (NEP-611) and this is the lane to use. */
  gasKeyNonceIndex?: number;
}

export interface Config {
  readApiUrl: string;
  circle: string;
  maxEdges: number;
}

const USAGE = "usage: x207-solver --epoch <n> [--no-submit]";

export function parseCliArgs(argv: string[]): CliArgs {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { epoch: { type: "string" }, "no-submit": { type: "boolean" } } }));
  } catch (error) {
    throw new UsageError(`${(error as Error).message}\n${USAGE}`);
  }
  if (values.epoch === undefined) throw new UsageError(`--epoch wajib diisi\n${USAGE}`);
  const epoch = Number(values.epoch);
  if (!/^\d+$/.test(values.epoch) || !Number.isSafeInteger(epoch)) {
    throw new UsageError(`--epoch harus bilangan bulat >= 0, diterima "${values.epoch}"\n${USAGE}`);
  }
  return { epoch, noSubmit: values["no-submit"] === true };
}

export function readConfig(env: NodeJS.ProcessEnv): Config {
  const readApiUrl = env.X207_READ_API_URL;
  if (!readApiUrl) throw new UsageError("X207_READ_API_URL wajib diisi (lihat .env.example)");
  const rawMaxEdges = env.MAX_EDGES_PER_TX || String(DEFAULT_MAX_EDGES_PER_TX);
  const maxEdges = Number(rawMaxEdges);
  if (!/^[1-9]\d*$/.test(rawMaxEdges) || !Number.isSafeInteger(maxEdges)) {
    throw new UsageError(`MAX_EDGES_PER_TX harus bilangan bulat > 0, diterima "${rawMaxEdges}"`);
  }
  return { readApiUrl, circle: env.X207_CIRCLE_ID || "agents-main", maxEdges };
}

const SUBMIT_VARS = ["NEAR_RPC_URL", "X207_CONTRACT_ID", "SOLVER_ACCOUNT_ID", "SOLVER_PRIVATE_KEY"] as const;

/**
 * `null` when no submit variable is set (the solver only prints the proposal). A partial set is a
 * configuration error: a half-configured solver must not look like one that chose not to submit.
 */
export function readSubmitConfig(env: NodeJS.ProcessEnv): SubmitConfig | null {
  const present = SUBMIT_VARS.filter((name) => env[name]);
  if (present.length === 0) return null;
  const missing = SUBMIT_VARS.filter((name) => !env[name]);
  if (missing.length > 0) throw new UsageError(`konfigurasi submit tidak lengkap, kurang: ${missing.join(", ")}`);
  const rawGas = env.SUBMIT_GAS_TGAS || "300";
  const gasTgas = Number(rawGas);
  if (!/^[1-9]\d*$/.test(rawGas) || gasTgas > 300) {
    throw new UsageError(`SUBMIT_GAS_TGAS harus bilangan bulat 1..300, diterima "${rawGas}"`);
  }
  const rawLane = env.SOLVER_GAS_KEY_NONCE_INDEX;
  let gasKeyNonceIndex: number | undefined;
  if (rawLane !== undefined && rawLane !== "") {
    gasKeyNonceIndex = Number(rawLane);
    if (!/^\d+$/.test(rawLane) || gasKeyNonceIndex > 1023) {
      throw new UsageError(`SOLVER_GAS_KEY_NONCE_INDEX harus bilangan bulat 0..1023, diterima "${rawLane}"`);
    }
  }
  return {
    ...(gasKeyNonceIndex === undefined ? {} : { gasKeyNonceIndex }),
    rpcUrl: env.NEAR_RPC_URL!,
    contractId: env.X207_CONTRACT_ID!,
    signerId: env.SOLVER_ACCOUNT_ID!,
    secretKey: env.SOLVER_PRIVATE_KEY!,
    gasTgas,
  };
}

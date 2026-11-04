// SV-018: random checks of finished jobs of pipeline P5. A small share of the DETERMINISTIC jobs is run again, the hash of the result is compared with the one that the
// provider gave, and the result is signed and sent to the read API (BE-053), where it enters the reputation of the provider and serves as evidence in a dispute.
//
// Which jobs are checked is decided by a secret seed, so that a provider cannot know in advance and cheat only on the jobs that are not looked at. A job whose rerun fails
// (the verifier could not run it, a timeout) is `inconclusive`: nothing is sent, because the failure is not the fault of the provider.
import { createHash } from "node:crypto";
import type { VoucherSecretKey } from "@x207/core";
import { jobHashOf, signSpotCheck, type SpotCheckNotice } from "./spot-check.js";

export interface JobRecord {
  /** the id that the provider gave the job */
  jobId: string;
  provider: string;
  /** only a deterministic job can be checked: the same input must give the same output */
  deterministic: boolean;
  /** what the verifier needs to run the job again; opaque here */
  input: unknown;
  /** sha256 (hex) of the result that the provider gave */
  resultHash: string;
}

export type CheckResult =
  | { jobId: string; provider: string; status: "passed" | "failed"; jobHash: string; expectedHash: string; gotHash: string; reported: "sent" | "already_recorded" }
  | { jobId: string; provider: string; status: "inconclusive"; reason: string }
  | { jobId: string; provider: string; status: "report_failed"; jobHash: string; reason: string };

export interface VerifierConfig {
  circle: string;
  verifier: string;
  secretKey: VoucherSecretKey;
  /** share of the eligible jobs to check, 0 to 1 */
  rate: number;
  /** secret: decides which jobs are checked; the same seed gives the same choice */
  seed: string;
  /** at most this many checks in one run (default: no limit) */
  maxPerRun?: number;
  /** `job_hash` values that already have a result: not checked twice */
  alreadyChecked?: ReadonlySet<string>;
}

export interface VerifierPorts {
  /** runs the job again and returns the sha256 (hex) of its result; throws when it cannot */
  rerun: (job: JobRecord) => Promise<string>;
  /** sends the notice to the read API; returns `recorded` or `duplicate`; throws on any other answer */
  report: (notice: SpotCheckNotice, signature: string) => Promise<"recorded" | "duplicate">;
  /** unix seconds */
  now: () => number;
}

/** Whether `job` is chosen: a number in [0, 1) derived from the seed and the job, below `rate`. Deterministic, not predictable without the seed. */
export function isChosen(seed: string, job: Pick<JobRecord, "provider" | "jobId">, rate: number): boolean {
  if (!(rate > 0)) return false;
  if (rate >= 1) return true;
  const digest = createHash("sha256").update(`${seed}\u0000${job.provider}\u0000${job.jobId}`).digest();
  const fraction = digest.readUInt32BE(0) / 0x1_0000_0000;
  return fraction < rate;
}

/** The jobs that would be checked, in the order given. */
export function chooseJobs(jobs: readonly JobRecord[], config: Pick<VerifierConfig, "rate" | "seed" | "maxPerRun" | "alreadyChecked" | "verifier">): JobRecord[] {
  if (!(config.rate >= 0 && config.rate <= 1)) throw new Error("rate must be between 0 and 1");
  const chosen = jobs.filter(
    (j) => j.deterministic && j.provider !== config.verifier && !config.alreadyChecked?.has(jobHashOf(j.provider, j.jobId)) && isChosen(config.seed, j, config.rate),
  );
  return config.maxPerRun === undefined ? chosen : chosen.slice(0, config.maxPerRun);
}

const HASH = /^[0-9a-f]{64}$/;

export async function runSpotChecks(jobs: readonly JobRecord[], config: VerifierConfig, ports: VerifierPorts): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const job of chooseJobs(jobs, config)) {
    if (!HASH.test(job.resultHash)) {
      results.push({ jobId: job.jobId, provider: job.provider, status: "inconclusive", reason: "resultHash of the provider is not a sha256" });
      continue;
    }
    let got: string;
    try {
      got = await ports.rerun(job);
    } catch (error) {
      results.push({ jobId: job.jobId, provider: job.provider, status: "inconclusive", reason: `rerun failed: ${(error as Error).message}` });
      continue;
    }
    if (!HASH.test(got)) {
      results.push({ jobId: job.jobId, provider: job.provider, status: "inconclusive", reason: "the rerun did not give a sha256" });
      continue;
    }
    const jobHash = jobHashOf(job.provider, job.jobId);
    const passed = got === job.resultHash;
    const notice: SpotCheckNotice = {
      circle: config.circle, subject: job.provider, verifier: config.verifier, job_hash: jobHash, passed, expected_hash: job.resultHash, got_hash: got, at: ports.now(),
    };
    try {
      const sent = await ports.report(notice, signSpotCheck(notice, config.secretKey));
      results.push({ jobId: job.jobId, provider: job.provider, status: passed ? "passed" : "failed", jobHash, expectedHash: job.resultHash, gotHash: got, reported: sent === "recorded" ? "sent" : "already_recorded" });
    } catch (error) {
      results.push({ jobId: job.jobId, provider: job.provider, status: "report_failed", jobHash, reason: (error as Error).message });
    }
  }
  return results;
}

/** Sends the notice to `POST /x207/circles/{circle}/reputation/spot-checks` of the read API. */
export function httpReporter(api: { readApiUrl: string; circle: string; fetch?: typeof fetch }): VerifierPorts["report"] {
  const doFetch = api.fetch ?? fetch;
  return async (notice, signature) => {
    const res = await doFetch(`${api.readApiUrl.replace(/\/$/, "")}/x207/circles/${api.circle}/reputation/spot-checks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notice, signature }),
    });
    if (res.status === 201) return "recorded";
    if (res.status === 409) return "duplicate";
    throw new Error(`read API answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  };
}

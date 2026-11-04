// SV-018: the signed result of a random check of a job, the format of BE-053 (`backend/src/marketplace/reputation.ts`; a test compares the two). Canonical JSON in the
// order `circle, subject, verifier, job_hash, passed, expected_hash, got_hash, at`, signed in the NEP-413 style with the voucher key of the verifier.
import { createHash } from "node:crypto";
import { nep413SigningHash, signHash, type VoucherSecretKey } from "@x207/core";

export interface SpotCheckNotice {
  circle: string;
  subject: string;
  verifier: string;
  job_hash: string;
  passed: boolean;
  expected_hash: string | null;
  got_hash: string | null;
  at: number;
}

const HASH = /^[0-9a-f]{64}$/;
const sha = (text: string): Uint8Array => createHash("sha256").update(text, "utf8").digest();

export function serializeSpotCheck(n: SpotCheckNotice): string {
  if (!HASH.test(n.job_hash)) throw new Error("job_hash must be 64 lowercase hex characters");
  if ((n.expected_hash === null) !== (n.got_hash === null)) throw new Error("expected_hash and got_hash are both set or both null");
  for (const h of [n.expected_hash, n.got_hash]) if (h !== null && !HASH.test(h)) throw new Error("expected_hash and got_hash must be 64 lowercase hex characters");
  if (n.passed && n.expected_hash !== null && n.expected_hash !== n.got_hash) throw new Error("passed true means the hashes match");
  if (!n.passed && n.expected_hash !== null && n.expected_hash === n.got_hash) throw new Error("passed false means the hashes differ");
  return JSON.stringify({ circle: n.circle, subject: n.subject, verifier: n.verifier, job_hash: n.job_hash, passed: n.passed, expected_hash: n.expected_hash, got_hash: n.got_hash, at: n.at });
}

export const spotCheckHash = (n: SpotCheckNotice): string => Buffer.from(sha(serializeSpotCheck(n))).toString("hex");
export const signSpotCheck = (n: SpotCheckNotice, secretKey: VoucherSecretKey): string =>
  signHash(nep413SigningHash(serializeSpotCheck(n), sha(serializeSpotCheck(n)), n.circle), secretKey);

/** The hash that names a job in a notice: the provider and the id that the provider gave the job. */
export const jobHashOf = (provider: string, jobId: string): string => Buffer.from(sha(`${provider}:${jobId}`)).toString("hex");

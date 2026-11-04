import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { generateVoucherKeypair, nep413SigningHash, verifyHash } from "@x207/core";
import { chooseJobs, httpReporter, isChosen, jobHashOf, runSpotChecks, serializeSpotCheck, signSpotCheck, spotCheckHash, type JobRecord, type SpotCheckNotice, type VerifierConfig, type VerifierPorts } from "../src/verifier/index.js";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const CIRCLE = "x207-circle.near";
const NOW = 1_793_000_000;
const keys = generateVoucherKeypair();
const config = (over: Partial<VerifierConfig> = {}): VerifierConfig => ({ circle: CIRCLE, verifier: "fina.x207-circle.near", secretKey: keys.secretKey, rate: 1, seed: "secret-seed", ...over });
/** A job of `provider` whose honest result is the sha256 of `input`. */
const job = (provider: string, id: string, over: Partial<JobRecord> = {}): JobRecord => ({ jobId: id, provider: `${provider}.x207-circle.near`, deterministic: true, input: id, resultHash: sha(id), ...over });
const ports = (over: Partial<VerifierPorts> = {}, sent: Array<{ notice: SpotCheckNotice; signature: string }> = []): VerifierPorts & { sent: typeof sent } => ({
  rerun: async (j) => sha(String(j.input)),
  report: async (notice, signature) => {
    sent.push({ notice, signature });
    return "recorded";
  },
  now: () => NOW,
  sent,
  ...over,
});

describe("SV-018 random checks of P5 jobs", () => {
  it("TC-SV-018-01 the choice is decided by the seed: the same every time, a share close to the rate, another seed another choice, rate 0 none and rate 1 all", () => {
    const jobs = Array.from({ length: 3000 }, (_, i) => job("andi", `j${i}`));
    const pick = (seed: string, rate: number) => jobs.filter((j) => isChosen(seed, j, rate)).map((j) => j.jobId);
    expect(pick("s1", 0.1)).toEqual(pick("s1", 0.1));
    const share = pick("s1", 0.1).length / jobs.length;
    expect(share).toBeGreaterThan(0.08);
    expect(share).toBeLessThan(0.12);
    expect(pick("s2", 0.1)).not.toEqual(pick("s1", 0.1));
    expect(pick("s1", 0)).toHaveLength(0);
    expect(pick("s1", 1)).toHaveLength(jobs.length);
    // a job that is chosen at a low rate is also chosen at a higher one
    const low = new Set(pick("s1", 0.05));
    for (const id of pick("s1", 0.2)) low.delete(id);
    expect(low.size).toBe(0);
  });

  it("TC-SV-018-02 only deterministic jobs of other accounts that have no result yet are eligible, up to maxPerRun", () => {
    const done = new Set([jobHashOf("andi.x207-circle.near", "j2")]);
    const jobs = [job("andi", "j1"), job("andi", "j2"), job("andi", "j3", { deterministic: false }), job("fina", "j4"), job("andi", "j5"), job("budi", "j6")];
    expect(chooseJobs(jobs, config({ alreadyChecked: done })).map((j) => j.jobId)).toEqual(["j1", "j5", "j6"]);
    expect(chooseJobs(jobs, config({ alreadyChecked: done, maxPerRun: 2 })).map((j) => j.jobId)).toEqual(["j1", "j5"]);
    expect(() => chooseJobs(jobs, config({ rate: 1.5 }))).toThrow(/rate/);
    expect(() => chooseJobs(jobs, config({ rate: -0.1 }))).toThrow(/rate/);
  });

  it("TC-SV-018-03 an honest result passes and a forged one is detected; both are signed and sent, with the hashes", async () => {
    const p = ports();
    const jobs = [job("andi", "ok"), job("andi", "forged", { resultHash: sha("something else") })];
    const results = await runSpotChecks(jobs, config(), p);
    expect(results.map((r) => [r.jobId, r.status])).toEqual([["ok", "passed"], ["forged", "failed"]]);
    expect(p.sent).toHaveLength(2);
    const bad = p.sent[1]!.notice;
    expect(bad).toMatchObject({ circle: CIRCLE, subject: "andi.x207-circle.near", verifier: "fina.x207-circle.near", passed: false, expected_hash: sha("something else"), got_hash: sha("forged"), at: NOW });
    expect(bad.job_hash).toBe(jobHashOf("andi.x207-circle.near", "forged"));
    for (const { notice, signature } of p.sent) {
      const json = serializeSpotCheck(notice);
      expect(verifyHash(nep413SigningHash(json, createHash("sha256").update(json).digest(), CIRCLE), signature, keys.publicKey)).toBe(true);
    }
  });

  it("TC-SV-018-04 a rerun that fails, or that gives no hash, is inconclusive and sends nothing: the failure is not the fault of the provider", async () => {
    const p = ports({ rerun: async (j) => { if (j.jobId === "boom") throw new Error("timeout"); return j.jobId === "junk" ? "not a hash" : sha(String(j.input)); } });
    const results = await runSpotChecks([job("andi", "boom"), job("andi", "junk"), job("andi", "bad-result", { resultHash: "nope" }), job("andi", "fine")], config(), p);
    expect(results.map((r) => [r.jobId, r.status])).toEqual([["boom", "inconclusive"], ["junk", "inconclusive"], ["bad-result", "inconclusive"], ["fine", "passed"]]);
    expect(results[0]).toMatchObject({ reason: expect.stringContaining("timeout") });
    expect(p.sent).toHaveLength(1);
  });

  it("TC-SV-018-05 a duplicate answer of the read API is not an error; any other answer is reported as report_failed and the run goes on", async () => {
    const p = ports({ report: async (n) => { if (n.job_hash === jobHashOf("andi.x207-circle.near", "dup")) return "duplicate"; if (n.job_hash === jobHashOf("andi.x207-circle.near", "down")) throw new Error("read API answered 503"); return "recorded"; } });
    const results = await runSpotChecks([job("andi", "dup"), job("andi", "down"), job("andi", "next")], config(), p);
    expect(results.map((r) => [r.jobId, r.status, "reported" in r ? r.reported : "reason" in r ? r.reason : ""])).toEqual([["dup", "passed", "already_recorded"], ["down", "report_failed", "read API answered 503"], ["next", "passed", "sent"]]);
  });

  it("TC-SV-018-06 the http reporter posts to the route of BE-053 and maps 201, 409 and the rest", async () => {
    const seen: Array<{ url: string; body: any }> = [];
    const answers = [201, 409, 401];
    const fetchFn = (async (url: string, init: { body: string }) => {
      seen.push({ url, body: JSON.parse(init.body) });
      return new Response("{}", { status: answers.shift() ?? 500 });
    }) as unknown as typeof fetch;
    const report = httpReporter({ readApiUrl: "http://api/", circle: "agents-main", fetch: fetchFn });
    const n: SpotCheckNotice = { circle: CIRCLE, subject: "a.near", verifier: "b.near", job_hash: "ab".repeat(32), passed: true, expected_hash: "cd".repeat(32), got_hash: "cd".repeat(32), at: NOW };
    expect(await report(n, "sig")).toBe("recorded");
    expect(await report(n, "sig")).toBe("duplicate");
    await expect(report(n, "sig")).rejects.toThrow(/401/);
    expect(seen[0]).toEqual({ url: "http://api/x207/circles/agents-main/reputation/spot-checks", body: { notice: n, signature: "sig" } });
  });

  it("TC-SV-018-07 golden vector: the notice is the same bytes as the one of the read API (BE-053), hash and signature", () => {
    const secret = `ed25519:${"3".repeat(88)}` as const;
    const n: SpotCheckNotice = { circle: "x207-circle.near", subject: "andi.x207-circle.near", verifier: "fina.x207-circle.near", job_hash: "ab".repeat(32), passed: false, expected_hash: "cd".repeat(32), got_hash: "ef".repeat(32), at: 1793000000 };
    expect(serializeSpotCheck(n)).toBe('{"circle":"x207-circle.near","subject":"andi.x207-circle.near","verifier":"fina.x207-circle.near","job_hash":"' + "ab".repeat(32) + '","passed":false,"expected_hash":"' + "cd".repeat(32) + '","got_hash":"' + "ef".repeat(32) + '","at":1793000000}');
    expect(spotCheckHash(n)).toBe("325958b0b59c669df4b8b3c51fa4645d3b01e7c788feffc7d0066bd5287a9501");
    expect(signSpotCheck(n, secret)).toBe("ed25519:4zFBUFgwfVuHexfymRiWs28WXZ49bZckfVDrw7Xuzr2CbpTXc8RV3A87gQnpMoKu1CNiVmEMpdyHc2RbNJqJbj9k");
  });

  it("TC-SV-018-08 a notice with hashes that disagree with passed is refused before it is signed", () => {
    const base: SpotCheckNotice = { circle: CIRCLE, subject: "a.near", verifier: "b.near", job_hash: "ab".repeat(32), passed: true, expected_hash: "cd".repeat(32), got_hash: "ef".repeat(32), at: NOW };
    expect(() => signSpotCheck(base, keys.secretKey)).toThrow(/hash sama/);
    expect(() => signSpotCheck({ ...base, passed: false, got_hash: "cd".repeat(32) }, keys.secretKey)).toThrow(/berbeda/);
    expect(() => signSpotCheck({ ...base, got_hash: null }, keys.secretKey)).toThrow(/both set or both null/);
    expect(() => signSpotCheck({ ...base, job_hash: "xyz" }, keys.secretKey)).toThrow(/job_hash/);
  });
});

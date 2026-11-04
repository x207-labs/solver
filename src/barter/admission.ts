import type { LoadBookOptions } from "./load.js";

export type SeekerAdmission = { ok: true; stake: bigint } | { ok: false; reason: "not_a_member" | "not_active" | "stake_too_low"; stake?: bigint; detail: string };

/**
 * SV-017: the seeker role is open to any party, but only an `active` member of the circle with a stake of at least
 * `minStake` base units may send offers. Read from the member endpoint of the read API (BE-004), which mirrors the
 * contract view `member`. A seeker that fails the check sends nothing.
 */
export async function checkSeekerAdmission(options: LoadBookOptions, seeker: string, minStake: bigint): Promise<SeekerAdmission> {
  const base = options.readApiUrl.replace(/\/+$/, "");
  const url = `${base}/x207/circles/${encodeURIComponent(options.circle)}/members/${encodeURIComponent(seeker)}`;
  const response = await (options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) });
  if (response.status === 404) return { ok: false, reason: "not_a_member", detail: `${seeker} is not a member of ${options.circle}` };
  if (!response.ok) throw new Error(`read API ${response.status} for ${url}`);
  const member = (await response.json()) as { status?: string; stake?: string };
  const stake = BigInt(member.stake ?? "0");
  if (member.status !== "active") return { ok: false, reason: "not_active", stake, detail: `${seeker} is ${member.status ?? "unknown"}, not active` };
  if (stake < minStake) return { ok: false, reason: "stake_too_low", stake, detail: `${seeker} has stake ${stake}, the seeker role needs ${minStake}` };
  return { ok: true, stake };
}

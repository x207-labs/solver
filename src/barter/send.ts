import { signReferral, type BundleTerms, type Referral, type VoucherSecretKey } from "@x207/core";
import type { SeekerOffer } from "./seeker.js";

export interface BookApi {
  readApiUrl: string;
  /** Circle id in the path. */
  circle: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface Reply {
  status: number;
  body: any;
}

async function request(api: BookApi, method: "GET" | "POST", path: string, body?: unknown): Promise<Reply> {
  const url = `${api.readApiUrl.replace(/\/+$/, "")}/x207/circles/${encodeURIComponent(api.circle)}${path}`;
  const response = await (api.fetch ?? fetch)(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(api.timeoutMs ?? 10_000),
  });
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

export interface ProposalView {
  termsHash: string;
  status: "proposed" | "ready";
  epoch: number;
  terms: BundleTerms;
  participants: string[];
  signatures: { account: string; signature: string }[];
  missing: string[];
}

/**
 * SV-011: puts a bundle proposal into the book (`POST …/bundle-proposals`, 201 new, 200 when the same `terms_hash` is
 * already there). The server recomputes `terms_hash`; the participants then sign it through their agents.
 */
export async function postBundleProposal(api: BookApi, terms: BundleTerms, termsHash: string): Promise<{ created: boolean; proposal: ProposalView }> {
  const reply = await request(api, "POST", "/bundle-proposals", { terms, termsHash });
  if (reply.status !== 201 && reply.status !== 200) throw new Error(`bundle-proposals ${reply.status}: ${reply.body?.error?.code ?? "tanpa kode"}`);
  return { created: reply.status === 201, proposal: reply.body as ProposalView };
}

/** Proposals whose participants have all signed (`status=ready`) for `epoch`. */
export async function readyProposals(api: BookApi, epoch: number): Promise<ProposalView[]> {
  const reply = await request(api, "GET", "/bundle-proposals?status=ready");
  if (reply.status !== 200) throw new Error(`bundle-proposals ${reply.status}`);
  return (reply.body.items as ProposalView[]).filter((p) => p.epoch === epoch);
}

/** Arguments of `commit_bundle` for a ready proposal: the legs and one signature per participant. */
export function commitBundleArgs(p: ProposalView): { bundle: { epoch: number; legs: BundleTerms["legs"]; search_leg?: NonNullable<BundleTerms["search_leg"]> }; signatures: { account_id: string; signature: string }[] } {
  if (p.status !== "ready" || p.missing.length > 0) throw new Error(`usulan ${p.termsHash} belum lengkap tanda tangannya`);
  return { bundle: { epoch: p.epoch, legs: p.terms.legs, ...(p.terms.search_leg ? { search_leg: p.terms.search_leg } : {}) }, signatures: p.signatures.map((s) => ({ account_id: s.account, signature: s.signature })) };
}

export interface ReferralConfig {
  /** Account of the seeker; its voucher key signs. */
  seeker: string;
  secretKey: VoucherSecretKey;
  /** Contract account (the `circle` of the signed objects). */
  circle: string;
  now: number;
  /** Seconds the referral stays in the inbox. */
  ttlSeconds: number;
  searcherShareBps: number;
  deliverIn?: number;
}

/** `Referral` of a prepared offer (SV-015). `nonce` is `r<now>-<index>`, unique per run and offer. */
export function referralOf(offer: SeekerOffer, index: number, config: ReferralConfig): Referral {
  return {
    circle: config.circle,
    seeker: config.seeker,
    to: offer.to,
    listing_hash: offer.listingHash,
    mode: offer.offer.mode,
    value: offer.offer.value,
    quantity: offer.offer.quantity,
    deliver_by: offer.offer.deliver_by,
    searcher_share_bps: config.searcherShareBps,
    expires_at: config.now + config.ttlSeconds,
    nonce: `r${config.now}-${index}`,
  };
}

export type ReferralOutcome = { to: string; listingHash: string; status: "sent" | "refused" | "rejected"; code?: string };

/**
 * Signs each prepared offer as a referral and posts it to the inbox of the target agent (`POST …/referrals`). `refused`
 * (409 `referral_refused`) means the agent refused this pair before: the caller must remember it so it is not offered again.
 */
export async function sendReferrals(api: BookApi, offers: readonly SeekerOffer[], config: ReferralConfig): Promise<ReferralOutcome[]> {
  const out: ReferralOutcome[] = [];
  for (const [index, offer] of offers.entries()) {
    const referral = referralOf(offer, index, config);
    const reply = await request(api, "POST", "/referrals", { referral, signature: signReferral(referral, config.secretKey) });
    const code = reply.body?.error?.code as string | undefined;
    if (reply.status === 201 || reply.status === 200) out.push({ to: offer.to, listingHash: offer.listingHash, status: "sent" });
    else if (reply.status === 409 && code === "referral_refused") out.push({ to: offer.to, listingHash: offer.listingHash, status: "refused", code });
    else out.push({ to: offer.to, listingHash: offer.listingHash, status: "rejected", ...(code ? { code } : {}) });
  }
  return out;
}

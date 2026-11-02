import { bundleFullySigned, bundleParticipants, verifyBundleSignature, type BundleSignature, type BundleTerms } from "@x207/core";

/** Asks `account` to sign `terms` (its agent signs `terms_hash` with its voucher key); `null` means no answer or a refusal. */
export type SignatureRequester = (account: string, terms: BundleTerms) => Promise<BundleSignature | null>;

export interface CollectedBundle {
  terms: BundleTerms;
  signatures: BundleSignature[];
}

/**
 * Sends the proposal to every participant and gathers the signatures over its `terms_hash` (SV-011, F5). A bundle
 * goes out only when every participant has one valid signature; otherwise the result is `null` and nothing is sent to
 * the contract. `pubkeys` maps each account to its voucher key (`pubkey_voucher` in the read API).
 */
export async function collectBundleSignatures(
  terms: BundleTerms,
  pubkeys: Readonly<Record<string, string>>,
  ask: SignatureRequester,
): Promise<CollectedBundle | null> {
  const participants = bundleParticipants(terms);
  const answers = await Promise.all(
    participants.map(async (account) => {
      try {
        return await ask(account, terms);
      } catch {
        return null;
      }
    }),
  );
  const signatures: BundleSignature[] = [];
  participants.forEach((account, i) => {
    const answer = answers[i];
    const pubkey = pubkeys[account];
    if (answer && answer.account === account && pubkey !== undefined && verifyBundleSignature(terms, answer.signature, pubkey)) signatures.push(answer);
  });
  return bundleFullySigned(terms, signatures, pubkeys) ? { terms, signatures } : null;
}

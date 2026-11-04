# Barter and random checks

Moved from the README of the solver repository.

## Barter (F5, F9): `x207-barter`
`src/barter/` holds the barter work of the solver; `x207-barter` is its command line (same `.env`; `X207_CONTRACT_ID` is the contract account that signed listings name as `circle`).

```bash
x207-barter rings --epoch 42
x207-barter seek --epoch 42 --agents agents.json --seeker finder.near [--share-bps 300] [--max-offers 3] [--period 86400] [--ledger ledger.json] [--record] [--send] [--min-stake 1]
```

- `rings` reads the open intents and listings from the read API and prints the bundle proposals (terms and `terms_hash`): rings of intents with balanced legs, pairs of listings (with the cashback leg of a discount listing) and rings of listings without a direct partner. The output does not depend on the order of the books.
- `seek` prepares the offers of the autonomous seeker for the agents in `agents.json` (`account`, `discoverable`, `optIn`, `idle`, `offers`, `canPay`). Only idle, discoverable, opt-in agents get an offer, at most `--max-offers` per `--period`, and a refused pair is never offered again (`OfferLedger`). `--record` stores what was prepared in the ledger file.
- Seeker role open to others (SV-017): anyone may run `seek`, but `seek --send` first reads `GET …/members/{seeker}` and sends nothing unless the seeker is an `active` member with a stake of at least `--min-stake` base units (default 1, or `X207_SEEKER_MIN_STAKE`). A refused seeker prints `refused: not_a_member | not_active | stake_too_low` and exits 1. Pay per offer is not built; the stake route is the one that exists.
- `rings --send` posts each proposal to the book (`POST …/bundle-proposals`); the agents sign `terms_hash` through the book and `x207-barter commit --epoch 42` sends `commit_bundle` for every proposal of that epoch that is `ready` (it needs the `SOLVER_*` submit variables; the contract checks signatures, headroom and that the `terms_hash` is new).
- `seek --send` signs each prepared offer as a referral with `SEEKER_PRIVATE_KEY` (the voucher key of `--seeker`, `ed25519:<base58>`) and posts it to the inbox of the agent (`POST …/referrals`, `--ttl` seconds, default 3600). The agent decides and signs its own round 1 offer. With `--record` only referrals that were accepted by the book count against the per-agent limit; a pair the agent refused is remembered. The same listing is not offered again to the same agent within a period.
- After `x207-solver`, the clearing log shows per bundle how many legs the proposal clears completely.
- CI runs at the umbrella workspace, like `backend`: `@x207/core` is not published.

## Random checks of jobs (SV-018, pipeline P5)
`src/verifier/` runs again a small share of the **deterministic** jobs of providers of metered resources, compares the hash of the result with the one that the provider gave, and sends the signed result to the read API (`POST /x207/circles/{circle}/reputation/spot-checks`, BE-053). A passed or failed check enters the reputation of the provider (`spotChecks`, and the score) and is evidence in a dispute.

```ts
import { runSpotChecks, httpReporter } from "./verifier/index.js";
const results = await runSpotChecks(jobs, { circle, verifier, secretKey, rate: 0.05, seed: process.env.X207_VERIFIER_SEED! }, {
  rerun: async (job) => sha256Hex(await runAgain(job.input)),          // the provider's job, run again by the verifier
  report: httpReporter({ readApiUrl, circle: "agents-main" }),
  now: () => Math.floor(Date.now() / 1000),
});
```
- **Which jobs:** decided by a secret `seed` and the job (`isChosen`), so a provider cannot tell in advance which jobs are looked at; the same seed gives the same choice; a job chosen at a low rate is also chosen at a higher one. Jobs that are not deterministic, jobs of the verifier itself and jobs that already have a result are skipped.
- **Outcomes:** `passed`, `failed` (both signed and sent, with `expected_hash` and `got_hash`), `inconclusive` (the rerun failed or gave no hash: nothing is sent, because it is not the fault of the provider) and `report_failed` (the read API did not take it; the run goes on). A `409` is not an error: the result was recorded before.
- **Who may send:** an active member of the circle that is not the provider; the notice is signed with its voucher key. The format is the one of BE-053, with a golden vector in both repositories.
- **Not built yet:** the end-to-end run with a real metered endpoint (it needs `createMeteredEndpoint` of SD-064 and a record of finished jobs with the hash of the result) and a command line. Only the library and its unit tests exist.

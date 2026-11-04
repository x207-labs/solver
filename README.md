# x207 solver (M4, F3, F5)

Clearing solver for the x207 mutual credit layer on NEAR. It reads the obligation graph of a closed epoch, computes the optimal **cycle-only** clearing (MTCS, ADR-03) with min-cost flow, and prints a proposal in the exact shape of `submit_clearing(epoch, edges)`, and submits it to the contract when it beats the stored one.

Part of [x207](https://github.com/x207-labs/x207). Anyone can run a solver: the contract verifies every proposal on-chain, so a solver needs no trust (see the Trust section once SV-008 lands).

> **Status:** SV-001 to SV-006 are done. Without the submit variables the CLI only prints the proposal; with them it simulates, then sends `submit_clearing`.

## Requirements
- Node.js >= 22.22.2, npm
- A reachable x207 read API (indexer, `backend` repo) that serves `GET /x207/circles/{circle}/epochs/{n}/obligations?stage=cutoff`
- To submit: a NEAR RPC endpoint, the circle contract id, and a NEAR account with a full access or function call key for the contract. The account needs a few hundredths of a NEAR for gas; it needs no USDT and no membership (submitting is permissionless).

## Install and test
```bash
npm ci
npm test
```

## Configure
Copy `.env.example` to `.env` (the CLI loads `.env` from the working directory).

| Variable | Required | Meaning |
| --- | --- | --- |
| `X207_READ_API_URL` | yes | Read API base URL, without `/x207` |
| `X207_CIRCLE_ID` | no | Circle id, default `agents-main` |
| `MAX_EDGES_PER_TX` | no | Edge limit of one proposal, default `300` (spec 3.6, K-44) |
| `NEAR_RPC_URL` | to submit | NEAR JSON-RPC endpoint. `simulate_clearing` and the transaction go here, never to the backend |
| `X207_CONTRACT_ID` | to submit | Account of the circle contract |
| `SOLVER_ACCOUNT_ID` | to submit | Account that signs `submit_clearing` |
| `SOLVER_PRIVATE_KEY` | to submit | `ed25519:<base58>` secret key of that account. Keep it in `.env`; the solver never prints it |
| `SOLVER_GAS_KEY_NONCE_INDEX` | no | Set when `SOLVER_PRIVATE_KEY` is a gas key (NEP-611, ADR-11b): the nonce lane to use, 0 to 1023. The transaction is then `Transaction::V1` and gas is paid from the key's balance, so several solver processes can submit at once on different lanes. Create and fund the key with `near account add-key ... grant-gas-key-full-access` and `fund-gas-key` |
| `SUBMIT_GAS_TGAS` | no | Gas attached to `submit_clearing`, 1 to 300, default `60` (SV-020). The barter command uses it too when it is set; otherwise `x207-barter` attaches 150 Tgas to `commit_bundle` (79 Tgas for 64 legs) |

Set all four submit variables or none. A partial set stops the run with exit code 1 and names what is missing.

## Run
```bash
npm run build
node dist/cli.js --epoch 42
```
Add `--no-submit` to print the proposal and send nothing even when the submit variables are set.
The proposal goes to stdout as JSON: `{"epoch":42,"edges":[{"debtor":"…","creditor":"…","cleared":"30000000"}]}`. Logs go to stderr.

| Exit code | Meaning |
| --- | --- |
| 0 | Proposal printed or submitted, nothing to clear, the proposal window is already closed, a stored proposal is at least as good, or the solver lost the race (`ERR_PROPOSAL_NOT_BETTER`, `ERR_PROPOSAL_WINDOW_CLOSED`). None of these is retried |
| 1 | Bad arguments or config, read API or RPC error, snapshot that fails validation, epoch not in the `clearing` phase, or a proposal the contract simulation rejects. Nothing is submitted |

## What it does
1. Loads the `cutoff` snapshot and checks it against its own `edgeCount` and `totalObligation`. Any mismatch, duplicate pair, self edge or malformed amount stops the run. Amounts are `BigInt`, never floats.
2. Computes net positions `b_i` and NID, routes NID as min-cost flow from net debtors to net creditors, and sets `cleared = obligation - flow`. Only edges with `cleared > 0` are emitted, sorted by `(debtor, creditor)`.
3. If the optimum has more than `MAX_EDGES_PER_TX` edges, it splits the result into cycles and keeps whole cycles by largest value (K-44).
4. Checks the proposal locally with the contract's rules and error codes before anything else would run.
5. Submits (SV-006): reads `get_epoch` (phase must be `clearing`; `commit` means the window closed), calls the view `simulate_clearing(epoch, edges)`, and sends `submit_clearing` only when the simulation is valid and `better_than_current` is true. The log shows the simulation before the transaction hash, and the stored proposal that was replaced. Views read the latest block, so a proposal that landed seconds ago is seen.

Run it inside the proposal window (10 minutes by default, `proposal_window`). Anyone can submit; the largest valid proposal wins when the window closes and `commit_epoch` applies it.

The result is deterministic: ties between equally good routes are broken with a seed from the first 8 bytes of `sha256("<circleId>:<epoch>")` (K-43), so two runs on the same snapshot print identical bytes.

## Trust
You do not have to trust a solver. `x207-circle` checks every proposal in `O(n)` before it stores it (ADR-01, ADR-03), and two invariants are enough:
1. **No edge clears more than is owed.** For every edge, `cleared <= obligation` of the epoch snapshot; an edge that is not in the snapshot, a duplicate edge or a zero edge is refused (`ERR_CLEARED_EXCEEDS_OBLIGATION`, `ERR_EDGE_NOT_IN_SNAPSHOT`, `ERR_DUPLICATE_EDGE`, `ERR_ZERO_CLEARED`).
2. **Every member clears as much as it receives.** For every member, the sum of `cleared` on edges where it is the debtor equals the sum where it is the creditor (`ERR_UNBALANCED_MEMBER`). A proposal made only of cycles satisfies this, and it leaves every net position unchanged.

Anyone may submit (`submit_clearing` is permissionless). The contract keeps the valid proposal with the largest `cleared_total`, with a deterministic tie-break, and `commit_epoch` applies it after the window (ADR-21). A solver can therefore only propose a smaller clearing than the best one, never a harmful one: it cannot move a net position, create credit or touch stake. Its fee, when enabled, is a fixed share of the value it cleared.

Compare NEAR Intents: there the user signs an intent for each swap or accepts a solver quote per trade. Here a member agrees once, when it joins, to cycle clearing under these two rules, because a cycle never changes who owes what to whom outside the cycle. The contract, not the member and not the solver, enforces the rules.

## Gas
`submit_clearing` burns 2.5 Tgas for 3 edges, 3.4 for 12 and 5.2 for 30 (near-sandbox, `contracts/tests/ct043_gas.rs`), 28 Tgas for 210 edges on testnet (CT-100, `docs/testnet-0.0.13.json`) and about 33 for 300 (`contracts/docs/gas.md`). The default attached gas is **60 Tgas** (SV-020). Unused gas is refunded, but a transaction **reserves** its prepaid gas times the gas price from the balance of the signer while it runs: 250 Tgas reserve 0.25 NEAR, 60 Tgas reserve 0.06 NEAR (testnet price). On testnet a solver with 0.24 NEAR could not send 250 Tgas and the proposal window passed (CT-100, run 1). Before it signs, the solver reads the balance and the gas price and stops with `saldo ... kurang dari ... yang dicadangkan` if the balance is short; a gas key pays from its own balance and is not checked.

## IDs
Module M4, features F3 and F5 (F5 is roadmap). Backlog: SV-001 to SV-009. Spec: Spec API Backend 3.3, Spec Antarmuka Kontrak 3.6 and 4.3.

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

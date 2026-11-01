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
| `SUBMIT_GAS_TGAS` | no | Gas attached to `submit_clearing`, 1 to 300, default `300` |

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

## Gas
`submit_clearing` burns 2.5 Tgas for 3 edges, 3.4 for 12 and 5.2 for 30 (near-sandbox, `contracts/tests/ct043_gas.rs`). The default attached gas is 300 Tgas, the most one transaction can carry; unused gas is refunded.

## IDs
Module M4, features F3 and F5 (F5 is roadmap). Backlog: SV-001 to SV-009. Spec: Spec API Backend 3.3, Spec Antarmuka Kontrak 3.6 and 4.3.

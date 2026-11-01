# x207 solver (M4, F3)

Clearing solver for the x207 mutual credit layer on NEAR. It reads the obligation graph of a closed epoch, computes the optimal **cycle-only** clearing (MTCS, ADR-03) with min-cost flow, and prints a proposal in the exact shape of `submit_clearing(epoch, edges)`.

Part of [x207](https://github.com/x207-protocol/x207). Anyone can run a solver: the contract verifies every proposal on-chain, so a solver needs no trust (see the Trust section once SV-008 lands).

> **Status:** SV-001 to SV-005 are done. **Submitting to the contract (SV-006) is not implemented yet.** The CLI computes and prints the proposal; it does not call `simulate_clearing` or `submit_clearing`. This README is partial until SV-006 lands, so the end-to-end steps against a sandbox cannot be followed yet.

## Requirements
- Node.js >= 22.22.2, npm
- A reachable x207 read API (indexer, `backend` repo) that serves `GET /x207/circles/{circle}/epochs/{n}/obligations?stage=cutoff`

## Install and test
```bash
npm ci
npm test
```

## Configure
Copy `.env.example` to `.env` (the CLI loads `.env` from the working directory).

| Variable | Used now | Meaning |
| --- | --- | --- |
| `X207_READ_API_URL` | yes, required | Read API base URL, without `/x207` |
| `X207_CIRCLE_ID` | yes | Circle id, default `agents-main` |
| `MAX_EDGES_PER_TX` | yes | Edge limit of one proposal, default `300` (spec 3.6, K-44) |
| `NEAR_RPC_URL`, `X207_CONTRACT_ID`, `SOLVER_ACCOUNT_ID`, `SOLVER_PRIVATE_KEY` | not yet | Needed by SV-006 |

## Run
```bash
npm run build
node dist/cli.js --epoch 42
```
The proposal goes to stdout as JSON: `{"epoch":42,"edges":[{"debtor":"…","creditor":"…","cleared":"30000000"}]}`. Logs go to stderr.

| Exit code | Meaning |
| --- | --- |
| 0 | Proposal printed, or nothing to clear (empty snapshot, or no cycles) |
| 1 | Bad arguments or config, read API error, or snapshot that fails validation. Nothing is produced |

## What it does
1. Loads the `cutoff` snapshot and checks it against its own `edgeCount` and `totalObligation`. Any mismatch, duplicate pair, self edge or malformed amount stops the run. Amounts are `BigInt`, never floats.
2. Computes net positions `b_i` and NID, routes NID as min-cost flow from net debtors to net creditors, and sets `cleared = obligation - flow`. Only edges with `cleared > 0` are emitted, sorted by `(debtor, creditor)`.
3. If the optimum has more than `MAX_EDGES_PER_TX` edges, it splits the result into cycles and keeps whole cycles by largest value (K-44).
4. Checks the proposal locally with the contract's rules and error codes before anything else would run.

The result is deterministic: ties between equally good routes are broken with a seed from the first 8 bytes of `sha256("<circleId>:<epoch>")` (K-43), so two runs on the same snapshot print identical bytes.

## Gas
Not applicable until SV-006. Spike Ronde 4 measured about 0.34 Tgas per edge in `submit_clearing`, so a 300-edge proposal is about 100 Tgas.

## IDs
Module M4, feature F3. Backlog: SV-001 to SV-009. Spec: Spec API Backend 3.3, Spec Antarmuka Kontrak 3.6 and 4.3.

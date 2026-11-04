# x207 solver

The open clearing solver of [x207](https://github.com/x207-labs/x207), and its barter matching (`x207-barter`).

## Its role in x207

At the end of an epoch the debts in a credit circle are frozen. The solver reads that obligation graph from the [read API](https://github.com/x207-labs/backend), computes the largest **cycle-only** clearing with min-cost flow, and prints it in the exact shape of `submit_clearing(epoch, edges)` of the [contract](https://github.com/x207-labs/contracts). With the submit variables set it simulates first and sends only a proposal that beats the stored one.

**You do not have to trust a solver, and anyone can run one.** The contract checks every proposal in `O(n)` and keeps the valid one with the largest `cleared_total`. Two invariants are enough: no edge clears more than is owed, and every member clears as much as it receives. A cycle-only proposal satisfies both and leaves every net position unchanged, so a bad solver can only propose a smaller clearing, never move a net position, create credit or touch stake. Details and the error codes: [docs/gas-and-trust.md](docs/gas-and-trust.md).

## Try it: reproduce epoch 8 from the live API

Read-only, no key and no NEAR account. `--no-submit` prints the proposal and sends nothing.

```bash
npm ci && npm run build
X207_READ_API_URL=https://x207-backend-production.up.railway.app node dist/cli.js --epoch 8 --no-submit
```

On 2026-11-04 the log ends with 24 edges, total `41350000`, and a proposal of 18 edges with `cleared_total 21800000`: 21.8 of the 41.35 credit of epoch 8, the same figure the contract committed on testnet. The proposal is deterministic (ties are broken by a seed from `sha256("<circleId>:<epoch>")`), so two runs on one snapshot print identical bytes. Logs go to stderr and the JSON proposal to stdout.

## Test

```bash
npm ci
npm test
```

The performance benchmark is in [docs/benchmark.md](docs/benchmark.md) (`npm run bench`). The contract repository runs this solver against the real contract in `tests/sv006_solver_cli.rs`.

## Run it for real

Needs Node ≥ 22.22.2 and a reachable read API. To submit you also need a NEAR RPC endpoint, the circle contract id and an account key; the account needs a few hundredths of a NEAR for gas, no USDT and no membership (submitting is permissionless). Copy `.env.example` to `.env`.

| Variable | Required | Meaning |
| --- | --- | --- |
| `X207_READ_API_URL` | yes | Read API base URL, without `/x207` |
| `X207_CIRCLE_ID` | no | Circle id, default `agents-main` |
| `MAX_EDGES_PER_TX` | no | Edge limit of one proposal, default `300` |
| `NEAR_RPC_URL`, `X207_CONTRACT_ID`, `SOLVER_ACCOUNT_ID`, `SOLVER_PRIVATE_KEY` | to submit | Set all four or none. The key is `ed25519:<base58>`, kept in `.env`, never printed |
| `SOLVER_GAS_KEY_NONCE_INDEX` | no | Use when the key is a gas key (NEP-611): the nonce lane, 0 to 1023 |
| `SUBMIT_GAS_TGAS` | no | Gas attached to `submit_clearing`, 1 to 300, default `60` |

```bash
node dist/cli.js --epoch 42
```

Run it inside the proposal window (10 minutes by default). Exit code 0: proposal printed or submitted, nothing to clear, window closed, or a stored proposal is at least as good (none of these is retried). Exit code 1: bad arguments or config, read API or RPC error, a snapshot that fails validation, an epoch not in the `clearing` phase, or a proposal the simulation rejects; nothing is submitted.

What it does, in order: loads the `cutoff` snapshot and validates it (amounts are `BigInt`); computes net positions and routes the net debt as min-cost flow; keeps whole cycles by value if the result exceeds `MAX_EDGES_PER_TX`; checks the proposal locally with the contract's rules; reads `get_epoch`, calls the view `simulate_clearing`, and sends `submit_clearing` only when the simulation is valid and `better_than_current` is true. A transaction reserves 0.001 NEAR per Tgas of prepaid gas, and the solver stops before signing if the balance is short ([docs/gas-and-trust.md](docs/gas-and-trust.md)).

## Barter and random checks

`x207-barter` proposes bundles of listings and intents (`rings`), prepares offers of the autonomous seeker (`seek`) and sends `commit_bundle` (`commit`). `src/verifier/` reruns a small share of deterministic jobs of metered providers and reports the result to the read API. This is a library and unit tests only; there is no end-to-end run with a real metered endpoint. Commands, rules and outcomes: [docs/barter-and-spot-checks.md](docs/barter-and-spot-checks.md).

## Back to x207

Overview, live demo links and the claims map: [x207-labs/x207](https://github.com/x207-labs/x207).

## License

Apache-2.0

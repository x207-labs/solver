# Solver benchmark on dense and star shaped circles (SV-019)

Status: measured on 2026-11-03 on the machine of the build (Node 22, one core), with a fixed seed. The graphs are synthetic: **no real payment graph was measured**, and none of these numbers says what a real circle will clear. They say what the solver does with a graph of a given shape, and where the limits of the protocol bite.

## How to repeat it
```bash
cd solver && npm run build && node bench/benchmark.mjs --repeat 5
node bench/benchmark.mjs --json > benchmark.json   # the same rows as JSON
```
The graphs come from a seeded generator (`mulberry32`), so every column except the time is the same on every run. `ms` is the median of the runs of `solveClearing` with no cut of the edges.

## What the columns mean
- **obligations**: pairs (debtor, creditor) with a debt above 0 (the edges of D2).
- **cycles, longest cycle**: the cycles of the unpruned optimum (`decomposeCycles`); a cycle is one bundle in the barter path (F5).
- **cycles of at most 64 legs**: how many of them fit a bundle (the contract takes at most 64 legs per `commit_bundle`).
- **edges of the solution**: edges with `cleared > 0`; `submit_clearing` takes at most `DEFAULT_MAX_EDGES_PER_TX` = 300 (K-44).
- **cleared, % of the debt**: `cleared_total / total obligation`, measured by value (UM-015).
- **% of the ceiling**: `cleared_total / (total obligation - nid)`, where nid is the net imbalance, the part of the debt that no clearing can remove if the graph could be rerouted freely. The ceiling is only reached when the graph has the cycles for it; a star never reaches it.
- **after the 300 edge cut**: the share cleared when the solution is cut to 300 edges by dropping whole cycles (`selectCycles`).

### Random graphs, 20 to 200 members, four densities

| case | members | obligations | ms | cycles | longest cycle | cycles of at most 64 legs | edges of the solution | cleared, % of the debt | % of the ceiling | % of the debt after the 300 edge cut |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| random n=20 p=0.02 | 10 | 6 | 0.1 | 0 | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 |
| random n=20 p=0.05 | 15 | 17 | 0.2 | 1 | 4 | 1 | 4 | 22.1 | 58.4 | 22.1 |
| random n=20 p=0.1 | 20 | 53 | 0.5 | 18 | 9 | 18 | 36 | 48.3 | 70.6 | 48.3 |
| random n=20 p=0.3 | 20 | 114 | 0.6 | 69 | 12 | 69 | 101 | 82.5 | 96.6 | 82.5 |
| random n=50 p=0.02 | 38 | 45 | 0.4 | 0 | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 |
| random n=50 p=0.05 | 50 | 143 | 1.5 | 38 | 21 | 38 | 86 | 41.0 | 64.9 | 41.0 |
| random n=50 p=0.1 | 50 | 238 | 2.5 | 97 | 22 | 97 | 176 | 61.0 | 88.2 | 61.0 |
| random n=50 p=0.3 | 50 | 732 | 9.2 | 359 | 19 | 359 | 651 | 84.0 | 98.2 | 44.3 |
| random n=100 p=0.02 | 97 | 202 | 3.9 | 33 | 23 | 33 | 98 | 25.4 | 46.0 | 25.4 |
| random n=100 p=0.05 | 100 | 486 | 10.0 | 162 | 30 | 162 | 339 | 57.4 | 82.9 | 53.5 |
| random n=100 p=0.1 | 100 | 963 | 20.7 | 366 | 37 | 366 | 768 | 72.0 | 92.5 | 30.2 |
| random n=100 p=0.3 | 100 | 2909 | 89.2 | 1138 | 31 | 1138 | 2699 | 90.6 | 99.9 | 14.7 |
| random n=200 p=0.02 | 200 | 832 | 31.3 | 241 | 40 | 241 | 609 | 56.2 | 81.5 | 27.9 |
| random n=200 p=0.05 | 200 | 1978 | 91.9 | 630 | 48 | 630 | 1688 | 79.2 | 95.7 | 13.5 |
| random n=200 p=0.1 | 200 | 3925 | 213.5 | 1243 | 45 | 1243 | 3522 | 85.3 | 99.6 | 9.7 |
| random n=200 p=0.3 | 200 | 12130 | 901.8 | 3721 | 54 | 3721 | 11400 | 92.4 | 100.0 | 3.8 |

### One hub and its leaves (every leaf owes the hub; the hub pays back a share of the leaves)

| case | members | obligations | ms | cycles | longest cycle | cycles of at most 64 legs | edges of the solution | cleared, % of the debt | % of the ceiling | % of the debt after the 300 edge cut |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| star n=20 hub pays back 0% of leaves | 20 | 19 | 0.1 | 0 | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 |
| star n=20 hub pays back 20% of leaves | 20 | 25 | 0.1 | 6 | 2 | 6 | 12 | 15.0 | 52.7 | 15.0 |
| star n=20 hub pays back 50% of leaves | 20 | 31 | 0.1 | 12 | 2 | 12 | 24 | 39.5 | 62.8 | 39.5 |
| star n=20 hub pays back 100% of leaves | 20 | 38 | 0.1 | 19 | 2 | 19 | 38 | 48.9 | 67.2 | 48.9 |
| star n=50 hub pays back 0% of leaves | 50 | 49 | 0.2 | 0 | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 |
| star n=50 hub pays back 20% of leaves | 50 | 59 | 0.3 | 10 | 2 | 10 | 20 | 16.5 | 79.0 | 16.5 |
| star n=50 hub pays back 50% of leaves | 50 | 67 | 0.3 | 18 | 2 | 18 | 36 | 40.6 | 85.5 | 40.6 |
| star n=50 hub pays back 100% of leaves | 50 | 98 | 0.5 | 49 | 2 | 49 | 98 | 65.9 | 79.9 | 65.9 |
| star n=100 hub pays back 0% of leaves | 100 | 99 | 0.7 | 0 | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 |
| star n=100 hub pays back 20% of leaves | 100 | 113 | 0.8 | 14 | 2 | 14 | 28 | 14.7 | 78.3 | 14.7 |
| star n=100 hub pays back 50% of leaves | 100 | 150 | 1.0 | 51 | 2 | 51 | 102 | 43.9 | 75.1 | 43.9 |
| star n=100 hub pays back 100% of leaves | 100 | 198 | 1.4 | 99 | 2 | 99 | 198 | 65.6 | 80.1 | 65.6 |
| star n=200 hub pays back 0% of leaves | 200 | 199 | 2.3 | 0 | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 |
| star n=200 hub pays back 20% of leaves | 200 | 250 | 3.0 | 51 | 2 | 51 | 102 | 27.0 | 83.2 | 27.0 |
| star n=200 hub pays back 50% of leaves | 200 | 293 | 3.6 | 94 | 2 | 94 | 188 | 47.7 | 82.8 | 47.7 |
| star n=200 hub pays back 100% of leaves | 200 | 398 | 5.0 | 199 | 2 | 199 | 398 | 65.9 | 80.9 | 62.7 |

### Several hubs (leaves pay one or two hubs, hubs owe each other and some leaves)

| case | members | obligations | ms | cycles | longest cycle | cycles of at most 64 legs | edges of the solution | cleared, % of the debt | % of the ceiling | % of the debt after the 300 edge cut |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 3 hubs n=50 | 50 | 76 | 0.5 | 8 | 6 | 8 | 17 | 13.3 | 37.9 | 13.3 |
| 8 hubs n=50 | 50 | 93 | 0.6 | 22 | 9 | 22 | 35 | 24.0 | 59.4 | 24.0 |
| 3 hubs n=200 | 200 | 332 | 5.4 | 61 | 6 | 61 | 118 | 28.1 | 86.8 | 28.1 |
| 8 hubs n=200 | 200 | 390 | 7.5 | 80 | 12 | 80 | 157 | 30.8 | 77.6 | 30.8 |

### A ring with chords

| case | members | obligations | ms | cycles | longest cycle | cycles of at most 64 legs | edges of the solution | cleared, % of the debt | % of the ceiling | % of the debt after the 300 edge cut |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ring n=20 plus 20 chords | 20 | 36 | 0.2 | 8 | 16 | 8 | 27 | 43.3 | 67.2 | 43.3 |
| ring n=100 plus 100 chords | 100 | 197 | 4.3 | 37 | 36 | 37 | 128 | 34.1 | 51.2 | 34.1 |
| ring n=200 plus 200 chords | 200 | 398 | 15.4 | 73 | 62 | 73 | 295 | 37.1 | 59.0 | 37.1 |

## What the numbers say

1. **Time is not the limit.** Up to 100 members the solver answers in under 100 ms in every shape; 200 members take 2 to 5 ms for a star, about 210 ms at 10 percent density and about 0.9 s at 30 percent density (12,000 obligations, far above what a circle of 200 agents will hold). The proposal window of the contract is 60 seconds in the tests and longer in production.
2. **The 300 edge limit is the real limit on a dense circle.** Cleared share falls from 92.4 percent to 3.8 percent for the random graph of 200 members at 30 percent density, because the optimum has 11,400 edges and a transaction takes 300. Density of 5 percent at 200 members (1,688 edges) already loses most of it (79.2 to 13.5 percent). There is no loss where the optimum has at most 300 edges. The optimum is always found; what is lost is what one transaction can carry. A larger `MAX_EDGES_PER_TX` is not free (the gas of `submit_clearing` and `commit_epoch` grows with the edges, see `contracts/docs/gas.md`).
3. **Cycles are short in a star and long in a dense graph.** All cycles of a star have 2 legs. In the random graphs the longest cycle has 4 to 54 legs and in the ring of 200 members 62, always within the 64 legs of a bundle in these runs (62 is close), so the barter path (F5) can carry every cycle that the solver finds here; it was not tested with a cycle longer than 64.
4. **A star clears nothing unless the hub is also a debtor.** With every leaf owing the hub and the hub owing nobody, the solver finds no cycle: 0 percent cleared, at any size. When the hub owes a share of the leaves, only the 2-cycles hub-leaf can be removed: 15 to 27 percent of the debt at a share of 20 percent, 40 to 48 percent at 50 percent, about 66 percent when the hub owes every leaf (49 percent at 20 members). What is left is the difference between what the leaf owes and what it is owed. Clearing in a star is therefore a netting of the two-way flows of each pair, and it exists only where flows go both ways.
5. **Several hubs help a little.** With 3 or 8 hubs the leaves still owe the hubs and the hubs owe each other, so cycles run through the hubs: 13 to 31 percent of the debt cleared in these runs, longest cycle 6 to 12 legs.

## On the claim of the concept notes about star shaped payment graphs
The notes (`x207 - Konteks Proyek`, ADR-16) say that real payment graphs are star shaped (many buyers, few sellers; reference arXiv 2607.12575, Gini above 0.98), so natural cycles are rare, and they plan for it with a dense closed circle in the demo and the metric "cleared ratio" next to the density of the graph. **This benchmark supports the consequence, not the premise**: it shows that a star with one-way flows clears 0 percent and that reciprocity is what clearing needs. It does not measure any real graph, and it cannot confirm that real graphs are stars. The honest reading for the README is: x207 helps where agents trade with each other in both directions (a closed circle, a market of services that also buy), it does nothing for a pure many-buyers-one-seller flow, and the demo circle is dense on purpose. The same section of the notes asks to show the density next to the cleared ratio; the columns `members`, `obligations` and `cleared, % of the debt` give the pairs of numbers to quote.

## When clearing helps, in one table
| Shape of the circle | Cleared share of the debt in these runs | Why |
| --- | --- | --- |
| Pure star, one-way flows | 0 | no cycle exists |
| Star, the hub pays back some leaves | 15 to 66 | only 2-cycles through the hub, as many as there are two-way pairs |
| A few hubs that also trade with each other | 13 to 31 | cycles through the hubs |
| Random, 5 to 10 percent density | 41 to 85 | many cycles of 4 to 50 legs |
| Random, 30 percent density | 82 to 92 | almost every obligation sits on a cycle; the 300 edge cut is the limit above about 50 members |
| Ring with chords | 34 to 43 | one long cycle plus the chords |

## Scale: 50, 200 and 1000 members (SV-021)

`npm run bench:solver` (from the root or from `solver/`) builds the solver, runs random graphs of 50, 200 and 1000 members at densities 0.01, 0.05, 0.1, 0.25 and 0.5 (density = share of the ordered pairs that owe something), and rewrites the tables below. Each case runs in its own process.

<!-- sv021:start -->
Measured by `npm run bench:solver`. Machine: Apple M5, 10 cores, 16 GiB, darwin arm64 (25.5.0). Node v26.11.1. Solver `@x207/solver@0.0.1` at commit `193eb90`. Seed 20261104 (graph seed = seed + 7 n + 1000 p), 3 runs per case (median; a case slower than 5 s runs once), a case is stopped after 120 s. Account names of 22 characters for the time; the byte sizes are given for 22 and for 64 characters (the longest NEAR name). Amounts are 1 to 1000 credit, spread evenly on a log scale.

#### Time and cleared share (no cut of the edges)

| members | density | obligations | solver time, ms | cleared, % of the debt | % of the ceiling | edges of the optimum | cycles | longest cycle |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 50 | 0.01 | 17 | 0.1 | 0.0 | 0.0 | 0 | 0 | 0 |
| 50 | 0.05 | 104 | 1.7 | 6.2 | 18.2 | 45 | 19 | 18 |
| 50 | 0.1 | 243 | 2.0 | 25.8 | 51.2 | 150 | 101 | 23 |
| 50 | 0.25 | 647 | 7.0 | 60.1 | 85.7 | 485 | 345 | 22 |
| 50 | 0.5 | 1,207 | 12 | 73.9 | 95.2 | 1,011 | 683 | 22 |
| 200 | 0.01 | 405 | 9.0 | 2.4 | 6.6 | 160 | 50 | 32 |
| 200 | 0.05 | 2,016 | 59 | 51.6 | 82.0 | 1,454 | 795 | 48 |
| 200 | 0.1 | 3,877 | 126 | 71.0 | 92.8 | 3,110 | 1,529 | 46 |
| 200 | 0.25 | 9,878 | 744 | 83.5 | 98.4 | 8,603 | 3,633 | 54 |
| 200 | 0.5 | 19,923 | 1524 | 89.8 | 99.9 | 18,411 | 7,292 | 49 |
| 1000 | 0.01 | 9,914 | 1978 | 53.1 | 79.5 | 7,102 | 2,840 | 108 |
| 1000 | 0.05 | 50,023 | 19606 (one run) | 84.1 | 98.7 | 43,769 | 10,643 | 124 |
| 1000 | 0.1 | 100,477 | 47318 (one run) | 89.7 | 99.8 | 92,041 | 20,563 | 133 |
| 1000 | 0.25 | about 249,750 | **stopped after 120 s** | | | | | |
| 1000 | 0.5 | about 499,500 | **stopped after 120 s** | | | | | |

#### Edges against the limits (300 edges per transaction, 16 KiB per log message)

Epochs: the contract takes ONE proposal per epoch (`submit_clearing`, at most 300 edges); what it clears comes off the debts and the next epoch solves the rest. "Cleared by epoch k" is the cumulative share of the original debt, each proposal cut to whole cycles of at most 300 edges (`selectCycles`).

| members | density | edges of the optimum | proposals of at most 300 edges (epochs) to clear it all | cleared by epoch 1 | by epoch 2 | by epoch 3 | by epoch 6 | optimum as JSON, 22 character names, KiB | 64 character names, KiB | edges that fit 16 KiB (22 / 64 characters) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 50 | 0.01 | 0 | 0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | - |
| 50 | 0.05 | 45 | 1 | 6.2 | 6.2 | 6.2 | 6.2 | 4.1 | 7.7 | 177 / 92 |
| 50 | 0.1 | 150 | 1 | 25.8 | 25.8 | 25.8 | 25.8 | 13.6 | 25.9 | 176 / 92 |
| 50 | 0.25 | 485 | 3 | 57.9 | 59.9 | 60.1 | 60.1 | 44.0 | 83.8 | 176 / 92 |
| 50 | 0.5 | 1,011 | more than 6 | 53.0 | 64.7 | 69.4 | 73.3 | 91.8 | 174.7 | 176 / 92 |
| 200 | 0.01 | 160 | 1 | 2.4 | 2.4 | 2.4 | 2.4 | 14.4 | 27.5 | 177 / 92 |
| 200 | 0.05 | 1,454 | more than 6 | 21.9 | 31.1 | 37.6 | 46.3 | 132.0 | 251.2 | 176 / 92 |
| 200 | 0.1 | 3,110 | more than 6 | 17.4 | 28.8 | 36.1 | 50.6 | 282.4 | 537.5 | 176 / 92 |
| 200 | 0.25 | 8,603 | more than 6 | 9.8 | 18.3 | 25.0 | 40.5 | 781.1 | 1486.8 | 176 / 92 |
| 200 | 0.5 | 18,411 | more than 6 | 6.3 | 11.6 | 16.6 | 29.9 | 1672.0 | 3182.3 | 176 / 92 |
| 1000 | 0.01 | 7,102 | more than 6 | 3.3 | 5.9 | 8.6 | 15.6 | 644.6 | 1227.2 | 176 / 92 |
| 1000 | 0.05 | 43,769 | more than 6 | 1.9 | 3.7 | 5.6 | 10.9 | 3975.2 | 7565.6 | 176 / 92 |
| 1000 | 0.1 | 92,041 | **rounds not finished in 120 s** | | | | | 8358.7 | 15908.9 | 176 / 92 |
<!-- sv021:end -->

### What the scale numbers say

- **Where clearing has to be split.** One proposal holds at most 300 edges (`MAX_EDGES_PER_TX`), so a clearing must be split into epochs as soon as the optimum has more than 300 edges. In this benchmark that is from 50 members at density 0.25 (485 edges, 3 epochs) and from 200 members at density 0.05 (1,454 edges). Below it (50 members up to density 0.1, 200 members at 0.01) the whole optimum goes in one proposal. The count of epochs grows with the edges: at 200 members and density 0.05 six epochs clear 46.3% of the debt, against 82.0% that the optimum would clear in one go (the optimum is not reachable under the limit, only approached).
- **The 16 KiB log limit comes first.** Written as JSON, one edge takes about 93 bytes with 22 character names and about 175 bytes with 64 character names, so 176 edges (22 characters) or 92 edges (64 characters) fill one 16 KiB log message, well before 300. That is why the `clearing_applied` event has a fixed size since CT-099 and does not carry the edges; the edges are read with `get_proposal` / `list_obligations`. A design that logged the edges would have to be split at 92 edges.
- **Solver time.** It is fast for what the contract can hold: 12 ms or less at 50 members for every density, 1.5 s at 200 members with half of all pairs in debt (19,923 obligations). It grows steeply with the obligations: 2.0 s for about 10,000 obligations, 19.6 s for 50,000 and 47 s for 100,000 (1000 members); densities 0.25 and 0.5 at 1000 members (250,000 and 500,000 obligations) did not finish one solve in 120 s. Between 10,000 and 100,000 obligations the time grows by about 24 times for 10 times the obligations (exponent near 1.4); no tuning of the min-cost-flow in `solveClearing` was done for this.
- **Memory** was not a limit in these runs (each case ran with a heap of 8 GiB).

## Limits of this benchmark

- **The contract is smaller than the benchmark.** `MAX_MEMBERS` is 64 and one `submit_clearing` is accepted per epoch, so 200 and 1000 members cannot be cleared by the deployed contract; those rows measure the solver alone, and the epochs column says how many epochs the same debts would need if the member limit were lifted. For a circle of up to 64 members the whole range of the first rows (50 members) applies: at most 12 ms of solver time, and at most 3 epochs when the density is 0.25.
- Random graphs with amounts 1 to 1000 credit on a log scale are not real traffic; real circles are likely to be sparser and to have more structure (hubs, rings). The cleared shares move with that, the times move with the number of obligations.
- One machine, one seed (`--seed` changes it), one run for the slow cases; the times are indicative to about 10%. The epochs after the first are computed with the same solver on the rest of the debt, without new obligations arriving between epochs.
- A case is stopped after 120 s (`--timeout`); a stopped case says nothing about its cleared share.

## Other limits of the earlier benchmark (SV-019)
Synthetic graphs with amounts of 1 to 1000 credit drawn evenly; real amounts are skewed. One seed per case. Time on one machine, in a warm process, without the network or the read API. The solver of the contract path (`submit_clearing` gas for 300 edges) is measured in `contracts/tests/ct043_gas.rs` and in `contracts/docs/gas.md`, not here.

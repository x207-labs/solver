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

## Limits of this benchmark
Synthetic graphs with amounts of 1 to 1000 credit drawn evenly; real amounts are skewed. One seed per case. Time on one machine, in a warm process, without the network or the read API. The solver of the contract path (`submit_clearing` gas for 300 edges) is measured in `contracts/tests/ct043_gas.rs` and in `contracts/docs/gas.md`, not here.

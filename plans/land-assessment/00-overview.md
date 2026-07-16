# Commit-Addressed Land Assessment

STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural

## Outcome
- Every land attempt — including rejections — leaves an immutable, commit-addressed, authority-tagged evidence record.
- Two deterministic analyzers (git topology; syntactic TS structural-delta) proven by offline replay against glance's own land history before the land path is touched.
- A replay report honest enough to kill the wedge cheaply if the signal isn't there — the state engine's go/no-go evidence.

## Work
| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| [01 schema + identity](01-schema-and-identity.md) | Frozen v0 shapes; capture-now refs; attempt/assessment/result identity | architectural | src/land-assessment/{schema,id}.ts |
| [02 taxonomy + manifest](02-taxonomy-and-manifest.md) | Written incident→claim mapping BEFORE building; pinned commits; per-class n | research | replay/{incident-taxonomy.ts,incident-manifest.json} |
| [03 topology analyzer](03-topology-analyzer.md) | The classes with real labeled incidents; go/no-go producer | architectural | analyzers/{plugin,topology}.ts |
| [04 structural-delta analyzer](04-structural-delta-analyzer.md) | First structural module — syntactic, honest claims | architectural | analyzers/typescript-structural-delta.ts |
| [05 replay corpus](05-replay-corpus.md) | (B,M,C) triples from 3 sources + synthetic pairs | architectural | replay/{corpus,synthesize}.ts |
| [06 replay CLI + report](06-replay-cli-and-report.md) | The offline driver, strict-with-accounting reader, honest metrics | architectural | replay/{run,report}.ts, store-reader.ts, cli.ts, src/index.ts |
| [07 event store writer](07-event-store-writer.md) | Append-only, tear-proof, off-hot-path durable store | architectural | store.ts |
| [08 observe-only land hook](08-observe-only-land-hook.md) | Phase 2: live wiring, every rejection recorded, zero decision influence | architectural | hook.ts, squad-manager.ts, land.ts, land-pr.ts |
| [09 validator experiment](09-validator-input-experiment.md) | Phase 3: cost delta + human-rated disagreement study | research (hitl) | replay/validator-experiment.ts |

## Order
| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01, 02 | Schema freeze + manifest archaeology; disjoint files; 02 needs only 01's class/ref shapes |
| 2 | 03, 04, 07 | All depend only on 01; disjoint TOUCHES; pure libraries |
| 3 | 05, 06 | Corpus feeds the CLI; 06 also needs 03/04 done |
| 4 | 08 | Live wiring after everything it runs exists |
| 5 | 09 | Needs the report machinery and (for fresh events) the hook |

## Dependency graph
| Concern | Blocked by | 30s check |
|---|---|---|
| 01 | — | — |
| 02 | 01 | schema.ts exports taxonomy-compatible finding/ref types (`grep claimedBy src/land-assessment/`) |
| 03 | 01 | schema.ts + plugin contract exist (`ls src/land-assessment/schema.ts`) |
| 04 | 01 | same |
| 05 | 01, 02 | manifest loads (`bun test .../manifest.test.ts`) |
| 06 | 03, 04, 05 | analyzers + corpus tests green (`bun test src/land-assessment/`) |
| 07 | 01 | schema.ts exists |
| 08 | 03, 04, 07 | store stress test green (`bun test .../store.test.ts`) |
| 09 | 06, 08 | replay CLI runs (`bun src/index.ts land-assessment replay --help`) |

## Not yet specified
- (none — later-phase items are in Out of scope with triggers)

## Out of scope
- Advisory warnings / any enforcement (BRIEF §10.11 Phases 4–5) — expands only on the replay report's evidence, Lars's call.
- Dashboard/web projection — only after replay shows useful signal (review §10.6).
- Criterion-level oracle for the validator decision — becomes a new concern only if 09's disagreement study warrants it.
- Store retention policy — deferred; append-only growth is not urgent at current land volume.
- `ts.resolveModuleName` escalation for dependency edges — only if replay shows real misses from path-arithmetic resolution.
- ACP context parity (OMPSQ-446) and DoneProof reachability (OMPSQ-447) — split out as separate issues per the independent review; not this plan's scope.

## Decisions so far
- [DESIGN.md](DESIGN.md) — syntactic analysis over checkouts+createProgram; topology promoted to Phase 1; attemptId minted once with durable counter; single-writer CRC store with strict-with-accounting reader; fingerprint captured post-commitWip under the land lock.

## Notes
- Headless run (research→plan pipeline off `glance_architecture_mandate.md`): EXPLORE/DESIGN/DECOMPOSE gates auto-approved per skill gate policy; adversarial round = sonnet designer + two opus red teams (fable 529-overloaded at spawn time) + fable arbitration inline.
- Phase-0 WIP snapshot: proceeded over 13 plans with open work (41 open concerns); forcing function fires at the next interactive /plan.
- EXECUTE not started — headless default. Open choice for Lars: execute now in parallel with daily-driver wave 1 (batches 1–3 are pure new-file library work, fleet-dispatchable, zero daily-driver TOUCHES overlap) or park until the adoption gate. Filing to Plane via /plan-to-plane also pending that call.
- Assessed-state honesty (schema doc rule): the assessed tree is C — never the merge/rebase result that lands; single-daemon checkout ownership is an integrity assumption.

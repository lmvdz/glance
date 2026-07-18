# ADR: Commit-Addressed Land Assessment (NORMATIVE — current decision only)

Status: accepted 2026-07-16 (three review rounds; decision history lives in `plans/research-glance-architecture-mandate/BRIEF.md`, which is superseded as a contract by this file + SCHEMA-V0.md). No superseded requirements appear here.

## Context

Glance's land pipeline is layered and fail-closed but semantically blind above file-path overlap (`land.ts:873` documents its own "semantic-merge ceiling"); its ~40 stores share no authority model, no stable identity, and no commit-addressed reconstruction outside `proof.ts`; rejected lands leave no structured evidence. The long-term thesis is an evidence-backed temporal model of repository truth; landing is the first boundary because it supplies exact temporal coordinates (B, M, C, R) and a definite outcome per attempt.

## Decision

Introduce a commit-addressed **Land Assessment envelope** at the existing landing boundary. Persist **append-only** evidence for every landing attempt, including rejected and invalidated attempts. Implement a deterministic **TypeScript structural-delta analyzer** (syntax-only v0) and a **git topology analyzer** as the first assessment modules. Validate coverage, latency, and incident-class precision through **offline historical replay** before integrating with the validator, any dashboard, advisory surfaces, or enforcement.

**The Commit-Addressed Land Assessment is the first temporal-state producer, not the Repository State Engine itself.** Each assessment module must preserve normalized observations, exact repository validity, observation time, authority, provenance, and extraction coverage in a form that can later be projected into repository, execution, planning, evidence, and episodic state. Accepted landings may update accepted repository state only via independent observation of the landed result R; rejected or invalidated attempts remain historical experience and must not be promoted to repository truth.

Record semantics are defined solely by `SCHEMA-V0.md`: three identities (attemptId / eventId / assessmentKey), exact-state addressing over the Git DAG (validity intervals are lineage projections, never primitives), observations separate from findings, four orthogonal knowledge axes, environment fingerprints, multidimensional coverage, manifest+checkpoint reconstruction with continuity detection.

## Phase gates

```text
Phase 0  taxonomy + labeled manifest + schema v0 + normative docs (this file)
Phase 1  pure analyzer libraries + offline replay CLI — zero land-path integration
Gate:    executable state-projection contract tests pass on a synthetic timeline
         (litmus queries answerable) BEFORE any live integration
Phase 2  append-only store + observe-only land hook + invalidation lifecycle
Phase 3  reports; replay-only validator-input experiment (cost + human-rated
         disagreements; not decision-grade without a criterion oracle)
Gate:    a SECOND producer (verification execution) writes the same contracts
         without schema redesign BEFORE land assessments may feed any
         enforcement input
Phase 4+ advisory, then narrow enforcement — separate future decisions, each
         requiring replay-measured precision and Lars's sign-off
```

## Alternatives considered

Criterion-evidence graph first (weaker evaluability); collision detection first (same computation, worse evaluation point); full multi-graph state engine (the "impressive but operationally weak" failure mode); worktree checkouts + ts.createProgram (rejected — in-repo `dead-exports.ts` precedent; every claimed detection class is syntactic); linear validFrom/UntilCommit intervals (rejected — Git is a DAG; intervals are projections); one combined event/assessment record (rejected — lifecycle identity and content identity conflict).

## Consequences

A new `src/land-assessment/` subsystem (schema, store, analyzers, replay, hook); the temporal-assertion idiom enters the codebase with one producer and contract-tested projections; rejected lands finally accumulate structured learning signal; validator input can later become structured; the store grows without retention (deferred decision).

### Integrity assumption: single-daemon checkout ownership (and its Phase-2 prerequisites)

The store and the attempt-id counter assume ONE writer process per `stateDir` — the assessed tree is the single daemon's own checkout (`C`, never the merge/rebase result `R`). Within that assumption the in-process mutex (store) and read-increment-rename (counter) are sufficient, and the cross-lineage review (grok + gpt-5.6, 2026-07-17) confirmed the in-process CRC, tear-proofing, corrupt-counter throw, and synthetic-vs-real recall separation all hold. The review also confirmed the assumption is the ONLY thing standing between Phase 1 and a set of real multi-writer defects. **Before concern 08 wires the hook onto the live land path, these become hard prerequisites** (each is bounded today because Phase 1 has no live writer and callers pass validated input):

- **Multi-process safety**: if a second process can ever write one `stateDir` (CLI + daemon, or two daemons), `mintAttemptId` needs a file lock / compare-and-swap (two writers can mint the same id) and store appends need `flock` (multi-KB O_APPEND can interleave; `nextSeq` can be re-primed across processes). Otherwise the ADR must state single-writer as an *enforced* invariant, not a hope.
- **Never-throw on the hot path**: `append*`'s shard-key derivation and priming must move inside the catch so a malformed record resolves `"write-failed"` and NEVER throws into a land; and `mintAttemptId`'s rename must fsync + reject counters ≥ `Number.MAX_SAFE_INTEGER`.
- **Reader accounting completeness**: the strict reader must additionally count interior blank lines, unreadable shards, schema-invalid-but-CRC-valid records, and adjacent-`seq` gaps as diagnostics (today it accounts only CRC/JSON-shape), and reconstruction must preserve — not last-wins-collapse — the dual snapshots a nondeterminism append deliberately keeps.
- **Report honesty**: unscorable labeled positives (unresolvable refs / context gaps) must enter the recall denominator as unscorable rather than silently shrinking `n` (a `6/6=100%` that hides three gaps); and the two `should-not-flag` clean-relanding negatives are mis-constructed — their recorded candidate SHAs are not ancestors of any main, so `orphaned-merge` fires and the negatives read 100% FP. Fixing needs correct re-land SHAs or the `candidate===base`+later-main construction `run.test.ts` documents — NOT merely unpinning `mainCommit` (verified: unpinning does not silence them).

## Non-goals

V1 will not construct the complete repository knowledge graph, **but its data contracts must not prevent historical reconstruction, accumulation of semantic deltas, or the addition of non-landing producers.** No graph database. No research-ingestion product. No RL routing. No full stable-identity solver (qualified name + rename evidence, uncertainty represented). No advisory or enforcement behavior. No dashboard in the first slice. No criterion-impact inference (refs only).

## Drift checklist (standing)

The ten danger signs from BRIEF §11.5 — scalar-scores-only, overwrite-instead-of-supersede, no exact commit validity, rejected attempts discarded, observations mixed with conclusions, unresolvable string refs, no historical reconstruction, landing-only forever, createdAt-as-temporality, fewer-bad-merges as the only metric — any one tripped means the work is drifting from this decision.

## Revisit conditions

Replay precision/recall below usefulness on claimed classes; syntax-only extraction coverage < ~90% of changed TS files on the dogfood repo; per-land latency budget exceeded; the second-producer gate failing (schema redesign required); the daily-driver adoption gate redirecting capacity (plan parks cleanly — decomposed, not half-built).

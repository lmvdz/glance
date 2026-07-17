# Design: Commit-Addressed Land Assessment (Phases 0–3)

Provenance: research + adopted reviews in `plans/research-glance-architecture-mandate/BRIEF.md` (§10–§12 = decision history). Adversarial design round 2026-07-16: sonnet designer draft, two independent red-team critiques (correctness/concurrency lens; scope/evaluability lens), fable arbitration; third review adopted same day (schema-precision corrections).

**Normative contracts live in [ADR.md](ADR.md) and [SCHEMA-V0.md](SCHEMA-V0.md)** — this file is design rationale; where it disagrees with those two, they win. Repo inspected at df4b89c.

## Approach

An assessment **envelope** at the existing land boundary. Every land attempt — including rejected ones — appends immutable, commit-addressed `LandAssessmentEvent` records to a per-repo JSONL store. Analyses are pluggable modules inside the envelope; the first slice ships **two** offline-replayable analyzers: **topology** (git ancestry/lineage — the class with all the real labeled incidents) and **TypeScript structural-delta** (syntactic, per-file AST — no type checker, no program, no checkouts). Everything is proven by offline replay against glance's own land history before the land path is touched, and the hook, when it arrives in Phase 2, is observe-only by construction: it never feeds a land decision.

## Key Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Delta computation | Syntactic: `git show <commit>:<path>` streamed into `ts.createSourceFile` per changed file | Three detached worktree checkouts + `ts.createProgram` (designer's draft); `git cat-file` + custom CompilerHost | Every claimed detection class is syntactic; the checker only buys non-claimed classes. In-repo precedent (`scripts/dead-exports.ts`) documents the same rejection. Kills checkout latency, node_modules staleness/mutation, composite-tsconfig fidelity, and the worktree cache in one move |
| Analyzer sequencing | Topology + structural-delta together in Phase 1 | Structural-delta alone first (draft) | All real labeled incidents are topology/workflow class; structural-delta alone would validate only against synthetic pairs generated with the same TS API it detects with (circular). Go/no-go evidence keys on topology's real-incident precision; structural-delta's synthetic-only evidence is labeled as such |
| First-slice analyzer set | topology, typescript-structural-delta only | + proof-freshness, regression "thin wrappers" (draft) | Regression would need hundreds of historical full-suite runs; proof-freshness needs a live Proof record that history didn't persist. Both become record-time wrappers in Phase 2, `not-evaluated` until then |
| Attempt identity | `attemptId` minted once in `land()` from (resolved repo, branch, candidateCommit, durable monotonic counter); `autoLandWorkflow` threads it, never mints | Per-emission minting; agentId-derived | No attempt object exists in the codebase today; `autoLandWorkflow` calls `land()`, so naive dual instrumentation double-emits; retries must be distinct, restarts must not collide |
| Fingerprint capture | Candidate commit/tree captured after `commitWip`, `mainCommit` read under `withRepoLandLock`; schema states the assessed tree is C, never the merge/rebase result | Capture at land() entry (draft) | Draft captured pre-`commitWip`, out-of-lock state — a fingerprint of a tree that never lands, racing concurrent merges |
| Store | Per-repo, month-sharded, append-only JSONL via a single-writer in-process mutex; per-line CRC; async writes off the land hot path, no fsync on the land thread | jsonl-log ring (clobbers history); best-effort unserialized appends (draft) | Concurrent multi-KB O_APPEND writes tear; WSL2 fsync spikes must never stall lands; append-only is the mandate |
| Replay reader | Strict-with-accounting: malformed lines skipped AND counted; any count > 0 marks the report INCOMPLETE and exits non-zero; total order = lexical filename sort + line index; reconstruction via supersedes DAG, never `createdAt` | Throw on first bad line (draft) | One torn line must not brick the store's only consumer; silent skipping must not fake completeness either |
| Identity of results | `assessmentId` = input hash per BRIEF §10.2, plus a separate `resultHash` over canonicalized findings; duplicate (assessmentId, resultHash) writes dedup-drop; extractor output is deterministically sorted | Input hash alone (draft) | Input-addressed ids with a nondeterministic extractor would yield same-id/different-findings records that `supersedes` can never reference |
| Object availability | Temp refs `refs/land-assessment/<attemptId>/<sha>` pin subjects before any background analysis; unreachable object = explicit coverage gap | Rely on reachability (draft) | `attemptAutoResolve` rebases rewrite the branch; gc/branch-delete prune the pre-rebase commit mid-analysis |
| Replay corpus | Three sources: merge-commit parents, `gh pr list` oids (verified available), and the main-proof/done-proof ledgers for fast-forward local lands | Two sources (draft) | FF local lands are invisible to both draft sources; the labeled composition-drift incidents include local lands |
| Phase-3 experiment | Cost delta + human-rated sample of raw-diff-vs-structured disagreements; explicitly NOT decision-grade for validator integration without a criterion-level oracle | "Compare judge agreement" (draft) | Agreement between two input conditions has no ground truth; the honest claim is cost + a qualitative study |

## Temporal-knowledge guardrail (second review, adopted — BRIEF §11)

This subsystem is the **first temporal-state producer, not the Repository State Engine itself**. Contract requirements that keep it so:

- Analyzers persist normalized **StructuralObservations** (subject, predicate, before/after, observedInCommit, deterministic authority, evidence) separately from derived findings; observations are the durable raw material, findings are re-derivable interpretations.
- **Bitemporal fields** on everything durable: valid time (`validFromCommit`/`validUntilCommit`) distinct from observation time (`observedAt`/`supersededAt`), plus `producer {name, version}`. `createdAt` is never the temporal model.
- **Attempted truth ≠ accepted truth**: records carry an epistemic state category (`observed | proposed | accepted | rejected`); assessments over C are *proposed*; only a `landed` terminal promotes toward accepted state; rejected attempts remain episodic history, never repository truth.
- Non-goal: v1 builds no knowledge graph, but its data contracts must not prevent historical reconstruction, semantic-delta accumulation, or non-landing producers joining later.
- Litmus (after several hundred assessments): the data must answer "interface of X at commit A / what changed A→B / which landing introduced this dependency / which rejected attempts touched the same concept / what did glance believe and what was superseded" — not merely "was this landing risky." BRIEF §11.5's ten danger signs are the standing drift checklist.

## Risks

- **Structural-delta has ~0 real labeled positives** — its Phase-1 recall evidence is synthetic and partially circular. Mitigation: labeled as such in the report; wedge go/no-go keys on topology.
- **Per-class recall on n<3 incidents is anecdote, not measurement.** Mitigation: report per-class *n* beside every recall figure; manifest pins exact commits per incident, including the later-main commit at which "should-block-eventually" detection is expected.
- **Rejected-attempt history is systematically thin** (deleted branches unrecoverable); stated in the report, corrected going forward by the store itself.
- **Syntactic module-dependency edges are approximate** (relative specifiers resolved by path; package specifiers opaque). Escalation to `ts.resolveModuleName` only if replay shows real misses.
- **Daemon crash mid-attempt** leaves terminal-less attempts; classified `incomplete`, excluded from metric denominators.

## Red Team Concerns Addressed

| Concern | Severity | Resolution |
|---|---|---|
| createProgram/worktrees over-built; in-repo precedent contradicts | critical | Adopted syntactic approach (decision 1) |
| Only-built analyzer is the only one the corpus can't validate | critical | Topology promoted into Phase 1; go/no-go re-keyed (decision 2) |
| No stable attemptId; dual instrumentation double-emits | critical | Durable-counter minting in land(), threaded to autoLandWorkflow (decision 4) |
| Torn concurrent appends + strict reader bricks replay | critical | Single-writer mutex + CRC + strict-with-accounting reader (decisions 6–7) |
| Fingerprint captures pre-commitWip, out-of-lock state | critical | Capture points moved (decision 5) |
| proof-freshness/regression wrappers need Phase-2 context | significant | Cut from slice 1 (decision 3) |
| assessmentId hashes inputs, not results | significant | resultHash + determinism + dedup rule (decision 8) |
| Rebase/gc prunes subject before background analysis | significant | Temp-ref pinning (decision 9) |
| Sync fsync on land hot path under WSL2 spikes | significant | SHA capture sync; durable writes fully off-path (decision 6) |
| Cross-file event ordering undefined; createdAt untrustworthy | significant | Lexical-file + line-index order; supersedes DAG (decision 7) |
| Metrics not computable as framed (n, budget K, "eventually") | significant | Manifest spec hardened (Risks; concern 02) |
| Phase-3 experiment lacks oracle | significant | Re-scoped claim (decision 12) |
| Early returns before proofGate emit nothing | minor | attempt-started moved before all early returns; four reason codes added |
| FF local lands invisible to replay | minor | Third corpus source (decision 11) |
| Land-lock key not path-normalized; single-daemon assumption | minor | Assessment uses path.resolve identity; assumption documented in schema concern |

## Open Questions

None blocking — all red-team criticals resolved above. Execution timing (now in parallel vs after the daily-driver adoption gate) is Lars's standing call and outside this design.

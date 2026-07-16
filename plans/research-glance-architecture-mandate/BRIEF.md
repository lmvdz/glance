# Research Brief: Glance Architecture Mandate — the next architectural wedge

## Provenance

- **Date**: 2026-07-16
- **Question**: which single wedge should glance build next — is a semantic land assessment (or another narrow slice of a temporal Repository State Engine) the strongest move, judged against the actual codebase and the project's standing bottleneck?
- **Sources**:
  - `glance_architecture_mandate.md` (repo root, v1.0, 2026-07-16) — the mandate under research
  - Local repo inspected at commit `df4b89c` (branch `feat/daily-driver-w1`; `origin/main` at `7c081bb`), toolchain bun 1.3.14
  - arXiv:2607.12605v1 — "Multi-Perspective Agentic Program Repair via Code Property Graphs and Temporal Execution Graphs" (CT-Repair; Huang, Xu, Zhang; Chongqing University; submitted 2026-07-14) — read directly from the PDF (HTML rendering 404s)
- **Method**: three parallel code scouts (sonnet, direct source read — `codegraph_explore` was unavailable inside subagents) over the landing pipeline, the memory/state/evidence stores, and fleet execution/context assembly; one paper scout over the PDF; one grok-4.5 exhaustive sweep of every durable write-site under `src/`. Load-bearing claims spot-verified against source by the strategist.
- **Material limitations**: no tests executed (read-only research). Not fully traced: webapp frontend, `src/resolver.ts`, `smart-spawn.ts`, exact server routes consuming `omp-graph` builders, `gate-logs.ts` schema. Workflow-graph authoring (whether every graph routes through a deterministic verify node before `exit`) not inspected.

---

## 1. Executive decision

**Build a semantic land assessment — as an observe-only, commit-addressed evidence record at the existing land boundary — and prove it by replay against glance's own land history before it gates anything.** The mandate's working hypothesis survives contact with the code, with one material correction: the wedge is not a new subsystem bolted onto landing; it is the *first producer* of the temporal assertion record the whole Repository State Engine thesis depends on, grown out of the strongest discipline the codebase already has (`proof.ts`'s commit/tree fingerprinting).

Concretely, the wedge is four deliverables:

1. **A deterministic TypeScript semantic-delta extractor** (`SemanticDelta`): given base `B`, target `M`, candidate `C`, compute symbol/export/import/module-level deltas for `semantic(M)−semantic(B)` and `semantic(C)−semantic(B)` using git + the TS compiler API. No LLM in the extraction path. Explicit `extractionCoverage` (files it could not parse are reported as gaps, never as "safe").
2. **A commit-addressed `LandAssessment` record written for EVERY land attempt — including rejections.** Fields per the mandate's shape: functional verdict (from the existing proof gate), semantic overlap risk, affected criteria, evidence pointers, extraction gaps, recommendation — each assertion tagged with an explicit authority class (`deterministic | derived | inferred`). This closes a verified gap: today a rejected land's only durable trace is a 600-char truncated streak entry (`land-ledger.ts`), and the mandate's principle "every rejected attempt should still generate evidence" is unmet.
3. **Observe-only wiring** beside `staleBranchReason` in the land path (`land.ts` / `land-pr.ts`) and a dashboard/report projection — no enforcement, no new hard dependency, mirroring the codebase's own propose-only precedent (confidence floor, shadow-first model routing).
4. **A replay benchmark over glance's own history.** Run the extractor over past lands (the repo has 190+ PRs, land ledgers, receipts, and — decisively — *real labeled incidents*: the 2026-07-13 composition-drift double-hit where sibling squashes merged cleanly and pristine main failed its own gates, the stacked-PR wrong-base incidents, the orphaned-merged-PR class). Measure precision/recall on those before any advisory warning ships, and false-positive rate on the hundreds of benign lands.

**Why this wedge beats the alternatives** (full scoring in §5): it attacks a gap the code itself documents (`src/land.ts:873` — the "semantic-merge ceiling": a merge can be textually clean, compile, pass the verify gate *and* the LLM reviewer, and still be semantically wrong); every input it needs already exists deterministically (git three-state, TS compiler, the proof/validator records); it is the *only* candidate with a ready-made labeled evaluation set; and it is upstream of four other candidates — cross-agent collision detection is the same computation run earlier, the criterion-evidence graph attaches to the same assessment record, trajectory analysis is these deltas accumulated over time, historical explanation is a query over them. It creates state-engine leverage without a speculative rewrite: the `TemporalAssertion` shape enters the codebase carried by a narrow, measurable consumer.

**What glance should explicitly NOT build yet** (§6): the universal multi-graph store or any graph database; the research-ingestion/applicability product; RL-driven routing; the deliberation graph; embeddings in fabric; a full stable-identity solver (v0 = qualified name + git rename evidence, with identity uncertainty *represented*, not resolved).

**What would invalidate this recommendation**: replay showing the extractor cannot separate the known incidents from benign lands (low precision at useful recall); extraction coverage on the dogfood repo too low to trust (< ~90% of changed TS files parsed); per-land runtime blowing the land path's latency budget; or the adoption gate (§7) redirecting all capacity to the daily lane, in which case this parks as an expanded plan, not a half-built substrate.

---

## 2. What the code actually says (scout digests)

### 2.1 Landing pipeline (verified)

- Gate order in `SquadManager.land` (`squad-manager.ts:3209-3533`): observer-unit refusal → proof refresh → auto-land fail cap → **proofGate** → confidence floor (propose-only hold) → **validator gate** (runs before mode dispatch, even on forced lands) → mode dispatch to `landAgent`/`landAgentPr` → stale-branch → land-risk → merge → regression gate → acceptance gate on merged main → done-proof + ledgers.
- **Pre-land `Proof` is the codebase's best temporal discipline**: `isFresh()` (`proof.ts:130-149`) demands exact match on commit, tree, branch, baseCommit, repo, worktree, and command hash, within a 24h TTL — main moving invalidates the proof. This is the pattern the wedge generalizes.
- **The semantic gap is real and self-documented**: `land.ts:873` names the "semantic-merge ceiling." Concurrent-work comparison today is file-path overlap only (`staleBranchReason`, `land.ts:793-860`); `applyRegressionGate` diffs test-failure *sets*, bounded by whatever tests exist. Nothing compares candidate-vs-main deltas structurally. `land-risk.ts` scores only the candidate's own blast radius (file count + sensitive-path regex).
- **Failure semantics are overwhelmingly fail-closed** (probe failures block-and-retry; content failures block), with two deliberate fail-opens: landing onto an already-red baseline with no *new* failures, and the validator's `abstain` when the LLM judge is unreachable. `skipped` (no criteria declared) is also fail-open by design.
- **Two evidence gaps verified**: (a) rejected lands produce no structured artifact — only the truncated `land-failures.json` streak + throttled findings; (b) `DoneProof` is never re-validated against current main — `proofCoversTip` (`done-proof.ts:127-143`) checks only that the *branch tip* still equals the proven commit, never that the merge commit is still reachable from a possibly rewritten main.
- Acceptance criteria enter the land decision **only** through an independent LLM judge (`validator.ts`, default opus, veto blocks unless human-overridden). There is no deterministic criterion→evidence link anywhere.

### 2.2 Memory/state/evidence inventory (verified)

- **~40+ distinct durable stores** under the state dir (grok sweep, exhaustive): receipts JSONL per agent, digests, proofs, done-proofs, land-failures/forced/validator-override ledgers, task-outcomes, model-outcomes, failure-annotations, baseline/threshold tuner state, drift audit, transitions, reflections, friction ledger, comments/plan-votes event logs, scout/observer/opportunity seen-maps, dispatch ledger, leases/presence, boundary-sync held patches, convergence oracle, plus DB-mode tables. `fabric.ts` is a read-only aggregator over them.
- **Authority tiers exist in exactly five islands** and nowhere else as a queryable field: the type-enforced `causal: false` in `omp-graph/task-class-matrix.ts`; the drift-lens Hypothesis→judged-verdict split enforced by import structure; digest reward tags (boost-only); `(weak match)` provenance labels in the context primer; `FeatureDecision.source: plan|human|agent`. Meanwhile LLM-inferred values (failure-memory `rootCause`, confidence scores) sit in flat schemas indistinguishable from deterministic facts.
- **Identity is strings all the way down**: `agentId`, branch name, issue identifier, constructed fingerprints. `omp-graph/provenance.ts` joins by regex over commit subjects and has a *documented* prefix-collision bug it had to fix. The only content-addressed identity is `proof.ts`'s fingerprint.
- **"What was believed at commit X" is reconstructable only for proofs.** Most ledgers mutate in place, destroying history; the rest are timestamp-ordered, not commit-addressed.
- `fabric-search` is **BM25 only** (K1=1.5/B=0.75, title-boosted, recency/reward priors) — no embeddings anywhere. Every retrieved memory injected into an agent passes through one untrusted-data fence (`fenceUntrusted`, `digest.ts:167-171`) with delimiter-injection neutralization — the mandate's "content ≠ instructions" rule already has a single enforced choke point.
- Corruption discipline is inconsistent: `baseline-tracker.ts` and `convergence-oracle.ts` THROW on corrupt state (escalate, never silently re-baseline); most other ledgers silently reset to empty.

### 2.3 Fleet execution & context assembly (verified)

- Context assembly is structured, not a chunk bag: profile memory + tool grants + membrane discipline + BM25 primer (top-6 typed facts with provenance/age/weak-match labels, 5s budget, per-repo circuit breaker) + fenced authored spec (Plane Tier-2 body), capped at 24k chars per fence. Live pull via `squad_kb_search`; decisions flow back via `squad_record_decision`.
- **Side-finding that matters for the daily lane**: `contextReachesAgent` (`harness-registry.ts:276-290`) — ACP harnesses (including verified claude-code/grok/opencode) receive **no system-prompt channel by default**; the primer/spec/tool-grants are built but reach those agents only when `OMP_SQUAD_ACP_CONTEXT=prompt`. The daily-driver casual lane rides the claude harness — worth an explicit check in the daily-onramp plan that parity includes the primer.
- Feature-board criterion `completed` flags are STATUS-line/counter-derived, not evidence (`features.ts:743-751`); land-time gating is the evidence-based path (proof + validator).
- Routing learning already exists **shadow-first** (`OMP_SQUAD_MODEL_OUTCOMES`, `OMP_SQUAD_MODEL_ROUTE_SHADOW` default on = log-only), fed by `task-outcomes.jsonl` and the non-causal task-class matrix. Parallel-agent awareness = pre-dispatch scope-cycle checks, spawn-time ownership conflicts, advisory 120s-TTL leases mid-run — all path/string level, no semantic layer.
- Governance of self-modification is already structural: repo-committed profiles are defanged at parse time (`bin` dropped, unverified `harness` rejected, `mcp` dropped — each a loud warn); agents have no host-tool or transport path to policy/profile mutation.

### 2.4 The paper (arXiv:2607.12605, read directly)

CT-Repair: two-stage APR framework. Deterministic substrates — Joern code-property graph + a Temporal Execution Graph built from bytecode instrumentation, compacted by three deterministic filters (coverage, structural, behavioral; ~95% method reduction, then 37%/46% further volume cuts) — exposed to LLMs only through typed query tools. Three FSM-guided agents (static / dynamic / hybrid) independently form root-cause hypotheses; diversity is moved from patch sampling to *reasoning*. Results: 489/854 Defects4J v3.0 bugs correct (mixed-model), beats ReinFix/RepairAgent under same-base-model control with a far smaller sampling budget; ablations show CPG (−11.8%), TEG (−8.6%), and each agent perspective (−5.7 to −12.2%) are individually load-bearing. Caveats: Java-only, perfect-fault-localization assumption (authors concede it overestimates end-to-end performance), filtering stages never individually ablated against accuracy, headline number not ablation-tested, possible data leakage acknowledged. **The transferable core is validated**: deterministic compaction of noisy evidence into queryable structure *before* LLM reasoning, plus perspective diversity over one shared substrate. The program-repair pipeline itself does not transfer.

---

## 3. Concept extraction table

| Concept | How the source implements it | Transferable? | Why / why not |
|---|---|---|---|
| Deterministic compaction before reasoning | CT-Repair: coverage/structural/behavior filters shrink 2.38M-event traces ~99% before any LLM sees them | **Yes** | Glance's validator judges raw diffs; gate logs are offloaded prose. A deterministic `SemanticDelta` is glance's CPG-equivalent; ablation-validated in the paper |
| Perspective diversity over one substrate | Three agents (static/dynamic/hybrid) independently hypothesize over the same CPG/TEG; union +25% over best single | **Yes** | Glance's validator + lens panel already half-does this but over prose diffs; feeding distinct judges the same structured delta is the paper's validated shape. Do not average verdicts — glance's veto/advisory split already preserves conflict |
| Query interface, not context dump | Agents pull evidence via typed tools capped per state | Already present | `squad_kb_search` matches; extend with delta queries later, not first |
| Commit-scoped proof freshness | `proof.ts` fingerprint (commit+tree+base+command, TTL) | Already present — **generalize it** | The wedge extends this discipline from "did the command pass" to "what changed semantically" |
| Explicit authority tiers on assertions | Mandate's Tier 1/2/3; glance has 5 disconnected islands | **Yes** | Introduce the `authority` field in NEW records (LandAssessment) rather than migrating 40 stores; islands prove the pattern is native to this codebase |
| Evidence for rejected attempts | Mandate principle; CT-Repair keeps failed-hypothesis records | **Yes** | Verified gap: rejections leave a 600-char streak entry. Assessment record for every attempt closes it |
| Temporal assertions / commit-addressed state | Mandate's `TemporalAssertion`/`SemanticDelta` schemas | **Yes, narrowly** | Only as the wedge's record format — not as a universal store retrofitted onto 40 ledgers |
| Multi-graph logical families | Mandate's 7 graph families | **Not yet** | The code says: one assertion record with typed subjects, grown from one producer. Seven families now = the "impressive but operationally weak knowledge graph" the mandate itself warns against |
| Research→engineering applicability product | Mandate §Research-to-Engineering | **Defer** | Mandate's own sequencing question answers itself: without the internal state model there is nothing to match claims against. The manual `/research`+`/crypto-research` lane covers this today |
| RL/learned routing | Mandate's triage says compare simpler methods first | Already answered | Shadow-first supervised path with a type-enforced non-causal label exists; stay the course, no RL |
| Horizon declaration / temporal debt | Mandate's `HorizonPolicy`/`TemporalDebt` | **Later, cheap entry exists** | `accepted-friction.md` + Plane tickets are the informal version; formalize only once assessments produce `allow-with-debt` outcomes to attach records to |

---

## 4. Ranked concepts (strategist output)

Ranked against the named bottleneck (see §7) and architectural leverage:

**1. Semantic land assessment as the first temporal-assertion producer** (the wedge — §1)
**Pattern**: at every integration boundary, compute deterministic semantic deltas for candidate-vs-base and main-vs-base, join them into an authority-tagged, commit-addressed assessment record, persist for every attempt, enforce nothing until replay-measured.
**Mechanism**: TS compiler API + git three-state; overlap detection at symbol/export/interface level; record shape per mandate's `SemanticLandAssessment` with `extractionCoverage` mandatory.
**Where it applies**: `land.ts` (beside `staleBranchReason`), `land-pr.ts`, new `src/semantic-delta.ts` + `src/land-assessment.ts`, new state-dir store, one dashboard projection.
**Build vs buy**: build; the TS compiler is already in-tree. Joern/CPG tooling is Java-centric overkill for v0.

**2. Deterministic evidence compaction before LLM judgment** (paper borrow, applies beyond the wedge)
**Pattern**: no LLM judge consumes raw logs/diffs when a deterministic compactor can hand it structure. **Where**: `validator.ts` input (structured delta + affected criteria instead of raw diff), gate-log excerpting. Paper-validated; also cuts validator token cost.

**3. Commit-addressed, authority-tagged assertion records** (the state-engine seed)
**Pattern**: new durable records carry `{authority, status, validFromCommit, evidence[], extractorVersion}` from day one; existing stores are *not* migrated. The five authority islands unify by convention forward, not by rewrite backward.

**4. Rejected-attempt evidence** — subsumed by the wedge but independently cheap; highest-value single fix inside it (turns 1,700+ historical land attempts of learning signal from truncated strings into structured records going forward).

**5. Criterion→evidence links** (phase-2 consumer)
**Pattern**: `affectedCriteria` on the assessment joins `FeatureCriterion` ids to the delta's touched entities and the proof's stages — the first deterministic input the validator gets, and the seed of the acceptance-criterion evidence graph *without* building a graph product.

**6. Daily-lane side-finding (immediate, tiny)**: verify the ACP context-delivery gap (`OMP_SQUAD_ACP_CONTEXT`) against the daily-onramp parity requirement — casual sessions on the claude harness may be running without the primer/spec channel entirely. One-line env default or an explicit parity test in `plans/daily-onramp/`.

Also worth registering (not wedge-blocking): `DoneProof` main-reachability re-check as an observer audit; corruption-throw discipline (`baseline-tracker.ts` pattern) applied to the new assessment store from day one.

---

## 5. Candidate-wedge comparison

Scored high/med/low against the mandate's criteria (operator value, architectural leverage, implementation risk, data availability, evaluability, time-to-first-result):

| Candidate | Value | Leverage | Risk | Data ready | Evaluable | First result | Verdict |
|---|---|---|---|---|---|---|---|
| **Semantic land assessment** | high | **high** (substrate for 4 others) | med | **yes — git+TS+ledgers** | **high — replay + real labeled incidents** | weeks | **CHOSEN** |
| Acceptance-criterion evidence graph | high | med | med | partial (criteria free-form) | low (no ground truth for "proven") | months | phase-2 consumer of the wedge |
| Cross-agent semantic collision detection | med | med | med | yes | med | weeks | same computation as the wedge, run earlier; do after, not instead |
| Task-specific context assembly | med | low | low | yes | med | days | fabric already structured; the real gap is *delivery* (ACP channel), a bugfix not a wedge |
| Observer invariant drift | med | med | high | **no — no invariant records exist** | low | months | needs authoring burden nothing produces today |
| Architectural trajectory analysis | med | med | high | no (needs accumulated deltas) | low | months | consumer of the wedge's deltas over time |
| Temporal debt tracking | low-med | low | low | partial (`accepted-friction.md`) | med | days | formalize when `allow-with-debt` outcomes exist |
| Historical repository explanation | low | med | med | partial | low | months | query layer over a substrate that doesn't exist yet |
| Research-opportunity matching | low (today) | low | high | no internal problem model | low | months | separate product; defer until the state engine exists |

The decisive separators are **evaluability** and **data-already-available**: semantic land assessment is the only candidate that can be proven or killed cheaply, offline, against real history, before touching the land path's trust budget.

---

## 6. Explicitly not building yet

1. **No graph database, no universal multi-graph store.** Ordinary JSON/JSONL records with typed subjects, per the codebase's own storage idiom and the mandate's "choose storage on access patterns, not fashion." The seven logical graph families remain a *reading* of future records, not a physical commitment.
2. **No research-ingestion product.** Sequencing decision per the mandate's own §Product Boundary: defer until the state engine exists; the manual `/research` + `/crypto-research` lane is the interim.
3. **No RL routing.** The shadow-first supervised path with type-enforced non-causal labeling is the correct current rung.
4. **No full stable-identity solver.** v0 identity = qualified name + file path + git rename evidence, with `changedIdentities` carrying explicit uncertainty. Symbol splits/merges and cross-language migration are out of scope until measured to matter.
5. **No deliberation graph, no embeddings in fabric, no enforcement.** Enforcement arrives only via the phased ladder (observe → report → advisory → narrow enforcement), each phase with measured precision from replay, matching the mandate's Phase 0–4 and glance's own confidence-floor precedent.

---

## 7. Sequencing against the named bottleneck

The project's standing p0 is **daily-driver adoption** — `plans/daily-driver/00-meta.md` is explicit: "the strategy is not features — it is starting the dogfood loop," with a kill-criterion adoption gate after wave 1 and post-wave-1 epics executing only on adoption evidence. This wedge does not attack that bottleneck, and this brief does not pretend it does.

The honest sequencing: **the wedge is the fleet lane's next initiative, not wave 1's competitor.** Phase 0 (assemble the replay corpus from existing ledgers/PR history) and phase 1 (observe-only extractor + assessment records) are fleet-dispatchable background work touching zero daily-driver files, creating zero enforcement dependency, and producing a measurable verdict either way. Whether it executes now-in-parallel or after the adoption gate is Lars's call at the gate — the plan should exist either way, because the replay evaluation is also the cheapest way to *kill* the state-engine thesis before months are spent on it. The ACP-context side-finding (§4.6) is the one item from this research that belongs *inside* wave 1's parity checklist.

---

## 8. Proposed ADR

- **Context**: glance's land pipeline is layered and fail-closed but semantically blind above file-path overlap; its ~40 stores share no authority model, no stable identity, and no commit-addressed reconstruction outside `proof.ts`; the mandate proposes a temporal Repository State Engine; CT-Repair validates deterministic-compaction-before-reasoning.
- **Decision**: introduce the Repository State Engine via one narrow producer — an observe-only semantic land assessment writing commit-addressed, authority-tagged assessment records for every land attempt — evaluated by replay against glance's own history before any advisory or enforcement role.
- **Alternatives considered**: criterion-evidence graph first (weaker evaluability), collision detection first (same computation, worse evaluation point), context-assembly overhaul (real gap is delivery, not assembly), full multi-graph engine (the "impressive but operationally weak" failure mode), defer everything until after adoption gate (kept as an explicit option — the plan parks cleanly).
- **Consequences**: a new extractor + store + record shape to maintain; the `TemporalAssertion` idiom enters the codebase with one producer and 2–3 readers; validator input can become structured (cheaper, more grounded); rejected lands finally accumulate learning signal.
- **Non-goals**: graph DB, research product, RL, identity solver, any enforcement in v1.
- **Revisit conditions**: replay precision/recall below usefulness; extraction coverage < ~90% on the dogfood repo; adoption gate outcome redirecting capacity; TS-only scope proving too narrow for real fleet repos.

---

## 9. Handoff to /plan (when approved)

Instruct `/plan`'s EXPLORE phase to treat these as a pre-mapped landscape to validate and extend, not rediscover: `src/land.ts:793-877` (staleBranchReason + semantic-merge ceiling comment), `src/land-pr.ts:717-722`, `src/proof.ts:26-149` (the fingerprint discipline to generalize), `src/done-proof.ts:101-143`, `src/land-ledger.ts`, `src/validator.ts` (structured-input opportunity), `src/types.ts:388-408` (FeatureCriterion/ValidationRecord), `src/omp-graph/provenance.ts` (string-join cautionary tale), state-dir conventions in `src/dal/storage.ts` (durable write primitives) and the corruption-throw discipline in `src/baseline-tracker.ts:20-56`. Build vs buy: build the extractor on the in-tree TS compiler; adopt no new dependency. Replay corpus: land ledgers + `gh pr list` history + the labeled incidents in auto-memory (composition-drift 2026-07-13, stacked-PR wrong-base, orphaned merged PRs).

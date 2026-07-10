# Design: EAP borrows — success-coupled accounting, lossless offload, honesty tiers, fail-closed sweep, membrane disciplines

Source: plans/research-eap/BRIEF.md (merged PR #148). Adversarial design 2026-07-09:
sonnet designer → 2 red teams (fable: correctness/state; opus: system/product) → fable arbiter.

## Approach

Five borrows, built native, nothing adopted. The unifying posture is EAP's own: honest
measurement (success co-equal with cost), lossless-by-pointer instead of truncation, capability
tiers named honestly, checkers that fail closed, and prompt-only disciplines that are measured
and auto-reverted. Everything sequenced around the live `fix/one-green-loop` (G3) branch: nothing
that can refuse a land ships before G3 merges.

## Key Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Where (tokens,cost,success) join | Read-time join receipts↔task-outcomes on agentId, summed per agent; no TaskOutcomeRow fattening | Denormalize onto outcome rows; third ledger | Outcome rows are deliberately small (PIPE_BUF/O_APPEND, task-outcomes.ts:16-20); both ledgers already agentId-keyed |
| Success signal | outcome + validator veto + in-run rework, with a variance floor | mergeRate alone | Live data: all collapsed outcomes are `landed`, mergeRate saturates at 1.0 — a mergeRate-only regression flag is structurally inert (red team B C1) |
| Efficiency cell key | Model variant (full id), modelFamily fixed to include xai | family-level cells | family collapses 5.6-sol/luna into "openai", grok into "other" — the motivating comparisons become invisible (red team A S2) |
| Baseline | Auto-champion per taskClass + optional human pin + staleness AttentionEvent | Hand-edited baselines.json | Hand file rots silently when the roster churns (red team B S2) |
| Publish gate | `reproducible` computed in the pure matrix builder (n, cost+token coverage, variance floor); consumers cannot recompute | Render-layer convention | Only enforcement point a consumer can't bypass; shadow router already honors `insufficientData` |
| Scoreboard UI | CUT for now | webapp "unpublished" render states | No matrix consumer exists beyond the shadow router (red team B C3) — build the panel when there's a reader |
| Offload store | Plain durable per-agent log files, unique path per write; path = pointer | Content-addressed blob store + index + TTL CLI | Judge is one-shot and tool-less — pointers are post-hoc forensics, a file path suffices; unique paths dissolve the torn-tmp concurrency bug by construction (A C3 vs B S3; B wins) |
| Judge excerpting | Diff-aware (diffstat + whole hunks) for diffs; head+tail for suite output; never-throw fallback to truncate | head(0.7)+tail(0.3) everywhere | head/tail bisects hunks and creates phantom deletions (A M3); a throw inside the validator fail-closes a land (A S5) |
| Harness tiers | Additive pure `harnessTierInfo` (static verified × detected × usage-verified); `verified:boolean` untouched at all 4 gate sites | Migrate gate onto a tier enum | Spawn gate and RCE guard stay byte-identical — "exactly as strict" by not touching them |
| Fail-closed wave split | By behavioral blast radius: "can this refuse a land" | By file overlap with G3 branch | The branch doesn't even touch land.ts; file overlap was the wrong criterion (A C4). Wave 1 = #7,#12,#14,#15,#16 only |
| Fail-closed PR shape | One atomic PR per wave (classifier + all its call sites) | 5-8 small PRs | A half-applied taxonomy is harder to reason about than uniform fail-open; repo history punishes many stacked PRs (B S4) |
| Membrane placement | v1 = validator/lens judges + planner prompts; implementer units native-only, delivery-confirmed, double-gated | Implementer units first | Minimal-code ladder on implementers fights the repo's completeness norms (B M2); judges are already output-shaped |
| Membrane delivery | Separate expansion channel — tokens never enter `capabilities[]`/toolGrants | capabilities[] tokens | capabilities IS the host-tool allow-list; a membrane-only profile would deny every host tool (A C1) |
| Membrane measurement | efficiencyFlags stamped ONLY on confirmed delivery; hard auto-disable breaker past MIN_EDGE over N units | Stamp at spawn; advisory-only breaker | ACP default drops appended prompts — spawn-stamping measures a placebo (A C2); advisory-only makes "revert on drop" ceremonial (B M3) |

## Risks

- G3 (`fix/one-green-loop`) not merging stalls Wave 2 + the land-path offload half; escape hatch = re-cut those concerns against whatever land.ts looks like when unblocked.
- Efficiency flag may not fire for months at current fleet volume — accepted; the point is schema-before-router (G4), and the variance floor keeps us from publishing confident nulls.
- ACP usage mapping is unverified against live harnesses; per-cell token-coverage gate quarantines those lanes until a live smoke verifies the mapping (tracked in the tiers concern).
- Escalation events may lack a live AgentDTO at some land-probe sites; concern 04 verifies attachment and adds a daemon-scoped attention record if needed.

## Red Team Concerns Addressed

| Concern | Severity | Resolution |
|---|---|---|
| A C1 toolGrants poisoning by membrane tokens | critical | Separate expansion channel; test asserts membrane-only profile keeps toolGrants undefined |
| A C2 ACP non-delivery → placebo measurement | critical | Delivery-confirmed stamping; v1 unit-delivery native-only |
| A C3 torn concurrent blob writes | critical | CAS cut; unique log path per write |
| A C4 wave split can re-jam the factory | critical | Waves re-cut by can-refuse-a-land; #8/#10/#11 moved behind G3 |
| B C1 mergeRate zero variance | critical | Composite success signal + variance floor |
| B C2 ACP token blindness | critical | Per-cell token-coverage publish gate + usage-verified bit |
| B C3 nonexistent consumers | critical | Builder-level enforcement only; UI cut |
| A S1 green-only hasProof zombifies closes | significant | #11 speced tri-state (green closes; red-baseline closes annotated; unverified escalates) |
| A S2 modelFamily collapse | significant | xai family + variant-level cell key |
| A S4 multi-receipt join ambiguity | significant | Sum-per-agentId; flag identity = union w/ mixed marker |
| A S5/S6/S7/S8 | significant | Never-throw excerpting; #12 as gate-unrunnable finding; #15 escalate w/o sidecar write; mtime sweep, 14d default |
| B S1 saturated-cell confident nulls | significant | Variance floor inside `reproducible` |
| B S2 baseline rot | significant | Auto-champion + pin + staleness event |
| B S4 taxonomy fragmentation | significant | One atomic PR per wave |
| B M1 no reproducible eval harness | missing piece | Explicitly deferred concern (08), not smuggled in |
| B M3 ceremonial breaker | minor | Hard auto-disable past MIN_EDGE over N units |
| A M1 Bun.which lies both ways | minor | Resolve bin as spawn does; "not on daemon PATH" wording; list-time cache |

## Open Questions

- None blocking. G3 merge timing gates Batch 3 by construction.

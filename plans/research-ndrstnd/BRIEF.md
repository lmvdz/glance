# Research brief: ndrstnd

- **Date**: 2026-07-15
- **Source**: https://github.com/truizlop/ndrstnd (Apache-2.0, TypeScript, 57★, created 2026-07-08)
- **Commit scouted**: `92159701fd2001923fbb8e6085e489066c968312` (2026-07-14)
- **Files read**: README.md, src/skill-assets/ndrstnd/SKILL.md, src/shared/analysis-schema.ts, src/shared/domain.ts, src/server/evidence-ordering.ts (source, not marketing)
- **Target project**: glance (omp-squad) — maps directly onto the in-flight `plans/comprehension/` lane (operator comprehension: attention log, fog overlay, mental-model-delta PR sections, symptom index, weekly episode)

## What it is

A local comprehension workspace for large agent-produced branch changes: `ndrstnd review <branch> --base main` turns a diff into an evidence-linked **Story, Timeline, Test plan, and Full diff** HTML artifact, instead of asking the reviewer to read files in alphabetical order. Explicitly comprehension-only: it never critiques, comments, or edits — critique is delegated to the agent's own `/review`. Analysis runs on the host agent's existing session (Codex or Claude Code); presentation logic is deterministic and zero-token.

## How it works

1. Git scope resolution (always merge-base; warns when an inferred base pulls extra commits).
2. Optional conversation export (`ndrstnd-conversation-v1.json`, user+assistant text only) grounds motives, rejected alternatives, constraints, and observed test runs. Skill instructs: *when no dialogue exists, skip the export instead of fabricating one.*
3. The analysis agent fills a zod-validated `AnalysisDocument` (schema-versioned; version bump ⇒ cached analyses re-run rather than render broken; unchanged revision ⇒ cache reuse).
4. Deterministic core derives file signal (meaningful vs low-signal + `signalReason`), evidence reading order, and renders a self-contained artifact in git-ignored `.ndrstnd/` (short-lived, local, private).

## The load-bearing schema ideas (src/shared/analysis-schema.ts)

- **Chapters**: `{kind, synopsis, before?, after?, confidence, attention(low→critical), riskCategories[], evidenceIds: min(1)}` — every narrative claim MUST anchor to ≥1 diff hunk. `before`/`after` capture semantic change, not textual change.
- **Steps** (the Timeline): `{goal, youNowHave, deferred[{concern, resolvedByStepId?}], dependsOn, forwardRefs, advancesChapterIds, evidenceIds}` — a suggested *build order* narrative: what you have after each step, which concerns are consciously deferred and where they resolve.
- **omittedGroups** `{title, reason, evidenceIds}` + **unclassifiedEvidenceIds**: what the narrative deliberately collapsed and what it failed to classify are both first-class, enumerated outputs — omission is stated, never silent.
- **testExecution** `{command, outcome, summary, source: "conversation"|"repository"}` max 5, doc-comment: "actually observed…; **never inferred**" — enforced at the schema level.
- **focus**: per-evidence reviewer-critical line ranges (max 5) driving zoomed excerpts (ZoomLevel 0–4).

## Evidence ordering (src/server/evidence-ordering.ts) — fully deterministic

Symbol-definition-before-use constraints (token scan minus keyword set) + layer precedence (layers emitted ascending — deliberately avoids the O(n²) constraint materialization they had first) + per-layer topological sort; any cycle or layer-contradiction falls back gracefully to plain rank order. Zero LLM involvement in ordering.

## Concept extraction (comparator table)

| Concept | Their implementation | Transferable? | Why |
|---|---|---|---|
| Evidence-mandatory narrative | zod `evidenceIds: min(1)` on every chapter/step | **Yes — top pick** | Schema-enforced "no claim without a diff anchor" is the anti-slop mechanism the comprehension lane's mental-model-delta section currently lacks |
| Before/after semantic framing | optional `before`/`after` per chapter | **Yes** | A mental-model delta IS a before/after statement; the shape teaches better than freeform bullets |
| Explained omission | `omittedGroups{reason}` + `unclassifiedEvidenceIds` | **Yes** | Lars' absence invariant ("absence of evidence ≠ evidence of absence") encoded as output schema; applies to digests/debriefs/episodes that currently truncate silently |
| Observed-only test claims | `testExecution.source` enum + never-inferred rule | **Yes** | Same false-green discipline glance's proof lane fights for, enforced one layer earlier (in the summary contract) |
| Deterministic reading order | symbol/layer/topo ordering, zero-token | **Yes** | Drop-in pure-helper pattern for IntervenceView's diff spine (currently file order) |
| Low-signal collapse with stated reason | `FileSignal + signalReason` | **Yes** | IntervenceView diff + fog weighting |
| Conversation-grounded narrative | portable conversation export | **Partially** | glance owns live transcripts natively — no export step needed; the *provenance discipline* (motive/rejected-alternatives sourced from dialogue, marked) transfers |
| Comprehension ≠ critique separation | separate tool from `/review` by design | **Yes (validation)** | Independent confirmation of the comprehension lane's premise: review-as-gate doesn't teach; teaching needs its own surface |
| Schema-versioned analysis cache | `ANALYSIS_DOCUMENT_VERSION`, bump ⇒ re-analyze | **Yes (minor)** | Any cached derived artifact (episodes, delta parses) should version-gate |
| Heartbeat during long analysis | 15s "still analyzing: <what>" lines | Yes (minor) | glance already has richer live status; noted for CLI-side long ops |

## Ranked patterns for glance (strategist)

**1. Evidence-anchored mental-model deltas** *(impact: highest — directly patches a red-team-flagged weakness)*
**Pattern**: every narrative claim in a machine-authored summary must carry ≥1 machine-checkable anchor into the diff it describes; anchorless claims are schema-rejected.
**Mechanism**: delta bullets become `{before?, after, evidence: [{file, hunk|lineRange}]}`; the PR-body template renders them with the anchors; the reconciler parse (planned in `src/pr-body.ts`) validates anchors against the merged diff and drops (and counts) bullets whose evidence doesn't exist.
**Where**: `src/pr-body.ts` (planned, concern 06 of plans/comprehension), `FeatureDecision` shape, IntervenceView bullet rendering.
**Build vs buy**: borrow the pattern (a zod/Effect-Schema contract + parser), trivial to build.

**2. Explained-omission contract for every summary surface** *(impact: high, cheap)*
**Pattern**: a summarizer's output enumerates what it left out and why, and what it could not classify — silence is structurally impossible.
**Mechanism**: add `omitted[{title, reason}]` + `uncovered` fields to digest/debrief/episode builders; renderers show "not covered: N (reasons)". The voice debrief already does a primitive version ("history was truncated — partial report") — generalize it.
**Where**: `src/digest.ts`, planned `src/weekly-episode.ts`, `buildVoiceDebrief` (post-#186).
**Build vs buy**: borrow.

**3. Deterministic suggested reading order for the Intervene diff spine** *(impact: high for the "where to look" goal)*
**Pattern**: order diff hunks by definition-before-use + architectural layer via topological sort, computed in pure code with graceful cycle fallback — a Story order, not path order, at zero token cost.
**Mechanism**: port the ~150-line algorithm shape (symbol scan → constraints → layered topo, fallback to rank order on cycle/contradiction) as a tested pure helper; feed it the existing `/api/agents/:id/diff` payload.
**Where**: new `webapp/src/lib/diff-order.ts` + `IntervenceView.tsx`.
**Build vs buy**: borrow (reimplement; their code is Apache-2.0 so adaptation with attribution is also fine).

**4. Observed-only test-execution provenance** *(impact: medium)*
**Pattern**: summaries may only report test/build runs actually observed, tagged with where they were observed; inference is contractually forbidden.
**Mechanism**: `testExecution[{command, outcome, source: "transcript"|"repository"}]` on digests/episodes/PR bodies, populated from transcript receipts (glance already has ground truth ndrstnd has to ask the agent to export).
**Where**: `src/digest.ts`, `src/receipts.ts` join, planned episode.
**Build vs buy**: borrow.

**5. Before/after chapter framing + attention levels for episodes** *(impact: medium)*
**Pattern**: narrative units carry semantic before→after plus a calibrated attention level (low→critical) and risk category, letting a lazy reader triage by attention.
**Where**: weekly episode sections; possibly the debrief's architecture-story clause.
**Build vs buy**: borrow.

**Adopt-the-tool assessment**: do NOT adopt as a dependency for the product — ndrstnd is a per-review local CLI bound to Codex/Claude host sessions, artifact-per-branch; glance is a multi-tenant daemon that already owns transcripts, diffs, and rendering, and needs these ideas fused into its live surfaces, not a parallel artifact. (Personal use of the CLI for reviewing big branches is reasonable; it's 7 days old with a single maintainer — watch, don't depend.)

## Suggested handoff

A comprehension plan is already active (`plans/comprehension/`, mid-design). Per /research handoff rules, propose **modifications to that plan** rather than a new one: fold pattern 1 into concern 06 (PR template/parser), pattern 2 into concerns 08 + the digest, pattern 3 as a new concern (Intervene reading order), pattern 4 into 06/08. Patterns are sized to slot into the existing decomposition without changing its dependency spine.

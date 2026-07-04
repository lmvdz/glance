# Wave 1 trust — overview

STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural

## Goal

Make "Done" mean something the operator can check, and make the daemon's merge world match the operator's merge world:

1. **Land = GitHub draft PR, not a silent local merge**, whenever a repo is provably safe to do that (per-repo, auto-probed) — the dashboard's Land button becomes "merge the PR" and out-of-band GitHub-UI merges are reconciled back into daemon truth.
2. **A "Done" write (Plane close, plan-doc STATUS) requires a DoneProof** — a retrievable ledger entry pointing at commits reachable from the repo's real default branch — for every *daemon-automated* writer; human/operator writes stay proofless but become audit-visible instead of invisible.
3. **Safety defaults flip to the safe side**: the regression gate defaults ON (and actually runs in PR mode, not just local), and gate-class questions (real workflow gates) are never auto-answered by either of the two auto-approval engines.

## Why (source: plans/research-direct-vs-glance/BRIEF.md Wave 1 + adversarial design 2026-07-03)

`plans/research-direct-vs-glance/BRIEF.md` diagnosed why direct Claude Code sessions still beat the glance daemon on trust: the daemon merges into a local checkout that drifts ~112 commits behind the operator's real GitHub-PR world, "Done" is written by arithmetic (`ahead==0`) that squash/rebase merges make permanently wrong, gate-class questions are indistinguishable from routine confirms to both auto-answer engines, and the regression gate defaults OFF. This wave's design (`plans/wave1-trust/DESIGN.md`) went through two rounds of adversarial red-team (26 findings, 9 critical) before an arbiter fixed the plan below — every decision in DESIGN.md's tables is already resolved; this overview and its eight concern files do not re-litigate any of it. Each concern file carries only the anchors and edge cases its implementer needs; DESIGN.md remains the single source of truth for *why* a given seam was chosen over an alternative.

## Work

| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01-done-proof-ledger.md | New `src/done-proof.ts`: the single retrievable DoneProof ledger + `isAncestor` git helper. Nothing else in this wave can gate a Done write, resolve PR-vs-local mode, or write a PR-mode proof until this exists. | architectural | src/done-proof.ts (new), src/land.ts, src/squad-manager.ts, tests/done-proof.test.ts (new) |
| 02-gate-class-guard.md | Stamp `gateClass` on a `PendingRequest` at the real gate emitter (`raiseGate`) and enforce it in BOTH auto-answer engines before they can approve a real workflow gate. Mode-independent — ships day one regardless of PR-mode progress. | architectural | src/types.ts, src/squad-manager.ts, src/supervisor.ts, tests/gate-class.test.ts (new) |
| 03-regression-gate-default.md | Flip `OMP_SQUAD_REGRESSION_GATE` from opt-in to opt-out, register it in the runtime-settings flag registry, invert the test that currently pins the old (unsafe) default. Mode-independent. | mechanical | src/land.ts, src/runtime-settings.ts, .env.example, tests/land-regression-gate.test.ts |
| 04-done-write-gating.md | Every *daemon-automated* Done write (`closeLandedIssue`, `issueAlreadyDone`'s close-half, plan-sync's `⇒done`) requires a DoneProof lookup; operator/skill writes stay proofless but gain an audit record. Depends on 01's ledger existing. | architectural | src/squad-manager.ts, src/plan-sync.ts, ~/.claude/skills/claim-and-implement/SKILL.md, tests/*.test.ts (new) |
| 05-land-mode-probe.md | New `src/land-mode.ts` (5-point per-repo auto-probe) + new `src/gh.ts` (gh CLI wrapper) + `addWorktree` gains a real `startPoint` + ONE origin-aware `aheadOfBase` primitive swapped into every arithmetic consumer, with DoneProof consulted FIRST everywhere "is this landed" is asked. Depends on 01 for `isAncestor`. | architectural | src/land-mode.ts (new), src/gh.ts (new), src/worktree.ts, src/squad-manager.ts, src/observer.ts, tests/*.test.ts (new) |
| 06-pr-land-path.md | New `src/land-pr.ts`: `ensurePr` + synchronous `landAgentPr` (scratch-merge gate, `gh pr merge`, per-method reachability assertion, DoneProof write) wired in as `landBranch`'s PR-mode dispatch target; `landFeature` rerouted through the same seam so it can no longer bypass mode dispatch. Depends on 01 (DoneProof write) + 05 (mode resolution, `aheadOfBase`, `gh.ts`). | architectural | src/land-pr.ts (new), src/land.ts, src/squad-manager.ts, src/types.ts, tests/*.test.ts (new) |
| 07-pr-reconciler-backstop.md | Always-on manager loop (not Observer-gated) reconciling the pending-PR ledger against `gh pr view` for out-of-band GitHub-UI merges, closed-unmerged PRs, and crash-ordering retries. Depends on 06's ledger + `ensurePr`. | architectural | src/squad-manager.ts, tests/*.test.ts (new) |
| 08-webapp-pr-surface.md | `prUrl`/`prNumber`/`prState` mirrored onto the webapp DTO with badges/Land-button-copy in the dashboard the operator actually watches. Depends on 06's server-side DTO fields existing. | mechanical | webapp/src/lib/dto.ts, webapp/src/components/ActiveWorkPane.tsx, webapp/src/components/AssistantChat.tsx, webapp/src/components/TaskDetail.tsx, src/web/index.html |

## Order

| Batch | Concerns | Why together |
|---|---|---|
| B1 | 01-done-proof-ledger.md, 02-gate-class-guard.md, 03-regression-gate-default.md | All three are mode-independent trust — none of them needs PR-mode to exist to deliver value, and none blocks on any other concern in this wave. They touch disjoint regions of the shared files (see Notes) and land in parallel worktrees. |
| B2 | 04-done-write-gating.md, 05-land-mode-probe.md | Both consume 01's `done-proof.ts` exports (`hasProof`/`recordDoneProof`/`isAncestor`) but touch disjoint regions of `squad-manager.ts` (issueAlreadyDone/plan-sync wiring vs. mode-resolution/aheadOfBase/Observer wiring) — parallel once B1 lands. |
| B3 | 06-pr-land-path.md | Needs 01's ledger-write shape AND 05's `resolveLandMode`/`aheadOfBase`/`gh.ts`/`addWorktree(startPoint)` to exist before the PR land path can dispatch or fork worktrees correctly. |
| B4 | 07-pr-reconciler-backstop.md, 08-webapp-pr-surface.md | Both consume 06's exports (`PendingPr` ledger + `ensurePr` for 07; `AgentDTO.prUrl/prNumber/prState` for 08) but touch disjoint files (manager reconcile loop vs. pure webapp UI) — parallel once B3 lands. |

## Dependency graph

| Concern | Blocked by | 30s check |
|---|---|---|
| 01-done-proof-ledger.md | — | — |
| 02-gate-class-guard.md | — | — |
| 03-regression-gate-default.md | — | — |
| 04-done-write-gating.md | 01-done-proof-ledger.md | `grep -n "export function hasProof\|export function recordDoneProof" src/done-proof.ts` returns two hits |
| 05-land-mode-probe.md | 01-done-proof-ledger.md | `grep -n "export async function isAncestor" src/done-proof.ts` returns a hit |
| 06-pr-land-path.md | 01-done-proof-ledger.md, 05-land-mode-probe.md | `grep -n "export.*resolveLandMode" src/land-mode.ts && grep -n "export.*aheadOfBase" src/land-mode.ts && grep -n "export.*ghAvailable" src/gh.ts` returns three hits |
| 07-pr-reconciler-backstop.md | 06-pr-land-path.md | `grep -n "export.*ensurePr\|export.*PendingPr" src/land-pr.ts` returns two hits |
| 08-webapp-pr-surface.md | 06-pr-land-path.md | `grep -n "prUrl\|prNumber\|prState" src/types.ts` returns three hits |

## Notes

- **Phase 0 WIP snapshot** (headless chained `/plan` run): proceeded over 3 plans with open concerns (agentic-learning-loop 5, factory-control-plane 3, change-driven-loops 2; all last-touched 2026-07-03).
- **Cross-plan shared-file warning**: the sibling plans `plans/lifecycle-truth/`, `plans/never-lose-work/`, and `plans/inspectable-topology/` (all open, from PR #24) also touch `src/squad-manager.ts`, `src/types.ts`, `src/server.ts`, and the webapp `dto.ts`/`TaskDetail.tsx` pair. This wave's `squad-manager.ts` regions are localized to: `land()`/`landFeature()`/`landBranch()` (verified :1585-1744), `issueAlreadyDone` (verified :694-720), `onUi` (verified :3124-3149), `aheadOfMain`/`agentHasUnlandedWork` (verified :1804-1820), `maybeAutoSupervise`/`isRiskyRequest` (verified :2572-2598), `closeLandedIssue` (verified :2849-2854), Observer construction (verified :556-577), plan-sync timer wiring (verified :581-601), and `reapDeadWorktrees` (verified :3354-3396). **This wave must not touch `AgentStatus` write-path semantics** (the raw `rec.dto.status =` / `rec.dto.pending =` assignments) — `lifecycle-truth` owns that write-path exclusively; every land/proof/gate-class change in this wave reads or sets other `AgentDTO` fields (`landReady`, `prUrl`, `prNumber`, `prState`, `PendingRequest.gateClass`) and must leave status/pending assignments exactly as they are today.
- **Same-file batching note**: concerns 01+02 (B1) and 04+05 (B2) each touch disjoint regions of `squad-manager.ts`, but "disjoint regions of the same file" is not "safe to co-edit in one working tree" — each concern MUST be built in its own isolated worktree and the two worktrees' branches merged **sequentially** (not squash-merged in parallel), or one's edit silently reverts the other's during a naive merge of a large generated file.
- `bun test` needs `node_modules/.bin` (the `omp` binary) on `PATH` for two spawn-based tests in this repo — every concern's Verify section assumes `PATH="$PATH:$(pwd)/node_modules/.bin"` is prefixed.
- **Enforcement checks are `bun test`, never bash `grep`** — the `rtk` hook in this environment mangles raw `grep` output (can look like zero matches when there were hits), and `lifecycle-truth` reached the same ruling independently. The 30-second dependency-graph checks above are informal human/agent sanity probes only, not the concerns' actual enforcement tests — each concern's own Verify section specifies real `bun test` commands and file names.
- All file:line citations across these eight concern files were re-read directly from this worktree during decomposition (not carried over unverified from the design doc); a small number had drifted by a handful of lines from DESIGN.md's citations — each concern file states the corrected line where that happened. Two corrections are load-bearing enough to call out here: (a) `src/land.ts`'s `applyRegressionGate` already takes an explicit `repo` field in its parameter object that IS the cwd it operates on (no global-state assumption) — it needs an `export` keyword added, not a signature refactor, to be callable from concern 06's scratch-merge gate; (b) `src/features.ts`'s read-path STATUS regex (`C_STATUS`) captures only the single `[\w-]+` token after `STATUS:`, ignoring any trailing text on the same line — this is what makes concern 04's `done (unproven — closed in Plane without land proof)` marker parse identically to bare `done` everywhere `isClosedConcernStatus`/`concernDocStatus` read it, while still being human-legible in the file.

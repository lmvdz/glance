# Operator Comprehension Lane

## Outcome
- The operator can see, per file, what the fleet changed that no human has looked at (fog overlay with an honest, monotone debt metric), gets taught by every fleet PR (evidence-anchored mental-model deltas rendered in the PR body and Intervene view), can ask "where do I look?" mid-incident (`glance symptom` + doctor-failure auto-match), and gets a weekly state-of-the-codebase brief (durable artifact + push ping; spoken via voice once PR #186 lands).

## Work
| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| [01 attention substrate](01-attention-substrate.md) | No operator state exists anywhere; everything else reads it | architectural | src/attention.ts, src/schema/http-body.ts, src/authz.ts, src/server.ts, src/answers.ts, webapp/src/lib/attention.ts, webapp/src/lib/api.ts |
| [02 honest emitters](02-honest-emitters.md) | Events must mean what they claim (viewport, visibility, explicit acks) | mechanical | webapp IntervenceView/CommandPalette, webapp/src/lib/attention.ts, src/index.ts |
| [03 fog computation](03-fog-computation.md) | Monotone comprehension-debt metric + API | architectural | src/comprehension-fog.ts, src/server.ts |
| [04 fog overlay UI](04-fog-overlay-ui.md) | Render debt as an actionable shortlist, not a red wall; fix heatPayload bugs | architectural | src/server.ts, webapp/src/lib/heatmap.ts, webapp HeatTree.tsx |
| [05 teaching producers](05-teaching-producers.md) | Deltas/symptoms must be *recorded* by units mid-run or nothing downstream has content | architectural | src/squad-manager.ts, src/symptoms.ts, src/types.ts, unit briefing |
| [06 PR body projection](06-pr-body-projection.md) | Render recorded teaching into fleet PR bodies (first non-empty bodies ever) | architectural | src/pr-body.ts, src/land-pr.ts, src/squad-manager.ts |
| [07 symptom consumption](07-symptom-consumption.md) | `glance symptom`, doctor-failure auto-match, fabric fact | architectural | src/index.ts, src/doctor.ts, src/fabric.ts, src/fabric-search.ts, src/server.ts |
| [08 intervene teaching surface](08-intervene-teaching.md) | Bullets above the diff, surprise tap, deterministic reading order | architectural | webapp IntervenceView.tsx, webapp/src/lib/diff-order.ts, src/server.ts |
| [09 weekly episode](09-weekly-episode.md) | Calendar-cadence brief from agent-authored atoms; push ping | architectural | src/weekly-episode.ts, src/squad-manager.ts, src/fabric.ts, src/fabric-search.ts, src/server.ts, src/push.ts |
| [10 ask into fabric](10-ask-into-fabric.md) | Answers searchable + stale-answer resurfacing | mechanical | src/fabric.ts, src/fabric-search.ts, src/weekly-episode.ts, webapp commandPalette.ts |
| [11 voice episode delivery](11-voice-episode-delivery.md) | Spoken debrief of the episode; debrief-heard emission | architectural | webapp/src/lib/voice/*, sessionStore (post-#186) |

## Order
| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01, 05 | Independent substrates: attention store/API and teaching producers; no shared files |
| 2 | 02, 03, 06, 07 | Consumers of batch 1; pairwise-disjoint TOUCHES (02 webapp+CLI, 03 fog+route, 06 PR body, 07 doctor/fabric/CLI) |
| 3 | 04, 08, 09 | UI + episode; depend on 03/05/06 |
| 4 | 10 | Depends on 09's resurfacing slot |
| 5 | 11 | Voice delivery — unblocked (PR #186 merged 2026-07-15), lands after 09 |

## Dependency graph
| Concern | Blocked by | 30s check |
|---|---|---|
| 02 | 01 | `grep -q reportAttention webapp/src/lib/attention.ts` |
| 03 | 01 | `grep -q lastSeen src/attention.ts` |
| 04 | 03 | `curl daemon /api/fog returns entries` or `grep -q computeFog src/comprehension-fog.ts` |
| 06 | 05 | `grep -q model-delta src/squad-manager.ts` |
| 07 | 05 | `grep -q recordSymptom src/symptoms.ts` |
| 08 | 01, 05 | both checks above |
| 09 | 03, 05, 06 | checks above + `grep -q prBodyFor src/pr-body.ts` |
| 10 | 09 | `grep -q staleAnswer src/weekly-episode.ts` |
| 11 | 09 | episode API exists (`grep -q buildEpisode src/weekly-episode.ts`) |

## Not yet specified
- (none)

## Out of scope
- LLM-composed episode narrative — deterministic projection first; revisit with usage evidence
- GitHub-webhook pr-reviewed source; `git log --follow` rename tracking; per-org attention retention/purge UI — declared deferred in DESIGN.md
- Raw attention events in fabric/BM25 — privacy + churn (DESIGN.md)

## Decisions so far
- [DESIGN.md](DESIGN.md) — record-then-render inversion; compacted last-seen map; monotone debt; honest emission semantics (full red-team resolution table there)

## Notes
- Headless run (background job): EXPLORE/DESIGN/DECOMPOSE gates auto-approved per skill policy; user explicitly authorized execution ("make it a plan and execute").
- WIP snapshot at start: 315 plans with open work (oldest 2026-07-04); proceeded on explicit user instruction.
- Baseline in worktree `worktree-comprehension-lane`: webapp 1144 pass + tsc clean; root 2977 pass with one non-reproducing flake.
- Voice-loop (PR #186) NOT on main — concern 11 is the only voice-touching concern and is externally blocked.
- Research input: `plans/research-ndrstnd/BRIEF.md` (evidence anchors, explained omission, reading order, observed-only tests).

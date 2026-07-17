# `glance promote` — one-shot Tier-1/Tier-2 enrichment with human release
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/promote.ts (new), src/index.ts, src/server.ts, src/authz.ts, webapp/src/ (TaskDetail button), tests/promote.test.ts (new)
BLOCKED_BY: 03, 04

## Goal
A human (or later, an automation) triggers `glance promote <issue>` and gets back a Plane ticket whose body carries agent-authored Tier-1 context + Tier-2 implementation schema, fail-closed validated; the ticket stays in Backlog until a human drags it to Todo, which — with concern 03's gate flipped — is the release.

## Approach
- `src/promote.ts` (new): `promoteIssue(manager, repo, issueIdOrIdentifier)`:
  1. Fetch detail (`fetchIssueDetail`). **Refuse** `do-not-auto-land`/`[scout]`/`[observer]`-marked tickets with a clear message (red-team S7: auto-enriching quarantined LLM-self-generated work is injection amplification; a human can strip the marker first if they truly mean it).
  2. Idempotency: if the body already carries the promotion marker (concern 04) or `parseTier2` already yields non-empty sections, report already-promoted and stop.
  3. Run the enrichment through the **existing ask-mode entry point** — the manager's ask path, not a raw `create({ask})` (red-team S5: `ask()` also sets `task`, `autoRoute:false`, `track:false`; replicating it partially auto-routes the promoter into a build workflow). Prompt = the promote-issue skill's checklist (Tier-1: origin/why-non-trivial/options/recommendation; Tier-2: file paths+line ranges, acceptance test, verification gate, scope boundary, expected-vs-actual) ported into a self-contained prompt. Handle the WIP-cap throw at create (squad-manager.ts:4237-4244) by reporting "fleet busy, retry" rather than wedging.
  4. Fail-closed validation on the **injectable form** (red-team S7): truncate the draft to `OMP_SQUAD_SPEC_MAX_CHARS` exactly as `dispatchSpec` will (squad-manager.ts:1354-1366), then `parseTier2` (src/tier2.ts) — empty `acceptanceCriteria` or `verification` after truncation ⇒ no Plane write at all, error reported with the draft attached for the human. If the full body validates but the truncated one doesn't, say so explicitly (the fix is trimming Tier-1 prose, not raising the cap silently).
  5. Write via `updatePlaneIssueBody` (hash-guarded) with the promotion marker; leave state untouched (Backlog = unreleased; no custom "Promotion Review" state — two states express the machine once concern 03 gates dispatch).
- CLI: `glance promote <issue>` in src/index.ts; daemon endpoint `POST /api/issues/:id/promote` (authz: same write tier as spawn); webapp: a "Promote" button on TaskDetail for Backlog tickets rendering the result (small, included — the API does the work).
- Trigger economics recorded: measured ~2 promotable human tickets/week (live Plane, 2026-07-15) — no polling loop, no budget env, no custom state. If volume grows, a loop is a later concern that reuses everything here.

## Cross-Repo Side Effects
None.

## Verify
- `bun test tests/promote.test.ts` — refusal on quarantined titles; idempotent second call; fail-closed on empty verification after truncation; no Plane write on validation failure (mock).
- Live scratch-daemon pass: promote a real Backlog ticket end-to-end; confirm body enriched + marker present + state still Backlog; drag to Todo with `OMP_SQUAD_DISPATCH_STATES=unstarted,started` and watch it dispatch with the Tier-2 spec injected (check the unit's system prompt block).

## Resolution
Shipped on branch worktree-research-adw-software-factory (PR #183), merged as 373db2d with integration/audit follow-ups on the same branch (see EXECUTION-LOG.md). promoteIssue via the real ask() seam, truncation-aware fail-closed validation, quarantine refusal, CLI + POST /api/issues/:id/promote + webapp button; async route fix (30-min block vs 120s idleTimeout); post-audit: original body preserved under a tail heading + expectHash clobber guard wired (audit F5 / code-review [9]).

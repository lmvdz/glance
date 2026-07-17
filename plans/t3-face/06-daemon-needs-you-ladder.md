# Daemon needs-you ladder — one server-computed priority per unit

STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
MODE: hitl
TOUCHES: src/attention (lane), src/api (attention endpoint), src/types.ts, plans/daily-driver/01-charter-needs-you-ladder.md

## Goal

The daemon computes one priority state + `lastVisitedAt`/seen semantics per unit, exposed on an API the cockpit, webapp, and push lanes all consume. No client computes its own ranking. This executes the expansion of daily-driver charter H, whose written trigger ("a committed cockpit consumer") this program satisfies.

## Approach

**This concern is MODE: hitl** — it expands a charter whose expansion default was explicitly reserved for Lars, and it touches the daemon attention model that daily-driver locked. It must not be auto-executed by a headless pipeline. Lars merging the t3-face plan PR (or an explicit go) is the authorization; absent that, the program renders existing client states via concern 07 and this concern stays open.

When authorized:
1. Read `plans/daily-driver/01-charter-needs-you-ladder.md` in full and honor its locked constraints (single server-computed state; lastVisited/viewer semantics; boot-recompute rules already adjudicated there). This concern implements that charter; it does not re-decide it.
2. Define the priority state per unit — the t3 cascade adapted to fleet reality, ranked: `error`/landing-failure > pending-approval > awaiting-input > working/connecting > plan-ready > completed-unseen > idle. Map from existing fleet signals (agent status, pending approvals, lease/presence, landing state, transcript completion vs seen).
3. `lastVisitedAt`/seen is **daemon-side per viewer** so a completion read on the phone is not still "unseen" in the cockpit — this is exactly why it can't live in a client store.
4. Expose on the API (extend the existing attention lane / `/api/agents` payload or a dedicated `/api/attention`), with roll-up aggregation available (per project/daemon) since the spine's group headers need it.
5. Update the charter's STATUS/expansion ledger to reflect execution.

Follow model routing: this is judgment + a git-write-adjacent daemon path — cross-lineage review (codex AND grok) at implementation review time per the repo standing rule.

## Cross-Repo Side Effects

glance-desktop concern 07 consumes this endpoint. The webapp roster and push lanes become eligible consumers (not built here — this concern only provides the source of truth).

## Verify

- `curl <daemon>/api/attention` (or the extended agents payload) returns a single priority state + seen flag per unit and a roll-up per group.
- Two clients (cockpit + a second poller) agree on seen-state after one marks a unit seen.
- Existing daemon suite green; charter doc STATUS updated.
- Cross-lineage review clean on the attention/API diff.

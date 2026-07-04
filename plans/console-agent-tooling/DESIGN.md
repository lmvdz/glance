# Design: console-agent investigation tools

Origin: 2026-07-04 dogfood incident — the webapp assistant chat was asked "what's being worked on and what needs me?" and produced a correct-but-shallow answer: its only investigative tool (`squad_kb_search`) returned 0 results, so it could only reformat the injected snapshot. A direct Claude Code session answering the same question found duplicate tickets, an unreproducible regression, stranded fixes in four worktrees, and a waiting PR — all via reads the daemon could have served. This is the "context-poor units" failure (plans/research-direct-vs-glance) manifesting in the console agent itself.

Goal: give the console agent read-only investigation tools so fleet questions get investigated answers, not snapshot reformatting.

## Approach

Extend the existing host-tool mechanism (the `squad_kb_search` pattern — verified canonical: `HostToolDef` in `src/agent-driver.ts:23`, defs in `SQUAD_HOST_TOOLS` `src/squad-manager.ts:179`, dispatch in `onHostTool` `:3678`, handler + `tests/kb-tool.test.ts`) with:

1. A **tool registry module** (`src/console-tools.ts`) so each new tool is a self-contained `{def, handler}` object instead of another inline branch in `squad-manager.ts` — the dispatcher consults the registry before the generic human-gate path.
2. A **read-only classification** (`readOnly: true` on `HostToolDef`) — registry tools marked read-only run without the `PendingRequest` human gate (like `squad_kb_search` already does), but are still audited and transcript-noted, and still respect `toolGrants` when set.
3. A **console discriminator** — `console: true` persisted on the agent record (set by `POST /api/console`), so investigation tools are advertised to the console agent only, not to unit agents (units should stay focused; their context budget is for their task).
4. Four tools built on existing server-side reads: fleet status (roster + factory status + automation rollup), worktree inspect (`explore.ts` `worktreeDiff`/`changedFiles`), ticket lookup (`src/plane.ts` helpers), and a needs-attention summary (lean server-side assembly — NOT a port of the webapp's 34KB `insights.ts`).
5. A `CONSOLE_SYSTEM_PROMPT` update teaching investigate-before-answering.

## Key Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Gating for read-only tools | Run ungated (audited), like `squad_kb_search` | Human-gate every call; auto-supervise answering | Exposure-equivalent: every one of these reads is already served ungated to the webapp UI (`/api/agents/:id/diff`, `/api/automation`, `/api/plane/issues`) — the operator sees the same data one click away. `isRiskyRequest` treats ALL tool calls as risky (`:2837`), so gating would mean a human click per read, which is exactly the friction that made the chat useless. Mutating tools stay on the generic human-gated path. |
| Tool scoping | Console-only advertisement via persisted `console` flag | Give all agents the tools; infer console-ness from `name==="chat"` heuristically | Unit agents don't need fleet introspection and shouldn't spend context on it; name-heuristics break the moment someone renames. Flag must be persisted (`PersistedAgent`) to survive daemon restart re-adoption. |
| Registry vs inline branches | New `src/console-tools.ts` registry consulted by `onHostTool` | Keep adding branches in `squad-manager.ts` | Four+ tools as inline branches turns the dispatcher into a wall; a registry keeps each tool one self-contained, separately-testable object and makes the follow-on additions cheap. |
| Attention tool | Lean server-side assembly (pending requests, dirty worktrees, idle-with-turns-exhausted, factory status) | Port webapp `insights.ts` server-side | The 34KB port is a project of its own; the four signals above cover the operator's actual question and reuse existing reads. Overlap with OMPSQ-422's stranded-work item is deliberate — this tool is its read side. |
| Test execution tool | CUT (explicitly out of scope) | Reuse `verifyAgentWork`/`runMainGate` | Those take the repo land-lock and spawn docker — expensive, contended, and mutation-adjacent. The Verify button already exists for operators. Revisit only if investigated answers keep dead-ending at "run the test to know". |
| Output limits | Each handler self-caps (~8KB body, per-file diff caps) | Rely on runtime limits | Verified: no size limit exists in the host-tool result path; an uncapped `worktreeDiff` of a big refactor would flood the model's context. |

## Risks

- **Secrets in worktree diffs**: a unit's diff could contain a committed secret. Accepted: identical exposure already exists via the webapp diff panel and TaskDetail; the daemon's redaction chokepoint covers transcripts, and the tool result enters the transcript (so redaction applies — verify in tests).
- **ACP runtime**: `registerHostTools` no-ops for ACP agents (`:3670`); console is omp today. Tools must tolerate absence (already the pattern).
- **Registry bypasses the grant gate order**: dispatch order must be registry-check AFTER `toolGrants` evaluation for grant-restricted profiles, or read-only tools on a restricted profile silently widen its surface. Concern 01 pins this with a test.
- **Roster/diff calls per attention query**: `changedFiles` per agent is a git subprocess per unit; cap at the active roster (≤ dozens) and run concurrently — measured acceptable; do not scan archived agents.

## Open Questions

None blocking. One deliberate deferral: whether the console agent should also receive the fabric cold-start primer (`buildContextPrimer`) — today it's gated on `featureId`, which consoles lack. Left out; the tools make live state queryable, which supersedes a static primer for this use case.

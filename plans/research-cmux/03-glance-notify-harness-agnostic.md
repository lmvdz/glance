# (v2, DEFERRED) harness-agnostic `glance notify` + AttentionEvent
STATUS: blocked
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: research
TOUCHES: src/types.ts, src/index.ts, src/squad-manager.ts, src/server.ts, scripts/, .claude/settings.json (v2 — not built in v1)

## Goal
Let a unit on **any** harness (omp/pi/claude-code/codex/opencode/gemini) explicitly declare "I need a human, here's why [+ blocking]" — agent-*declared* attention, not just daemon-*inferred*. This is the genuinely-new capability from the cmux research (BRIEF.md pattern #2). It is **deferred to v2**: v1 already delivers the loved feature (background push on inferred blocks) without it, and the draft's v1 version was broken in three ways (below).

## Why deferred, not built in v1
- **Redundant for the omp 80%**: omp units already have the `squad_report` host tool (`squad-manager.ts:192,5150-5168`) → `AgentReport` → a `report` attention row. The new capability only earns its keep for **non-omp harnesses that lack a host-tool channel** (`registerHostTools` returns early for `runtime==="acp"`, `squad-manager.ts:5045-5048`).
- **Not what makes the feature loved**: the loved half is *delivery to a device you're not staring at* — shipped in v1. Agent-declared attention is a quality upgrade on the *source*, valuable but secondary.

## Corrected design (the v1 draft was killed by 2 red teams — build it THIS way)
1. **Ingress**: a `{ type: "notify" }` `ClientCommand` variant over the existing `POST /api/command` (bearer-gated). Add `case "notify"` to the CLI switch (`src/index.ts:765`), reusing `postCommand` (`src/index.ts:180-190`).
2. **Identity — do NOT resolve by worktree path.** `worktree === repo` for in-place/flagship/operator units and for the human's own cwd (`worktree.ts:151`, invariant across `proof.ts`/`land.ts`), so path-matching is ambiguous and misattributes the human's own hook fires. Instead: the daemon **writes the agent id into a per-worktree marker file at spawn** (alongside the `convergence/armed` sentinel pattern); the hook reads it and passes an explicit `id`. Reject on ambiguity.
3. **Blocking — do NOT synthesize a `PendingRequest`.** A `PendingRequest` is the correlation id for a Promise the agent-host is awaiting; a synthetic one has no awaiter, so the operator's answer routes to `respondHostTool` against a non-existent promise and is **black-holed** (`squad-manager.ts:3703-3708`, `types.ts:62-65`), and the "block" is cosmetic (an HTTP POST from a hook can't suspend the harness turn). Real blocking for a non-omp harness needs a real suspend mechanism (e.g. the hook script itself blocks the harness while polling the daemon) — design that explicitly. Non-blocking notify is safe and should ship first.
4. **Data model**: a new `AgentDTO.attentionEvents[]` of type `AttentionEvent { id; summary; detail?; blocking; source: "notify" | "inferred"; createdAt }` — parallel to `reports[]`, not overloading `AgentReport`. Surfaces via a new branch in `attentionItems()`.
5. **Hook install**: a committed `scripts/notify-hook.sh` + `.claude/settings.json` stanza inherited by every worktree — but it **must** gate on (a) Claude Code's `notification_type` (only genuine "needs input", not every idle/permission event) and (b) the per-worktree spawn marker from (2), so it **no-ops in the human's own glance sessions and the main checkout** (otherwise every developer running Claude Code in glance self-DoSes the daemon). Verify what Claude Code's `Notification` hook actually fires on before wiring.
6. **Push stays blocking-only.** If v2 wants push on agent-declared *blocking* events, widen `escalationPayload` then — never on non-blocking notifies/stalls (fatigue).

## Verify (when built)
- A non-omp unit (claude-code) calls the notify hook → an `attention` row appears in the panel, attributed to the correct unit, with no misfire from the operator's own session.
- A `--blocking` notify actually suspends the harness and the operator's answer reaches it (no black-hole).

## Resolution
Deferred at v1 close. Pick up as its own `/plan` + PR. v1 (concerns 01-02) ships the loved feature without it.

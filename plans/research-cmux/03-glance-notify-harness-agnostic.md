# (v2) harness-agnostic `glance notify` + AttentionEvent
STATUS: closed

## v2 buildable scope (CORRECTED after claude-code-guide + explore, this pass)
**Key finding: glance runs NO `claude-code` unit driver.** Real drivers are omp (`RpcAgent`, has the host-tool channel) and generic ACP (`auggie --acp`, no host-tool channel); "claude-code" is only a passive cost-*ingester* (`src/ingest/claude-code.ts`), never spawned. So the committed Claude Code Notification-hook + spawn-marker identity is **moot until glance drives claude-code** — CUT from this pass (kept in Deferred below). Claude Code's `Notification` hook *can* filter to matcher `idle_prompt` and must be env-gated (`$GLANCE_AGENT_ID`) to avoid firing on the human's own repo sessions — recorded for when it's real.

What ships this pass (non-blocking attention lane, harnesses glance actually runs; push stays status-driven per v1 red team — NO push widening):
1. **Wire** — `AttentionEvent { id; summary; detail?; source: "notify"|"tool"|"harness"; createdAt }` in `src/types.ts`, `AgentDTO.attentionEvents?: AttentionEvent[]` (live/run-scoped, append-only, mirrors `reports`), mirrored in `webapp/src/lib/dto.ts`. New `{ type: "notify"; id; summary; detail? }` `ClientCommand` (`src/types.ts:1108`).
2. **Operator/scriptable ingress** — `glance notify <id> "<summary>" [--detail x]` CLI (`src/index.ts`, `case "notify"` + `cmdNotify`, mirrors `cmdPrompt`) → `applyCommand` `case "notify"` resolves `this.agents.get(id)`, appends `AttentionEvent{source:"notify"}`, `emitAgent`. This is the `cmux notify` analog — any program/CI/hook can raise attention on a unit.
3. **omp in-band** — `squad_attention` host tool (sibling of `squad_report`, `SQUAD_HOST_TOOLS` @ `squad-manager.ts:199`), `onHostTool` dispatch + `handleAttentionTool` → append `source:"tool"`.
4. **Un-black-hole the harness notify** — `onUi` `req.method === "notify"` (`squad-manager.ts:5024`) today only appends a transcript line; ALSO append an `AttentionEvent{source:"harness"}` + `emitAgent`, making the inert RPC notify protocol a real attention row.
5. **Surface** — new `for (const e of a.attentionEvents ?? [])` branch in `attentionItems()` (after the `reports` branch, `insights.ts:591`) → new `AttentionKind` `'attention'` (add to the union @ `insights.ts:434`), severity `warn`, action `View`. Tests: insights branch + squad-manager (notify command, squad_attention tool, harness-notify wiring).

Identity is by **explicit id** (operator knows it from the dashboard; omp tool/harness-notify already have `rec`) — the worktree-path trap is avoided by not path-matching at all. No spawn marker needed this pass.

## Original goal
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
**v2 attention lane SHIPPED** (non-blocking, harnesses glance actually runs). `AttentionEvent` type + `AgentDTO.attentionEvents[]` (src + webapp mirror, byte-identical), `{type:"notify"}` ClientCommand, `glance notify <id> "<summary>" [--detail]` CLI, `squad_attention` omp host tool, and the previously-black-holed `onUi` harness notify now appended as a `source:"harness"` attention event. Surfaces as a new `'attention'` warn row in `attentionItems()` (no AttentionPanel change — severity-keyed grouping). Root typecheck clean; backend 1562 pass (+5 integration tests, +1 pre-existing kb-tool fix); webapp insights 70 pass. **Live-driven**: `glance notify` against a real unit on a throwaway daemon → DTO carries the AttentionEvent, status stays `working`, 0 pending (non-blocking contract holds — no synthetic PendingRequest).

**Still deferred (moot until glance drives claude-code units):** the committed Claude Code Notification hook (matcher `idle_prompt`, env-gated on `$GLANCE_AGENT_ID` to avoid firing on the human's own repo sessions) + spawn-written id marker + a real blocking-suspend mechanism (fake PendingRequest is a category error — see above). glance runs no claude-code driver today; revisit when it does.

# Epic E — Chat↔unit escalation

Parent: plans/fleet-first-ide/00-meta.md · Charter: plans/fleet-first-ide/04-chat-unit-escalation.md
Expanded 2026-07-15 (trigger met: Epic I complete-on-delivery — I01/I02/I03/I04 merged, I05 gd#19 in-review). Grounded on a two-repo surface map (daemon spawn/session/gate surface + fork ai-module/fleet-module), file:line refs per concern.

## Outcome

Chat and units stop being two different things. A conversation in the cockpit's chat panel is **already a daemon unit at its smallest size** (a console session with a worktree), so "escalating" it into a gated, landable work unit is a re-wire in place — same session, same worktree, zero context loss — not a hand-off to a fresh agent. And a coding session a developer started outside the cockpit (`claude` in a terminal, detected via Epic B's hooks) can be **adopted** into the fleet: its uncommitted work is captured into an isolated worktree and wrapped in a gated unit. The through-line: one substrate (the daemon unit) presented at three sizes — chat, promoted unit, adopted unit — with the human moving fluidly between them.

## Ground truth (from the surface map — consume, don't rebuild)

**The load-bearing insight: seeding a foreign transcript is theater.** The daemon's `AgentRecord.transcript` (`src/squad-manager.ts:623`) is a **mirror** of what the harness emitted over ACP, never an input to it. A new unit's harness (claude-code/codex/etc.) opens its OWN session and only ever sees its first `task` prompt (`CreateAgentOptions.task`, `src/types.ts`; sent on ready). So there is no way to make a *fresh* unit "aware" of a prior chat except by re-briefing it in the opening prompt — which loses the real context (that context lives in the harness's own session, not the daemon mirror). **Therefore the faithful escalation is promote-IN-PLACE**: the chat must already BE a daemon unit, and promotion re-wires that same unit. This is why E01 (daemon-backed chat) is the substrate E02 (promote) sits on, not an optional nicety.

**Daemon — EXISTS:**
- **Spawn funnels through one chokepoint**: `SquadManager.create()` → `createWithId()` (`src/squad-manager.ts:4117,4136`). HTTP entry `POST /api/command {type:"create", options: CreateAgentOptions}` (`src/server.ts:2520,2531`), operator-tier. `CreateAgentOptions` (`src/types.ts:1107-1197`): **only `repo` required**; `task?` (opening prompt), `existingPath?` (reuse a dir, no worktree cut), `autoRoute?`, `verify?`/`verifyMode?`, `workflow?`, `appendSystemPrompt?`, `autonomyMode?`, `adopted?`/`cold?`.
- **The console unit is the closest thing to a "chat"**: `POST /api/console {repo?, model?, profileId?}` (`src/server.ts:2321`) → `create({repo, name:"chat", autoRoute:false, appendSystemPrompt: CONSOLE_SYSTEM_PROMPT})` (`:2326`; prompt at `:193` — "do not create features/worktrees/commits unless asked"). `autoRoute:false` ⇒ **no gate**. Still cuts a worktree.
- **Transcript over HTTP** (I01): `GET /api/agents/:id/transcript?since=<seq>` → `TranscriptEntry[]` with monotonic `seq`. A console unit is a normal `AgentRecord`, so its transcript is readable the same way.
- **Steer into the same ACP session**: `POST /api/command {type:"prompt", id, message}` — every turn is one conversation (the invariant Epic I is built on).
- **Gate = the verify loop**, auto-wired in `createWithId` (`:4260`) ONLY when `task` present AND `autoRoute !== false` AND the repo has a detectable verify command (`routeIntake` → `detectVerify`, `src/intake.ts:63,157`). `isLandingUnit(rec)` (`src/is-landing-unit.ts:60`) is true by default (any non-observer/non-flue/non-observe unit).
- **Harness hooks (B03)**: `POST /api/harness-events {harness, event, sessionId, cwd}` (`src/server.ts:1701`, `src/harness-hooks.ts`) → presence claim `harness:<sessionId>`, source `"other"` (drops events whose cwd isn't a registered project). Only `claude-code` is `verified`.

**Daemon — MISSING (the additive daemon work):**
- No **promote** primitive: nothing re-wires a console unit into a gated landable unit (clear the console restriction, wire verify, flip autonomy) in place. E02 adds it.
- No **seed-from-transcript / conversation fork**: `create()` always starts `transcript:[]`; `fork()` (`:5454`) is workflow-checkpoint-only, carries no transcript. (Confirms promote-in-place is the only faithful path.)
- No **diff-intake / adopt-external-dir**: diff helpers only READ existing units; `existingPath` points a unit at a dir but captures/isolates nothing. Adopting an ad-hoc session needs: capture the cwd's `git diff` → fresh worktree → apply → briefed gated unit. E03 adds it.

**Fork (glance-desktop) — EXISTS:**
- **Chat**: `src/modules/ai/` — Vercel AI SDK, `UIMessage`, zustand `chatStore` (`store/chatStore.ts`), transport factory `createContextAwareTransport` (`lib/transport.ts:75`) cast to `ChatTransport<UIMessage>` and selected in `chatRuntime.makeChat` (`store/chatRuntime.ts:21,101`). Direct BYOK, streams through the Rust `ai_http_stream` proxy (`lib/proxyFetch.ts`). **Exactly one transport implementation** — a daemon-backed one is a second `ChatTransport` selected there.
- **FleetClient** (`src/modules/fleet/lib/fleetClient.ts`): roster/diff/transcript/leases/interrupt/setMode/claimPresence/releasePresence/steer/health. **No spawn/promote/adopt** — E01–E03 extend it.
- **Additive surface pattern** (established across C04–C08): Tab-kind + `newXTab` factory (`src/modules/tabs/lib/useTabs.ts`) → render in `WorkspaceSurface.tsx` → palette command via a `ctx.*` callback wired in `App.tsx` → cross-module actions via a `setX/getX` App-registered singleton (`worktreeOpener.ts`, mirrors `setLspNavigator`).
- **Worktree→Space** (C06): `getWorktreeOpener().open({name, worktree})` — a promoted/adopted unit opens in place through the exact same singleton. Openability gated by `isLoopbackDaemon` (remote daemons can't cd).
- **CSP**: `connect-src` allows `http://127.0.0.1:*`/`http://localhost:*`, **no `ws://`** (`src-tauri/tauri.conf.json:28`) → daemon chat streaming is HTTP-poll or HTTP-SSE, never a socket. Same constraint Epic I lives under.
- **Notification bell** (`src/modules/agents/components/NotificationBell.tsx`): keyed to local terminal PTY leaves (`tabId`/`leafId`), NOT daemon units. Fleet has a separate `fleetBell.ts`. "Adopt from the bell" is unbuilt.

**Constraint carried into every concern (DB mode):** create/console/prompt = operator; **land = admin**; `/api/agents/:id/open` is refused in DB mode (host-actuating). So in a multi-tenant daemon an org member can chat and promote but cannot land, and cannot open a worktree as a host Space. The cockpit already reflects this (loopback-gated open). v1 targets the loopback/single-tenant developer daemon; DB-mode land/open stay admin/host-gated.

## Work

| Concern | Repo | Why it exists | Complexity | Depends |
|---|---|---|---|---|
| 01 daemon-backed-chat | glance-desktop (+ tiny omp-squad) | the ai-module chat gains a daemon transport: a `/api/console` unit created lazily, turns sent via `POST /api/command {prompt}`, replies rendered by polling `transcript?since` (I01) → `UIMessage`. The chat IS a unit (visible in roster), so it is promotable. The substrate. | architectural | I01 (merged) |
| 02 promote-in-place | omp-squad + glance-desktop | daemon `POST /api/agents/:id/promote`: atomically re-wire a console/chat unit into a gated landable unit — clear the console system-prompt restriction, wire a verify workflow, flip autonomy — KEEPING the same worktree + transcript (zero context loss). Cockpit "Promote to unit" button → open the worktree as a Space. **WRITE to run-state + gate wiring → codex+grok cross-lineage review REQUIRED.** | architectural | 01 |
| 03 adopt-adhoc-session | omp-squad + glance-desktop | daemon `POST /api/agents/adopt {harness, sessionId, cwd}`: capture the cwd's `git diff`, cut a fresh worktree, apply the diff, create a briefed gated unit. Cockpit surfaces adoptable B03 presence sessions (`harness:<sessionId>`, source "other") in the bell/roster with an "Adopt" action. **git-write + spawn → cross-lineage review REQUIRED.** Highest risk. | architectural | B03 (merged) |

## Order

| Batch | Concerns | Why |
|---|---|---|
| 1 | 01 | independent, cockpit-primary; reuses I01 delta + steer; ship first — it's the substrate promote sits on |
| 2 | 02 | needs 01 merged (it promotes 01's console unit in place); the first daemon-write concern in Epic E → full gauntlet |
| 3 | 03 | independent of 01/02 (leans on B03, merged); hardest — git-write diff-intake; sequence after 02 for review bandwidth. p3-friendly: Epic E's chat↔unit core (01+02) delivers without it |

## Discipline (inherited from the meta-plan)

- **Daemon concerns (02, 03)**: omp-squad worktree, standard gate (`bun test` with node_modules/.bin on PATH + scratch-daemon live verify). Both are WRITEs to run-state / git — **codex AND grok cross-lineage review before the PR** (the promote re-wire mutates a live unit's gate+autonomy; adopt does a git apply into a fresh worktree + spawns). New HTTP bodies go through Effect Schema decode (never cast). Authz deliberate: promote is operator (it drives an existing unit the operator already owns); adopt is operator (it spawns) — landing the result stays admin.
- **Cockpit concerns (01, and the UI half of 02/03)**: glance-desktop, additive `src/modules/ai/` + `src/modules/fleet/` only, gate = tsc+lint+vitest+build (cargo check with the PKG_CONFIG_PATH fix). Poll, never `ws://`. The daemon-backed chat transport reuses the I01 transcript-delta store + `steer`; it does NOT invent a socket.
- **The ACP-not-keystroke invariant holds end to end**: the daemon-backed chat sends every turn via `POST /api/command {type:"prompt"}` (one ACP session), and promote keeps that same session — never a PTY/keystroke path.
- **Promote-in-place over seed-a-new-unit is load-bearing, not a preference**: seeding a fresh unit's transcript would be theater (the harness owns its context). Any concern that drifts toward "start a new agent briefed with a digest" must justify it as an explicit *fallback* (e.g. promoting a purely-local BYOK chat that was never a daemon unit), never the spine.

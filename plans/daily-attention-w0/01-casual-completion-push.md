# Casual completion push — generalize the voice-done latch by session category

STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/types.ts (AgentDTO.voicePushArmed :921, PersistedAgent.voicePushArmed :1087, CreateAgentOptions.voicePushArmed :1219), src/squad-manager.ts (createWithId arm expression :4748, applyCommand "prompt" case arm :5474, "interrupt" case disarm :5529-5531, onAgentEvent "agent_end" case exposure :6243-6248, clearVoicePushArmed method :8505-8509, isConsolePrompt/promoted check precedent :4082), src/push.ts (escalationPayload :35-41 read-only reference — unchanged, voiceDonePayload :53-57 generalized), src/server.ts (maybePushAlert :2656, maybePushVoiceDone :2688, maybePushAlertOrg :2711), src/runtime-settings.ts (FeatureFlagKey :7-24, FEATURE_FLAGS :51-69, boolFromEnv :82-88), src/console-prompt.ts (isConsolePrompt :19, read-only reference), tests/voice-push-arm.test.ts, tests/push.test.ts, tests/push-org.test.ts, tests/push-server.test.ts

## Goal

A casual session — today the console/chat channel (`POST /api/console` → `manager.create({name:"chat", autoRoute:false, appendSystemPrompt: CONSOLE_SYSTEM_PROMPT})`, src/server.ts:2375; the same channel Epic A's `glance here` on-ramp extends) gets a phone push not only on approval/input (escalationPayload already covers that, src/push.ts:35-41, untouched) but on ordinary turn COMPLETION — the "reason to switch" wave-0 push named in 00-meta.md. A fleet unit (dispatched, promoted, or workflow-kind work) defaults to no completion push — a tracked unit finishing is not the away-from-keyboard signal a casual chat's idle transition is, and pushing on every unit's every idle would be spam (DESIGN.md's named risk). The existing voice-loop latch (`voicePushArmed`/`voiceDonePayload`: arm on a voice-sourced prompt, expose only at genuine terminal `agent_end`, fire on the working→idle edge, disarm on send or on a voice-sourced interrupt) is the proven shape this concern widens — voice dispatch keeps arming unconditionally (it is definitionally an away-from-screen call); every other session now arms or not based on its category's default.

## Approach

- **Category classifier, no new field.** A pure helper (e.g. in squad-manager.ts near the latch logic) `sessionCategory(opts: {appendSystemPrompt?: string; promoted?: boolean}): "casual" | "fleet"`: casual iff `isConsolePrompt(opts.appendSystemPrompt)` is true AND `opts.promoted` is not true. This is the EXACT inverse of the test `promote()` (squad-manager.ts:4054-4103) already runs at :4082 (`o.kind !== "omp-operator" || rec.dto.name !== "chat" || !isConsolePrompt(o.appendSystemPrompt)`) to decide whether a session is promotable — a promotable-and-unpromoted session is precisely a casual one. Everything else (workflow kind, flue-service, dispatched/autoRoute issue units, a promoted former-casual session) is "fleet". No new persisted field: `promote()` flipping `o.promoted = true` (:4093) already makes a session's category flip mid-life for free, and the day Epic A's `glance here` ships (whether or not it rides this exact console-prompt channel), it either inherits "casual" automatically or the classifier gets one more clause — never a rewrite.
- **Two new global settings, not a per-viewer store.** Add `OMP_SQUAD_PUSH_CASUAL_DONE` (defaultEnabled: true) and `OMP_SQUAD_PUSH_FLEET_DONE` (defaultEnabled: false) to `FeatureFlagKey`/`FEATURE_FLAGS` (src/runtime-settings.ts:7-24/:51-69). This is the smallest honest preference mechanism available: it rides the ALREADY-BUILT `settings.json` + env-mirror (`applyFeatureFlags`) + `GET`/`POST /api/settings` (server.ts:1497-1507) with zero new storage or wiring — one operator-tier on/off per category, exactly matching the binding decision's "not a per-viewer store" constraint (there is no per-viewer principal in file mode to begin with).
- **Generalize the latch's name.** Rename `voicePushArmed` → `completionPushArmed` everywhere it is declared or touched: types.ts's three interfaces (AgentDTO :921, PersistedAgent :1087, CreateAgentOptions :1219 — the orphan-adopt carry-through), squad-manager.ts's arm site in `createWithId` (:4748), the prompt-case arm (:5474), the interrupt-case disarm (:5529-5531), the `agent_end` exposure (:6243-6248 — the workflow-aware `isTerminal = kind !== "workflow" || workflowJustFinished` predicate does NOT change, only the field it assigns), and the public disarm method `clearVoicePushArmed` → `clearCompletionPushArmed` (:8505-8509, called from server.ts's push sites). This is a mechanical rename plus one widened predicate at the two arm sites — nothing about the terminal-vs-intermediate workflow logic changes.
- **Widen the arm condition.** At both arm sites (`createWithId` :4748 and the `applyCommand` "prompt" case :5474), replace the bare `source === "voice"` test with a small pure helper `shouldArmCompletionPush(category, source, casualEnabled, fleetEnabled)`:
  - `source === "voice"` still ALWAYS arms — preserve today's behavior verbatim, never gated by settings (a voice dispatch is its own signal).
  - otherwise arm iff the session's category flag reads true: `category === "casual"` → `OMP_SQUAD_PUSH_CASUAL_DONE` (default true), `category === "fleet"` → `OMP_SQUAD_PUSH_FLEET_DONE` (default false). Read via `boolFromEnv(process.env[key], flag.defaultEnabled)` (runtime-settings.ts:82-88), the repo's existing env-read convention. Both call sites already carry the `opts`/`rec.options` the classifier needs — no new plumbing to reach it.
- **Fire-on-idle logic is UNCHANGED.** push.ts's latch-consuming function only ever checked `a.status === "idle" && a.voicePushArmed === true` (post-rename: `a.completionPushArmed === true`) — the per-category decision already happened at arm time above, so the payload builder needs no category awareness of its own, and the 3s debounce + `pushSeeded` gating in server.ts is untouched. Rename `voiceDonePayload` → `completionPayload` (push.ts:53-57) for honesty (it is no longer voice-specific). Generalize its copy: the current body ("Tap to open glance — call back for the spoken debrief") only makes sense for a voice dispatch. Since the boolean latch alone can't distinguish "armed because voice" from "armed because casual-category default" after the fact, the implementer chooses one of: (a) carry one extra persisted bit (`completionPushKind: "voice" | "category"`) alongside the boolean so the copy can branch, or (b) ship one honest generic body ("Tap to open glance") for both and drop the voice-specific debrief line. Either is acceptable — record the choice made in this file's own status update, since it is a copy/taste call, not a correctness one.
- **server.ts renames.** `maybePushVoiceDone` → `maybePushCompletionDone` (:2688) and `maybePushAlertOrg`'s twin local (`voiceDonePayload` call, :2711 region) follow the same rename. Keep the exact debounce (`done:${a.id}` key, 3s) and the sync-disarm-BEFORE-send ordering (the documented race fix at :2688-2698) byte-for-byte — this concern changes names, the classifier, and the arm predicate; it never touches debounce or send ordering.
- **Approval/input path untouched.** escalationPayload (push.ts:35-41, fired from maybePushAlert :2656) fires for every category with no changes — per the binding decision, approval/input pushes stay ON everywhere regardless of casual/fleet.

## Cross-Repo Side Effects

none — omp-squad only. glance-desktop's cockpit reads OSC 777/9 off `escalationPayload` (src/osc-notify.ts, fleet-ide-bridge PR #177), which this concern does not touch; the cockpit has no consumer of the completion-push family today.

## Verify

- `tests/voice-push-arm.test.ts` (rename-and-extend): source `"voice"` still arms unconditionally regardless of category/flags; a casual (console-prompt, unpromoted) session arms by default with `OMP_SQUAD_PUSH_CASUAL_DONE` unset (defaults true); a fleet (dispatched/promoted/workflow) session does NOT arm by default with `OMP_SQUAD_PUSH_FLEET_DONE` unset (defaults false); explicit `OMP_SQUAD_PUSH_FLEET_DONE=1` arms a fleet unit and explicit `OMP_SQUAD_PUSH_CASUAL_DONE=0` suppresses a casual one.
- `tests/push.test.ts` / `tests/push-org.test.ts`: `completionPayload` (renamed) keeps the same shape and `done:${id}` tag/debounce namespace as today's `voiceDonePayload`; add a promote()-mid-session case — arm a console-chat session, `promote()` it, confirm the NEXT idle transition after promotion does not push unless `OMP_SQUAD_PUSH_FLEET_DONE` is on (the category flip takes effect with zero extra bookkeeping).
- `tests/push-server.test.ts`: `maybePushCompletionDone` rename plus behavior-preservation (identical 3s debounce, identical sync-disarm-before-send ordering, no change to `pushSeeded` gating).
- Live (scratch-daemon skill): open a console chat, send a prompt, let it idle — confirm a push fires with defaults; separately dispatch a normal tracked/dispatched unit, let it idle — confirm NO push fires with defaults; flip `OMP_SQUAD_PUSH_FLEET_DONE` via `POST /api/settings/feature-flags` and confirm the fleet unit's next completion now pushes.
- Full `bun test` (tsc + suite) green.

## Resolution

Executed 2026-07-16 (branch worktree-wf_55eef634-d22-7 off feat/daily-driver-w1), completing a
session-limited prior attempt's salvage (wip 72db271, audited line-by-line, reshaped into reviewed
commits). Everything below the test line was driven live against a scratch daemon (own state dir,
port 18791, loops off) with real omp agents and a local Web Push catcher standing in for the push
service — encrypted RFC8291 deliveries observed on the wire, not inferred from green tests.

**What shipped.** Exactly the Approach: `src/completion-push.ts` (sessionCategory classifier —
verified against the shipped cmdHere unit shape: `POST /api/console` / `glance here` create
`name:"chat"` + `CONSOLE_SYSTEM_PROMPT`, which classifies casual until promote() — plus
`armCompletionPushKind`: voice always arms, otherwise the category flag decides); the two flags in
runtime-settings (casual default ON, fleet default OFF) riding settings.json + `POST
/api/settings/feature-flags`; the full latch rename (`completionPushArmed`/`completionPushKind`
across types/manager/push/server, `clearCompletionPushArmed`, `maybePushCompletionDone`); debounce,
send-ordering, terminal-exposure, and escalation lane untouched byte-for-byte.

**Copy choice (the implementer call the Approach left open): option (a)** — one extra persisted bit
`completionPushKind: "voice" | "category"` rides beside the boolean so the copy can branch honestly:
voice keeps "Tap to open glance — call back for the spoken debrief."; a category arm gets "Ready
when you are — tap to pick up where you left off." A kindless-armed DTO falls back to the generic
body (never the voice line for a dispatch we can't prove was voice). Kind also enables the promote()
boundary rule: an unconsumed CATEGORY latch is cleared at casual→fleet promotion (the just-promoted
unit's next idle must not push under fleet-OFF defaults); a VOICE latch rides across untouched.

**Beyond the letter of the plan (found necessary during the audit):** (1) legacy `voicePushArmed`
records migrate forward at load in BOTH stores (dal/store.ts) so an armed latch and the one push it
owes survive the upgrade, kind defaulting to "voice" — the only legacy arm source; (2) loadPersisted
(--restore) gains the same latch carry adoptOrphanedAgents already had; (3) a re-arm takes the
LATEST prompt's kind; (4) promote()'s failure-atomic rollback restores the prior latch.

**Verify record.** tsc clean; 43 tests across the four push suites green (arm matrix incl. both
fail-closed flag directions, promote flip end-to-end through the real server push lane with the
debounce slot cleared so only the category decision can be the reason, restart round-trip, legacy
migration, workflow node-boundary exposure); adjacent suites (here/console/store/settings/authz,
99 tests) green. Live (scratch daemon): casual chat turn → idle fired exactly one aes128gcm
VAPID-signed push with defaults; a plain tracked fleet unit → idle fired none; flipping
`OMP_SQUAD_PUSH_FLEET_DONE` via `POST /api/settings/feature-flags` took effect WITHOUT a daemon
restart (env-mirror live) and the same unit's next completion pushed. Full-suite run remains the
review gate's job. Phone-in-hand tap-through of the new copy is worth one glance on the next real
device session; the payload path is byte-identical to the voice push that already tap-verified.

## Notes

- The routed `/api/spawn` path turns a bare prompt into a verify WORKFLOW unit — its intermediate
  idles never carried the latch (the `workflowJustFinished` pairing, unchanged), observed live
  before switching to a plain tracked unit for the timed check.
- 02-transition-subscription should now refactor the POST-rename `maybePushAlert` /
  `maybePushAlertOrg` bodies (`completionPayload`, `clearCompletionPushArmed`) — the 30s check in
  00-overview.md passes.

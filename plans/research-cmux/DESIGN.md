# Design: Push-based blocked-agent attention (cmux "Notification Rings" for glance)

## Outcome
When a unit blocks on a human, the operator's **phone/desktop buzzes with the unit name, the reason, and a one-tap deep link — even with the glance tab closed or the laptop asleep.** This is the single most-loved feature in the orchestration category (cmux's Notification Rings), delivered on glance's web-app form (which, unlike cmux's macOS-only app, reaches any device).

## Approach
The adversarial design pass (2 independent red teams) overturned the original draft. **The loved half of this feature already exists in the codebase and just isn't wired to the React app.** glance ships a complete RFC-8291 VAPID web-push stack — `src/push.ts` (`PushService`), `GET /api/push/key`, `POST /api/push/subscribe`, `maybePushAlert` → `escalationPayload` firing a real background push on every transition into `input`/`error`, with the reason in the body, a `/#/agent/<id>` deep link, and `tag`-collapse + 3s/agent debounce — plus a full service worker (`src/web/sw.js`) and manifest/icons served **tokenless at the React app's own origin** (`PUBLIC_ASSETS`, `src/server.ts:117-122`). It is consumed only by the legacy `src/web/index.html`. The React `webapp/` has **zero** push wiring (verified).

So v1 is: **point the React app at the push backend that already works.** ~30-50 lines of already-written code (copy `subscribePush()` + `urlB64ToUint8Array` from `src/web/index.html:2473-2492`, register `/sw.js`, request permission on a user gesture, add a Settings toggle). No backend change. Plus a cheap, real win: a **blocked-longest sort** on the existing attention panel.

The genuinely-new capability from the research — a harness-agnostic `glance notify` CLI so attention can be *agent-declared* across non-omp harnesses — is **deferred to v2** (concern 03), because: (a) omp units already have `squad_report` for this; (b) glance already *infers* blocked state well enough that push fires without agent cooperation; and (c) the draft's v1 version of it was shown to be broken (see Red Team Concerns).

## Key Decisions
| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| What is v1 | Wire the **existing** VAPID/SW push into the React app | Build the new `glance notify` CLI + `AttentionEvent` type first (the draft) | The loved feature is *delivery to a device you're not staring at*. That already exists server-side; the React app just never subscribed. Building the CLI first ships the deferrable half and defers the core. |
| Push delivery mechanism | Service-worker web-push (existing `PushService`) | Foreground `new Notification()` from `useSquad.ts` (the draft) | Foreground-only fires only while the tab is open/focused — the weakest possible version, and it throws away glance's web-app edge (a phone can't hold a tab open). The SW renders notifications app-closed. |
| Push signal threshold | **Blocking-only** (`input`/`error` transition), unchanged | Widen to non-blocking notifies + stalls + reports (the draft) | cmux rings are loved *because* high-signal. Pushing on every event trains the operator to ignore it — the exact failure that kills ambient-notify. Non-blocking stays a quiet panel row. |
| Backend changes in v1 | **None** | Widen `escalationPayload`, add a stall-sweep synth loop | `escalationPayload` already carries name+reason+deeplink+collapse. Stalls already render as a client-side `stalled` row (`insights.ts:574`). |
| `glance notify` CLI + `AttentionEvent` type | **Defer to v2** (concern 03, corrected design captured) | Ship in v1 | Redundant with `squad_report` for the omp 80%; the draft's identity/hook/blocking mechanisms were all broken (see below). Needs its own design cycle. |
| blocked-longest ranking | Sort param on `attentionItems()` + panel toggle | Separate "queue" tab | 20-line change on the existing gold-standard panel vs a new tab with duplicated load/action wiring. |

## Risks
- **iOS web-push requires the PWA be added to the home screen.** The `manifest.webmanifest` + icons are already public assets, so the install path exists — but the plan must link the manifest from the React `index.html` and state the home-screen caveat honestly. This is a platform constraint identical to cmux needing macOS, not a glance gap.
- **`/sw.js` SHELL pre-caches `/`, `/manifest.webmanifest`, `/icon*`** — all confirmed to exist as public assets, so `install` won't 404. If the React app is served under a base path other than `/`, the SW scope must be checked.
- **Permission must be requested on a user gesture** (browser rule) — the Settings toggle is the gesture; do not auto-request on load. On load, only *re-subscribe silently* if permission is already `granted`.

## Red Team Concerns Addressed
| Concern | Severity | Resolution |
|---|---|---|
| Draft's foreground `new Notification()` misses the goal (fires only while tab open) & squanders glance's web-app edge | critical | **Cut.** v1 uses the existing service-worker background push. |
| Draft defers the loved half (background delivery) and builds the deferrable half (the CLI) — scope inversion | critical | **Priority flipped.** v1 = delivery wiring; CLI → v2. |
| `--blocking` as a synthetic `PendingRequest` is a category error — no awaiter in agent-host, so the operator's answer is routed to `respondHostTool` against a non-existent promise and black-holed; the "block" is cosmetic and never clears (`squad-manager.ts:3703-3708`, `types.ts:62-65`) | critical | **Cut from v1.** Real blocking for non-omp harnesses needs a real suspend mechanism — a v2 design problem, documented in concern 03. |
| Committed `.claude/settings.json` Notification hook fires on permission prompts + idle (not just blocks) and leaks into the **human's own** glance sessions → daemon self-spam | significant | **Deferred to v2** with the fix specified: gate on `notification_type` + a per-worktree spawn marker (like `continue-loop.sh`'s `armed` sentinel), so it no-ops in human/main-checkout sessions. |
| Resolving agent by worktree path collides for in-place agents (`worktree === repo`), flagship/operator, and the human's cwd; nested/sandbox cwd ≠ host worktree | significant | **Deferred to v2**; corrected approach = explicit agent id written into a spawn-time worktree marker, worktree-path only as a rejected-on-ambiguity fallback. |
| New `AttentionEvent` type redundant with shipped `squad_report`/`AgentReport` for the omp 80% | significant | v2 builds it only for the non-omp harnesses that lack a host-tool channel — where it earns its keep. |
| Notification fatigue from pushing on non-blocking + stalls + reports | significant | **Push is blocking-only.** Baked in as a hard rule. |
| Stall-sweep double-counts (client already renders a `stalled` row) and re-fires on restart | minor | **Cut.** No stall-sweep in v1. |

## Deferred (named, not dropped)
- **v2 — harness-agnostic `glance notify --blocking` + `AttentionEvent`** (concern 03): agent-declared attention across omp/pi/claude-code/codex/opencode/gemini. Corrected design captured in the concern. Its own plan/PR.
- **v2 — widen push to agent-declared blocking events** once `glance notify --blocking` has a real suspend mechanism — still blocking-signal-quality only.

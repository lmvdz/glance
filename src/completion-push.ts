/**
 * completion-push.ts — per-session-category COMPLETION push policy (plans/daily-attention-w0
 * concern 01), generalizing the voice-loop `voicePushArmed` latch into `completionPushArmed`.
 *
 * The latch mechanics stay in squad-manager.ts (arm on prompt/spawn, expose only at the genuine
 * terminal `agent_end`, fire on the working→idle edge, disarm on send or interrupt). This module
 * owns only the ARM DECISION — which sessions owe the operator a "finished" push at all:
 *
 *   - a voice-sourced dispatch ALWAYS arms, never gated by settings (a voice dispatch is
 *     definitionally an away-from-screen call — today's behavior, preserved verbatim);
 *   - a CASUAL session (a console-lane chat: `POST /api/console` / `glance here` — identified by
 *     the CONSOLE_SYSTEM_PROMPT identity test, and not yet promoted into a work unit) arms by
 *     default (`OMP_SQUAD_PUSH_CASUAL_DONE`, default ON) — an idle chat turn finishing IS the
 *     "reason to switch back" when the operator stepped away;
 *   - everything else — dispatched/workflow/flue units, and a PROMOTED former-casual session — is
 *     FLEET and defaults to quiet on completion (`OMP_SQUAD_PUSH_FLEET_DONE`, default OFF): a
 *     tracked unit finishing is routine, and pushing on every unit's every idle would be spam
 *     (plans/daily-driver/DESIGN.md's named risk). Approval/input escalations are a separate lane
 *     (push.ts `escalationPayload`) and always fire regardless of category.
 *
 * The classifier is the exact inverse of the test `promote()` runs to decide whether a session is
 * promotable (squad-manager.ts): a promotable-and-unpromoted session is precisely a casual one.
 * `promote()` flipping `promoted: true` makes a session's category flip mid-life for free — the
 * next arm decision reads it with zero extra bookkeeping.
 */

import { isConsolePrompt } from "./console-prompt.ts";
import { boolFromEnv, FEATURE_FLAGS, type FeatureFlagKey } from "./runtime-settings.ts";

export type SessionCategory = "casual" | "fleet";

/** Why the completion latch is armed — branches the push copy (a voice dispatch's push points back
 *  at the spoken-debrief channel; a category arm gets the generic body). Persisted alongside the
 *  boolean latch because the boolean alone can't distinguish the two after the fact. */
export type CompletionPushKind = "voice" | "category";

/** Casual iff the session carries the console identity prompt AND has not been promoted into a
 *  work unit. Everything else (workflow, flue-service, dispatched units, promoted former-casuals)
 *  is fleet. Note a promoted session is fleet by BOTH tests: `promoted` is true, and promote()
 *  strips the console segment from `appendSystemPrompt` — so the fresh-id restore paths (which
 *  don't carry `promoted`) still classify it correctly from the stripped prompt alone. */
function sessionCategory(opts: { appendSystemPrompt?: string; promoted?: boolean }): SessionCategory {
	return isConsolePrompt(opts.appendSystemPrompt) && opts.promoted !== true ? "casual" : "fleet";
}

const CATEGORY_FLAG: Record<SessionCategory, FeatureFlagKey> = {
	casual: "OMP_SQUAD_PUSH_CASUAL_DONE",
	fleet: "OMP_SQUAD_PUSH_FLEET_DONE",
};

/** Read one category's completion-push flag the repo's standard way (settings.json mirrors into
 *  env via applyFeatureFlags; boolFromEnv falls back to the flag's declared default: casual ON,
 *  fleet OFF). Fail-closed for fleet: an unknown key or missing definition reads as disabled. */
function completionPushEnabled(category: SessionCategory, env: NodeJS.ProcessEnv = process.env): boolean {
	const key = CATEGORY_FLAG[category];
	const def = FEATURE_FLAGS.find((f) => f.key === key);
	return boolFromEnv(env[key], def?.defaultEnabled ?? false);
}

/** Pure core: voice always arms; otherwise arm iff the session category's flag is on. */
function shouldArmCompletionPush(category: SessionCategory, source: string | undefined, casualEnabled: boolean, fleetEnabled: boolean): CompletionPushKind | undefined {
	if (source === "voice") return "voice";
	return (category === "casual" ? casualEnabled : fleetEnabled) ? "category" : undefined;
}

/** The one call squad-manager's two arm sites make: classify the session, read the flags, decide.
 *  Returns the arm KIND to stamp on the latch, or undefined for "do not arm". `env` is injectable
 *  for tests only — production call sites use the ambient process.env. */
export function armCompletionPushKind(
	opts: { appendSystemPrompt?: string; promoted?: boolean },
	source: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
): CompletionPushKind | undefined {
	return shouldArmCompletionPush(sessionCategory(opts), source, completionPushEnabled("casual", env), completionPushEnabled("fleet", env));
}

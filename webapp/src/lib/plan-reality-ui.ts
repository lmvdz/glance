/**
 * plan-reality-ui.ts — pure label/tone derivation for the plan-reality screen
 * (PlanRealityView.tsx, OMPSQ-448). No DOM: badge classes are plain Tailwind strings the
 * component splats onto a `<span>`; this file only decides which ones, so the decisions are
 * unit-tested without mounting anything (same discipline as `planGraph.ts` / `plan-doc-review.ts`).
 */

import type { ConcernRealityState, PlanRealityRollupDTO } from "./dto";

export interface Badge {
  label: string;
  /** Tailwind classes for the badge chrome (bg/text/border), light+dark. */
  className: string;
}

const BADGE_BASE = "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none";

/**
 * A "done" concern's realityState reflects the ONE feature-level proof (see PlanRealityProofDTO)
 * onto that row — there is no per-concern proof. Four distinct tones on purpose (green/amber/
 * orange/neutral): stale (proof once passed, no longer reachable) and unproven (no proof was ever
 * run) are different failure shapes and must not collapse into one "not quite done" amber.
 */
export function realityStateBadge(state: ConcernRealityState): Badge {
  switch (state) {
    case "done-proven":
      return { label: "✓ proven", className: `${BADGE_BASE} border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300` };
    case "done-stale":
      return { label: "⚠ stale proof", className: `${BADGE_BASE} border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300` };
    case "done-unproven":
      return { label: "● unproven", className: `${BADGE_BASE} border-orange-300 bg-orange-50 text-orange-700 dark:border-orange-800 dark:bg-orange-950/40 dark:text-orange-300` };
    case "open":
    default:
      return { label: "○ open", className: `${BADGE_BASE} border-gray-300 bg-gray-50 text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400` };
  }
}

/** The "blocked" chip — orthogonal to realityState (a concern can be open AND blocked). */
export function blockedBadge(): Badge {
  return { label: "blocked", className: `${BADGE_BASE} border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300` };
}

/** The header's verified-verdict badge — the proof's own pass/fail state, independent of
 *  reachability (a green proof can still be unreachable/stale — see `reachabilityBadge`). */
export function verifiedBadge(verified: "green" | "red-baseline" | "unverified" | undefined): Badge {
  if (verified === "green") return { label: "green", className: `${BADGE_BASE} border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300` };
  if (verified === "red-baseline") return { label: "red baseline", className: `${BADGE_BASE} border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300` };
  return { label: "unverified", className: `${BADGE_BASE} border-gray-300 bg-gray-50 text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400` };
}

/** `reachable===true` ⇒ the proven commit is still on the default branch ("on &lt;default&gt;");
 *  `false` ⇒ it fell off (rewritten/reset — "STALE"); `null` ⇒ reachability was never checked. */
export function reachabilityBadge(reachable: boolean | null, defaultBranch = "default"): Badge {
  if (reachable === true) return { label: `on ${defaultBranch}`, className: `${BADGE_BASE} border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300` };
  if (reachable === false) return { label: "STALE", className: `${BADGE_BASE} border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300` };
  return { label: "unknown", className: `${BADGE_BASE} border-gray-300 bg-gray-50 text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400` };
}

/** Tone for the header's proof-coverage ring: green only when EVERY done concern is proven; amber
 *  the moment any stale/unproven row exists, or when nothing is done yet (nothing proven either). */
export function proofRingTone(rollup: Pick<PlanRealityRollupDTO, "done" | "doneProven">): "green" | "amber" {
  return rollup.done > 0 && rollup.doneProven === rollup.done ? "green" : "amber";
}

/** The scope-drift chip's one-line summary. `actualChangedFiles === null` means the daemon never
 *  computed a real diff for this plan (no landed candidate yet) — "diff n/a" is the honest label,
 *  not a false "0 · 0". */
export function scopeDriftLabel(scopeDrift: PlanRealityRollupDTO["scopeDrift"]): string {
  if (scopeDrift.actualChangedFiles === null) return "diff n/a";
  return `${scopeDrift.plannedNotTouched.length} declared not touched · ${scopeDrift.touchedNotPlanned.length} touched not declared`;
}

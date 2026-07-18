/**
 * plan-reality-route.ts — pure logic for the standalone "plan vs reality" screen
 * (`/plan-reality[/:featureId]`, OMPSQ-448).
 *
 * This SPA has no react-router; deep-linkable state lives in the hash, same convention as
 * `plan-doc-review.ts`'s `#/review/:taskId` (parseReviewHash/buildReviewHash). No `featureId` in
 * the hash ⇒ the plans index; a `featureId` ⇒ the single-plan comprehension page. DOM-free and
 * unit-tested, matching this file's sibling.
 */

import type { FeatureDTO } from "./dto";

export interface PlanRealityLocation {
  /** Absent ⇒ the plans index (`#/plan-reality`). */
  featureId?: string;
}

/** Parse `#/plan-reality` or `#/plan-reality/<featureId>` into a location, or `undefined` when the
 *  current hash isn't a plan-reality deep link. */
export function parsePlanRealityHash(hash: string): PlanRealityLocation | undefined {
  const m = /^#\/plan-reality(?:\/([^?]+))?$/.exec(hash);
  if (!m) return undefined;
  const featureId = m[1] ? decodeURIComponent(m[1]) : undefined;
  return { featureId };
}

/** Build the deep-linkable hash for one plan-reality location — the inverse of
 *  `parsePlanRealityHash`. */
export function buildPlanRealityHash(location: PlanRealityLocation): string {
  return location.featureId ? `#/plan-reality/${encodeURIComponent(location.featureId)}` : "#/plan-reality";
}

/** Every feature that has a plan directory — the plans index's row set. A feature with no
 *  `planDir` has nothing for this screen to reconcile (no concern docs, no plan-vs-reality
 *  question to answer), so it's filtered out rather than rendered as an empty card. */
export function planFeatures(features: FeatureDTO[]): FeatureDTO[] {
  return features.filter((f) => !!f.planDir);
}

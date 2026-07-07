/**
 * Model → vendor LINEAGE (for cross-lineage adversarial review, plans/cross-lineage-review/).
 *
 * "Lineage" is the coarser, VENDOR grain of `modelFamily()` (src/omp-graph/attribution.ts): when the
 * same vendor both authors and judges a change, their blind spots are correlated, so the land gate's
 * independent validator is only truly independent if its lineage differs from the author's.
 *
 * Built ON TOP of `modelFamily()` so the two heuristics can't drift — a new model family added there
 * flows through `FAMILY_LINEAGE` here, and `model-lineage.test.ts` asserts every family maps to a
 * lineage. NOTE the one deliberate divergence: `modelFamily` keeps `fable` as its own cost-band family,
 * but `fable` is `claude-fable-*` — an Anthropic model — so its VENDOR lineage is `anthropic`.
 */

import { modelFamily } from "./omp-graph/attribution.ts";

export type ModelLineage = "anthropic" | "openai" | "google" | "unknown";

/** Provider token (before the first "/") → lineage, for the vendor-qualified specs omp's `pickModel`
 *  accepts (`anthropic/claude-sonnet-4-5`, `openai/gpt-5`, `google-vertex/gemini-2.5-pro`). The poll
 *  loop backfills `dto.model` in exactly this `provider/id` shape (squad-manager applyState). */
const PROVIDER_LINEAGE: Record<string, ModelLineage> = {
	anthropic: "anthropic",
	openai: "openai",
	"azure-openai": "openai",
	google: "google",
	"google-vertex": "google",
	gemini: "google",
};

/** `modelFamily()` result → vendor lineage. `opus|sonnet|haiku|fable` are all Anthropic; `other`/
 *  `unknown` (and anything absent here) fall through to `unknown` — never guessed. */
const FAMILY_LINEAGE: Record<string, ModelLineage> = {
	opus: "anthropic",
	sonnet: "anthropic",
	haiku: "anthropic",
	fable: "anthropic",
	openai: "openai",
	gemini: "google",
};

/**
 * Collapse any model reference — a provider-prefixed spec, a bare family (`sonnet`, `gpt-5.2`,
 * `gemini-2.5-pro`), or `undefined`/junk — into a vendor lineage. NEVER throws; unreadable ⇒ `unknown`
 * (we do not assert a lineage we can't substantiate).
 */
export function modelLineage(model?: string): ModelLineage {
	const raw = (model ?? "").trim();
	if (!raw) return "unknown";
	// Provider-qualified fast path. Only trust a provider token we recognize; an unknown provider
	// (e.g. "mistral/large") falls through to the family heuristic, which honestly returns unknown.
	const slash = raw.indexOf("/");
	if (slash > 0) {
		const byProvider = PROVIDER_LINEAGE[raw.slice(0, slash).toLowerCase()];
		if (byProvider) return byProvider;
	}
	// Family fallback — also catches prefixed strings whose id carries the family keyword
	// ("anthropic/claude-sonnet-4-5" → modelFamily → "sonnet"), and bare families.
	return FAMILY_LINEAGE[modelFamily(raw)] ?? "unknown";
}

/** Lineage of a harness NAME, for the VENDOR-PINNED harnesses only — the fallback when a model string
 *  is absent (ACP units never backfill a Model). Multi-model runtimes (`omp`/`pi`/`opencode`/…) don't
 *  imply a vendor, so they return `unknown` — a harness name alone must not fabricate a lineage. */
const HARNESS_LINEAGE: Record<string, ModelLineage> = {
	gemini: "google",
	"claude-code": "anthropic",
	codex: "openai",
};

export function harnessLineage(harness?: string): ModelLineage {
	return HARNESS_LINEAGE[(harness ?? "").toLowerCase()] ?? "unknown";
}

/**
 * The fleet's dominant / default model-subscription vendor (concern 06, degradation ladder). omp/pi's
 * default model, when a unit doesn't pin one, is Anthropic — so an unclassifiable unit's provider
 * folds into THIS bucket (see `rate-limit.ts`) rather than a separate "unknown" pause bucket. That
 * closes the under-pause bug the ladder exists to fix: a vendor-pinned Anthropic harness (claude-code)
 * capping out must still pause an unlabeled default omp unit on the same subscription, and vice versa.
 */
export const DEFAULT_PROVIDER: ModelLineage = "anthropic";

/**
 * Resolve a dispatch-time unit's provider for rate-limit gating: prefer the explicit model spec
 * (`modelLineage`), falling back to the harness's static vendor pin (`harnessLineage`) only when the
 * model can't be read. Mirrors `validator.ts`'s private `lineageFields` author-lineage fallback (same
 * model-then-harness order) — kept here as the canonical implementation since both the rate-limit gate
 * and the dispatcher need it, not just the validator.
 */
export function resolveProvider(model?: string, harness?: string): ModelLineage {
	const fromModel = modelLineage(model);
	return fromModel === "unknown" ? harnessLineage(harness) : fromModel;
}

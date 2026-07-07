/**
 * Review-lens selector (plans/perspective-diversified-review/ concern 01).
 *
 * PURE, no-LLM decision of WHICH out-of-criteria review lens(es) should run for a given diff — or
 * none at all. This is the affordability gate: a docs/config/lockfile-only land returns `[]` and the
 * land gate falls back to exactly today's single-criteria-judge behavior, paying zero extra cost.
 *
 * v1 has a single lens (`"regression"` — "does this diff introduce a problem the declared acceptance
 * criteria would not have named"). `LensId` is a string union so the deferred pool (perf / architecture
 * / testing) extends it without a breaking change. The module reads NO env vars — the caller resolves
 * `max`/`allow` from config and passes them in, keeping this unit-testable without an environment.
 */

import { HIGH_RISK } from "./intake.ts";

/** The out-of-criteria review lenses. v1 ships only `"regression"`; the union is open for the pool. */
export type LensId = "regression";

/** Files with no reviewable *code* — pure docs, lockfiles, and project metadata. A land touching ONLY
 *  these has nothing for an out-of-criteria code reviewer to inspect, so the lens is skipped. (A risky
 *  path like a lockfile IS worth a human glance — that is the land-risk gate's job, not this reviewer's;
 *  a lens has no diff-of-logic to read there.) */
const DOCS_ONLY_RE =
	/(\.(md|mdx|txt|rst|adoc)$)|(^|\/)(LICENSE|NOTICE|CODEOWNERS|\.gitignore|\.gitattributes)$|(^|\/)(package-lock\.json|bun\.lock|bun\.lockb|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock)$/i;

/**
 * Extract changed file paths from a unified diff's `diff --git a/<old> b/<new>` headers, taking the
 * new-side (`b/`) path. No git call — the land gate already has the diff text in hand.
 */
export function changedFilesFromDiff(diff: string): string[] {
	const files: string[] = [];
	const re = /^diff --git a\/.+? b\/(.+)$/;
	for (const line of diff.split("\n")) {
		const m = re.exec(line);
		if (m) files.push(m[1]);
	}
	return files;
}

export interface SelectLensOpts {
	/** The unit's declared-criteria / task text — a HIGH_RISK match fires the lens even on an
	 *  otherwise docs-only diff (e.g. a docs change whose task is "migrate the schema"). */
	criteriaText?: string;
	/** Hard cap on how many lenses may fire (the caller reads `OMP_SQUAD_LENS_MAX`). `<= 0` ⇒ none. */
	max: number;
	/** Optional allowlist (the caller reads `OMP_SQUAD_LENS_SET`); result is intersected with it. */
	allow?: LensId[];
}

/**
 * Decide which lenses fire for `diff`. v1 rule: a diff touching only docs/lockfiles/metadata (and whose
 * criteria text is not itself high-risk) fires nothing; any diff with real source changes fires the
 * single `regression` lens, bounded by `max` and `allow`. The risky-path / blast-radius signals become
 * load-bearing only once the pool exists to select AMONG (security vs perf vs architecture); for one
 * lens, "there is code to review" is the whole decision.
 */
export function selectLenses(diff: string, opts: SelectLensOpts): LensId[] {
	if (opts.max <= 0) return [];
	const files = changedFilesFromDiff(diff);
	if (files.length === 0) return [];
	const allDocs = files.every((f) => DOCS_ONLY_RE.test(f));
	const criteriaRisk = !!opts.criteriaText && HIGH_RISK.test(opts.criteriaText);
	if (allDocs && !criteriaRisk) return [];
	const selected: LensId[] = ["regression"];
	const allowed = opts.allow ? selected.filter((l) => opts.allow!.includes(l)) : selected;
	return allowed.slice(0, opts.max);
}

/**
 * Small text-shaping primitives shared across the codebase's various "cap this string for a log
 * line / detail field" call sites (noisegate-compaction concern 01). Extracted so the FOUR
 * near-identical locals (land.ts, validator.ts, squad-manager.ts, flue-service-driver.ts) collapse
 * onto ONE definition each instead of independently drifting — concern 05 swaps the call sites to
 * import from here; this module only introduces the shared implementations plus `stripAnsi`, moved
 * from observer.ts so `output-reduce.ts` (concern 01's reducer core) can use it as step 0 without a
 * dependency on observer.ts's Plane-filing machinery.
 *
 * `truncate` and `truncateLabel` are deliberately BYTE-IDENTICAL to the locals they replace — this
 * module makes no behavioral change, only a location change. See tests/text-util.test.ts for the
 * equivalence proof against the original inline definitions.
 */

/** Cap `s` to `n` chars, appending `…` when it had to cut anything. Matches land.ts's/validator.ts's
 *  former local `truncate` — used where whitespace/newlines in `s` are meaningful (gate dumps,
 *  rationale prose) and must NOT be collapsed. */
export function truncate(s: string, n: number): string {
	return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/** Flatten all whitespace runs (including newlines) to a single space, trim, then cap to `n` chars.
 *  Matches squad-manager.ts's/flue-service-driver.ts's former local `truncate` — used for single-line
 *  labels (feedback summaries, safeJson previews) where a stray newline would break the display. */
export function truncateLabel(s: string, n: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

/** Strip terminal control sequences (CSI + the rarer single-char-introducer form) from `value`. Moved
 *  from observer.ts (which imports it back — see that module) so `output-reduce.ts` can run it as its
 *  step 0 without pulling in observer.ts's Plane-filing dependencies. */
export function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b[@-_][0-?]*[ -/]*[@-~]/g, "");
}

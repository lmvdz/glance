/**
 * Shared "extract the outermost bracketed JSON value from noisy model output" scanner.
 * Generalized over the bracket pair (`[`/`]` for planner.ts's array extraction, `{`/`}` for
 * omp-call.ts's object extraction) — both call sites shared a byte-identical loop before this
 * dedup (code-review fixlist finding #8's D-duplication note).
 *
 * Both false-start shapes it must survive:
 *   - a verdict-first prose sentence naming a bracketed reference BEFORE the real JSON
 *     (VERDICT_FIRST_BLOCK ships unconditionally on judge/planner SYSTEM prompts and instructs
 *     exactly this ordering) — e.g. `"gap coverage: [2 items remain] ... [{"real":"json"}]"`;
 *   - truncated output whose LAST bracket in the text belongs to an inner, already-nested
 *     structure, not the intended top-level payload — e.g. `'garbage [ {"a":1}, {"b": []} '`
 *     (no closing bracket for the outer array). The naive "anchor on `raw.lastIndexOf(close)`,
 *     try every `open` in front of it" approach (this file's predecessor) parses the inner `[]`
 *     against that same fixed end and returns it as if it were the whole, complete answer —
 *     silently turning a garbled response into a false "nothing left to do" / "empty object".
 *
 * Fixed by tracking bracket DEPTH (string-literal- and escape-aware) across the whole input: only
 * an `open` char seen at depth 0 — i.e. NOT nested inside any earlier structure, closed or not —
 * is a legitimate top-level candidate. A bracket nested inside an earlier UNCLOSED structure never
 * reaches depth 0, so it is never tried; a bracket that closes cleanly (the false-start-prose case)
 * returns depth to 0 and lets a later real candidate through, unchanged from the old behavior.
 */
export function extractOutermostJson<T>(raw: string, open: "[" | "{", isT: (v: unknown) => v is T): T | undefined {
	const close = open === "[" ? "]" : "}";
	const end = raw.lastIndexOf(close);
	if (end < 0) return undefined;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i <= end; i++) {
		const ch = raw[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "[" || ch === "{") {
			if (ch === open && depth === 0) {
				try {
					const parsed: unknown = JSON.parse(raw.slice(i, end + 1));
					if (isT(parsed)) return parsed;
				} catch {
					// a false-start bracket at top level (e.g. inside verdict-first prose) — depth
					// tracking below still lets a LATER top-level candidate get tried.
				}
			}
			depth++;
		} else if (ch === "]" || ch === "}") {
			depth = Math.max(0, depth - 1);
		}
	}
	return undefined;
}

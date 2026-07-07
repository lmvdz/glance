// Typed environment-variable readers.
//
// Replaces the widespread `Number(process.env.OMP_SQUAD_X) || <default>`
// anti-pattern, which has two bugs:
//   1. It eats a legitimate `0` (e.g. `X=0` collapses to the default, because
//      `0 || d === d`).
//   2. It silently coerces garbage to the default (`Number("abc")` = NaN,
//      `NaN || d` = d) with no signal that the config is broken.
//
// These helpers instead:
//   - respect `0` and negative values,
//   - return the default ONLY when the var is unset or blank,
//   - warn (once per var) when a present value is non-numeric, then fall back.
//
// Backing: parse with JavaScript's numeric conversion, then require
// Number.isFinite so garbage such as "abc", "NaN", and "Infinity" falls back
// with a warning instead of silently becoming the default.
//
// These are read LAZILY, per call: each call reads the CURRENT `process.env`,
// so tests (and live re-config) that set an env var and then call the getter
// observe the new value.

const warned = new Set<string>()

function warnOnce(name: string, raw: string): void {
	if (warned.has(name)) return
	warned.add(name)
	console.warn(
		`[config] ${name}="${raw}" is not a valid number; using the default instead`,
	)
}

// Read the current env value and decode it to a finite number, or return
// undefined when the var is unset/blank (no warning) or invalid (warn once).
function readFinite(name: string, fallback: number): number | undefined {
	const raw = process.env[name]
	// Unset or blank/whitespace-only => treat as "not configured": use the
	// default, silently (this is the normal, expected case).
	if (raw === undefined || raw.trim() === "") return undefined
	const parsed = Number(raw)
	if (Number.isFinite(parsed)) return parsed
	// Present but non-numeric => misconfiguration; surface it once, then fall back.
	warnOnce(name, raw)
	return undefined
}

/**
 * Read an integer env var, respecting `0` and negatives.
 * Returns `fallback` when unset/blank; warns once and returns `fallback` when
 * the value is present but not a valid integer.
 */
export function envInt(name: string, fallback: number): number {
	const n = readFinite(name, fallback)
	if (n === undefined) return fallback
	if (!Number.isInteger(n)) {
		warnOnce(name, String(process.env[name]))
		return fallback
	}
	return n
}

/**
 * Read a floating-point env var, respecting `0` and negatives.
 * Returns `fallback` when unset/blank; warns once and returns `fallback` when
 * the value is present but not a valid number.
 */
export function envNumber(name: string, fallback: number): number {
	const n = readFinite(name, fallback)
	return n === undefined ? fallback : n
}

/** Test-only: reset the once-per-var warning guard. */
export function __resetConfigWarnings(): void {
	warned.clear()
}

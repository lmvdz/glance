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

function warnBoolOnce(name: string, raw: string): void {
	if (warned.has(name)) return
	warned.add(name)
	console.warn(
		`[config] ${name}="${raw}" is not a valid boolean flag (use "1" or "0"); using the default instead`,
	)
}

/**
 * Read a "0"/"1" boolean env var (the fleet's flag convention).
 *
 * Replaces the scattered `process.env.X === "1"` / `process.env.X !== "0"`
 * comparisons with one typed reader whose RETURN VALUES are exactly equivalent
 * to the raw comparisons they replace:
 *   - `X === "1"`  ⇒ `envBool("X", false)`   (off unless explicitly "1")
 *   - `X !== "0"`  ⇒ `envBool("X", true)`    (on unless explicitly "0")
 *   - `X !== "1"`  ⇒ `!envBool("X", false)`
 *   - `X === "0"`  ⇒ `!envBool("X", true)`
 *
 * Exactly "1" ⇒ true, exactly "0" ⇒ false, unset/blank ⇒ `fallback`, silently.
 * Any OTHER present value (e.g. "true", "yes") also returns `fallback` — the
 * same value every raw comparison above produced for it — but warns once per
 * var, because that is a misconfiguration the old idiom swallowed silently.
 * Read lazily per call, like envInt/envNumber.
 */
export function envBool(name: string, fallback: boolean): boolean {
	const raw = process.env[name]
	if (raw === undefined || raw.trim() === "") return fallback
	if (raw === "1") return true
	if (raw === "0") return false
	warnBoolOnce(name, raw)
	return fallback
}

/**
 * Read a comma-separated list env var, trimming and dropping blank entries.
 * Returns `fallback` (already trimmed/deduped by the caller if needed) when
 * unset/blank. No warning path: any nonempty token is valid — there's no
 * "not a valid list" shape to misconfigure into.
 */
export function envStringList(name: string, fallback: string[]): string[] {
	const raw = process.env[name]
	if (raw === undefined || raw.trim() === "") return fallback
	const parsed = raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
	return parsed.length > 0 ? parsed : fallback
}

/**
 * Releasable Plane state groups the Dispatcher will auto-dispatch from.
 *
 * Default `backlog,unstarted,started` is today's behavior (no change) — the
 * Dispatcher has never checked `issue.state` before this concern, so flipping
 * the default here would silently starve dispatch of raw Backlog tickets an
 * operator relies on. The migration to `unstarted,started` (Backlog becomes a
 * real holding pen for promotion) is an explicit operator step, not a code
 * default flip.
 */
export function dispatchStates(): string[] {
	// Lowercased: Plane state GROUPS are lowercase ("unstarted"), but Plane's UI capitalizes state
	// names — an operator typing `Unstarted,Started` would otherwise silently hold 100% of open work
	// (code-review, CONFIRMED).
	return envStringList("OMP_SQUAD_DISPATCH_STATES", ["backlog", "unstarted", "started"]).map((s) => s.toLowerCase())
}

/** Test-only: reset the once-per-var warning guard. */
export function __resetConfigWarnings(): void {
	warned.clear()
}

/**
 * Race-once at workflow catastrophe (adw-factory-borrows concern 07): default OFF. Flipping this on
 * only ARMS the mechanism — an individual unit still only races when its resolved lane's
 * `LANE_POLICY[lane].race === 1` (today: hotfix only, DESIGN.md). Two gates, not one, so enabling the
 * feature globally never races a lane the constants table didn't already opt in.
 */
export function raceOnceEnabled(): boolean {
	return envBool("OMP_SQUAD_RACE_ONCE", false)
}

/**
 * Should the operator's own autonomous factory run alongside the tenant registry?
 *
 * Enabling multi-tenancy once silently turned the factory off: the per-org managers behind the registry
 * are lazy and org-scoped, so nothing owned the global Plane loops (auto-dispatch → build → prove →
 * auto-land → self-heal). `OMP_SQUAD_ROOT_FACTORY=1` AND at least one configured Plane repo stands up a
 * single root SquadManager that does. Default OFF — a bare SaaS deployment never silently spins a global
 * factory.
 *
 * Lives here, not in `index.ts`, so the server can report the factory's real state to `glance doctor`
 * without importing the CLI entrypoint (a cycle). `index.ts` re-exports it for the boot-gate test.
 */
export function rootFactoryEnabledWith(repoCount: number): boolean {
	return envBool("OMP_SQUAD_ROOT_FACTORY", false) && repoCount > 0;
}

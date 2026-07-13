/**
 * RateLimitGate — pause auto-dispatch, PER PROVIDER, while a model subscription is
 * rate-limited (the 5-hour / weekly usage cap, a 429, "too many requests").
 *
 * The signal comes from omp's auto-retry stream: when a turn fails with a usage-limit
 * error, omp emits `auto_retry_start { delayMs, errorMessage }` where `delayMs` is the
 * parsed retry hint — when the cap frees up. squad-manager feeds those into `note(...)`;
 * the dispatcher consults `paused(provider)` before spawning a given unit, so a cap on
 * one provider's subscription no longer stops units that would run on a different, live
 * provider — only the no-arg legacy path still ORs across every tracked provider. The
 * cooldown lifts on its own once the hint window elapses (`Date.now() >= until`), so no
 * manual resume is needed.
 *
 * Degradation ladder (concern 06, plans/research-sirvir/06-degradation-ladder.md): a
 * `Map<lineage, until>` alone is a no-op unless the DISPATCHER also checks per prospective
 * unit instead of once globally — see `dispatch.ts`'s per-issue `paused(providerFor(...))`.
 * Buckets are keyed by `ModelLineage` (anthropic/openai/google/xai) — the vendor/subscription
 * grain, not the harness name — via `model-lineage.ts`'s `resolveProvider`. An unclassifiable
 * ("unknown") provider folds into `DEFAULT_PROVIDER` (the fleet's dominant subscription)
 * rather than a separate bucket, so it fails SAFE (over-pauses the common case) instead of
 * failing open into a live cap, and so a vendor-pinned cap and an unlabeled default-harness
 * cap on the SAME real subscription land in the same bucket instead of silently diverging.
 *
 * Classification is text-matching (mirrors omp's own usage-limit classifier — there are
 * no typed provider error codes on this path). The clock is injectable for tests.
 *
 * In-memory only — the map is lost on daemon restart (pre-existing property, carried
 * forward unchanged; a handful of provider buckets is not a growth concern).
 */

import { DEFAULT_PROVIDER } from "./model-lineage.ts";

/** Marks a model-subscription usage cap: 5h/weekly limit, a 429, or "too many requests". */
const USAGE_LIMIT_RE =
	/\b(rate.?limit|usage limit|too many requests|429|quota|weekly limit|5.?hour limit|usage cap|resets? at)\b/i;

/** Cooldown floor: even a tiny/absent hint pauses briefly so we don't re-spawn straight back into the cap. */
const MIN_COOLDOWN_MS = 60_000;
/** Used when a usage-limit fires with no usable retry hint. */
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
/** Sanity ceiling so a bogus huge hint can't pin dispatch indefinitely. The weekly cap is hours, not days. */
const MAX_COOLDOWN_MS = 6 * 60 * 60_000;

/** True when `msg` reads like a model-subscription rate-limit / usage-cap error. */
export function isUsageLimit(msg: unknown): msg is string {
	return typeof msg === "string" && USAGE_LIMIT_RE.test(msg);
}

interface Cooldown {
	untilMs: number;
	reason: string;
}

export class RateLimitGate {
	/** One cooldown bucket per provider (see module doc — "unknown" folds into DEFAULT_PROVIDER). */
	private readonly buckets = new Map<string, Cooldown>();
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	/** Absent / "unknown" ⇒ the dominant-provider bucket (fail-safe fold — see module doc). */
	private static key(provider?: string): string {
		return !provider || provider === "unknown" ? DEFAULT_PROVIDER : provider;
	}

	/**
	 * Record a retry for `provider`. When `errorMessage` is a usage-limit, start (or extend) that
	 * provider's cooldown to `now + clamp(delayMs)`. Returns true iff this was a usage-limit (so the
	 * caller can log it). Non-usage-limit retries (transient overload, network blips) are ignored —
	 * they don't pause dispatch. `provider` is OPTIONAL and trailing for back-compat: pre-partitioning
	 * callers (`note(errorMessage, delayMs)`) keep working byte-for-byte, folding into the one dominant
	 * bucket — identical to the old single-global-cooldown behavior until a caller starts passing it.
	 */
	note(errorMessage: unknown, delayMs: unknown, provider?: string): boolean {
		if (!isUsageLimit(errorMessage)) return false;
		const hint = typeof delayMs === "number" && delayMs > 0 ? delayMs : DEFAULT_COOLDOWN_MS;
		const cooldown = Math.min(Math.max(hint, MIN_COOLDOWN_MS), MAX_COOLDOWN_MS);
		const key = RateLimitGate.key(provider);
		const untilMs = Math.max(this.buckets.get(key)?.untilMs ?? 0, this.now() + cooldown);
		this.buckets.set(key, { untilMs, reason: errorMessage.slice(0, 200) });
		return true;
	}

	/**
	 * True while dispatch should pause for `provider` (its cooldown not yet elapsed). Omitted
	 * `provider` ⇒ the legacy global check: true while ANY tracked provider is still paused. That OR
	 * is the safe fallback for callers that haven't been threaded with a per-unit provider yet (and is
	 * exactly the old behavior when only the dominant bucket is ever written).
	 */
	paused(provider?: string): boolean {
		if (provider === undefined) {
			for (const { untilMs } of this.buckets.values()) if (this.now() < untilMs) return true;
			return false;
		}
		const bucket = this.buckets.get(RateLimitGate.key(provider));
		return !!bucket && this.now() < bucket.untilMs;
	}

	/** Providers currently under an unexpired cooldown (bucket keys, so "unknown" reads as
	 *  DEFAULT_PROVIDER) — for observability / "is every candidate capped" checks. */
	pausedProviders(): readonly string[] {
		const now = this.now();
		return [...this.buckets.entries()].filter(([, b]) => now < b.untilMs).map(([k]) => k);
	}

	/** Epoch ms `provider`'s cooldown lifts (0 when never tripped). Omitted `provider` ⇒ the LATEST
	 *  lift across every tracked provider — the pre-partitioning reader's one global clock. */
	untilFor(provider?: string): number {
		if (provider !== undefined) return this.buckets.get(RateLimitGate.key(provider))?.untilMs ?? 0;
		let max = 0;
		for (const { untilMs } of this.buckets.values()) max = Math.max(max, untilMs);
		return max;
	}

	/** Back-compat alias for `untilFor()` (no provider) — existing readers (squad-manager's
	 *  auto_retry_start log line) keep compiling and reading the same "next lift" clock unmodified. */
	get until(): number {
		return this.untilFor();
	}

	/** `provider`'s last usage-limit error text (truncated). Omitted ⇒ the reason belonging to
	 *  whichever bucket lifts latest (the most recently extended / most "current" one) — the
	 *  pre-partitioning reader's one global reason string. */
	reasonFor(provider?: string): string {
		if (provider !== undefined) return this.buckets.get(RateLimitGate.key(provider))?.reason ?? "";
		let best: Cooldown | undefined;
		for (const b of this.buckets.values()) if (!best || b.untilMs > best.untilMs) best = b;
		return best?.reason ?? "";
	}

	/** Back-compat alias for `reasonFor()` (no provider). */
	get reason(): string {
		return this.reasonFor();
	}
}

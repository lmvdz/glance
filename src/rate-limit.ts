/**
 * RateLimitGate — pause auto-dispatch while the model subscription is rate-limited
 * (the 5-hour / weekly usage cap, a 429, "too many requests").
 *
 * The signal comes from omp's auto-retry stream: when a turn fails with a usage-limit
 * error, omp emits `auto_retry_start { delayMs, errorMessage }` where `delayMs` is the
 * parsed retry hint — when the cap frees up. squad-manager feeds those into `note(...)`;
 * the dispatcher consults `paused()` before spawning, so it stops launching agents that
 * would immediately stall on the same cap. The cooldown lifts on its own once the hint
 * window elapses (`Date.now() >= until`), so no manual resume is needed.
 *
 * Classification is text-matching (mirrors omp's own usage-limit classifier — there are
 * no typed provider error codes on this path). The clock is injectable for tests.
 */

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

export class RateLimitGate {
	private untilMs = 0;
	private lastReason = "";
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	/**
	 * Record a retry. When `errorMessage` is a usage-limit, start (or extend) the cooldown to
	 * `now + clamp(delayMs)`. Returns true iff this was a usage-limit (so the caller can log it).
	 * Non-usage-limit retries (transient overload, network blips) are ignored — they don't pause dispatch.
	 */
	note(errorMessage: unknown, delayMs: unknown): boolean {
		if (!isUsageLimit(errorMessage)) return false;
		const hint = typeof delayMs === "number" && delayMs > 0 ? delayMs : DEFAULT_COOLDOWN_MS;
		const cooldown = Math.min(Math.max(hint, MIN_COOLDOWN_MS), MAX_COOLDOWN_MS);
		this.untilMs = Math.max(this.untilMs, this.now() + cooldown);
		this.lastReason = errorMessage.slice(0, 200);
		return true;
	}

	/** True while dispatch should be paused (cooldown not yet elapsed). */
	paused(): boolean {
		return this.now() < this.untilMs;
	}

	/** Epoch ms the cooldown lifts (0 when never tripped). */
	get until(): number {
		return this.untilMs;
	}

	/** Last usage-limit error text (truncated), for logging/UI. */
	get reason(): string {
		return this.lastReason;
	}
}

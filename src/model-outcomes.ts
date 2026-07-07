/**
 * Model-outcome ledger + reader (Epic 6 concern 06) — landed-vs-rejected counts per
 * `(model, complexity-tier)` from the fleet's own land outcomes. This is the data layer concern 07
 * (outcome-driven model default) consumes; it never gates a land, it only records a statistic
 * already produced at land time. Mirrors `land-ledger.ts` exactly (do NOT invent a new persistence
 * pattern): one JSON file under `stateDir`, sync read-modify-write (the manager is single-writer,
 * single event loop), corrupt/missing ⇒ `{}`, best-effort write swallows its own errors.
 *
 * Recording is ALWAYS-ON (a cheap statistic, like `land-ledger`) so the baseline is populated even
 * while the consumer (concern 07's default-shift) is off; only the SHIFT is flag-gated.
 */

import * as path from "node:path";
import { getStorageBackend } from "./dal/storage.ts";
import type { ThinkingLevel } from "./types.ts";

export type ComplexityTier = "light" | "mid" | "heavy";

export interface ModelOutcomeCounts {
	landed: number;
	rejected: number;
	/**
	 * Attempted but never reached a landed/rejected verdict — a retryable/environmental refusal (a
	 * dirty main checkout, a PR-merge API hiccup) blocked the land before the model's work could be
	 * judged (research-sirvir/01-recording-unlock, part 2). Recorded so a fleet that rarely reaches a
	 * clean land still produces SOME learning signal instead of total silence, but kept in its OWN
	 * bucket, never folded into `landed`/`rejected`: a dirty main is not the model's fault, and every
	 * existing reader of those two fields (smart-spawn's outcome-driven default, attribution-scoreboard,
	 * cost-gate) must see land-rate exactly as before. Optional and back-compat: absent on any ledger
	 * entry written before this field existed, and absent on any entry that has only ever
	 * landed/rejected — so exact-shape equality (`toEqual({landed, rejected})`) on existing call sites
	 * is unaffected.
	 */
	blocked?: number;
}

/** `${model}::${tier}` → counts. */
export type ModelOutcomes = Record<string, ModelOutcomeCounts>;

function ledgerPath(stateDir: string): string {
	return path.join(stateDir, "model-outcomes.json");
}

function readLedger(stateDir: string): ModelOutcomes {
	try {
		const p = ledgerPath(stateDir);
		const b = getStorageBackend();
		if (!b.exists(p)) return {};
		const raw0 = b.readTextSync(p);
		if (raw0 === undefined) return {};
		const raw = JSON.parse(raw0) as unknown;
		return raw && typeof raw === "object" ? (raw as ModelOutcomes) : {};
	} catch {
		return {}; // corrupt/unreadable ⇒ start fresh (worst case: the shift forgets one key's history)
	}
}

function writeLedger(stateDir: string, ledger: ModelOutcomes): void {
	try {
		getStorageBackend().writeDurableSync(ledgerPath(stateDir), JSON.stringify(ledger));
	} catch {
		/* best-effort: a disk failure must never break the land it records */
	}
}

/**
 * Bucket a run's `ThinkingLevel` into one of three coarse tiers, so the ledger stays dense enough
 * to reach `MIN_SAMPLES` in a reasonable time. `undefined` (no thinking set) buckets to `"mid"` —
 * intake/spawn's own default is `"low"`, so an undefined thinking level is rare in practice.
 * EXPORTED so concern 07 reuses the SAME bucketing at spawn time — record and read must agree.
 */
export function tierOf(thinking?: ThinkingLevel): ComplexityTier {
	if (thinking === "minimal" || thinking === "low") return "light";
	if (thinking === "high" || thinking === "xhigh") return "heavy";
	return "mid"; // "medium" | undefined
}

/** Fold an undefined/empty model to `"default"` so default-model runs bucket together. EXPORTED so
 *  concern 07 reuses the same normalization. */
export function modelKey(model?: string): string {
	return model && model.trim() ? model.trim() : "default";
}

function ledgerKey(model: string, tier: ComplexityTier): string {
	return `${model}::${tier}`;
}

/**
 * Record one land outcome for `(model, tier)`: `landed` bumps `.landed`, else `.rejected`.
 * No-op-safe on an undefined/empty model (folds to `"default"` via `modelKey`). Returns the
 * updated entry. Read fresh + write-back every call (matches `recordLandOutcome`'s discipline —
 * the manager is single-writer/single-event-loop, so no interleave).
 */
export function recordModelOutcome(stateDir: string, model: string | undefined, tier: ComplexityTier, landed: boolean, _now = Date.now()): ModelOutcomeCounts {
	const key = ledgerKey(modelKey(model), tier);
	const ledger = readLedger(stateDir);
	const entry = ledger[key] ?? { landed: 0, rejected: 0 };
	if (landed) entry.landed++;
	else entry.rejected++;
	ledger[key] = entry;
	writeLedger(stateDir, ledger);
	return entry;
}

/**
 * Record one BLOCKED land attempt for `(model, tier)` — the retryable/environmental-refusal case
 * (squad-manager's `result.retryable`, e.g. a dirty main checkout) that never reached a landed/rejected
 * verdict. Bumps ONLY `.blocked`; `.landed`/`.rejected` on the entry are left exactly as they were, so
 * this is purely additive from every existing reader's point of view — a separate counter, not a third
 * value of the landed/rejected statistic. Same read-modify-write discipline as `recordModelOutcome`.
 */
export function recordModelOutcomeBlocked(stateDir: string, model: string | undefined, tier: ComplexityTier, _now = Date.now()): ModelOutcomeCounts {
	const key = ledgerKey(modelKey(model), tier);
	const ledger = readLedger(stateDir);
	const entry = ledger[key] ?? { landed: 0, rejected: 0 };
	entry.blocked = (entry.blocked ?? 0) + 1;
	ledger[key] = entry;
	writeLedger(stateDir, ledger);
	return entry;
}

/** Read-only: `{landed:0, rejected:0}` for an unseen `(model, tier)` key — never throws. */
export function modelOutcomes(stateDir: string, model: string | undefined, tier: ComplexityTier): ModelOutcomeCounts {
	return readLedger(stateDir)[ledgerKey(modelKey(model), tier)] ?? { landed: 0, rejected: 0 };
}

/** Read-only: the whole `${model}::${tier}` → counts ledger (empty on missing/corrupt). For the
 *  model scoreboard, which needs every key at once rather than one lookup. */
export function readModelOutcomes(stateDir: string): ModelOutcomes {
	return readLedger(stateDir);
}

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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "./types.ts";

export type ComplexityTier = "light" | "mid" | "heavy";

export interface ModelOutcomeCounts {
	landed: number;
	rejected: number;
}

/** `${model}::${tier}` → counts. */
export type ModelOutcomes = Record<string, ModelOutcomeCounts>;

function ledgerPath(stateDir: string): string {
	return path.join(stateDir, "model-outcomes.json");
}

function readLedger(stateDir: string): ModelOutcomes {
	try {
		const p = ledgerPath(stateDir);
		if (!existsSync(p)) return {};
		const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
		return raw && typeof raw === "object" ? (raw as ModelOutcomes) : {};
	} catch {
		return {}; // corrupt/unreadable ⇒ start fresh (worst case: the shift forgets one key's history)
	}
}

function writeLedger(stateDir: string, ledger: ModelOutcomes): void {
	try {
		writeFileSync(ledgerPath(stateDir), JSON.stringify(ledger));
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

/** Read-only: `{landed:0, rejected:0}` for an unseen `(model, tier)` key — never throws. */
export function modelOutcomes(stateDir: string, model: string | undefined, tier: ComplexityTier): ModelOutcomeCounts {
	return readLedger(stateDir)[ledgerKey(modelKey(model), tier)] ?? { landed: 0, rejected: 0 };
}

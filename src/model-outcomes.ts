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
import { modelFamily as rawModelFamily } from "./omp-graph/attribution.ts";
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
		const parsed = raw && typeof raw === "object" ? (raw as ModelOutcomes) : {};
		return foldToFamilyKeys(parsed);
	} catch {
		return {}; // corrupt/unreadable ⇒ start fresh (worst case: the shift forgets one key's history)
	}
}

/**
 * Migration (research-sirvir/02, key-coherence): re-key every entry of a possibly PRE-migration
 * ledger onto the ONE `modelFamily` namespace, so a row recorded under any old raw-id shape
 * (`claude-opus-4-8`, `opus`, `anthropic/claude-opus-4-8`, the old phantom `default` bucket, …) is
 * found by a reader that only knows the family. Two old keys that collapse onto the same
 * `family::tier` are SUMMED (`landed`/`rejected`/`blocked`) — never shadowed, never dropped — so no
 * history is lost across the rename. Read-time only: this does not write anything back itself; the
 * next `recordModelOutcome`/`recordModelOutcomeBlocked` call persists the folded shape as a side
 * effect of its own read-modify-write. Idempotent — an already-family-keyed ledger folds onto
 * itself unchanged (`modelFamilyMigrated` is a fixed point for every real family name; asserted by
 * `model-outcomes.test.ts`).
 */
function foldToFamilyKeys(ledger: ModelOutcomes): ModelOutcomes {
	const out: ModelOutcomes = {};
	for (const [key, counts] of Object.entries(ledger)) {
		const sep = key.lastIndexOf("::");
		if (sep < 0) {
			out[key] = counts; // malformed key — pass through rather than silently drop history
			continue;
		}
		const rawModelPart = key.slice(0, sep);
		const tier = key.slice(sep + 2);
		const newKey = `${migratedFamilyOf(rawModelPart)}::${tier}`;
		const existing = out[newKey];
		if (!existing) {
			out[newKey] = { ...counts };
		} else {
			existing.landed += counts.landed ?? 0;
			existing.rejected += counts.rejected ?? 0;
			const blocked = (existing.blocked ?? 0) + (counts.blocked ?? 0);
			if (blocked > 0) existing.blocked = blocked;
		}
	}
	return out;
}

/**
 * One raw on-disk model-key fragment (the part before `::tier`) → its family, for migration
 * purposes only. The single special case: the literal `"default"` key — the OLD `modelKey()`'s own
 * phantom incumbent bucket-name, never a real model id a receipt could carry — folds exactly like
 * an empty/unset model does today. Everything else (including an already-family-keyed fragment
 * written by THIS module on a previous save) goes through the SAME `modelFamily()` a live record
 * call uses, which is itself a fixed point for every real family name (see its doc comment) so
 * re-folding an already-migrated ledger is a stable no-op.
 */
function migratedFamilyOf(rawModelPart: string): string {
	return rawModelPart === "default" ? DEFAULT_MODEL_FAMILY : modelFamily(rawModelPart);
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

/**
 * The family the fleet's OWN default heuristic falls back to when a spawn leaves `model` unset
 * (`smart-spawn.ts`'s planner: `"opus"` for hard work, "omit" — i.e. this family — otherwise) — the
 * REAL recorded family behind every omitted-model run, never a phantom `"default"` string that can
 * never equal an actual recorded key (research-sirvir/02's evidence: `"default"` and `"opus"` never
 * appear as recorded keys, so `outcomes("default", tier)` was always `{0,0}` by construction).
 * Mirrors `model-route.ts`'s `ROUTE_CHEAP_FAMILY` ("this codebase's actual cheap/default model
 * family") — kept as an independent constant here (not imported) to avoid a
 * model-outcomes → model-route → smart-spawn → model-outcomes import cycle; `model-outcomes.test.ts`
 * asserts equality with `ROUTE_CHEAP_FAMILY` directly so the two names can never drift apart silently.
 */
export const DEFAULT_MODEL_FAMILY = "sonnet";

/**
 * Collapse ANY raw model-identity string observed on the wire into the ONE family bucket used by
 * BOTH the record path (`recordModelOutcome`/`recordModelOutcomeBlocked`) and every read path
 * (`modelOutcomes`, `readModelOutcomes`, the scoreboard, `smart-spawn`'s candidate scan) — so a row
 * recorded for `anthropic/claude-opus-4-8` (the poll-backfilled `provider/id` shape) is found again
 * by a reader that only knows the bare `"opus"` family, and a `claude-code` receipt's bare
 * `claude-opus-4-8` lands in the SAME bucket. Delegates the actual family-keyword matching
 * (fable/opus/sonnet/haiku/openai/gemini — provider-prefix and version-suffix agnostic, since it
 * just substring-matches) to `omp-graph/attribution.ts`'s `modelFamily()`; this function does NOT
 * re-derive that parsing (a second parser could drift from the first — research-sirvir/02 explicitly
 * forbids that), it only adds the ledger-specific empty-input rule: an empty/undefined model
 * resolves to `DEFAULT_MODEL_FAMILY` (the real family the omission routes to), never the base
 * function's own `"unknown"` — a legitimate bucket THERE for a genuinely-unclassifiable non-empty id,
 * but wrong here, since every omitted-model run in THIS ledger has a real, known destination family.
 * EXPORTED so `smart-spawn.ts` (record-time via squad-manager, read-time via candidate scan) and
 * `attribution-scoreboard.ts` (the daemon-cost fold) share the identical function — one namespace.
 *
 * Fixed point, EVERY real family name included: this matters for the migration fold
 * (`foldToFamilyKeys`/`migratedFamilyOf`) to be idempotent on an already-migrated ledger. All but one
 * family name already fall out of `rawModelFamily`'s own keyword match for free (`"fable"` contains
 * "fable", `"opus"` contains "opus", …); `"openai"` does NOT (`rawModelFamily`'s keyword match looks
 * for `"gpt"/"codex"/"o[34]"`, not the literal string `"openai"`), so it gets an explicit guard here
 * — without it, re-reading an already-family-keyed `openai::tier` row would silently re-key it to
 * `other::tier` on every subsequent read.
 */
export function modelFamily(model?: string): string {
	const raw = (model ?? "").trim();
	if (!raw) return DEFAULT_MODEL_FAMILY;
	if (raw.toLowerCase() === "openai") return "openai";
	return rawModelFamily(raw);
}

function ledgerKey(model: string, tier: ComplexityTier): string {
	return `${model}::${tier}`;
}

/**
 * Record one land outcome for `(model, tier)`: `landed` bumps `.landed`, else `.rejected`.
 * No-op-safe on an undefined/empty model (folds to `DEFAULT_MODEL_FAMILY` via `modelFamily`).
 * Returns the updated entry. Read fresh + write-back every call (matches `recordLandOutcome`'s
 * discipline — the manager is single-writer/single-event-loop, so no interleave). The write-back
 * ALSO persists `readLedger`'s family-key migration fold for every other entry in the file — a
 * side effect, not a separate migration step (research-sirvir/02's "read-time normalization" story).
 */
export function recordModelOutcome(stateDir: string, model: string | undefined, tier: ComplexityTier, landed: boolean, _now = Date.now()): ModelOutcomeCounts {
	const key = ledgerKey(modelFamily(model), tier);
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
	const key = ledgerKey(modelFamily(model), tier);
	const ledger = readLedger(stateDir);
	const entry = ledger[key] ?? { landed: 0, rejected: 0 };
	entry.blocked = (entry.blocked ?? 0) + 1;
	ledger[key] = entry;
	writeLedger(stateDir, ledger);
	return entry;
}

/** Read-only: `{landed:0, rejected:0}` for an unseen `(model, tier)` key — never throws. */
export function modelOutcomes(stateDir: string, model: string | undefined, tier: ComplexityTier): ModelOutcomeCounts {
	return readLedger(stateDir)[ledgerKey(modelFamily(model), tier)] ?? { landed: 0, rejected: 0 };
}

/** Read-only: the whole `${model}::${tier}` → counts ledger (empty on missing/corrupt). For the
 *  model scoreboard, which needs every key at once rather than one lookup. */
export function readModelOutcomes(stateDir: string): ModelOutcomes {
	return readLedger(stateDir);
}

/**
 * Comprehension fog (plans/comprehension/03-fog-computation.md): an honest per-file
 * comprehension-debt number — fleet change mass accumulated since the human last looked at a file,
 * monotone until viewed, never self-clearing, tri-state-renderable, tenant-scoped.
 *
 * Deliberately NOT `hotAreasFromReceipts` (fabric.ts): that helper's 7-day half-life decay and
 * top-50 cap are exactly what DESIGN.md's "Debt formula" row rejects — a draft formula that
 * self-cleared via heat decay and zeroed on a tab-flick "measured neither comprehension nor debt."
 * Fog aggregates receipts directly, per-repo, uncapped, and only a genuine view event ever lowers
 * it. See `AttentionStore`/`SeenMap` in src/attention.ts for the other half of the join.
 */

import type { RunReceipt } from "./types.ts";
import { normalizeRepoPath } from "./project-registry.ts";
import type { SeenMap } from "./attention.ts";

export type FogState = "never-seen" | "seen-current" | "stale";

export interface FileFogEntry {
	repo: string;
	file: string;
	/** Count of receipts touching this file with `endedAt > (lastSeenAt ?? 0)` — each receipt counts
	 *  once per file, regardless of duplicate entries in that receipt's own `filesTouched`. This is
	 *  the raw, honest touch count: NEVER inflated by the concern-08 surprise boost below — that
	 *  boost only affects `debt`, so this field always answers "how many completed runs touched this
	 *  file since it was last seen", nothing else. */
	changesSinceSeen: number;
	/** Max `endedAt` over every completed (has `endedAt`) receipt that ever touched this file, scoped
	 *  to the requested repos — independent of `lastSeenAt`, used only for the tri-state comparison. */
	lastChangedAt: number;
	lastSeenAt?: number;
	/** `Math.min(1, Math.log2(1 + effectiveChanges) / DEBT_LOG_DIVISOR)` — absolute log-bucket
	 *  normalization, not a percentile or a decayed heat score. `effectiveChanges` is
	 *  `changesSinceSeen` plus the concern-08 surprise boost (below); with zero surprises the two are
	 *  identical. Monotone by construction: nothing in this formula depends on `now`, so the passage
	 *  of time alone can never move it — only a fresh receipt (raises it) or a fresh view collapsing
	 *  `changesSinceSeen` back to 0 (resets it) can. */
	debt: number;
	state: FogState;
}

/** `Math.log2(1 + n) / DEBT_LOG_DIVISOR`, clamped to 1. Named per the concern's "constant named,
 *  tested at boundaries" requirement. Mathematically, `n = 63` is the exact saturation point
 *  (`log2(64) === 6`); DESIGN.md's "≥64 unseen touches saturates" is the same order of magnitude
 *  stated informally — this constant and the formula below are the source of truth, not the prose.
 *  @substrate exported for tests (the boundary assertions compare against the named constant, not a
 *  duplicated magic number); production callers go through `computeFog`. */
export const DEBT_LOG_DIVISOR = 6;

/** Concern-08 forward-compat (plans/comprehension/08-intervene-teaching.md): a one-tap "surprised"
 *  chip on a file raises its effective change mass by this constant, independent of how many receipts
 *  actually touched it. Exported so 08's test suite can assert against the same constant this module
 *  uses, instead of a duplicated magic number.
 *  @substrate built-before-its-caller by design — concern 08 (intervene teaching) wires the surprise
 *  counts through; until then only tests reference it. */
export const SURPRISE_BOOST = 8;

const DAY_MS = 24 * 60 * 60 * 1000;

/** `${normalizeRepoPath(repo)}\0${file}` — MUST match `src/attention.ts`'s private `seenKey` exactly
 *  (same literal join key), since `SeenMap`'s keys are produced there and this module only reads them,
 *  never re-derives its own convention. */
function fogKey(repo: string, file: string): string {
	return `${normalizeRepoPath(repo)}\0${file}`;
}

/** `repos` filter as a fast-lookup predicate, normalized on both sides — the join-safety net
 *  DESIGN.md's "Tenant scoping" row demands: both receipts AND the seen map are filtered through
 *  this BEFORE anything is aggregated or joined, never after. An empty `repos` array admits nothing
 *  (fail closed — mirrors `AttentionStore.seenMapFor`'s `[]`-means-nothing contract), not "everything."
 */
function repoAllow(repos: string[]): (repo: string) => boolean {
	const keys = new Set(repos.map(normalizeRepoPath));
	return (repo: string) => keys.has(normalizeRepoPath(repo));
}

export interface ComputeFogInput {
	receipts: RunReceipt[];
	seen: SeenMap;
	/** Actor-visible repo allow-list — both inputs are filtered through this before joining. An empty
	 *  array yields an empty result (fail closed), never "unrestricted." */
	repos: string[];
	/** Present for interface symmetry with every other repo-scoped read in this codebase and reserved
	 *  for a future recency projection; the debt formula itself is `now`-independent by design (see
	 *  `FileFogEntry.debt`'s doc) — passing a different `now` with identical receipts/seen MUST NOT
	 *  change any entry's `debt`, which the property tests assert directly. */
	now: number;
	/** Concern-08 forward-compat: per-(repo,file) surprise-tap counts, keyed by the SAME `fogKey` join
	 *  key as `SeenMap`. Defaults to empty (no boost) so every batch-2 caller is a pure no-op extension
	 *  point until 08 wires real data through. Each count adds `SURPRISE_BOOST` to that file's
	 *  effective change mass for the `debt` calculation only — `changesSinceSeen` stays the raw count. */
	surpriseCounts?: Record<string, number>;
}

/**
 * Aggregate receipts directly into a monotone per-file comprehension-debt list, per DESIGN.md's
 * "Debt formula" row. Both `receipts` and `seen` are filtered through `input.repos` BEFORE any
 * aggregation or join happens — a foreign-repo receipt (or seen entry) never contributes to a file
 * it wasn't scoped for, regardless of an accidental file-path collision across repos.
 */
export function computeFog(input: ComputeFogInput): FileFogEntry[] {
	const { receipts, seen, repos, surpriseCounts } = input;
	const admit = repoAllow(repos);

	// Step 1: filter BOTH inputs through the repos allow-list before anything joins.
	const scopedReceipts = receipts.filter((r) => admit(r.repo));
	const scopedSeen: SeenMap = {};
	for (const [key, entry] of Object.entries(seen)) {
		const repo = key.slice(0, key.indexOf("\0"));
		if (admit(repo)) scopedSeen[key] = entry;
	}

	// Step 2: aggregate the scoped receipts per (repo,file) — every completed touch, uncapped,
	// tracking both "since last seen" and "ever" (for lastChangedAt / tri-state).
	interface Agg {
		repo: string;
		file: string;
		changesSinceSeen: number;
		lastChangedAt: number;
	}
	const byKey = new Map<string, Agg>();
	for (const r of scopedReceipts) {
		if (r.endedAt === undefined) continue; // an in-flight run's touch isn't a completed change yet
		const files = new Set(r.filesTouched); // each receipt counts once per file, even if listed twice
		for (const file of files) {
			const key = fogKey(r.repo, file);
			const existing = byKey.get(key) ?? { repo: r.repo, file, changesSinceSeen: 0, lastChangedAt: -Infinity };
			existing.lastChangedAt = Math.max(existing.lastChangedAt, r.endedAt);
			const lastSeenAt = scopedSeen[key]?.lastSeenAt ?? 0;
			if (r.endedAt > lastSeenAt) existing.changesSinceSeen++;
			byKey.set(key, existing);
		}
	}

	// Step 3: join with the (already-scoped) seen map and compute debt/state.
	const entries: FileFogEntry[] = [];
	for (const [key, agg] of byKey) {
		const lastSeenAt = scopedSeen[key]?.lastSeenAt;
		const boost = (surpriseCounts?.[key] ?? 0) * SURPRISE_BOOST;
		const effectiveChanges = agg.changesSinceSeen + boost;
		const debt = Math.min(1, Math.log2(1 + effectiveChanges) / DEBT_LOG_DIVISOR);
		const state: FogState = lastSeenAt === undefined ? "never-seen" : lastSeenAt >= agg.lastChangedAt ? "seen-current" : "stale";
		entries.push({
			// Canonical (normalized, ~-expanded) form — repoHasHistory keys and heat nodes emit the same
			// form server-side, so client membership checks never have to expand `~` themselves (code-
			// review resume finding 5).
			repo: normalizeRepoPath(agg.repo),
			file: agg.file,
			changesSinceSeen: agg.changesSinceSeen,
			lastChangedAt: agg.lastChangedAt,
			lastSeenAt,
			debt,
			state,
		});
	}

	// Deterministic order — not load-bearing for correctness, but stable across identical inputs.
	entries.sort((a, b) => normalizeRepoPath(a.repo).localeCompare(normalizeRepoPath(b.repo)) || a.file.localeCompare(b.file));
	return entries;
}

/**
 * Repo-level cold-start honesty (DESIGN.md "Cold-start red wall" row): true only when this repo's
 * attention history SPANS at least a day (`max(lastSeenAt) - min(lastSeenAt) >= 1 day`) across every
 * file the operator has ever looked at in it — a single bulk-import burst of seen events (all within
 * minutes of each other) does not count as "history," and neither does zero events. Exposed on the
 * fog payload so the UI can render "no view history yet" instead of an all-red wall for a repo the
 * operator simply hasn't had time to build real viewing history in.
 *
 * `now` clamps against a corrupt future-dated entry (defensive only — a real seen-map write is always
 * stamped no later than "now" at write time) so a bad clock on one write can't manufacture a false span.
 */
export function repoHasHistory(seenMap: SeenMap, repo: string, now: number): boolean {
	const target = normalizeRepoPath(repo);
	let min = Infinity;
	let max = -Infinity;
	for (const [key, entry] of Object.entries(seenMap)) {
		if (key.slice(0, key.indexOf("\0")) !== target) continue;
		const ts = Math.min(entry.lastSeenAt, now);
		if (ts < min) min = ts;
		if (ts > max) max = ts;
	}
	if (min === Infinity) return false;
	return max - min >= DAY_MS;
}

/** Top-N debt shortlist (DESIGN.md "Fog UI" row: "an actionable shortlist is the contract" — a
 *  full-tree red wall trains "toggle is noise"). Sorted by `debt` descending, ties broken by
 *  `changesSinceSeen` descending, then lexically by (repo,file) for a fully deterministic order —
 *  same headline list this concern's `GET /api/fog` callers, concern 04's overlay, and concern 09's
 *  weekly episode all share.
 *  2026-07-15 (concern 09, weekly episode): left the `@substrate` bucket for a REAL caller —
 *  `squad-manager.ts`'s `gatherEpisodeInputs` now consumes this directly for the episode's
 *  comprehension-debt section. Concern 04 (fog overlay shortlist) has since shipped too — its
 *  client-side ranking (`webapp/src/lib/heatmap.ts`'s `topFogDebt`) mirrors this exact ordering
 *  against the `/api/fog` payload rather than calling this server-side function directly (the
 *  overlay computes its own shortlist client-side), so both real callers this comment named now
 *  exist; this is no longer a substrate-only export waiting on a first caller. */
export function topDebt(entries: FileFogEntry[], n = 10): FileFogEntry[] {
	return [...entries]
		.sort(
			(a, b) =>
				b.debt - a.debt ||
				b.changesSinceSeen - a.changesSinceSeen ||
				normalizeRepoPath(a.repo).localeCompare(normalizeRepoPath(b.repo)) ||
				a.file.localeCompare(b.file),
		)
		.slice(0, n);
}

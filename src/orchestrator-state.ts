/**
 * Branch-keyed, restart-safe ledger of the Orchestrator's TERMINAL decisions (OMPSQ-139).
 *
 * The loop's halted/landed/staged sets were in-memory only, so a daemon restart reconsidered
 * every parked agent: it re-ran the acceptance suite, re-spent the repair budget, and could
 * re-trip CATASTROPHE on a genuinely-stuck agent every cycle. In a crash-supervised / self-
 * reloading daemon (OMPSQ-130) restarts are routine, so a human-summoned agent was silently
 * re-driven instead of staying parked. These decisions are terminal, so they must survive
 * restart.
 *
 * Keyed on BRANCH — stable across restarts — because create() mints a fresh agent id on every
 * re-adoption of a surviving worktree, the same reason land-ledger.ts keys on branch.
 *
 * ponytail: one JSON file under <stateDir>, read once into memory, write-through on mutation
 * (the manager is single-writer, single event loop, so no interleave). Ceiling: the file grows
 * one entry per ever-halted/landed/staged branch and is never pruned. Upgrade path: prune to
 * live branches on write, or fold into the sqlite ledger.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

/** The three terminal-decision classes the loop must not re-litigate after a restart. */
type Kind = "halted" | "landed" | "staged";
const KINDS: Kind[] = ["halted", "landed", "staged"];

/** Branch-keyed terminal-decision store consulted by the Orchestrator each tick. */
export interface OrchestratorPersistence {
	isHalted(branch: string): boolean;
	isLanded(branch: string): boolean;
	isStaged(branch: string): boolean;
	markHalted(branch: string): void;
	markLanded(branch: string): void;
	markStaged(branch: string): void;
	/**
	 * Purge ledger entries for branches that no longer exist in the current roster.
	 * Only branches absent from `liveBranches` are dropped — live branches are never touched.
	 * Call this once per tick (after the agent loop) to bound ledger growth: branches that
	 * were deleted/cleaned up leave stale entries otherwise accumulating forever.
	 */
	purgeStale(liveBranches: string[]): void;
}

/** Open (or create) the on-disk ledger under `stateDir`, loading any prior decisions into memory. */
export function openOrchestratorState(stateDir: string): OrchestratorPersistence {
	const file = path.join(stateDir, "orchestrator-state.json");
	const sets: Record<Kind, Set<string>> = { halted: new Set(), landed: new Set(), staged: new Set() };
	try {
		if (existsSync(file)) {
			const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Record<Kind, unknown>>;
			for (const k of KINDS) {
				const v = raw?.[k];
				if (Array.isArray(v)) sets[k] = new Set(v.filter((x): x is string => typeof x === "string"));
			}
		}
	} catch {
		/* corrupt/unreadable ⇒ start fresh (worst case: one redundant verify / re-summon per branch) */
	}

	const flush = (): void => {
		try {
			writeFileSync(file, JSON.stringify({ halted: [...sets.halted], landed: [...sets.landed], staged: [...sets.staged] }));
		} catch {
			/* best-effort: a disk failure must never break the decision it records */
		}
	};
	const mark = (k: Kind, branch: string): void => {
		if (branch && !sets[k].has(branch)) {
			sets[k].add(branch);
			flush();
		}
	};

	const purgeStale = (liveBranches: string[]): void => {
		const live = new Set(liveBranches.filter(Boolean));
		let changed = false;
		for (const k of KINDS) {
			for (const branch of [...sets[k]]) {
				if (!live.has(branch)) {
					sets[k].delete(branch);
					changed = true;
				}
			}
		}
		if (changed) flush();
	};

	return {
		isHalted: (b) => !!b && sets.halted.has(b),
		isLanded: (b) => !!b && sets.landed.has(b),
		isStaged: (b) => !!b && sets.staged.has(b),
		markHalted: (b) => mark("halted", b),
		markLanded: (b) => mark("landed", b),
		markStaged: (b) => mark("staged", b),
		purgeStale,
	};
}

/**
 * Spawn identity + restart-adoption policy — pure decisions extracted from the
 * squad-manager god-file (it re-exports these, so import paths are unchanged).
 *
 * Identity: agent ids are unique across restarts (branch + worktree derive from the id,
 * never the display name). Adoption: which persisted agents a fresh daemon takes over,
 * bounded so a restart can't respawn every orphaned worktree at once, and which
 * checkpointed workflows must be PRESERVED when the ceiling defers them (D1).
 */

import { randomBytes } from "node:crypto";
import * as os from "node:os";
import type { IssueRef } from "./types.ts";

/** Absolute live-agent ceiling that even bypass-cap (fan-out) spawns respect, so runaway fan-out can't
 *  melt the host. Default ≈ the host's CPU count (min 3) so a bare launch is bounded; override with OMP_SQUAD_MAX_AGENTS. */
export function hardAgentCeiling(): number {
	return Number(process.env.OMP_SQUAD_MAX_AGENTS) || Math.max(os.cpus().length || 2, 3);
}

/** Persisted agents to take over on restart: not already reattached (live), not flue, and whose worktree
 *  still holds context on disk. Live hosts are reattached by reconnectLive; a gone worktree re-dispatches. */
export function agentsToAdopt<T extends { id: string; kind?: string; worktree?: string; parentId?: string }>(
	persisted: T[],
	rosterIds: ReadonlySet<string>,
	worktreeExists: (worktree: string) => boolean,
): T[] {
	// Exclude parallel-branch children (parentId set): a branch belongs to its parent run, whose own
	// resume re-drives the fan-out. Adopting a branch as a plain agent would direct-land it independently
	// of the join → a double-land (and revives completed wait_all branches on the next restart).
	return persisted.filter((p) => p.kind !== "flue-service" && !p.parentId && !rosterIds.has(p.id) && !!p.worktree && worktreeExists(p.worktree));
}

/**
 * From the adoptable set, resume only agents that still have UNLANDED work, capped at `cap`. A restart
 * otherwise re-spawned EVERY orphaned worktree at once (adoptOrphanedAgents uses bypassCap, so MAX_AGENTS
 * didn't hold) — N simultaneous omp hosts that OOM the box. Done/clean agents are skipped (their open
 * issue, if any, is re-dispatched gradually under the WIP cap); `cap<=0` ⇒ adopt none.
 */
export function selectAdoptable<T extends { id: string }>(eligible: T[], hasWork: (a: T) => boolean, cap: number): T[] {
	if (cap <= 0) return [];
	return eligible.filter(hasWork).slice(0, cap);
}

/**
 * The resumable records NOT taken this boot (dropped by the ceiling). They must be PRESERVED, not
 * erased: the full-snapshot-replace persist would otherwise overwrite an un-adopted checkpointed
 * workflow into permanent loss (D1). persistNow folds these back into the snapshot so a later routine
 * restart re-attempts them. Resumability is the operative signal — a plain over-ceiling agent re-dispatches
 * from its still-open issue, but a workflow checkpoint has nothing to re-dispatch it.
 */
export function deferredResumable<T extends { id: string }>(eligible: T[], resumable: (p: T) => boolean, adopted: T[]): T[] {
	const adoptedIds = new Set(adopted.map((a) => a.id));
	return eligible.filter((p) => resumable(p) && !adoptedIds.has(p.id));
}

let agentIdSeq = 0;

/**
 * Unique agent id: name + time + process-local sequence + random suffix. The branch and worktree derive
 * from this id (NOT the agent's display name), so two agents — even same name, even spawned in the same
 * millisecond or across a daemon restart — never share a branch or worktree. (The name alone collides:
 * dispatched agents fall back to `agent-N` whose counter resets every restart, so "agent-1" gets reused.)
 */
export function newAgentId(name: string): string {
	return `${name}-${Date.now().toString(36)}-${(++agentIdSeq).toString(36)}-${randomBytes(4).toString("hex")}`;
}

export function slugPart(text: string, max = 60): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");
}

/** Descriptive, stable branch for Plane-driven work: `squad/ompsq-319-short-title`. */
export function planeIssueBranch(issue: IssueRef): string {
	const ident = slugPart(issue.identifier ?? issue.id, 32);
	const title = slugPart(issue.name);
	return `squad/${[ident, title].filter(Boolean).join("-") || "plane-issue"}`;
}

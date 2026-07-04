/**
 * Plan STATUS reconciler — keeps `plans/<x>/NN-concern.md` STATUS lines truthful.
 *
 * The factory dispatches and prioritizes off STATUS lines, and they drift: a concern
 * lands (its Plane issue goes Done) but the doc still says `open`, so WIP counters lie
 * and operators re-derive state by hand. The 2026-07-01 goal-gap audit found five plans
 * lying this way. The /sync-plans skill closes the gap manually; this loop closes it
 * continuously, in-product, for every concern that carries a `PLANE: <ID>` pointer.
 *
 * Deliberately conservative, one-directional-per-transition:
 *   - Plane Done/Completed/Closed  ⇒ STATUS: done       (from any non-done status)
 *   - Plane Cancelled              ⇒ STATUS: cancelled   (from any non-terminal status)
 *   - Plane In Progress/Started    ⇒ STATUS: in_progress (ONLY from open-ish statuses)
 *   - It NEVER reopens a done/cancelled doc — a human may know better than the tracker;
 *     that drift is logged (`plan-sync: <id> doc says done but Plane says <state>`) for
 *     the operator instead of silently un-doing verified work.
 *
 * Only the STATUS line is rewritten (first match, in place); the doc body is never touched.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { AutomationRecorder } from "./automation-log.ts";
import type { IssueRef } from "./types.ts";
import { listPlanDirs, parsePlanConcerns, type PlanConcern } from "./features.ts";

const STATUS_LINE = /^STATUS:\s*[\w-]+[^\n]*$/im;
const OPENISH = new Set(["open", "todo", "not_started", "not-started", "backlog", "pending", "planned", ""]);
const TERMINAL = new Set(["done", "complete", "completed", "closed", "cancelled", "canceled"]);

/**
 * The STATUS a concern doc should carry for a Plane state — undefined ⇒ leave the doc alone.
 * `planeState` is a state GROUP (`listPlaneIssuesAllStates` resolves ids → groups:
 * backlog/unstarted/started/completed/cancelled); raw state names are accepted as fallback.
 */
export function statusForPlaneState(planeState: string | undefined, docStatus: string): string | undefined {
	const state = (planeState ?? "").trim().toLowerCase();
	const doc = docStatus.trim().toLowerCase();
	if (!state) return undefined;
	if (["completed", "done", "closed"].includes(state)) return TERMINAL.has(doc) ? undefined : "done";
	if (["cancelled", "canceled"].includes(state)) return TERMINAL.has(doc) ? undefined : "cancelled";
	if (["started", "in progress", "in_progress"].includes(state)) return OPENISH.has(doc) ? "in_progress" : undefined;
	return undefined; // backlog/unstarted/unknown never mutate the doc
}

export interface PlanSyncDeps {
	repo: string;
	/** Open + closed issues for the repo; `null` ⇒ Plane unreachable this tick (skip, no writes). */
	listIssues: () => Promise<IssueRef[] | null>;
	/** Whether a DoneProof (concern 01's ledger) is on record for the issue identifier — gates the `done` write. */
	hasProof: (issueIdentifier: string) => boolean;
	log?: (msg: string) => void;
	record?: AutomationRecorder;
}

export interface PlanSyncResult {
	scanned: number;
	updated: { path: string; planeId: string; from: string; to: string }[];
	/** Doc says done/cancelled but the tracker disagrees — surfaced, never auto-reopened. */
	conflicts: { path: string; planeId: string; doc: string; plane: string }[];
	/** Plane says done/completed but no DoneProof exists — written as `done (unproven ...)`, surfaced here. */
	unproven: { path: string; planeId: string }[];
}

/** One reconcile pass over every plan dir in the repo. Best-effort: an unreadable doc is skipped. */
export async function syncPlanStatuses(deps: PlanSyncDeps): Promise<PlanSyncResult> {
	const result: PlanSyncResult = { scanned: 0, updated: [], conflicts: [], unproven: [] };
	const issues = await deps.listIssues();
	if (issues === null) return result; // tracker unreachable — change nothing
	const byIdentifier = new Map<string, IssueRef>();
	for (const issue of issues) {
		if (issue.identifier) byIdentifier.set(issue.identifier.toUpperCase(), issue);
	}

	for (const planDir of await listPlanDirs(deps.repo)) {
		let concerns: PlanConcern[];
		try {
			concerns = await parsePlanConcerns(deps.repo, planDir.dir);
		} catch {
			continue;
		}
		for (const concern of concerns) {
			if (!concern.planeId) continue;
			result.scanned++;
			const issue = byIdentifier.get(concern.planeId.toUpperCase());
			if (!issue) continue;
			const docStatus = concern.status.trim().toLowerCase();
			const next = statusForPlaneState(issue.state, docStatus);
			if (next === undefined) {
				// Terminal doc vs non-terminal tracker ⇒ a human-visible conflict, never an auto-reopen.
				const planeState = (issue.state ?? "").toLowerCase();
				if (TERMINAL.has(docStatus) && planeState && !["done", "completed", "closed", "cancelled", "canceled"].includes(planeState)) {
					result.conflicts.push({ path: concern.path, planeId: concern.planeId, doc: concern.status, plane: issue.state ?? "" });
				}
				continue;
			}
			// A Plane-completed doc with no recorded DoneProof is a legitimate human override (or a
			// grandfathered pre-ship Done) — allowed, but never written as an indistinguishable-from-verified
			// bare `done`. The parenthetical is purely a human-legible annotation: features.ts's C_STATUS
			// regex only captures the `[\w-]+` token immediately after `STATUS:`, so it still reads back as `done`.
			let writeValue = next;
			if (next === "done" && !deps.hasProof(concern.planeId)) {
				writeValue = "done (unproven — closed in Plane without land proof)";
				result.unproven.push({ path: concern.path, planeId: concern.planeId });
			}
			try {
				const abs = path.join(deps.repo, concern.path);
				const text = await fsp.readFile(abs, "utf8");
				if (!STATUS_LINE.test(text)) continue;
				await fsp.writeFile(abs, text.replace(STATUS_LINE, `STATUS: ${writeValue}`));
				result.updated.push({ path: concern.path, planeId: concern.planeId, from: concern.status, to: writeValue });
				deps.log?.(`plan-sync: ${concern.planeId} ${concern.status} → ${writeValue} (${concern.file})`);
			} catch {
				// skip an unwritable doc; next tick retries
			}
		}
	}
	for (const conflict of result.conflicts) {
		deps.log?.(`plan-sync: ${conflict.planeId} doc says ${conflict.doc} but Plane says ${conflict.plane} — not auto-reopening (${conflict.path})`);
	}
	deps.record?.({
		found: result.updated.length,
		level: result.conflicts.length ? "warn" : "info",
		detail: result.updated.length
			? `${result.updated.length} STATUS line(s) reconciled${result.conflicts.length ? `; ${result.conflicts.length} terminal-doc conflict(s)` : ""}${result.unproven.length ? `; ${result.unproven.length} unproven done(s)` : ""}`
			: result.conflicts.length
				? `${result.conflicts.length} terminal-doc conflict(s) surfaced (doc says done, tracker disagrees)`
				: `no drift across ${result.scanned} PLANE-linked concern(s)`,
	});
	return result;
}

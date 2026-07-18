/**
 * `ContinuityRecord` maintenance (concern 11, `plans/land-assessment/11-accepted-state-anchor.md`) —
 * whether the indexed history is a continuous ACCEPTED-state lineage from `lastIndexed` to `current`.
 * Not every main transition flows through glance (humans, bots, force pushes) — SCHEMA-V0.md's
 * `ContinuityRecord` doc is explicit that `unknown` continuity triggers reconcile-or-re-extract; the
 * temporal model must never silently assume completeness (ADR.md's drift checklist, danger sign #7).
 *
 * Two ways continuity breaks, both surfaced as `status: "unknown"`, distinguished only by `reason`:
 *   - `lastIndexed` is no longer an ancestor of `current` at all — history was rewritten (force push,
 *     rebase-and-force of a shared branch). Detected via `git merge-base --is-ancestor`.
 *   - `lastIndexed` IS an ancestor, but one or more commits strictly between the two were never
 *     accounted for by glance (an external push that fast-forwarded past the daemon while it was down,
 *     a bot merge). Detected only when the caller supplies `knownTransitions` — this module has no
 *     ledger of its own to consult (that ledger, if one is ever built, belongs to a later concern's land
 *     hook); without it, this leg of the check is simply skipped, never guessed at.
 *
 * Repair is `repairContinuity`: reconcile-or-re-extract, per the Approach — re-checkpoints AT `current`
 * (`manifest.ts#extractManifest`) and returns a fresh `continuous` record. `current` here plays exactly
 * the accepted-state role SCHEMA-V0.md's C≠R rule describes for a landed `R`: this function must only
 * ever be called with an INDEPENDENTLY OBSERVED accepted state, never an unlanded candidate.
 */

import * as path from "node:path";
import { getStorageBackend } from "../dal/storage.ts";
import { errText } from "../err-text.ts";
import { git } from "./analyzers/plugin.ts";
import { extractManifest, writeManifest } from "./manifest.ts";
import { validateRepositoryStateRef } from "./schema.ts";
import type { ContinuityRecord, ProducerRef, RepositoryManifest, RepositoryStateRef } from "./schema.ts";
import { repoHash16 } from "./store.ts";

export const REASON_NON_ANCESTOR = "non-ancestor (force push)";
export const REASON_UNOBSERVED_TRANSITION = "unobserved external transition";

function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.length > 0;
}

// ── Validation (owned here — schema.ts's own doc: "shapes frozen here; owned by concern 11") ──────

/** THROWS on any structurally invalid `ContinuityRecord` — the validate-on-read guard every durable
 *  record in this subsystem carries. */
export function validateContinuityRecord(v: unknown): ContinuityRecord {
	if (!v || typeof v !== "object") throw new Error(`land-assessment continuity: ContinuityRecord is not an object: ${JSON.stringify(v)}`);
	const c = v as Partial<ContinuityRecord>;
	if (!isNonEmptyString(c.repositoryId)) throw new Error("land-assessment continuity: ContinuityRecord.repositoryId must be a non-empty string");
	validateRepositoryStateRef(c.lastIndexed, "ContinuityRecord.lastIndexed");
	validateRepositoryStateRef(c.current, "ContinuityRecord.current");
	if (c.status !== "continuous" && c.status !== "unknown") throw new Error(`land-assessment continuity: ContinuityRecord.status is invalid: ${JSON.stringify(c.status)}`);
	if (c.reason !== undefined && typeof c.reason !== "string") throw new Error("land-assessment continuity: ContinuityRecord.reason must be a string when present");
	return c as ContinuityRecord;
}

// ── Persistence (one current record per repo — a later check supersedes the earlier one by overwrite,
//    the same way a re-checkpoint supersedes; the record's whole purpose is "what is CURRENTLY known
//    about continuity", not a history of every past check) ─────────────────────────────────────────

function continuityFilePath(stateDir: string, repositoryId: string): string {
	return path.join(stateDir, "land-assessment", repoHash16(repositoryId), "continuity.json");
}

export async function writeContinuityRecord(stateDir: string, record: ContinuityRecord): Promise<void> {
	await getStorageBackend().writeDurable(continuityFilePath(stateDir, record.repositoryId), JSON.stringify(record));
}

/** `undefined` when no continuity record has ever been written for this repo — the legitimate
 *  never-checked case, not an error. THROWS (validate-on-read) on a corrupt/torn file. */
export async function readContinuityRecord(stateDir: string, repositoryId: string): Promise<ContinuityRecord | undefined> {
	const file = continuityFilePath(stateDir, repositoryId);
	const text = await getStorageBackend().readText(file);
	if (!text) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		throw new Error(`land-assessment continuity: ${file} unparseable (possibly torn): ${errText(err)}`);
	}
	return validateContinuityRecord(parsed);
}

// ── The check ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Compare `lastIndexed` against `current` and report continuity. `repo` is the local checkout both
 * refs were observed against. `knownTransitions`, when supplied, is the set of commit SHAs glance
 * itself accounted for (e.g. every `resultCommit` this repo's land-assessment store has recorded) — used
 * to detect the "ancestor, but an unaccounted external transition landed in between" case; omitted, that
 * leg is skipped (never guessed at) and only the non-ancestor (rewrite) case is checked.
 */
export async function checkContinuity(repo: string, lastIndexed: RepositoryStateRef, current: RepositoryStateRef, knownTransitions?: ReadonlySet<string>): Promise<ContinuityRecord> {
	if (lastIndexed.repositoryId !== current.repositoryId) {
		throw new Error("land-assessment continuity: checkContinuity requires lastIndexed and current to share the same repositoryId");
	}
	const repositoryId = current.repositoryId;
	if (lastIndexed.commit === current.commit) return { repositoryId, lastIndexed, current, status: "continuous" };

	const isAncestor = await git(["merge-base", "--is-ancestor", lastIndexed.commit, current.commit], repo);
	if (isAncestor.code !== 0) return { repositoryId, lastIndexed, current, status: "unknown", reason: REASON_NON_ANCESTOR };

	if (knownTransitions) {
		const between = await git(["rev-list", "--first-parent", `${lastIndexed.commit}..${current.commit}`], repo);
		if (between.code === 0) {
			const commits = between.stdout.split("\n").filter(Boolean);
			const unaccounted = commits.some((c) => !knownTransitions.has(c));
			if (unaccounted) return { repositoryId, lastIndexed, current, status: "unknown", reason: REASON_UNOBSERVED_TRANSITION };
		}
	}

	return { repositoryId, lastIndexed, current, status: "continuous" };
}

// ── Repair: reconcile-or-re-extract ─────────────────────────────────────────────────────────────────

/**
 * Re-checkpoint AT `current` and return a fresh `continuous` record. Per this module's own doc, `current`
 * must be an independently-observed ACCEPTED state (never an unlanded candidate) — the same discipline
 * `manifest.ts#extractManifest` states for its own `stateRef` parameter, which this function calls
 * directly.
 */
export async function repairContinuity(stateDir: string, repo: string, current: RepositoryStateRef, producer: ProducerRef): Promise<{ manifest: RepositoryManifest; continuity: ContinuityRecord }> {
	void repo; // not needed for the repair itself (extractManifest reads via current.repositoryId), kept for signature symmetry with checkContinuity and future accounted-transition seeding
	const manifest = await extractManifest(current, producer);
	await writeManifest(stateDir, manifest);
	const continuity: ContinuityRecord = { repositoryId: current.repositoryId, lastIndexed: current, current, status: "continuous" };
	await writeContinuityRecord(stateDir, continuity);
	return { manifest, continuity };
}

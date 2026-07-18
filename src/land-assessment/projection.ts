/**
 * The lineage projector (concern 11, `plans/land-assessment/11-accepted-state-anchor.md`) —
 * `projectState(repoStateRef)` = nearest ancestor manifest/checkpoint (`manifest.ts`) + accepted
 * `ChangeObservation`s along the selected lineage, falling back to on-demand full historical extraction
 * (`extractStateFacts`) when the chain is broken.
 *
 * SCHEMA-V0.md's exact-state-addressing rule this module implements: `validFromCommit`/`validUntilCommit`
 * intervals are NEVER stored as primitives — they are lineage PROJECTIONS computed HERE, at read time.
 * Concretely: a fact carried forward unchanged from a checkpoint keeps its ORIGINAL `state` (it was
 * genuinely OBSERVED at that commit) — this projector does not re-stamp it to the target commit. What it
 * asserts is narrower and more honest: "this fact, last observed at the checkpoint, is STILL VALID at
 * the target" — an interval computed by walking the git diff between the two, never a property baked
 * into the stored record. A fact whose file DID change between the checkpoint and the target is
 * re-extracted fresh, addressed to the target the way `extractStateFacts` always addresses output.
 *
 * The identity check this concern's Verify section names ("projection through a checkpoint + deltas
 * equals direct extraction at the target commit") is therefore a CONTENT check — the (subject, predicate,
 * object) triples a projection asserts as true at the target must equal what a full extraction at the
 * target would assert — not a byte-for-byte record comparison (`factContentTriple`/`factContentSet`
 * below are the exported comparison primitive for exactly this).
 */

import { git } from "./analyzers/plugin.ts";
import { extractStateFacts, parseNameStatus } from "./analyzers/typescript-structural-delta.ts";
import { buildEntityRecords, listManifestCommits, readManifest } from "./manifest.ts";
import type { EntityRecord, ExtractionCoverage, RepositoryStateRef, SnapshotFact } from "./schema.ts";

export interface ProjectionResult {
	state: RepositoryStateRef;
	entities: EntityRecord[];
	facts: SnapshotFact[];
	/** Coverage of the work THIS projection call actually performed (fresh extraction of changed files) —
	 *  never a running total across the checkpoint's own history. Consult the checkpoint manifest's own
	 *  `extractionCoverage` (via `readManifest`) for that checkpoint's own numbers; this module never
	 *  double-counts a file into both. */
	coverage: ExtractionCoverage[];
	/** Set when NO checkpoint chain could be used at all (no checkpoint exists for this lineage, or the
	 *  checkpoint found was unreadable, or the git diff probe itself failed) — the projector fell all the
	 *  way back to a full `extractStateFacts(target)` run. Absence of this field means the incremental
	 *  checkpoint+delta path was actually exercised, not merely available. */
	fallback?: { reason: string };
}

/** Every checkpoint commit for this repo that is an ANCESTOR of `target`, closest first (fewest commits
 *  between the checkpoint and `target`). `undefined` when no candidate is an ancestor at all (e.g. every
 *  checkpoint predates a history rewrite, or none exists yet) — the caller's cue to fall back to full
 *  extraction. Ancestry (not merely "checkpoint's commit differs from target") is required because a
 *  checkpoint on a sibling/abandoned branch is not on `target`'s lineage at all — walking a diff between
 *  unrelated commits would fabricate a delta, not compute one. */
async function nearestAncestorCheckpoint(repo: string, candidates: readonly string[], target: string): Promise<string | undefined> {
	let best: { commit: string; distance: number } | undefined;
	for (const candidate of candidates) {
		if (candidate === target) return candidate; // exact match — distance 0, cannot be beaten
		const isAncestor = await git(["merge-base", "--is-ancestor", candidate, target], repo);
		if (isAncestor.code !== 0) continue; // not on target's lineage — not a candidate at all
		const count = await git(["rev-list", "--count", `${candidate}..${target}`], repo);
		const distance = count.code === 0 && count.stdout ? Number.parseInt(count.stdout, 10) : Number.POSITIVE_INFINITY;
		if (!best || distance < best.distance) best = { commit: candidate, distance };
	}
	return best?.commit;
}

async function fullFallback(target: RepositoryStateRef, reason: string): Promise<ProjectionResult> {
	const extraction = await extractStateFacts(target);
	return { state: target, entities: buildEntityRecords(extraction.facts), facts: extraction.facts, coverage: extraction.coverage, fallback: { reason } };
}

/**
 * Project the accepted-state facts at `target` from the nearest checkpoint on its lineage plus the git
 * delta between them. `repo` is the local checkout `target` was observed against (plain read-only git
 * plumbing, same convention as every analyzer in this subsystem — no worktree checkout, no mutation).
 *
 * @substrate Phase-1 producer (concern 11) with no external caller yet -- a future replay/inspect CLI
 * surface and concern 08's land hook are this projector's intended production callers
 * (plans/land-assessment); a co-located test consumer is not a real reference (dead-exports.ts's own
 * carve-out).
 */
export async function projectState(stateDir: string, repo: string, repositoryId: string, target: RepositoryStateRef): Promise<ProjectionResult> {
	const candidates = await listManifestCommits(stateDir, repositoryId);
	if (candidates.length === 0) return fullFallback(target, "no checkpoint manifest exists yet for this repository — full historical extraction");

	const nearestCommit = await nearestAncestorCheckpoint(repo, candidates, target.commit);
	if (!nearestCommit) return fullFallback(target, "no checkpoint manifest is an ancestor of the target commit on this lineage — full historical extraction");

	const checkpoint = await readManifest(stateDir, repositoryId, nearestCommit);
	if (!checkpoint) return fullFallback(target, `checkpoint manifest listed for commit ${nearestCommit} but unreadable — full historical extraction`);

	if (checkpoint.state.commit === target.commit) {
		// Exact hit: the checkpoint IS the target — nothing to re-extract, coverage of THIS call is empty.
		return { state: target, entities: checkpoint.entities, facts: checkpoint.facts, coverage: [] };
	}

	const diff = await git(["diff", "--name-status", "-M", checkpoint.state.commit, target.commit], repo);
	if (diff.code !== 0) {
		return fullFallback(target, `git diff probe failed between checkpoint ${checkpoint.state.commit} and target ${target.commit}: ${diff.stderr || diff.stdout || "no output"}`);
	}

	const { entries } = parseNameStatus(diff.stdout);
	// A file's checkpoint-era facts are superseded the instant that PATH is touched on either side of a
	// rename, or removed outright — `changedPaths` is exactly the set `extractStateFacts`'s `filesOverride`
	// needs re-extracted fresh at `target`; `supersededOnlyPaths` (the pre-rename source of a clean rename)
	// carries no facts at `target` at all — its old-path entries are simply dropped, never re-extracted.
	const changedPaths = new Set<string>();
	const supersededOnlyPaths = new Set<string>();
	for (const entry of entries) {
		if (entry.operation === "removed") {
			supersededOnlyPaths.add(entry.path);
			continue;
		}
		if (entry.operation === "renamed") supersededOnlyPaths.add(entry.fromPath!);
		changedPaths.add(entry.path);
	}

	// IMPORTS facts are the one predicate whose OBJECT is resolved against the WHOLE tree at the commit
	// (typescript-structural-delta.ts: `object.value = resolvedPath ?? spec`), so an OTHERWISE-untouched
	// file's kept import edge can go stale even though its own path never changed — its sibling did. Any of:
	//   1. a RESOLVED edge (object is a tree path) whose target module was removed or renamed away — the
	//      import no longer resolves there;
	//   2. an UNRESOLVED edge (object kept the raw relative specifier) that a newly added path could satisfy;
	//   3. a RESOLVED edge that a newly added HIGHER-PRIORITY path shadows — e.g. `./foo` resolved to foo.tsx
	//      at the checkpoint, target adds foo.ts, and direct extraction now resolves to foo.ts (found by the
	//      cross-lineage review; the earlier fix missed this case because it only re-checked unresolved edges).
	// Because we store only the RESOLVED object (not the original specifier), we cannot cheaply tell which
	// resolved edges an addition could shadow — so when the tree gained any path we conservatively re-extract
	// every untouched IMPORTS owner. Re-extraction yields identical facts when resolution didn't actually
	// change (pure cost, never wrong), and is bounded to commits that added/renamed-in a path. Every other
	// predicate's object is a name or a hash (EXPORTS/EXTENDS/IMPLEMENTS/HAS_SIGNATURE), membership-independent,
	// and stays safely kept. This closes the concern-11 identity contract (projection == direct extraction).
	const additionsPresent = entries.some((e) => e.operation === "added" || e.operation === "renamed");
	for (const f of checkpoint.facts) {
		if (f.predicate !== "IMPORTS" || f.object.kind !== "string") continue;
		const owner = f.subject.path;
		if (changedPaths.has(owner) || supersededOnlyPaths.has(owner)) continue; // already re-extracted, or dropped as superseded
		const resolvedTargetGone = supersededOnlyPaths.has(f.object.value); // only a real tree path can match this set
		if (resolvedTargetGone || additionsPresent) changedPaths.add(owner);
	}

	const keptFacts = checkpoint.facts.filter((f) => !supersededOnlyPaths.has(f.subject.path) && !changedPaths.has(f.subject.path));
	const changedExtraction = await extractStateFacts(target, [...changedPaths]);
	const facts = [...keptFacts, ...changedExtraction.facts].sort((a, b) => a.factId.localeCompare(b.factId));
	return { state: target, entities: buildEntityRecords(facts), facts, coverage: changedExtraction.coverage };
}

// ── Content-level comparison (the "anchor identity check" primitive) ───────────────────────────────

/** A projected fact and a directly-extracted fact for the SAME target commit may legitimately carry
 *  different `factId`/`state.commit`/`observedAt`/`evidence` (a kept fact's `state` still points at the
 *  checkpoint commit it was genuinely observed at — see this module's own doc). This is the CONTENT the
 *  two are asserting, stripped of that provenance, so a caller can compare "what does the projection
 *  believe is true" against "what does direct extraction say is true" without the provenance fields
 *  producing a false mismatch. */
/** @substrate exported for tests only — `factContentSet` (below, same file) is the one production
 *  caller; a co-located test consumer is not a real reference (dead-exports.ts's own carve-out). */
export function factContentTriple(f: SnapshotFact): string {
	return JSON.stringify({ subject: f.subject, predicate: f.predicate, object: f.object });
}

/** @substrate exported for tests only — the accepted-state-anchor identity check (this module's own
 *  doc, above) is currently asserted directly from tests; a future `projectState` caller that wants to
 *  compare its own result against a fresh extraction is expected to call this too. */
export function factContentSet(facts: readonly SnapshotFact[]): Set<string> {
	return new Set(facts.map(factContentTriple));
}

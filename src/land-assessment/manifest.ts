/**
 * Accepted-state anchor — manifest extraction + persistence (concern 11,
 * `plans/land-assessment/11-accepted-state-anchor.md`). Deltas alone cannot answer "what was module X's
 * interface at commit A" — a `RepositoryManifest` is the periodic checkpoint the lineage projector
 * (`projection.ts`) replays deltas forward FROM, bounding replay length instead of walking a repo's
 * entire history for every read.
 *
 * Extraction reuses the structural-delta analyzer's own full-state entry point (concern 04's
 * `extractStateFacts`) unchanged — the concern's explicit requirement that the manifest anchor and the
 * per-land delta analyzer never diverge into two different notions of "what does this file export".
 *
 * `RepositoryManifest`/`EntityRecord` are schema.ts shapes "frozen here; owned by concern 11" (that
 * module's own doc comment) — this file is where their validate-on-read guard and persistence live,
 * mirroring `schema.ts`'s validate-on-read discipline for every other durable shape in this subsystem.
 *
 * Persistence is one file per checkpoint commit (`manifest-<commit>.json`, atomic
 * `writeDurable`/temp+rename via `getStorageBackend`) under the SAME per-repo shard directory `store.ts`
 * uses (`repoHash16`) — collectively append-only across the directory (a commit's manifest file is never
 * overwritten; a later checkpoint is a new file, never a mutation), even though each individual file
 * itself is not a JSONL append log the way `store.ts`'s event shards are: a periodic checkpoint is
 * written once, at most a handful of times per day, never concurrently from two directions at the same
 * commit — the append-only invariant that matters (never destroying a PRIOR checkpoint) holds without
 * needing `store.ts`'s single-writer mutex/CRC machinery, which exists for `store.ts`'s very different
 * concurrent-multi-KB-append-per-land workload.
 */

import * as path from "node:path";
import { getStorageBackend } from "../dal/storage.ts";
import { errText } from "../err-text.ts";
import { extractStateFacts } from "./analyzers/typescript-structural-delta.ts";
import { validateRepositoryStateRef, validateSnapshotFact } from "./schema.ts";
import type { EntityLocator, EntityRecord, ExtractionCoverage, ProducerRef, RepositoryManifest, RepositoryStateRef, SnapshotFact } from "./schema.ts";
import { repoHash16 } from "./store.ts";

// ── Checkpoint cadence (Approach: "on first enablement per repo, then every N accepted transitions") ──

/** The concern's own stated default cadence — bounds `projection.ts`'s replay length between
 *  checkpoints. Configurable per call site; not a global constant anything else reads. */
export const DEFAULT_CHECKPOINT_CADENCE = 50;

/** No prior checkpoint exists for this repo at all — "on first enablement per repo" (Approach). Pure:
 *  callers pass whatever `listManifestCommits` (below) already told them. */
export function needsInitialCheckpoint(existingManifestCommits: readonly string[]): boolean {
	return existingManifestCommits.length === 0;
}

/** "then every N accepted transitions" (Approach) — pure cadence arithmetic; the caller (a future land
 *  hook / periodic job, outside this concern's scope) is responsible for tracking
 *  `transitionsSinceLastCheckpoint` itself. */
export function dueForPeriodicCheckpoint(transitionsSinceLastCheckpoint: number, cadence: number = DEFAULT_CHECKPOINT_CADENCE): boolean {
	return transitionsSinceLastCheckpoint >= cadence;
}

// ── Entity grouping (SnapshotFact[] -> EntityRecord[]) ─────────────────────────────────────────────

function entityKey(locator: EntityLocator): string {
	return `${locator.qualifiedName}\0${locator.path}\0${locator.kind}`;
}

/** Groups a flat fact list into one `EntityRecord` per distinct subject locator — `factIds` indexed by
 *  id rather than duplicating fact bodies (`schema.ts`'s own doc on `EntityRecord`). Sorted
 *  deterministically so two extractions of the same content always produce the same manifest bytes. */
export function buildEntityRecords(facts: readonly SnapshotFact[]): EntityRecord[] {
	const byLocator = new Map<string, { locator: EntityLocator; factIds: Set<string> }>();
	for (const f of facts) {
		const key = entityKey(f.subject);
		let entry = byLocator.get(key);
		if (!entry) {
			entry = { locator: f.subject, factIds: new Set() };
			byLocator.set(key, entry);
		}
		entry.factIds.add(f.factId);
	}
	const entities = [...byLocator.values()].map((e) => ({ locator: e.locator, factIds: [...e.factIds].sort() }));
	entities.sort((a, b) => entityKey(a.locator).localeCompare(entityKey(b.locator)));
	return entities;
}

// ── Manifest extraction (the accepted-state extraction path) ───────────────────────────────────────

/**
 * Extract a full `RepositoryManifest` at one exact state — the anchor `projection.ts` replays forward
 * from. `stateRef` MUST be an ACCEPTED state (main, or an independently-observed landed result `R`) —
 * SCHEMA-V0.md's C≠R rule: `facts(C)` (an unlanded candidate) are NEVER relabeled as accepted facts by
 * calling this with a candidate's `stateRef`. This function does not itself know or enforce which
 * `RepositoryStateRef` a caller passes; the discipline is the CALLER's (concern 08's land hook and any
 * future periodic-checkpoint job), stated here because this is the one function in the codebase whose
 * output becomes "accepted state" the moment it is written via `writeManifest`.
 */
export async function extractManifest(stateRef: RepositoryStateRef, producer: ProducerRef): Promise<RepositoryManifest> {
	const { facts, coverage } = await extractStateFacts(stateRef);
	return {
		repositoryId: stateRef.repositoryId,
		state: stateRef,
		entities: buildEntityRecords(facts),
		facts,
		extractionCoverage: coverage,
		producer,
	};
}

// ── Validation (owned here — schema.ts's own doc: "shapes frozen here; owned by concern 11") ──────

function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.length > 0;
}

function isProducerRefLike(v: unknown): v is ProducerRef {
	if (!v || typeof v !== "object") return false;
	const p = v as Partial<ProducerRef>;
	return isNonEmptyString(p.name) && isNonEmptyString(p.version);
}

function isExtractionCoverageArrayLike(v: unknown): v is ExtractionCoverage[] {
	return (
		Array.isArray(v) &&
		v.every(
			(c) =>
				c &&
				typeof c === "object" &&
				["syntax", "resolution", "type"].includes((c as ExtractionCoverage).dimension) &&
				typeof (c as ExtractionCoverage).covered === "number" &&
				typeof (c as ExtractionCoverage).total === "number" &&
				Array.isArray((c as ExtractionCoverage).gaps),
		)
	);
}

/** THROWS on any structurally invalid `EntityRecord` — reused by `validateRepositoryManifest` for every
 *  entry in `entities`. */
export function validateEntityRecord(v: unknown): EntityRecord {
	if (!v || typeof v !== "object") throw new Error(`land-assessment manifest: EntityRecord is not an object: ${JSON.stringify(v)}`);
	const e = v as Partial<EntityRecord>;
	const loc = e.locator as Partial<EntityLocator> | undefined;
	if (!loc || typeof loc !== "object" || !isNonEmptyString(loc.qualifiedName) || !isNonEmptyString(loc.path) || !isNonEmptyString(loc.kind)) {
		throw new Error(`land-assessment manifest: EntityRecord.locator is invalid: ${JSON.stringify(loc)}`);
	}
	if (!Array.isArray(e.factIds) || !e.factIds.every((x) => typeof x === "string")) {
		throw new Error("land-assessment manifest: EntityRecord.factIds must be a string[]");
	}
	return e as EntityRecord;
}

/** THROWS on any structurally invalid `RepositoryManifest` — the validate-on-read guard every durable
 *  record in this subsystem carries (`schema.ts`'s idiom). Reuses `schema.ts`'s exported
 *  `validateRepositoryStateRef`/`validateSnapshotFact` for the nested shapes it already owns. */
export function validateRepositoryManifest(v: unknown): RepositoryManifest {
	if (!v || typeof v !== "object") throw new Error(`land-assessment manifest: RepositoryManifest is not an object: ${JSON.stringify(v)}`);
	const m = v as Partial<RepositoryManifest>;
	if (!isNonEmptyString(m.repositoryId)) throw new Error("land-assessment manifest: RepositoryManifest.repositoryId must be a non-empty string");
	validateRepositoryStateRef(m.state, "RepositoryManifest.state");
	if (!Array.isArray(m.entities)) throw new Error("land-assessment manifest: RepositoryManifest.entities must be an array");
	for (const e of m.entities) validateEntityRecord(e);
	if (!Array.isArray(m.facts)) throw new Error("land-assessment manifest: RepositoryManifest.facts must be an array");
	for (const f of m.facts) validateSnapshotFact(f);
	if (!isExtractionCoverageArrayLike(m.extractionCoverage)) throw new Error("land-assessment manifest: RepositoryManifest.extractionCoverage must be an ExtractionCoverage[]");
	if (!isProducerRefLike(m.producer)) throw new Error("land-assessment manifest: RepositoryManifest.producer is not a valid ProducerRef");
	return m as RepositoryManifest;
}

// ── Persistence ──────────────────────────────────────────────────────────────────────────────────────

function manifestDir(stateDir: string, repositoryId: string): string {
	return path.join(stateDir, "land-assessment", repoHash16(repositoryId), "manifests");
}

function manifestFilePath(stateDir: string, repositoryId: string, commit: string): string {
	return path.join(manifestDir(stateDir, repositoryId), `manifest-${commit}.json`);
}

/** Atomic write (temp+rename via `getStorageBackend#writeDurable`) — a reader only ever observes a
 *  fully-written prior checkpoint or a fully-written new one, never a torn mix. A checkpoint at a commit
 *  that already has one OVERWRITES that file — the same exact state re-checkpointed twice (e.g.
 *  `continuity.ts#repairContinuity` re-running at an unchanged tip) is idempotent, not an error; it is
 *  never partially written either way. */
export async function writeManifest(stateDir: string, manifest: RepositoryManifest): Promise<void> {
	const file = manifestFilePath(stateDir, manifest.repositoryId, manifest.state.commit);
	await getStorageBackend().writeDurable(file, JSON.stringify(manifest));
}

/** `undefined` when no checkpoint exists at this commit — the legitimate "never checkpointed" case, not
 *  an error. THROWS (validate-on-read) when a file exists but is corrupt/torn/malformed — never silently
 *  treated as absent, mirroring `id.ts`'s corrupt-vs-missing discipline for the attempt counter. */
export async function readManifest(stateDir: string, repositoryId: string, commit: string): Promise<RepositoryManifest | undefined> {
	const file = manifestFilePath(stateDir, repositoryId, commit);
	const text = await getStorageBackend().readText(file);
	if (!text) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		throw new Error(`land-assessment manifest: ${file} unparseable (possibly torn): ${errText(err)}`);
	}
	return validateRepositoryManifest(parsed);
}

/** Every commit this repo has a persisted checkpoint at (unsorted directory order — callers that need
 *  lineage-nearest selection, e.g. `projection.ts`, do their own ancestry ordering via git, not string
 *  sort). `[]` when the repo has never been checkpointed — not an error. */
export async function listManifestCommits(stateDir: string, repositoryId: string): Promise<string[]> {
	const dir = manifestDir(stateDir, repositoryId);
	const names = await getStorageBackend().readdir(dir);
	return names.filter((n) => n.startsWith("manifest-") && n.endsWith(".json")).map((n) => n.slice("manifest-".length, -".json".length));
}

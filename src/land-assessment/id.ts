/**
 * Land Assessment identity — three identities, not one (SCHEMA-V0.md's "Identity model"):
 *   attemptId      one landing operation. Minted ONCE in `land()` (concern 08) from a durable,
 *                  crash-surviving counter; `autoLandWorkflow` THREADS the same id through its call
 *                  to `land()`, it never mints its own — dual minting would double-emit an attempt.
 *   eventId        one occurrence within an attempt. `hash(attemptId, seq)`, `seq` a per-attempt
 *                  monotonic counter the caller (concern 08) tracks in memory for the attempt's
 *                  lifetime — it does not need to survive a restart, only `attemptId` does.
 *   assessmentKey  one exact assessed repository state + analyzer environment. Content-addressed —
 *                  same (base, target, candidate, environment) always yields the same key, so a
 *                  rebase/main-advance/conflict-resolution/config-change naturally mints a NEW key
 *                  rather than requiring an explicit invalidation trigger.
 *
 * `computeOutputHash`/`checkOutputHash` implement the loud-nondeterminism rule: the SAME
 * `assessmentKey` producing a DIFFERENT `outputHash` on a later run is analyzer nondeterminism and is
 * surfaced as a thrown error, never silently absorbed as "the newer run wins" (SCHEMA-V0.md, the
 * `LandAssessmentSnapshot.outputHash` doc). The SAME key producing the SAME hash is a legitimate
 * duplicate (e.g. a retried land attempt reusing an unchanged candidate) and dedup-drops.
 *
 * The durable attempt counter mirrors `baseline-tracker.ts`'s corrupt-vs-missing discipline exactly:
 * a MISSING counter file is the legitimate first-boot case (start at 0); a file that EXISTS but is
 * unreadable/unparseable/malformed is CORRUPT and throws rather than silently resetting to 0 — a
 * silent reset after a crash could re-mint a counter value (and therefore an attemptId) that collides
 * with one minted before the crash. Writes are atomic (unique-suffixed temp file + rename), so a
 * reader only ever observes the fully-written prior value or the fully-written new one.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { classifyProbeFailure } from "../classify-probe-failure.ts";
import { errText } from "../err-text.ts";
import type { AnalysisEnvironmentFingerprint, RepositoryStateRef } from "./schema.ts";

/** The TypeScript structural-delta extractor's own version (concern 04) — distinct from
 *  `schema.ts#SCHEMA_VERSION` (the record shape) and from any individual analyzer's
 *  `AnalysisEnvironmentFingerprint.analyzerVersion`. Bumped whenever the extractor's detection logic
 *  changes in a way that could change its output for unchanged input — the fingerprint helpers below
 *  fold it into `configurationHash` so a logic change invalidates prior assessments automatically. */
export const EXTRACTOR_VERSION = "0.1.0";

// ── Canonicalization (shared by assessmentKey / outputHash / configurationHash) ────────────────────

/** Deep, key-sorted JSON encoding — the ONE canonicalization primitive every hash in this module goes
 *  through, so "same content, different key/array order" always yields the same bytes to hash. Array
 *  ORDER is preserved (callers that need order-independence, e.g. `computeOutputHash`, sort their
 *  arrays by stable id BEFORE calling this — this function alone cannot know which arrays are
 *  order-significant and which aren't). */
function canonicalizeForHash(value: unknown): string {
	return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeysDeep);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
		}
		return out;
	}
	return value;
}

/** Deterministic hash of an arbitrary bag of config fields (tsconfig hash, lockfile hash, extractor
 *  version, mode, ...) into `AnalysisEnvironmentFingerprint.configurationHash` — analyzers (concerns
 *  03/04) call this rather than hand-rolling their own concatenation so every fingerprint's hash is
 *  computed the same way.
 *  @substrate Phase-0 producer (concern 01) with no external caller yet -- land()/analyzers wire it up in concerns 03-11 (plans/land-assessment); a co-located test consumer is not a real reference (dead-exports.ts's own carve-out). */
export function computeConfigurationHash(fields: Record<string, string | number | boolean | undefined>): string {
	return createHash("sha256").update(canonicalizeForHash(fields)).digest("hex");
}

// ── attemptId: durable counter + mint ───────────────────────────────────────────────────────────────

interface AttemptCounterState {
	counter: number;
}

function attemptCounterPath(stateDir: string): string {
	return path.join(stateDir, "land-assessment", "attempt-counter.json");
}

/** THROWS (classifyProbeFailure "corrupt-state") when the counter file EXISTS but is unreadable,
 *  unparseable, or has an invalid shape — never silently treated as "counter is 0". Missing file ⇒ 0
 *  (the legitimate first-boot case; mirrors `baseline-tracker.ts#readState`). */
function readAttemptCounter(stateDir: string): number {
	const p = attemptCounterPath(stateDir);
	if (!existsSync(p)) return 0; // MISSING — legitimate first boot, no attempt minted yet
	let raw: string;
	try {
		raw = readFileSync(p, "utf8");
	} catch (err) {
		throw new Error(classifyProbeFailure({ kind: "corrupt-state", detail: `land-assessment attempt counter at ${p} unreadable: ${errText(err)}` }).reason);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch (err) {
		throw new Error(classifyProbeFailure({ kind: "corrupt-state", detail: `land-assessment attempt counter at ${p} unparseable (possibly truncated/torn): ${errText(err)}` }).reason);
	}
	const counter = (parsed as Partial<AttemptCounterState> | null)?.counter;
	if (typeof counter !== "number" || !Number.isInteger(counter) || counter < 0) {
		throw new Error(classifyProbeFailure({ kind: "corrupt-state", detail: `land-assessment attempt counter at ${p} has an invalid shape: ${JSON.stringify(parsed)}` }).reason);
	}
	return counter;
}

/** Atomic write: unique-suffixed temp file + rename (mirrors `baseline-tracker.ts#writeState` /
 *  `convergence-oracle.ts#writeFailures`) — a reader can only ever observe the fully-written prior
 *  value or the fully-written new one, never a torn mix. Unlike `baseline-tracker.ts`'s best-effort
 *  write, a failure here THROWS: this counter mints identity (`attemptId`), so a silently-dropped
 *  increment could hand out the same counter value twice on a later restart. */
function writeAttemptCounter(stateDir: string, counter: number): void {
	const dest = attemptCounterPath(stateDir);
	const dir = path.dirname(dest);
	mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.attempt-counter.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	writeFileSync(tmp, JSON.stringify({ counter } satisfies AttemptCounterState));
	renameSync(tmp, dest);
}

/** The caller's stable identity for a local checkout — `path.resolve` of the repo path, exactly once,
 *  so every site that needs a `repositoryId` (attemptId minting, `RepositoryStateRef`, the land-lock
 *  key) derives it the same way. (Design note: the pre-fix land lock was NOT path-normalized — two
 *  differently-spelled paths to the same checkout could race. This assessment layer uses the
 *  normalized identity throughout.)
 *  @substrate Phase-0 producer (concern 01) with no external caller yet -- land()/analyzers wire it up in concerns 03-11 (plans/land-assessment); a co-located test consumer is not a real reference (dead-exports.ts's own carve-out). */
export function computeRepositoryId(repoPath: string): string {
	return path.resolve(repoPath);
}

/**
 * Mint a fresh `attemptId` for one landing operation — call exactly ONCE per `land()` invocation,
 * before any early return, so every attempt (including ones that never reach `landBranch`) gets a
 * durable identity (concern 08's wiring). `autoLandWorkflow` must NOT call this; it threads the id
 * `land()` already minted.
 *
 * `attemptId = hash(resolvedRepo, branch, candidateCommit, durableCounter)` — the counter is read and
 * incremented atomically as part of this call, so two calls (even across a process restart) never
 * mint the same id for the same repo.
 *
 * @substrate Phase-0 producer (concern 01) with no external caller yet -- land()/analyzers wire it up in concerns 03-11 (plans/land-assessment); a co-located test consumer is not a real reference (dead-exports.ts's own carve-out).
 */
export function mintAttemptId(stateDir: string, repoPath: string, branch: string, candidateCommit: string): string {
	const counter = readAttemptCounter(stateDir) + 1;
	writeAttemptCounter(stateDir, counter);
	const resolvedRepo = computeRepositoryId(repoPath);
	return createHash("sha1").update(`${resolvedRepo}\0${branch}\0${candidateCommit}\0${counter}`).digest("hex").slice(0, 20);
}

// ── eventId: per-attempt occurrence ──────────────────────────────────────────────────────────────────

/** `eventId = hash(attemptId, seq)`. `seq` is the CALLER's per-attempt monotonic counter (starts at 0
 *  or 1 per attempt, caller's choice, held in memory for the attempt's lifetime — it is not persisted
 *  by this module; only `attemptId`'s durable counter needs to survive a restart).
 *  @substrate Phase-0 producer (concern 01) with no external caller yet -- land()/analyzers wire it up in concerns 03-11 (plans/land-assessment); a co-located test consumer is not a real reference (dead-exports.ts's own carve-out). */
export function computeEventId(attemptId: string, seq: number): string {
	return createHash("sha1").update(`${attemptId}\0${seq}`).digest("hex").slice(0, 20);
}

// ── assessmentKey / outputHash: content-addressed assessment identity ──────────────────────────────

/** `assessmentKey = hash(base + target + candidate stateRefs + environment fingerprint)`. Any input
 *  changing (rebase → new candidate, main advancing, conflict resolution, a config/dependency change
 *  reflected in `environment`) naturally mints a DIFFERENT key — there is no separate "invalidate"
 *  step to remember to call; the content address does it by construction.
 *  @substrate Phase-0 producer (concern 01) with no external caller yet -- land()/analyzers wire it up in concerns 03-11 (plans/land-assessment); a co-located test consumer is not a real reference (dead-exports.ts's own carve-out). */
export function computeAssessmentKey(state: { base: RepositoryStateRef; target: RepositoryStateRef; candidate: RepositoryStateRef }, environment: AnalysisEnvironmentFingerprint): string {
	return createHash("sha256").update(canonicalizeForHash({ state, environment })).digest("hex");
}

/** An output record carrying a stable, order-independent identity — the minimum shape
 *  `computeOutputHash` needs to sort its inputs before canonicalizing. `SnapshotFact`, `ChangeObservation`,
 *  and `AssessmentFinding` all satisfy this (via `factId`/`observationId`/`id` respectively) — deliberately
 *  NOT intersected with `Record<string, unknown>` so those concrete interfaces stay structurally assignable
 *  here without a cast at every call site. `observedAt` is declared explicitly (rather than left to fall
 *  through as excess) so `stripObservedAt` below has a typed field to omit. */
type IdentifiedRecord = { factId?: string; observationId?: string; id?: string; observedAt?: string };

function stableIdOf(entry: IdentifiedRecord): string {
	const id = entry.factId ?? entry.observationId ?? entry.id;
	if (typeof id !== "string" || id.length === 0) {
		throw new Error(`land-assessment id: output entry has no stable id (factId/observationId/id) to sort by — cannot canonicalize: ${JSON.stringify(entry)}`);
	}
	return id;
}

/** Analyzers stamp wall-clock `observedAt` onto every `SnapshotFact`/`ChangeObservation` (observation
 *  TIME, per SCHEMA-V0.md — legitimately kept on the stored record). It must NOT enter the content hash
 *  that defines `outputHash`, or two replays of the byte-identical assessment (same inputs, same
 *  analyzer logic, run at two different wall-clock moments) would mint two different hashes for the
 *  same `assessmentKey` — which `checkOutputHash` would then report as analyzer nondeterminism, a false
 *  positive on every legitimate re-run. Shallow by design: `observedAt` is a top-level field on every
 *  producer shape in this module (`SnapshotFact.observedAt`, `ChangeObservation.observedAt`); nothing
 *  else in the canonicalized projection is time-derived. */
function stripObservedAt(entry: IdentifiedRecord): IdentifiedRecord {
	const { observedAt: _observedAt, ...rest } = entry;
	return rest;
}

/**
 * `outputHash = hash(canonicalized observations + findings)`, EXCLUDING each entry's `observedAt` (see
 * `stripObservedAt`) — the hash is a function of assessed CONTENT, never of when the assessment ran.
 * INVARIANT under permutation of either array: both are sorted by their own stable id before
 * canonicalizing, so an analyzer that happens to emit the same set in a different order (map iteration,
 * parallel extraction, ...) still produces the same hash — a genuine reordering must never look like
 * nondeterminism.
 *
 * @substrate Phase-0 producer (concern 01) with no external caller yet -- land()/analyzers wire it up in concerns 03-11 (plans/land-assessment); a co-located test consumer is not a real reference (dead-exports.ts's own carve-out).
 */
export function computeOutputHash(observations: ReadonlyArray<IdentifiedRecord>, findings: ReadonlyArray<IdentifiedRecord>): string {
	const sortedObservations = [...observations].sort((a, b) => stableIdOf(a).localeCompare(stableIdOf(b))).map(stripObservedAt);
	const sortedFindings = [...findings].sort((a, b) => stableIdOf(a).localeCompare(stableIdOf(b))).map(stripObservedAt);
	return createHash("sha256").update(canonicalizeForHash({ observations: sortedObservations, findings: sortedFindings })).digest("hex");
}

export type OutputHashOutcome = "new" | "duplicate";

/**
 * Reconcile a freshly-computed `outputHash` against a previously-stored one for the SAME
 * `assessmentKey`. Returns `"new"` when there is no prior record to compare against (first time this
 * key has been seen); returns `"duplicate"` when the hash matches (dedup-drop — the append is
 * redundant, e.g. a retried attempt over an unchanged candidate). THROWS when the key matches but the
 * hash does not: SCHEMA-V0.md is explicit that the same assessmentKey producing a different outputHash
 * exposes analyzer nondeterminism and "is surfaced loudly, never absorbed" — never silently kept as
 * "the latest wins".
 *
 * @substrate Phase-0 producer (concern 01) with no external caller yet -- land()/analyzers wire it up in concerns 03-11 (plans/land-assessment); a co-located test consumer is not a real reference (dead-exports.ts's own carve-out).
 */
export function checkOutputHash(assessmentKey: string, newOutputHash: string, previous?: { outputHash: string }): OutputHashOutcome {
	if (!previous) return "new";
	if (previous.outputHash === newOutputHash) return "duplicate";
	throw new Error(
		`land-assessment id: assessmentKey ${assessmentKey} previously produced outputHash ${previous.outputHash}, now ${newOutputHash} — analyzer nondeterminism, never absorbed`,
	);
}

/**
 * Concern 11 (accepted-state-anchor) verification, per its Verify section: manifest extraction on a
 * fixture repo; projection through a checkpoint + deltas equals direct extraction at the target commit
 * (the anchor identity check); continuity flips to `unknown` on a simulated force-push and repairs via
 * re-checkpoint; R-extraction after a squash-land differs from C's observations and wins as accepted
 * state.
 *
 * Real git in tmp dirs, no mocks — same convention as `land-assessment-topology.test.ts` /
 * `land-assessment-structural-delta.test.ts`. Lives in `tests/`, not co-located under `src/land-assessment/`
 * (the concern doc's literal TOUCHES path) — `bunfig.toml`'s `[test] root = "tests"`, same precedent
 * every other land-assessment concern's test file follows. Named `land-assessment-accepted-state.test.ts`
 * rather than `land-assessment-manifest.test.ts` to avoid colliding with concern 02's
 * (taxonomy-and-manifest) already-landed test file of that name — a different "manifest"
 * (`incident-manifest.json`) entirely.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { extractStateFacts } from "../src/land-assessment/analyzers/typescript-structural-delta.ts";
import { checkContinuity, readContinuityRecord, REASON_NON_ANCESTOR, REASON_UNOBSERVED_TRANSITION, repairContinuity, validateContinuityRecord } from "../src/land-assessment/continuity.ts";
import { computeRepositoryId, EXTRACTOR_VERSION } from "../src/land-assessment/id.ts";
import {
	buildEntityRecords,
	DEFAULT_CHECKPOINT_CADENCE,
	dueForPeriodicCheckpoint,
	extractManifest,
	listManifestCommits,
	needsInitialCheckpoint,
	readManifest,
	validateEntityRecord,
	validateRepositoryManifest,
	writeManifest,
} from "../src/land-assessment/manifest.ts";
import { factContentSet, projectState } from "../src/land-assessment/projection.ts";
import type { ProducerRef, RepositoryStateRef, SnapshotFact } from "../src/land-assessment/schema.ts";

// ── git fixture builders (real git, no mocking — mirrors land-assessment-structural-delta.test.ts) ────

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function git(cwd: string, ...a: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const p = Bun.spawn(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function tmpDir(prefix: string): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(d);
	return d;
}

async function gitRepo(prefix: string): Promise<string> {
	const repo = await tmpDir(prefix);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	return repo;
}

async function writeFiles(repo: string, files: Record<string, string>): Promise<void> {
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(repo, rel);
		await fs.mkdir(path.dirname(abs), { recursive: true });
		await fs.writeFile(abs, content);
	}
}

async function commitFiles(repo: string, files: Record<string, string>, message: string): Promise<string> {
	await writeFiles(repo, files);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", message);
	return (await git(repo, "rev-parse", "HEAD")).stdout;
}

async function stateRefFor(repo: string, commit: string): Promise<RepositoryStateRef> {
	const tree = (await git(repo, "rev-parse", `${commit}^{tree}`)).stdout;
	return { repositoryId: computeRepositoryId(repo), commit, tree };
}

const PRODUCER: ProducerRef = { name: "test-fixture", version: EXTRACTOR_VERSION };

async function freshStateDir(): Promise<string> {
	return tmpDir("land-assessment-accepted-state-dir-");
}

function factsOfPredicate(facts: readonly SnapshotFact[], predicate: string): SnapshotFact[] {
	return facts.filter((f) => f.predicate === predicate);
}

// ── manifest extraction on a fixture repo ───────────────────────────────────────────────────────────

describe("extractManifest: manifest extraction on a fixture repo", () => {
	test("groups facts into EntityRecords, one per subject locator", async () => {
		const repo = await gitRepo("anchor-extract-");
		const commit = await commitFiles(repo, { "a.ts": "export function foo(): number { return 1; }\n" }, "base");
		const stateRef = await stateRefFor(repo, commit);

		const manifest = await extractManifest(stateRef, PRODUCER);
		expect(manifest.repositoryId).toBe(stateRef.repositoryId);
		expect(manifest.state).toEqual(stateRef);
		expect(manifest.producer).toEqual(PRODUCER);

		const fooEntity = manifest.entities.find((e) => e.locator.qualifiedName === "a.foo");
		expect(fooEntity).toBeDefined();
		expect(fooEntity!.locator.path).toBe("a.ts");
		expect(fooEntity!.locator.kind).toBe("function");
		// EXPORTS + HAS_SIGNATURE, per extractStateFacts's full-state predicate vocabulary.
		expect(fooEntity!.factIds.length).toBe(2);
		for (const id of fooEntity!.factIds) expect(manifest.facts.some((f) => f.factId === id)).toBe(true);

		expect(factsOfPredicate(manifest.facts, "EXPORTS")).toHaveLength(1);
		expect(factsOfPredicate(manifest.facts, "HAS_SIGNATURE")).toHaveLength(1);
	});

	test("matches extractStateFacts's own output content exactly (never a second notion of extraction)", async () => {
		const repo = await gitRepo("anchor-extract-match-");
		const commit = await commitFiles(
			repo,
			{ "a.ts": "export function foo(): number { return 1; }\n", "b.ts": "export interface Bar { x: number }\n" },
			"base",
		);
		const stateRef = await stateRefFor(repo, commit);

		const manifest = await extractManifest(stateRef, PRODUCER);
		const direct = await extractStateFacts(stateRef);
		expect(factContentSet(manifest.facts)).toEqual(factContentSet(direct.facts));
		expect(manifest.extractionCoverage).toEqual(direct.coverage);
	});

	test("buildEntityRecords is deterministic and sorted regardless of input fact order", async () => {
		const repo = await gitRepo("anchor-extract-order-");
		const commit = await commitFiles(repo, { "a.ts": "export function foo(): number { return 1; }\nexport function bar(): number { return 2; }\n" }, "base");
		const stateRef = await stateRefFor(repo, commit);
		const { facts } = await extractStateFacts(stateRef);

		const forward = buildEntityRecords(facts);
		const reversed = buildEntityRecords([...facts].reverse());
		expect(forward).toEqual(reversed);
	});

	test("validateEntityRecord/validateRepositoryManifest round-trip through write+read and reject corruption", async () => {
		const repo = await gitRepo("anchor-extract-roundtrip-");
		const commit = await commitFiles(repo, { "a.ts": "export const x = 1;\n" }, "base");
		const stateRef = await stateRefFor(repo, commit);
		const manifest = await extractManifest(stateRef, PRODUCER);
		expect(validateRepositoryManifest(manifest)).toEqual(manifest);
		for (const e of manifest.entities) expect(validateEntityRecord(e)).toEqual(e);

		const stateDir = await freshStateDir();
		await writeManifest(stateDir, manifest);
		const reread = await readManifest(stateDir, stateRef.repositoryId, commit);
		expect(reread).toEqual(manifest);

		expect(() => validateRepositoryManifest({ ...manifest, state: undefined })).toThrow(/RepositoryStateRef/);
		expect(() => validateRepositoryManifest({ ...manifest, entities: "nope" })).toThrow(/entities must be an array/);
		expect(() => validateRepositoryManifest({ ...manifest, producer: {} })).toThrow(/producer is not a valid ProducerRef/);
		expect(() => validateEntityRecord({ locator: { qualifiedName: "x" }, factIds: [] })).toThrow(/locator is invalid/);
	});

	test("readManifest returns undefined for a commit never checkpointed; listManifestCommits reflects what was written", async () => {
		const stateDir = await freshStateDir();
		const repositoryId = computeRepositoryId(await gitRepo("anchor-extract-empty-"));
		expect(await readManifest(stateDir, repositoryId, "deadbeef")).toBeUndefined();
		expect(await listManifestCommits(stateDir, repositoryId)).toEqual([]);
	});

	test("checkpoint cadence helpers", () => {
		expect(needsInitialCheckpoint([])).toBe(true);
		expect(needsInitialCheckpoint(["abc"])).toBe(false);
		expect(dueForPeriodicCheckpoint(0)).toBe(false);
		expect(dueForPeriodicCheckpoint(DEFAULT_CHECKPOINT_CADENCE)).toBe(true);
		expect(dueForPeriodicCheckpoint(DEFAULT_CHECKPOINT_CADENCE - 1)).toBe(false);
		expect(dueForPeriodicCheckpoint(1000, 10)).toBe(true);
	});
});

// ── projection through a checkpoint + deltas equals direct extraction (the anchor identity check) ────

describe("projectState: the anchor identity check", () => {
	test("checkpoint + one changed file + one unchanged file == direct extraction at target", async () => {
		const repo = await gitRepo("anchor-project-");
		const baseCommit = await commitFiles(
			repo,
			{ "a.ts": "export function foo(): number { return 1; }\n", "b.ts": "export function bar(): number { return 2; }\n" },
			"base",
		);
		const baseState = await stateRefFor(repo, baseCommit);
		const stateDir = await freshStateDir();
		await writeManifest(stateDir, await extractManifest(baseState, PRODUCER));

		// b.ts is untouched; a.ts gains a new export — the delta the projector must pick up.
		const targetCommit = await commitFiles(
			repo,
			{ "a.ts": "export function foo(): number { return 1; }\nexport function baz(): string { return 'z'; }\n" },
			"target: a.ts gains baz",
		);
		const targetState = await stateRefFor(repo, targetCommit);

		const projected = await projectState(stateDir, repo, baseState.repositoryId, targetState);
		expect(projected.fallback).toBeUndefined(); // proves the incremental path actually ran, not a silent full fallback

		const direct = await extractStateFacts(targetState);
		expect(factContentSet(projected.facts)).toEqual(factContentSet(direct.facts));
		expect(projected.entities).toEqual(buildEntityRecords(projected.facts));

		// The unchanged fact (b.bar) is inherited from the checkpoint — it still carries the CHECKPOINT's
		// state (the lineage-projection rule: intervals are computed at read time, never re-stamped into
		// the stored record). The changed fact (a.baz) is freshly addressed to the target.
		const inheritedBar = projected.facts.find((f) => f.subject.qualifiedName === "b.bar" && f.predicate === "EXPORTS");
		expect(inheritedBar?.state.commit).toBe(baseCommit);
		const freshBaz = projected.facts.find((f) => f.subject.qualifiedName === "a.baz" && f.predicate === "EXPORTS");
		expect(freshBaz?.state.commit).toBe(targetCommit);
	});

	test("a removed file's checkpoint-era facts are dropped from the projection, never carried forward", async () => {
		const repo = await gitRepo("anchor-project-removed-");
		const baseCommit = await commitFiles(repo, { "a.ts": "export function foo(): number { return 1; }\n" }, "base");
		const baseState = await stateRefFor(repo, baseCommit);
		const stateDir = await freshStateDir();
		await writeManifest(stateDir, await extractManifest(baseState, PRODUCER));

		await git(repo, "rm", "-q", "a.ts");
		await git(repo, "commit", "-qm", "remove a.ts");
		const targetCommit = (await git(repo, "rev-parse", "HEAD")).stdout;
		const targetState = await stateRefFor(repo, targetCommit);

		const projected = await projectState(stateDir, repo, baseState.repositoryId, targetState);
		expect(projected.facts.some((f) => f.subject.qualifiedName === "a.foo")).toBe(false);
		const direct = await extractStateFacts(targetState);
		expect(factContentSet(projected.facts)).toEqual(factContentSet(direct.facts));
	});

	test("an UNTOUCHED file's IMPORTS edge is re-extracted when the sibling it resolves to is removed (identity holds)", async () => {
		const repo = await gitRepo("anchor-project-import-stale-");
		const baseCommit = await commitFiles(
			repo,
			{ "a.ts": "import { bar } from './b';\nexport function foo(): number { return bar(); }\n", "b.ts": "export function bar(): number { return 2; }\n" },
			"base",
		);
		const baseState = await stateRefFor(repo, baseCommit);
		const stateDir = await freshStateDir();
		await writeManifest(stateDir, await extractManifest(baseState, PRODUCER));

		// Setup sanity: at the checkpoint a.ts's import RESOLVED to b.ts, so removing b.ts makes the kept
		// edge stale — the exact condition the projector must catch even though a.ts itself never changes.
		const baseImport = (await extractStateFacts(baseState)).facts.find((f) => f.subject.path === "a.ts" && f.predicate === "IMPORTS");
		expect(baseImport?.object).toEqual({ kind: "string", value: "b.ts" });

		// b.ts is removed; a.ts is NOT touched — its `import './b'` now dangles (still parses, resolves to
		// nothing). Before the fix the projector kept a.ts's checkpoint edge (object "b.ts"), disagreeing
		// with a fresh extraction at target (which re-resolves to the raw unresolved spec).
		await git(repo, "rm", "-q", "b.ts");
		await git(repo, "commit", "-qm", "remove b.ts (a.ts's import now dangles)");
		const targetState = await stateRefFor(repo, (await git(repo, "rev-parse", "HEAD")).stdout);

		const projected = await projectState(stateDir, repo, baseState.repositoryId, targetState);
		expect(projected.fallback).toBeUndefined(); // the incremental checkpoint+delta path actually ran
		const direct = await extractStateFacts(targetState);
		expect(factContentSet(projected.facts)).toEqual(factContentSet(direct.facts)); // the identity contract
		// No projected edge still claims a.ts resolves to the deleted b.ts.
		expect(projected.facts.some((f) => f.predicate === "IMPORTS" && f.object.kind === "string" && f.object.value === "b.ts")).toBe(false);
	});

	test("no checkpoint at all falls back to full extraction, and content still matches direct extraction", async () => {
		const repo = await gitRepo("anchor-project-fallback-");
		const commit = await commitFiles(repo, { "a.ts": "export function foo(): number { return 1; }\n" }, "base");
		const stateRef = await stateRefFor(repo, commit);
		const stateDir = await freshStateDir(); // never written to — no checkpoint exists

		const projected = await projectState(stateDir, repo, stateRef.repositoryId, stateRef);
		expect(projected.fallback?.reason).toMatch(/no checkpoint manifest exists/);
		const direct = await extractStateFacts(stateRef);
		expect(factContentSet(projected.facts)).toEqual(factContentSet(direct.facts));
	});

	test("a checkpoint on an unrelated branch (not an ancestor of the target) is never used — falls back instead", async () => {
		const repo = await gitRepo("anchor-project-unrelated-");
		const root = await commitFiles(repo, { "root.txt": "root\n" }, "root");
		await git(repo, "checkout", "-qb", "side");
		const sideCommit = await commitFiles(repo, { "side.ts": "export const s = 1;\n" }, "side branch work");
		const sideState = await stateRefFor(repo, sideCommit);
		const stateDir = await freshStateDir();
		await writeManifest(stateDir, await extractManifest(sideState, PRODUCER));

		await git(repo, "checkout", "-q", "main");
		const mainCommit = await commitFiles(repo, { "main.ts": "export const m = 1;\n" }, "main-only work");
		const mainState = await stateRefFor(repo, mainCommit);
		void root;

		const projected = await projectState(stateDir, repo, sideState.repositoryId, mainState);
		expect(projected.fallback?.reason).toMatch(/no checkpoint manifest is an ancestor/);
		const direct = await extractStateFacts(mainState);
		expect(factContentSet(projected.facts)).toEqual(factContentSet(direct.facts));
	});
});

// ── continuity flips to unknown on a simulated force-push and repairs via re-checkpoint ───────────────

describe("checkContinuity / repairContinuity", () => {
	test("a normal fast-forward continuation stays continuous", async () => {
		const repo = await gitRepo("anchor-continuity-ff-");
		const a = await commitFiles(repo, { "f.txt": "1\n" }, "a");
		const aState = await stateRefFor(repo, a);
		const b = await commitFiles(repo, { "f.txt": "2\n" }, "b");
		const bState = await stateRefFor(repo, b);

		const record = await checkContinuity(repo, aState, bState);
		expect(record.status).toBe("continuous");
		expect(record.reason).toBeUndefined();
	});

	test("the SAME commit on both sides is trivially continuous without touching git", async () => {
		const repo = await gitRepo("anchor-continuity-same-");
		const a = await commitFiles(repo, { "f.txt": "1\n" }, "a");
		const aState = await stateRefFor(repo, a);
		const record = await checkContinuity(repo, aState, aState);
		expect(record.status).toBe("continuous");
	});

	test("mismatched repositoryId between lastIndexed and current throws", async () => {
		const repo = await gitRepo("anchor-continuity-mismatch-");
		const a = await commitFiles(repo, { "f.txt": "1\n" }, "a");
		const aState = await stateRefFor(repo, a);
		await expect(checkContinuity(repo, aState, { ...aState, repositoryId: "other-repo" })).rejects.toThrow(/same repositoryId/);
	});

	test("flips to unknown (non-ancestor) on a simulated force-push, and repairs via re-checkpoint", async () => {
		const repo = await gitRepo("anchor-continuity-force-push-");
		const a = await commitFiles(repo, { "f.ts": "export const v = 1;\n" }, "a");
		const b = await commitFiles(repo, { "f.ts": "export const v = 2;\n" }, "b");
		const bState = await stateRefFor(repo, b); // this is what "lastIndexed" believed was the tip

		// Simulate a force-push: reset main back to A and land a DIFFERENT commit B2 — the history glance
		// last indexed (B) is no longer reachable from the new tip at all.
		await git(repo, "reset", "-q", "--hard", a);
		const b2 = await commitFiles(repo, { "f.ts": "export const v = 3;\n", "g.ts": "export const w = 1;\n" }, "b2 (force-pushed rewrite)");
		const b2State = await stateRefFor(repo, b2);

		const broken = await checkContinuity(repo, bState, b2State);
		expect(broken.status).toBe("unknown");
		expect(broken.reason).toBe(REASON_NON_ANCESTOR);
		expect(validateContinuityRecord(broken)).toEqual(broken);

		const stateDir = await freshStateDir();
		const { manifest, continuity } = await repairContinuity(stateDir, repo, b2State, PRODUCER);
		expect(manifest.state.commit).toBe(b2);
		expect(continuity.status).toBe("continuous");
		expect(continuity.lastIndexed.commit).toBe(b2);
		expect(continuity.current.commit).toBe(b2);

		const rereadManifest = await readManifest(stateDir, b2State.repositoryId, b2);
		expect(rereadManifest).toEqual(manifest);
		const rereadContinuity = await readContinuityRecord(stateDir, b2State.repositoryId);
		expect(rereadContinuity).toEqual(continuity);

		// After repair, the new lastIndexed (b2) IS the new current — continuity holds going forward.
		const afterRepair = await checkContinuity(repo, continuity.lastIndexed, b2State);
		expect(afterRepair.status).toBe("continuous");
	});

	test("ancestor but an unaccounted transition in between flips to unknown (unobserved external transition)", async () => {
		const repo = await gitRepo("anchor-continuity-unaccounted-");
		const a = await commitFiles(repo, { "f.txt": "1\n" }, "a");
		const aState = await stateRefFor(repo, a);
		const external = await commitFiles(repo, { "f.txt": "2\n" }, "external push glance never saw");
		const c = await commitFiles(repo, { "f.txt": "3\n" }, "c");
		const cState = await stateRefFor(repo, c);

		const withoutKnowledge = await checkContinuity(repo, aState, cState, new Set());
		expect(withoutKnowledge.status).toBe("unknown");
		expect(withoutKnowledge.reason).toBe(REASON_UNOBSERVED_TRANSITION);

		const withKnowledge = await checkContinuity(repo, aState, cState, new Set([external, c]));
		expect(withKnowledge.status).toBe("continuous");
	});

	test("validateContinuityRecord rejects a corrupt record", () => {
		expect(() => validateContinuityRecord({ status: "sideways" })).toThrow(/repositoryId must be/);
	});
});

// ── R-extraction after a squash-land differs from C's observations and wins as accepted state ────────

describe("C != R: accepted state comes only from independently observing R", () => {
	test("R's extraction differs from C's, and the accepted-state manifest is keyed to R, never C", async () => {
		const repo = await gitRepo("anchor-c-neq-r-");
		const base = await commitFiles(repo, { "a.ts": "export function foo(): number { return 1; }\n" }, "base");

		// Candidate C: proposes changing foo's return type to string.
		await git(repo, "checkout", "-qb", "candidate");
		const c = await commitFiles(repo, { "a.ts": "export function foo(): string { return '1'; }\n" }, "candidate: foo returns string");
		const cState = await stateRefFor(repo, c);

		// The actually-landed result R: a squash/conflict-resolution that differs from C — it keeps foo
		// numeric AND adds a second export, modeling "R != C under squash/conflict resolution" (SCHEMA-V0.md).
		await git(repo, "checkout", "-q", "main");
		const r = await commitFiles(
			repo,
			{ "a.ts": "export function foo(): number { return 1; }\nexport function landedExtra(): boolean { return true; }\n" },
			"R: the actually-landed squash result, distinct from C",
		);
		const rState = await stateRefFor(repo, r);
		void base;

		const cExtraction = await extractStateFacts(cState);
		const rExtraction = await extractStateFacts(rState);
		expect(factContentSet(cExtraction.facts)).not.toEqual(factContentSet(rExtraction.facts));

		// Accepted state MUST be built from R, never from C — the manifest anchor takes exactly the
		// stateRef it's given, and here that must be R.
		const manifest = await extractManifest(rState, PRODUCER);
		expect(manifest.state.commit).toBe(r);
		expect(manifest.state.commit).not.toBe(c);
		expect(factContentSet(manifest.facts)).toEqual(factContentSet(rExtraction.facts));
		expect(factContentSet(manifest.facts)).not.toEqual(factContentSet(cExtraction.facts));

		// landedExtra (only in R) is present; C's return-type-to-string signature change is NOT.
		expect(manifest.entities.some((e) => e.locator.qualifiedName === "a.landedExtra")).toBe(true);
		const fooSignature = manifest.facts.find((f) => f.subject.qualifiedName === "a.foo" && f.predicate === "HAS_SIGNATURE");
		expect(fooSignature?.object).toEqual({ kind: "signature", value: "(): number" });
	});
});

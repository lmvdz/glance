/**
 * Concern 04 (structural-delta-analyzer) verification, per its Verify section: fixture pairs per
 * claimed class (export removed, signature changed, import graph changed, inheritance changed,
 * same-symbol concurrent edit, adjacent-dependency edit) detect correctly; determinism (two runs, same
 * canonical content modulo wall-clock `observedAt`); rename fixtures (clean rename carries identity,
 * ambiguous rename reports unresolved); non-TS and unparseable fixtures produce gaps, never findings.
 *
 * Real git in tmp dirs, no mocks — same convention as `land-assessment-topology.test.ts`. Lives in
 * `tests/`, not co-located under `src/land-assessment/analyzers/` (the concern doc's literal TOUCHES
 * path) for the same reason topology's test does: `bunfig.toml`'s `[test] root = "tests"`.
 *
 * DESIGN.md's Risks section is explicit that this analyzer has ~0 REAL labeled positives in the replay
 * corpus — every fixture below is SYNTHETIC, exercising the detection logic directly, not a claim of
 * measured recall against real incidents (that evidence is topology's, per the wedge's go/no-go gate).
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runAnalyzers, type AnalyzerContext } from "../src/land-assessment/analyzers/plugin.ts";
import {
	DEFAULT_SIZE_CAP,
	extractStateFacts,
	parseNameStatus,
	structuralDeltaAnalyzer,
	structuralDeltaEnvironmentFingerprint,
} from "../src/land-assessment/analyzers/typescript-structural-delta.ts";
import { computeRepositoryId, EXTRACTOR_VERSION } from "../src/land-assessment/id.ts";
import type { AssessmentFinding, SnapshotFact } from "../src/land-assessment/schema.ts";

// ── git fixture builders (real git, no mocking — mirrors land-assessment-topology.test.ts) ──────────

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

async function rev(repo: string, ref: string): Promise<string> {
	return (await git(repo, "rev-parse", ref)).stdout;
}

function factsOfPredicate(facts: readonly SnapshotFact[], predicate: string): SnapshotFact[] {
	return facts.filter((f) => f.predicate === predicate);
}

function findingsOfKind(findings: readonly AssessmentFinding[], kind: string): AssessmentFinding[] {
	return findings.filter((f) => f.kind === kind);
}

// ── the analyzer's own metadata ──────────────────────────────────────────────────────────────────────

test("structuralDeltaAnalyzer: claims exactly structural-api + dependency, matching incident-taxonomy's CLAIMED_BY", () => {
	expect(structuralDeltaAnalyzer.name).toBe("typescript-structural-delta");
	expect(structuralDeltaAnalyzer.version).toBe(EXTRACTOR_VERSION);
	expect([...structuralDeltaAnalyzer.claimedClasses].sort()).toEqual(["dependency", "structural-api"]);
});

test("structuralDeltaEnvironmentFingerprint: syntax-only mode, deterministic across calls", () => {
	const a = structuralDeltaEnvironmentFingerprint();
	const b = structuralDeltaEnvironmentFingerprint();
	expect(a).toEqual(b);
	expect(a.mode).toBe("syntax-only");
	expect(a.analyzerName).toBe("typescript-structural-delta");
	expect(a.analyzerVersion).toBe(EXTRACTOR_VERSION);
});

describe("applicable()", () => {
	test("false immediately when a commit is missing (no git call needed)", async () => {
		const ctx: AnalyzerContext = { repo: "/tmp/x", baseCommit: "a", mainCommit: "b", candidateCommit: "" };
		expect(await structuralDeltaAnalyzer.applicable(ctx)).toBe(false);
	});

	test("false when zero TS files changed on either side — the 'analysis key is ABSENT' case", async () => {
		const repo = await gitRepo("sd-applicable-neg-");
		const baseTip = await commitFiles(repo, { "notes.txt": "hello\n" }, "base");
		await git(repo, "checkout", "-qb", "candidate");
		const candidateTip = await commitFiles(repo, { "notes.txt": "hello again\n" }, "candidate touches only a txt file");

		const ctx: AnalyzerContext = { repo, baseCommit: baseTip, mainCommit: baseTip, candidateCommit: candidateTip };
		expect(await structuralDeltaAnalyzer.applicable(ctx)).toBe(false);
		const viaRegistry = await runAnalyzers([structuralDeltaAnalyzer], ctx);
		expect(viaRegistry.coverage).toHaveLength(0);
		expect(viaRegistry.observations).toHaveLength(0);
		expect(viaRegistry.findings).toHaveLength(0);
	});

	test("true when a TS file changed", async () => {
		const repo = await gitRepo("sd-applicable-pos-");
		const baseTip = await commitFiles(repo, { "a.ts": "export function foo(): number { return 1; }\n" }, "base");
		await git(repo, "checkout", "-qb", "candidate");
		const candidateTip = await commitFiles(repo, { "a.ts": "export function foo(): string { return String(1); }\n" }, "candidate changes foo's return type");

		const ctx: AnalyzerContext = { repo, baseCommit: baseTip, mainCommit: baseTip, candidateCommit: candidateTip };
		expect(await structuralDeltaAnalyzer.applicable(ctx)).toBe(true);
	});
});

// ── export removed ──────────────────────────────────────────────────────────────────────────────────

describe("export removed", () => {
	test("fires EXPORTS_REMOVED when a symbol is deleted", async () => {
		const repo = await gitRepo("sd-export-removed-");
		const baseTip = await commitFiles(repo, { "a.ts": "export function foo(): number { return 1; }\nexport function bar(): number { return 2; }\n" }, "base");
		await git(repo, "checkout", "-qb", "candidate");
		const candidateTip = await commitFiles(repo, { "a.ts": "export function bar(): number { return 2; }\n" }, "candidate removes foo");

		const ctx: AnalyzerContext = { repo, baseCommit: baseTip, mainCommit: baseTip, candidateCommit: candidateTip };
		const result = await structuralDeltaAnalyzer.run(ctx);
		const removed = factsOfPredicate(result.observations, "EXPORTS_REMOVED");
		expect(removed).toHaveLength(1);
		expect(removed[0]!.subject.qualifiedName).toBe("a.foo");
		expect(factsOfPredicate(result.observations, "EXPORTS_ADDED")).toHaveLength(0);
	});
});

// ── signature changed ───────────────────────────────────────────────────────────────────────────────

describe("signature changed", () => {
	test("fires SIGNATURE_CHANGED with signatureKind arity-changed when a parameter is added", async () => {
		const repo = await gitRepo("sd-sig-arity-");
		const baseTip = await commitFiles(repo, { "a.ts": "export function foo(a: number): number { return a; }\n" }, "base");
		await git(repo, "checkout", "-qb", "candidate");
		const candidateTip = await commitFiles(repo, { "a.ts": "export function foo(a: number, b: number): number { return a + b; }\n" }, "candidate adds a parameter");

		const ctx: AnalyzerContext = { repo, baseCommit: baseTip, mainCommit: baseTip, candidateCommit: candidateTip };
		const result = await structuralDeltaAnalyzer.run(ctx);
		const changed = factsOfPredicate(result.observations, "SIGNATURE_CHANGED");
		expect(changed).toHaveLength(1);
		expect(changed[0]!.subject.qualifiedName).toBe("a.foo");
		expect((changed[0]!.object as { value: { signatureKind: string } }).value.signatureKind).toBe("arity-changed");
	});

	test("fires SIGNATURE_CHANGED with signatureKind optionality-changed when a parameter becomes optional", async () => {
		const repo = await gitRepo("sd-sig-optional-");
		const baseTip = await commitFiles(repo, { "a.ts": "export function foo(a: number, b: number): number { return a + b; }\n" }, "base");
		await git(repo, "checkout", "-qb", "candidate");
		const candidateTip = await commitFiles(repo, { "a.ts": "export function foo(a: number, b?: number): number { return a + (b ?? 0); }\n" }, "candidate makes b optional");

		const ctx: AnalyzerContext = { repo, baseCommit: baseTip, mainCommit: baseTip, candidateCommit: candidateTip };
		const result = await structuralDeltaAnalyzer.run(ctx);
		const changed = factsOfPredicate(result.observations, "SIGNATURE_CHANGED");
		expect(changed).toHaveLength(1);
		expect((changed[0]!.object as { value: { signatureKind: string } }).value.signatureKind).toBe("optionality-changed");
	});

	test("fires SIGNATURE_CHANGED with signatureKind type-changed when only a type text changes", async () => {
		const repo = await gitRepo("sd-sig-type-");
		const baseTip = await commitFiles(repo, { "a.ts": "export function foo(a: number): number { return a; }\n" }, "base");
		await git(repo, "checkout", "-qb", "candidate");
		const candidateTip = await commitFiles(repo, { "a.ts": "export function foo(a: string): string { return a; }\n" }, "candidate changes param/return type, same arity");

		const ctx: AnalyzerContext = { repo, baseCommit: baseTip, mainCommit: baseTip, candidateCommit: candidateTip };
		const result = await structuralDeltaAnalyzer.run(ctx);
		const changed = factsOfPredicate(result.observations, "SIGNATURE_CHANGED");
		expect(changed).toHaveLength(1);
		expect((changed[0]!.object as { value: { signatureKind: string } }).value.signatureKind).toBe("type-changed");
	});
});

// ── import graph changed ────────────────────────────────────────────────────────────────────────────

describe("import graph changed", () => {
	test("fires IMPORTS_ADDED with a resolved in-repo target for a relative specifier", async () => {
		const repo = await gitRepo("sd-imports-");
		const baseTip = await commitFiles(
			repo,
			{ "a.ts": "export function foo(): number { return 1; }\n", "b.ts": "export function bar(): number { return 2; }\n" },
			"base",
		);
		await git(repo, "checkout", "-qb", "candidate");
		const candidateTip = await commitFiles(
			repo,
			{ "b.ts": 'import { foo } from "./a";\nexport function bar(): number { return foo() + 2; }\n' },
			"candidate imports a.ts from b.ts",
		);

		const ctx: AnalyzerContext = { repo, baseCommit: baseTip, mainCommit: baseTip, candidateCommit: candidateTip };
		const result = await structuralDeltaAnalyzer.run(ctx);
		const added = factsOfPredicate(result.observations, "IMPORTS_ADDED");
		expect(added).toHaveLength(1);
		expect(added[0]!.subject.path).toBe("b.ts");
		expect((added[0]!.object as { value: string }).value).toBe("a.ts");
	});

	test("keeps a package specifier opaque — no resolution attempted, no gap", async () => {
		const repo = await gitRepo("sd-imports-pkg-");
		const baseTip = await commitFiles(repo, { "a.ts": "export function foo(): number { return 1; }\n" }, "base");
		await git(repo, "checkout", "-qb", "candidate");
		const candidateTip = await commitFiles(repo, { "a.ts": 'import * as path from "node:path";\nexport function foo(): string { return path.sep; }\n' }, "candidate imports a package specifier");

		const ctx: AnalyzerContext = { repo, baseCommit: baseTip, mainCommit: baseTip, candidateCommit: candidateTip };
		const result = await structuralDeltaAnalyzer.run(ctx);
		const added = factsOfPredicate(result.observations, "IMPORTS_ADDED");
		expect(added).toHaveLength(1);
		expect((added[0]!.object as { value: string }).value).toBe("node:path");
		const resolutionDim = result.coverage.find((c) => c.dimension === "resolution")!;
		expect(resolutionDim.gaps).toHaveLength(0);
	});
});

// ── inheritance changed ─────────────────────────────────────────────────────────────────────────────

describe("inheritance changed", () => {
	test("fires EXTENDS_CHANGED when a class gains a base class", async () => {
		const repo = await gitRepo("sd-heritage-");
		const baseTip = await commitFiles(repo, { "a.ts": "export class Foo {}\n" }, "base");
		await git(repo, "checkout", "-qb", "candidate");
		const candidateTip = await commitFiles(repo, { "a.ts": "export class Bar {}\nexport class Foo extends Bar {}\n" }, "candidate adds extends Bar");

		const ctx: AnalyzerContext = { repo, baseCommit: baseTip, mainCommit: baseTip, candidateCommit: candidateTip };
		const result = await structuralDeltaAnalyzer.run(ctx);
		const changed = factsOfPredicate(result.observations, "EXTENDS_CHANGED");
		expect(changed).toHaveLength(1);
		expect((changed[0]!.object as { value: { before: string[]; after: string[] } }).value.after).toEqual(["Bar"]);
	});

	test("fires IMPLEMENTS_CHANGED when an interface's implements set changes", async () => {
		const repo = await gitRepo("sd-heritage-impl-");
		const baseTip = await commitFiles(repo, { "a.ts": "export interface Sized {}\nexport class Foo {}\n" }, "base");
		await git(repo, "checkout", "-qb", "candidate");
		const candidateTip = await commitFiles(repo, { "a.ts": "export interface Sized {}\nexport class Foo implements Sized {}\n" }, "candidate implements Sized");

		const ctx: AnalyzerContext = { repo, baseCommit: baseTip, mainCommit: baseTip, candidateCommit: candidateTip };
		const result = await structuralDeltaAnalyzer.run(ctx);
		const changed = factsOfPredicate(result.observations, "IMPLEMENTS_CHANGED");
		expect(changed).toHaveLength(1);
		expect((changed[0]!.object as { value: { before: string[]; after: string[] } }).value.after).toEqual(["Sized"]);
	});
});

// ── same-symbol concurrent edit ─────────────────────────────────────────────────────────────────────

describe("concurrentEdits", () => {
	test("fires when both main and candidate touch the same exported symbol", async () => {
		const repo = await gitRepo("sd-concurrent-");
		const baseTip = await commitFiles(repo, { "a.ts": "export function shared(): number { return 1; }\n" }, "base");

		await git(repo, "checkout", "-qb", "candidate");
		const candidateTip = await commitFiles(repo, { "a.ts": "export function shared(a: number): number { return a; }\n" }, "candidate adds a parameter to shared");

		await git(repo, "checkout", "-q", "main");
		const mainTip = await commitFiles(repo, { "a.ts": "export function shared(): string { return String(1); }\n" }, "main changes shared's return type");

		const ctx: AnalyzerContext = { repo, baseCommit: baseTip, mainCommit: mainTip, candidateCommit: candidateTip };
		const result = await structuralDeltaAnalyzer.run(ctx);
		const findings = findingsOfKind(result.findings, "structural-delta.concurrent-edits");
		expect(findings).toHaveLength(1);
		expect(findings[0]!.statement).toContain("a.shared");
		expect(findings[0]!.semantics.authority).toBe("deterministic");
		expect(findings[0]!.derivedFromObservations.length).toBeGreaterThan(0);
	});

	test("stays silent when the sides touch disjoint symbols", async () => {
		const repo = await gitRepo("sd-concurrent-neg-");
		const baseTip = await commitFiles(repo, { "a.ts": "export function foo(): number { return 1; }\nexport function bar(): number { return 2; }\n" }, "base");

		await git(repo, "checkout", "-qb", "candidate");
		const candidateTip = await commitFiles(repo, { "a.ts": "export function foo(a: number): number { return a; }\nexport function bar(): number { return 2; }\n" }, "candidate touches foo only");

		await git(repo, "checkout", "-q", "main");
		const mainTip = await commitFiles(repo, { "a.ts": "export function foo(): number { return 1; }\nexport function bar(a: number): number { return a; }\n" }, "main touches bar only");

		const ctx: AnalyzerContext = { repo, baseCommit: baseTip, mainCommit: mainTip, candidateCommit: candidateTip };
		const result = await structuralDeltaAnalyzer.run(ctx);
		expect(findingsOfKind(result.findings, "structural-delta.concurrent-edits")).toHaveLength(0);
	});
});

// ── adjacent-dependency edit ────────────────────────────────────────────────────────────────────────

describe("adjacentDependencyChanges", () => {
	test("fires when one side's new import edge targets a file the other side touched", async () => {
		const repo = await gitRepo("sd-adjacent-");
		const baseTip = await commitFiles(
			repo,
			{ "a.ts": "export function foo(): number { return 1; }\n", "b.ts": "export function bar(): number { return 2; }\n" },
			"base",
		);

		await git(repo, "checkout", "-qb", "candidate");
		const candidateTip = await commitFiles(
			repo,
			{ "b.ts": 'import { foo } from "./a";\nexport function bar(): number { return foo() + 2; }\n' },
			"candidate makes b.ts import a.ts",
		);

		await git(repo, "checkout", "-q", "main");
		const mainTip = await commitFiles(repo, { "a.ts": "export function foo(x: number): number { return x; }\n" }, "main changes foo's signature");

		const ctx: AnalyzerContext = { repo, baseCommit: baseTip, mainCommit: mainTip, candidateCommit: candidateTip };
		const result = await structuralDeltaAnalyzer.run(ctx);
		const findings = findingsOfKind(result.findings, "structural-delta.adjacent-dependency-changes");
		expect(findings).toHaveLength(1);
		expect(findings[0]!.statement).toContain("b.ts→a.ts");
		expect(findings[0]!.semantics.authority).toBe("derived");
		expect(findings[0]!.derivedFromObservations.length).toBeGreaterThan(0);
	});

	test("stays silent when the changed files are unrelated", async () => {
		const repo = await gitRepo("sd-adjacent-neg-");
		const baseTip = await commitFiles(
			repo,
			{ "a.ts": "export function foo(): number { return 1; }\n", "b.ts": "export function bar(): number { return 2; }\n", "c.ts": "export function baz(): number { return 3; }\n" },
			"base",
		);

		await git(repo, "checkout", "-qb", "candidate");
		const candidateTip = await commitFiles(repo, { "b.ts": "export function bar(x: number): number { return x; }\n" }, "candidate touches b.ts only");

		await git(repo, "checkout", "-q", "main");
		const mainTip = await commitFiles(repo, { "c.ts": "export function baz(x: number): number { return x; }\n" }, "main touches c.ts only");

		const ctx: AnalyzerContext = { repo, baseCommit: baseTip, mainCommit: mainTip, candidateCommit: candidateTip };
		const result = await structuralDeltaAnalyzer.run(ctx);
		expect(findingsOfKind(result.findings, "structural-delta.adjacent-dependency-changes")).toHaveLength(0);
	});
});

// ── determinism ──────────────────────────────────────────────────────────────────────────────────────

/** Strips wall-clock `observedAt` before comparing two separate `run()` calls: `id.ts#EXTRACTOR_VERSION`
 *  fixes analyzer identity, but each call stamps its own timestamp (SCHEMA-V0.md's `observedAt` is
 *  observation time, never an ordering/identity key) — the concern's "byte-identical canonical output"
 *  is about STRUCTURE and VALUES, which this comparison isolates. */
function stripObservedAt<T extends { observedAt: string }>(items: readonly T[]): Omit<T, "observedAt">[] {
	return items.map(({ observedAt: _observedAt, ...rest }) => rest);
}

describe("determinism", () => {
	test("two runs over the same commits produce byte-identical canonical output (modulo observedAt)", async () => {
		const repo = await gitRepo("sd-determinism-");
		const baseTip = await commitFiles(
			repo,
			{ "a.ts": "export function foo(): number { return 1; }\n", "b.ts": "export function bar(): number { return 2; }\n" },
			"base",
		);
		await git(repo, "checkout", "-qb", "candidate");
		const candidateTip = await commitFiles(
			repo,
			{ "a.ts": "export function foo(x: number): number { return x; }\nexport class Widget {}\n", "b.ts": 'import { foo } from "./a";\nexport function bar(): number { return foo(1) + 2; }\n' },
			"candidate: signature change, new export, new import",
		);

		const ctx: AnalyzerContext = { repo, baseCommit: baseTip, mainCommit: baseTip, candidateCommit: candidateTip };
		const first = await structuralDeltaAnalyzer.run(ctx);
		const second = await structuralDeltaAnalyzer.run(ctx);

		expect(stripObservedAt(first.observations)).toEqual(stripObservedAt(second.observations));
		expect(stripObservedAt(first.findings)).toEqual(stripObservedAt(second.findings));
		expect(first.coverage).toEqual(second.coverage);
		// sanity: the fixture actually produced something to compare, not two empty arrays trivially equal
		expect(first.observations.length).toBeGreaterThan(0);
	});
});

// ── rename fixtures ──────────────────────────────────────────────────────────────────────────────────

describe("rename identity", () => {
	test("a clean rename carries symbol identity — no spurious EXPORTS_ADDED/REMOVED/SIGNATURE_CHANGED", async () => {
		const repo = await gitRepo("sd-rename-clean-");
		const baseTip = await commitFiles(repo, { "a.ts": "export function foo(): number { return 1; }\n" }, "base");
		await git(repo, "checkout", "-qb", "candidate");
		await git(repo, "mv", "a.ts", "b.ts");
		await git(repo, "commit", "-qm", "rename a.ts to b.ts, no content change");
		const candidateTip = await rev(repo, "HEAD");

		const ctx: AnalyzerContext = { repo, baseCommit: baseTip, mainCommit: baseTip, candidateCommit: candidateTip };
		const result = await structuralDeltaAnalyzer.run(ctx);
		const exportFacts = result.observations.filter((f) => ["EXPORTS_ADDED", "EXPORTS_REMOVED", "SIGNATURE_CHANGED"].includes(f.predicate));
		expect(exportFacts).toHaveLength(0);
	});

	test("split/ambiguous rename sources degrade to add+remove with an unresolved-rename gap (parseNameStatus, direct)", () => {
		const output = ["R100\tsrc/orig.ts\tsrc/dest1.ts", "R090\tsrc/orig.ts\tsrc/dest2.ts"].join("\n");
		const parsed = parseNameStatus(output);
		expect(parsed.ambiguousRenameGaps).toHaveLength(1);
		expect(parsed.ambiguousRenameGaps[0]).toContain("src/orig.ts");
		expect(parsed.entries.filter((e) => e.operation === "renamed")).toHaveLength(0);
		expect(parsed.entries.filter((e) => e.operation === "removed")).toHaveLength(1);
		expect(parsed.entries.filter((e) => e.operation === "removed")[0]!.path).toBe("src/orig.ts");
		const added = parsed.entries.filter((e) => e.operation === "added").map((e) => e.path).sort();
		expect(added).toEqual(["src/dest1.ts", "src/dest2.ts"]);
	});

	test("an unambiguous rename (single R line) parses as a clean rename with fromPath set", () => {
		const parsed = parseNameStatus("R100\told.ts\tnew.ts");
		expect(parsed.ambiguousRenameGaps).toHaveLength(0);
		expect(parsed.entries).toEqual([{ operation: "renamed", path: "new.ts", fromPath: "old.ts" }]);
	});
});

// ── non-TS and unparseable fixtures ─────────────────────────────────────────────────────────────────

describe("gaps, never findings", () => {
	test("a non-TS changed file produces a syntax-dimension gap, contributes zero facts", async () => {
		const repo = await gitRepo("sd-nonts-");
		const baseTip = await commitFiles(repo, { "a.ts": "export function foo(): number { return 1; }\n", "data.json": "{}\n" }, "base");
		await git(repo, "checkout", "-qb", "candidate");
		const candidateTip = await commitFiles(repo, { "data.json": '{"changed": true}\n' }, "candidate touches only a JSON file");

		const ctx: AnalyzerContext = { repo, baseCommit: baseTip, mainCommit: baseTip, candidateCommit: candidateTip };
		const result = await structuralDeltaAnalyzer.run(ctx);
		expect(result.observations).toHaveLength(0);
		expect(result.findings).toHaveLength(0);
		const syntaxDim = result.coverage.find((c) => c.dimension === "syntax")!;
		expect(syntaxDim.gaps.some((g) => g.reason === "non-ts-extension" && g.path === "data.json")).toBe(true);
	});

	test("an unparseable TS file produces a parse-error gap, contributes zero facts for that file", async () => {
		const repo = await gitRepo("sd-unparseable-");
		const baseTip = await commitFiles(repo, { "a.ts": "export function foo(): number { return 1; }\n" }, "base");
		await git(repo, "checkout", "-qb", "candidate");
		const candidateTip = await commitFiles(repo, { "a.ts": "export function foo( {{{ ***garbage***" }, "candidate corrupts a.ts's syntax");

		const ctx: AnalyzerContext = { repo, baseCommit: baseTip, mainCommit: baseTip, candidateCommit: candidateTip };
		const result = await structuralDeltaAnalyzer.run(ctx);
		expect(result.observations.filter((f) => f.subject.path === "a.ts")).toHaveLength(0);
		expect(result.findings).toHaveLength(0);
		const syntaxDim = result.coverage.find((c) => c.dimension === "syntax")!;
		expect(syntaxDim.gaps.some((g) => g.path === "a.ts" && g.reason.startsWith("parse-error:"))).toBe(true);
	});

	test("a binary (NUL-byte) file produces a binary-content gap, never a parse attempt", async () => {
		const repo = await gitRepo("sd-binary-");
		const baseTip = await commitFiles(repo, { "a.ts": "export function foo(): number { return 1; }\n" }, "base");
		await git(repo, "checkout", "-qb", "candidate");
		await fs.writeFile(path.join(repo, "a.ts"), Buffer.from([0x00, 0x01, 0x02, 0x66, 0x6f, 0x6f]));
		await git(repo, "add", "-A");
		await git(repo, "commit", "-qm", "candidate replaces a.ts with binary junk");
		const candidateTip = await rev(repo, "HEAD");

		const ctx: AnalyzerContext = { repo, baseCommit: baseTip, mainCommit: baseTip, candidateCommit: candidateTip };
		const result = await structuralDeltaAnalyzer.run(ctx);
		expect(result.observations).toHaveLength(0);
		const syntaxDim = result.coverage.find((c) => c.dimension === "syntax")!;
		expect(syntaxDim.gaps.some((g) => g.path === "a.ts" && g.reason.startsWith("binary-content"))).toBe(true);
	});
});

// ── size cap ─────────────────────────────────────────────────────────────────────────────────────────

describe("size cap", () => {
	test("exceeding DEFAULT_SIZE_CAP changed files degrades to a size-cap-exceeded gap, not a partial run", async () => {
		const repo = await gitRepo("sd-sizecap-");
		const baseTip = await commitFiles(repo, { "root.ts": "export const root = 1;\n" }, "base");
		await git(repo, "checkout", "-qb", "candidate");
		const many: Record<string, string> = {};
		for (let i = 0; i < DEFAULT_SIZE_CAP + 1; i++) many[`gen/file${i}.ts`] = `export const v${i} = ${i};\n`;
		const candidateTip = await commitFiles(repo, many, `candidate adds ${DEFAULT_SIZE_CAP + 1} files`);

		const ctx: AnalyzerContext = { repo, baseCommit: baseTip, mainCommit: baseTip, candidateCommit: candidateTip };
		const result = await structuralDeltaAnalyzer.run(ctx);
		expect(result.observations).toHaveLength(0);
		const syntaxDim = result.coverage.find((c) => c.dimension === "syntax")!;
		expect(syntaxDim.gaps.some((g) => g.reason.includes("size-cap-exceeded"))).toBe(true);
	}, 20000);
});

// ── extractStateFacts (concern 11's shared anchor entry point) ─────────────────────────────────────

describe("extractStateFacts", () => {
	test("full-state inventory emits EXPORTS + HAS_SIGNATURE facts for every TS file at one commit", async () => {
		const repo = await gitRepo("sd-state-");
		const tip = await commitFiles(repo, { "a.ts": "export function foo(): number { return 1; }\n", "readme.md": "# hi\n" }, "one commit");
		const tree = (await git(repo, "rev-parse", `${tip}^{tree}`)).stdout;
		const stateRef = { repositoryId: computeRepositoryId(repo), commit: tip, tree };

		const extraction = await extractStateFacts(stateRef);
		const exportsFacts = factsOfPredicate(extraction.facts, "EXPORTS");
		const signatureFacts = factsOfPredicate(extraction.facts, "HAS_SIGNATURE");
		expect(exportsFacts).toHaveLength(1);
		expect(exportsFacts[0]!.subject.qualifiedName).toBe("a.foo");
		expect(signatureFacts).toHaveLength(1);
		const syntaxDim = extraction.coverage.find((c) => c.dimension === "syntax")!;
		expect(syntaxDim.covered).toBe(1);
		expect(syntaxDim.total).toBe(1); // readme.md is not TS, never entered the denominator
	});
});

// ── runAnalyzers registry ────────────────────────────────────────────────────────────────────────────

describe("runAnalyzers", () => {
	test("a well-formed run through the registry yields the same findings as calling the analyzer directly", async () => {
		const repo = await gitRepo("sd-registry-");
		const baseTip = await commitFiles(repo, { "a.ts": "export function foo(): number { return 1; }\n" }, "base");
		await git(repo, "checkout", "-qb", "candidate");
		const candidateTip = await commitFiles(repo, { "a.ts": "export function foo(): string { return String(1); }\n" }, "candidate changes foo's return type");

		const ctx: AnalyzerContext = { repo, baseCommit: baseTip, mainCommit: baseTip, candidateCommit: candidateTip };
		const direct = await structuralDeltaAnalyzer.run(ctx);
		const viaRegistry = await runAnalyzers([structuralDeltaAnalyzer], ctx);
		expect(viaRegistry.observations.map((o) => o.factId).sort()).toEqual(direct.observations.map((o) => o.factId).sort());
	});
});

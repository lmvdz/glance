/**
 * The symptom-card store (comprehension lane concern 05, "teaching producers") — JSON-per-record
 * persistence mirroring `answers.ts`, plus the mechanical `whereToLook` quality floor
 * (`classifyWhereToLookEntry`/`statWhereToLookEntry`) that rejects "Where to look: src/"-style slop.
 * The wired `squad_record_symptom` host-tool path is covered in `agent-context-fabric.test.ts`.
 */
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	classifyWhereToLookEntry,
	isoWeekKey,
	listSymptoms,
	MAX_WHERE_TO_LOOK,
	MIN_SYMPTOM_LEN,
	readSymptom,
	saveSymptom,
	statWhereToLookEntry,
	symptomId,
	validateSymptomText,
	validateWhereToLookCount,
	type SymptomEntry,
} from "../src/symptoms.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function tmpDir(): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), "symptoms-"));
	dirs.push(d);
	return d;
}

function entry(over: Partial<SymptomEntry> = {}): SymptomEntry {
	return {
		id: "abc123",
		symptom: "daemon healthy but dispatch stalled",
		whereToLook: ["src/dispatch.ts"],
		repo: "/srv/app",
		fixedBy: { agentId: "a1", runId: "run-1" },
		landedAt: 1000,
		...over,
	};
}

// ── store round-trip + repo normalization ──────────────────────────────────────────────────────

test("a symptom round-trips, and is listed newest-first", async () => {
	const dir = await tmpDir();
	await saveSymptom(dir, entry({ id: "s1", landedAt: 100 }));
	await saveSymptom(dir, entry({ id: "s2", landedAt: 200, symptom: "verify green but land never fires" }));

	expect((await readSymptom(dir, "s1"))?.symptom).toBe("daemon healthy but dispatch stalled");
	expect((await listSymptoms(dir)).map((s) => s.id)).toEqual(["s2", "s1"]);
});

test("a missing or corrupt symptom reads as absent — never a crashed daemon", async () => {
	const dir = await tmpDir();
	expect(await readSymptom(dir, "nope")).toBeUndefined();

	await fs.mkdir(path.join(dir, "symptoms"), { recursive: true });
	await fs.writeFile(path.join(dir, "symptoms", "bad.json"), "{ not json");
	expect(await readSymptom(dir, "bad")).toBeUndefined();
	expect(await listSymptoms(dir)).toEqual([]);
});

/** RT1-11's "symptom repo keyspace mismatch": `repo` is normalized at write time AND compared via
 *  `normalizeRepoPath` at read time, from day one — a trailing slash or `.`/`..` segment must not
 *  split one repo into two keyspaces. */
test("repo is normalized on write and on the listSymptoms(repo) filter", async () => {
	const dir = await tmpDir();
	await saveSymptom(dir, entry({ id: "s1", repo: "/srv/app/" })); // trailing slash
	await saveSymptom(dir, entry({ id: "s2", repo: "/srv/other" }));

	expect((await readSymptom(dir, "s1"))?.repo).toBe("/srv/app"); // normalized at write time
	expect((await listSymptoms(dir, { repo: "/srv/app" })).map((s) => s.id)).toEqual(["s1"]);
	expect((await listSymptoms(dir, { repo: "/srv/app/" })).map((s) => s.id)).toEqual(["s1"]); // query side too
	expect((await listSymptoms(dir, { repo: "/srv/other" })).map((s) => s.id)).toEqual(["s2"]);
});

/** Mirrors answers.ts's traversal-safety test: an id is a hash today, but nothing stops a future
 *  caller from handing this a raw string, so the write path must defang it regardless. */
test("an id cannot escape the symptoms directory", async () => {
	const dir = await tmpDir();
	const evil = "../../etc/passwd";
	expect(await saveSymptom(dir, entry({ id: evil }))).toBe(true);
	expect(await fs.readdir(path.join(dir, "symptoms"))).toEqual([".._.._etc_passwd.json"]);
	expect((await readSymptom(dir, evil))?.symptom).toBe("daemon healthy but dispatch stalled");
});

// ── id week-bucketing stability ─────────────────────────────────────────────────────────────────

test("isoWeekKey is stable within a week and Monday-anchored", () => {
	// 2026-07-13 is a Monday, 2026-07-19 is the following Sunday — same ISO week.
	expect(isoWeekKey(new Date("2026-07-13T00:00:00Z"))).toBe(isoWeekKey(new Date("2026-07-19T23:59:59Z")));
	// 2026-07-20 (Monday) is the NEXT ISO week.
	expect(isoWeekKey(new Date("2026-07-20T00:00:00Z"))).not.toBe(isoWeekKey(new Date("2026-07-19T23:59:59Z")));
});

test("symptomId is stable for the same symptom+agent within a week, regardless of whitespace/case", () => {
	const at = new Date("2026-07-14T10:00:00Z");
	const id1 = symptomId("Daemon healthy but dispatch stalled", "a1", at);
	const id2 = symptomId("  daemon healthy but dispatch stalled  ", "a1", new Date("2026-07-16T22:00:00Z"));
	expect(id1).toBe(id2); // same week, normalized text, same agent
});

test("symptomId differs across a week boundary and across agents (RT2-14 recurrence tracking)", () => {
	const sameWeek = symptomId("dispatch stalled", "a1", new Date("2026-07-13T00:00:00Z"));
	const nextWeek = symptomId("dispatch stalled", "a1", new Date("2026-07-20T00:00:00Z"));
	expect(sameWeek).not.toBe(nextWeek); // a recurrence months later is its own record

	const otherAgent = symptomId("dispatch stalled", "a2", new Date("2026-07-13T00:00:00Z"));
	expect(sameWeek).not.toBe(otherAgent);

	const noAgent = symptomId("dispatch stalled", undefined, new Date("2026-07-13T00:00:00Z"));
	expect(typeof noAgent).toBe("string");
	expect(noAgent.length).toBeGreaterThan(0);
});

// ── the whereToLook mechanical floor ────────────────────────────────────────────────────────────

test("symptom text below the floor is rejected", () => {
	expect(validateSymptomText("too short").ok).toBe(false);
	const result = validateSymptomText("x".repeat(MIN_SYMPTOM_LEN - 1));
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.rule).toBe("symptom-text-too-short");
	expect(validateSymptomText("x".repeat(MIN_SYMPTOM_LEN)).ok).toBe(true);
});

test("whereToLook count must be 1-5", () => {
	expect(validateWhereToLookCount([]).ok).toBe(false);
	expect(validateWhereToLookCount(new Array(MAX_WHERE_TO_LOOK + 1).fill("glance doctor")).ok).toBe(false);
	expect(validateWhereToLookCount(new Array(MAX_WHERE_TO_LOOK).fill("glance doctor")).ok).toBe(true);
	expect(validateWhereToLookCount(["src/dispatch.ts"]).ok).toBe(true);
});

test("a bare top-level directory is rejected even if it exists (the 'Where to look: src/' slop)", () => {
	const result = classifyWhereToLookEntry("src/", "dir");
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.rule).toBe("symptom-where-to-look-bare-dir");
	expect(classifyWhereToLookEntry("src", "dir").ok).toBe(false);
});

test("an existing file is accepted at any depth, including a single top-level file", () => {
	expect(classifyWhereToLookEntry("Makefile", "file")).toEqual({ ok: true });
	expect(classifyWhereToLookEntry("src/dispatch.ts", "file")).toEqual({ ok: true });
});

test("an existing directory at least two levels deep is accepted", () => {
	expect(classifyWhereToLookEntry("src/lib", "dir")).toEqual({ ok: true });
});

test("a missing path is rejected, naming the rule", () => {
	const result = classifyWhereToLookEntry("src/does-not-exist.ts", "missing");
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.rule).toBe("symptom-where-to-look-missing");
});

test("a `glance …` command string is accepted without any stat check", () => {
	expect(classifyWhereToLookEntry("glance doctor", "missing")).toEqual({ ok: true });
	expect(classifyWhereToLookEntry("glance symptom search dispatch", "missing")).toEqual({ ok: true });
});

test("a blank entry is rejected", () => {
	const result = classifyWhereToLookEntry("   ", "file");
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.rule).toBe("symptom-where-to-look-empty");
});

// ── statWhereToLookEntry: the one place that touches a real filesystem ─────────────────────────

test("statWhereToLookEntry resolves file/dir/missing against a real repo root", async () => {
	const repo = await tmpDir();
	await fs.mkdir(path.join(repo, "src", "lib"), { recursive: true });
	await fs.writeFile(path.join(repo, "src", "dispatch.ts"), "// stub");

	expect(await statWhereToLookEntry(repo, "src/dispatch.ts")).toBe("file");
	expect(await statWhereToLookEntry(repo, "src")).toBe("dir");
	expect(await statWhereToLookEntry(repo, "src/lib")).toBe("dir");
	expect(await statWhereToLookEntry(repo, "src/nope.ts")).toBe("missing");
	expect(await statWhereToLookEntry(repo, "./src/dispatch.ts")).toBe("file"); // leading ./ tolerated
});

/**
 * Weekly episode brief (comprehension lane concern 09) — `src/weekly-episode.ts`'s pure
 * `buildEpisode`, the ISO-week boundary math, the storage/readdir idiom, and `EpisodeLoop`'s
 * durable-idempotency tick. No squad-manager wiring here (that's exercised live, not unit-tested —
 * `gatherEpisodeInputs` is a thin assembly of already-tested primitives).
 */
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AutomationReport } from "../src/automation-log.ts";
import type { FileFogEntry } from "../src/comprehension-fog.ts";
import {
	buildEpisode,
	type BuildEpisodeInput,
	type EpisodeGatherResult,
	EPISODE_SCHEMA_VERSION,
	EpisodeLoop,
	episodeExists,
	episodeRepoHash,
	isoWeekBounds,
	listEpisodes,
	previousCompleteIsoWeek,
	readEpisode,
	saveEpisode,
} from "../src/weekly-episode.ts";
import { isoWeekKey } from "../src/symptoms.ts";
import type { FeatureDecision } from "../src/types.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function tmpDir(): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), "weekly-episode-"));
	dirs.push(d);
	return d;
}

function delta(text: string, evidence: string[]): FeatureDecision {
	return { id: crypto.randomUUID(), text, source: "model-delta", evidence, createdAt: 1_000 };
}

function fog(file: string, over: Partial<FileFogEntry> = {}): FileFogEntry {
	return { repo: "/repo", file, changesSinceSeen: 3, lastChangedAt: 900, debt: 0.5, state: "stale", ...over };
}

function baseInput(over: Partial<BuildEpisodeInput> = {}): BuildEpisodeInput {
	return {
		repo: "/repo",
		isoWeek: "2026-W10",
		deltas: [],
		symptoms: [],
		fogTop: [],
		testExecutions: [],
		digestIds: [],
		omitted: [],
		...over,
	};
}

// ── determinism ─────────────────────────────────────────────────────────────────────────────────

test("buildEpisode is deterministic: same inputs (minus `now`) produce byte-identical markdown", () => {
	const input = baseInput({
		deltas: [delta("Dispatch used to serialize spawns; it now fans out concurrently.", ["src/dispatch.ts:10-40"])],
		fogTop: [fog("src/dispatch.ts")],
	});
	const a = buildEpisode({ ...input, now: 1_000 });
	const b = buildEpisode({ ...input, now: 999_999_999 }); // very different `now` — must not affect markdown
	expect(a.markdown).toBe(b.markdown);
	expect(a.markdown.length).toBeGreaterThan(0);
});

test("meta carries EPISODE_SCHEMA_VERSION and the id equals the isoWeek", () => {
	const { id, meta } = buildEpisode(baseInput());
	expect(id).toBe("2026-W10");
	expect(meta.version).toBe(EPISODE_SCHEMA_VERSION);
	expect(meta.id).toBe("2026-W10");
});

// ── delta grouping ──────────────────────────────────────────────────────────────────────────────

test("deltas are grouped by area (evidence's directory) under sorted headings", () => {
	const { markdown } = buildEpisode(
		baseInput({
			deltas: [
				delta("Webapp attention wiring changed shape.", ["webapp/src/lib/attention.ts:1-9"]),
				delta("Dispatch now fans out.", ["src/dispatch.ts"]),
				delta("A second dispatch delta landed too.", ["src/dispatch.ts:50-60"]),
			],
		}),
	);
	const srcIdx = markdown.indexOf("### src");
	const webappIdx = markdown.indexOf("### webapp/src/lib");
	expect(srcIdx).toBeGreaterThanOrEqual(0);
	expect(webappIdx).toBeGreaterThanOrEqual(0);
	expect(srcIdx).toBeLessThan(webappIdx); // alphabetical: "src" < "webapp/src/lib"
	expect(markdown).toContain("Dispatch now fans out. — evidence: `src/dispatch.ts`");
	expect(markdown).toContain("A second dispatch delta landed too.");
});

test("no deltas renders a declared line, never a silently blank section", () => {
	const { markdown } = buildEpisode(baseInput());
	expect(markdown).toContain("## What changed in the mental model");
	expect(markdown).toContain("no mental-model deltas recorded this week");
});

// ── symptoms (omit-when-absent) ─────────────────────────────────────────────────────────────────

test("no symptoms this week omits the section entirely", () => {
	const { markdown } = buildEpisode(baseInput());
	expect(markdown).not.toContain("## New known symptoms");
});

test("a symptom renders its text and whereToLook", () => {
	const { markdown } = buildEpisode(
		baseInput({ symptoms: [{ id: "s1", symptom: "daemon healthy but dispatch stalled", whereToLook: ["src/dispatch.ts"], repo: "/repo", fixedBy: {}, landedAt: 100 }] }),
	);
	expect(markdown).toContain("## New known symptoms");
	expect(markdown).toContain("daemon healthy but dispatch stalled — where to look: src/dispatch.ts");
});

// ── fog top-10 (declared-empty, never silent) ───────────────────────────────────────────────────

test("no fog data renders a declared line", () => {
	const { markdown } = buildEpisode(baseInput());
	expect(markdown).toContain("## Comprehension debt top-10");
	expect(markdown).toContain("no comprehension-debt data recorded for this repo yet");
});

test("fog entries render as a table row per file", () => {
	const { markdown } = buildEpisode(baseInput({ fogTop: [fog("src/dispatch.ts", { debt: 0.83, changesSinceSeen: 12, state: "never-seen" })] }));
	expect(markdown).toContain("| `src/dispatch.ts` | 0.83 | never-seen | 12 |");
});

// ── Verified this week (observed-only, never fabricated) ────────────────────────────────────────

test("no observed test runs renders the same declared line pr-body.ts uses", () => {
	const { markdown } = buildEpisode(baseInput());
	expect(markdown).toContain("## Verified this week");
	expect(markdown).toContain("no observed test runs recorded");
});

test("a real observed test execution renders its provenance", () => {
	const { markdown } = buildEpisode(baseInput({ testExecutions: [{ command: "bun test", outcome: "36 pass", source: "transcript" }] }));
	expect(markdown).toContain("`bun test` — 36 pass (observed in transcript)");
});

// ── stale answers (undefined vs. defined-empty are different facts) ─────────────────────────────

test("staleAnswers undefined ⇒ section omitted AND counted in Not covered", () => {
	const { markdown } = buildEpisode(baseInput());
	expect(markdown).not.toContain("## Your questions whose answers may be stale");
	expect(markdown).toContain("stale-answer resurfacing");
	expect(markdown).toContain("not wired yet");
});

test("staleAnswers defined-empty ⇒ a declared 'checked, none stale' line, not an omission", () => {
	const { markdown } = buildEpisode(baseInput({ staleAnswers: [] }));
	expect(markdown).toContain("## Your questions whose answers may be stale");
	expect(markdown).toContain("no stale answers this week");
	expect(markdown).not.toContain("stale-answer resurfacing"); // not counted as an omission — it WAS checked
});

test("staleAnswers with entries renders each question", () => {
	const { markdown } = buildEpisode(baseInput({ staleAnswers: [{ id: "a1", question: "How does dispatch route by repo?" }] }));
	expect(markdown).toContain("- How does dispatch route by repo?");
});

// ── Not covered (REQUIRED, never empty-silent) ──────────────────────────────────────────────────

test("Not covered is ALWAYS present, even with zero omissions and zero digests", () => {
	const { markdown } = buildEpisode(baseInput());
	expect(markdown).toContain("## Not covered");
	expect(markdown).toContain("0 session digests generated this week");
});

test("digest count and caller-supplied omissions both fold into Not covered", () => {
	const { markdown } = buildEpisode(baseInput({ digestIds: ["a1", "a2", "a3"], omitted: [{ title: "2 non-model-delta decisions", reason: "not mental-model atoms" }] }));
	expect(markdown).toContain("3 session digests generated this week");
	expect(markdown).toContain("2 non-model-delta decisions — not mental-model atoms");
});

// ── excerpt (first paragraph + top-3 debt files ONLY — never full markdown) ─────────────────────

test("excerpt is short, names the top debt files, and never contains the full markdown body", () => {
	const { markdown, meta } = buildEpisode(
		baseInput({
			deltas: [delta("A real change happened here.", ["src/a.ts"])],
			fogTop: [fog("src/a.ts", { debt: 0.9 }), fog("src/b.ts", { debt: 0.8 }), fog("src/c.ts", { debt: 0.7 }), fog("src/d.ts", { debt: 0.6 })],
		}),
	);
	expect(meta.excerpt).toContain("src/a.ts");
	expect(meta.excerpt).toContain("src/b.ts");
	expect(meta.excerpt).toContain("src/c.ts");
	expect(meta.excerpt).not.toContain("src/d.ts"); // top-3 only, not top-4
	expect(meta.excerpt.length).toBeLessThan(markdown.length);
	expect(meta.excerpt).not.toContain("## Not covered"); // never the full doc
});

// ── ISO-week boundary math (year rollover) ──────────────────────────────────────────────────────

test("isoWeekBounds round-trips through isoWeekKey for an ordinary mid-year date", () => {
	const d = new Date("2026-07-15T12:00:00Z");
	const week = isoWeekKey(d);
	const { start, end } = isoWeekBounds(week);
	expect(d.getTime()).toBeGreaterThanOrEqual(start);
	expect(d.getTime()).toBeLessThan(end);
	expect(end - start).toBe(7 * 24 * 60 * 60 * 1000);
});

test("isoWeekBounds handles year rollover: 2026-W01's Monday falls in December 2025", () => {
	// 2026-01-01 is a Thursday, so it belongs to 2026-W01, and that week's Monday is 2025-12-29.
	const week = isoWeekKey(new Date("2026-01-01T00:00:00Z"));
	expect(week).toBe("2026-W01");
	const { start, end } = isoWeekBounds(week);
	expect(new Date(start).toISOString().slice(0, 10)).toBe("2025-12-29");
	// Every day from 2025-12-29 through 2026-01-04 round-trips back to the same week id.
	for (let t = start; t < end; t += 24 * 60 * 60 * 1000) {
		expect(isoWeekKey(new Date(t))).toBe(week);
	}
});

test("isoWeekBounds handles the other side of rollover: a year's last ISO week spills into January", () => {
	// 2026-12-31 is a Thursday; its ISO week is 2026-W53, whose Sunday lands in January 2027.
	const week = isoWeekKey(new Date("2026-12-31T00:00:00Z"));
	const { start, end } = isoWeekBounds(week);
	expect(new Date(end - 1).getUTCFullYear()).toBe(2027);
	expect(new Date(start).getUTCFullYear()).toBe(2026);
});

test("previousCompleteIsoWeek returns last week, and crosses a year boundary correctly", () => {
	// Any moment inside 2026-W01 (Mon 2025-12-29 .. Sun 2026-01-04) must resolve to the LAST week of
	// 2025, not a nonsense partial id.
	const prev = previousCompleteIsoWeek(new Date("2026-01-02T10:00:00Z"));
	expect(prev).not.toBe("2026-W01");
	const { end } = isoWeekBounds(prev);
	expect(end).toBeLessThanOrEqual(isoWeekBounds("2026-W01").start);
});

test("isoWeekBounds throws on a malformed id rather than silently misparsing", () => {
	expect(() => isoWeekBounds("not-a-week")).toThrow();
});

// ── storage: readdir idiom + idempotency ────────────────────────────────────────────────────────

test("episodeExists is false before save and true after", async () => {
	const dir = await tmpDir();
	expect(episodeExists(dir, "/repo", "2026-W10")).toBe(false);
	const episode = buildEpisode(baseInput());
	expect(await saveEpisode(dir, "/repo", episode)).toBe(true);
	expect(episodeExists(dir, "/repo", "2026-W10")).toBe(true);
});

test("readEpisode round-trips markdown + meta; a missing episode reads as undefined, never a crash", async () => {
	const dir = await tmpDir();
	const episode = buildEpisode(baseInput({ deltas: [delta("Something real changed.", ["src/x.ts"])] }));
	await saveEpisode(dir, "/repo", episode);
	const read = await readEpisode(dir, "/repo", "2026-W10");
	expect(read?.markdown).toBe(episode.markdown);
	expect(read?.excerpt).toBe(episode.meta.excerpt);
	expect(await readEpisode(dir, "/repo", "2099-W01")).toBeUndefined();
});

test("a corrupt meta sidecar reads as absent, not a crashed daemon", async () => {
	const dir = await tmpDir();
	const episode = buildEpisode(baseInput());
	await saveEpisode(dir, "/repo", episode);
	const metaPath = path.join(dir, "episodes", episodeRepoHash("/repo"), "2026-W10.json");
	await fs.writeFile(metaPath, "{ not json");
	expect(await readEpisode(dir, "/repo", "2026-W10")).toBeUndefined();
});

test("listEpisodes returns newest-week-first and never crosses repos (repoHash separates them)", async () => {
	const dir = await tmpDir();
	await saveEpisode(dir, "/repo", buildEpisode(baseInput({ isoWeek: "2026-W09" })));
	await saveEpisode(dir, "/repo", buildEpisode(baseInput({ isoWeek: "2026-W10" })));
	await saveEpisode(dir, "/other", buildEpisode(baseInput({ repo: "/other", isoWeek: "2026-W52" })));

	const forRepo = await listEpisodes(dir, "/repo");
	expect(forRepo.map((e) => e.isoWeek)).toEqual(["2026-W10", "2026-W09"]);
	const forOther = await listEpisodes(dir, "/other");
	expect(forOther.map((e) => e.isoWeek)).toEqual(["2026-W52"]);
});

test("listEpisodes sorts correctly across a year boundary (string sort, year-prefixed ids)", async () => {
	const dir = await tmpDir();
	await saveEpisode(dir, "/repo", buildEpisode(baseInput({ isoWeek: "2025-W52" })));
	await saveEpisode(dir, "/repo", buildEpisode(baseInput({ isoWeek: "2026-W01" })));
	const all = await listEpisodes(dir, "/repo");
	expect(all.map((e) => e.isoWeek)).toEqual(["2026-W01", "2025-W52"]); // newest first
});

// ── EpisodeLoop tick: idempotency + push + observability ────────────────────────────────────────

function gatherResult(over: Partial<EpisodeGatherResult> = {}): EpisodeGatherResult {
	return { deltas: [], symptoms: [], fogTop: [], testExecutions: [], digestIds: [], omitted: [], ...over };
}

test("EpisodeLoop.tick generates once, pushes once, and reports a meaningful (filed>0) event", async () => {
	const dir = await tmpDir();
	let gatherCalls = 0;
	const pushed: Array<{ title: string; tag?: string }> = [];
	const reports: AutomationReport[] = [];
	const loop = new EpisodeLoop({
		repos: () => ["/repo"],
		stateDir: dir,
		gather: async () => {
			gatherCalls++;
			return gatherResult({ deltas: [delta("A real delta.", ["src/a.ts"])] });
		},
		notifyPush: (p) => void pushed.push(p),
		now: () => new Date("2026-07-15T12:00:00Z").getTime(),
		recordFor: () => (r) => reports.push(r),
	});

	await loop.tick();

	expect(gatherCalls).toBe(1);
	expect(pushed).toHaveLength(1);
	expect(pushed[0]?.title).toBe("weekly brief ready");
	expect(pushed[0]?.tag).toMatch(/^episode:/);
	expect(reports).toHaveLength(1);
	expect(reports[0]?.filed).toBe(1);

	const targetWeek = previousCompleteIsoWeek(new Date("2026-07-15T12:00:00Z"));
	expect(episodeExists(dir, "/repo", targetWeek)).toBe(true);
});

test("EpisodeLoop.tick skips generation once the target week's artifact exists, and stays ring-only", async () => {
	const dir = await tmpDir();
	const clock = () => new Date("2026-07-15T12:00:00Z").getTime();
	const targetWeek = previousCompleteIsoWeek(new Date(clock()));
	await saveEpisode(dir, "/repo", buildEpisode(baseInput({ isoWeek: targetWeek })));

	let gatherCalls = 0;
	const pushed: unknown[] = [];
	const reports: AutomationReport[] = [];
	const loop = new EpisodeLoop({
		repos: () => ["/repo"],
		stateDir: dir,
		gather: async () => {
			gatherCalls++;
			return gatherResult();
		},
		notifyPush: (p) => void pushed.push(p),
		now: clock,
		recordFor: () => (r) => reports.push(r),
	});

	await loop.tick();

	expect(gatherCalls).toBe(0); // already exists — never even gathers
	expect(pushed).toHaveLength(0);
	expect(reports).toHaveLength(1);
	// Ring-only means: no skipReason, no level, and zero found/filed — automation-log.ts's
	// isMeaningful() would read this as non-meaningful (never spooled to automation.jsonl).
	expect(reports[0]).toEqual({ durationMs: expect.any(Number), found: 0, filed: 0 });
});

test("EpisodeLoop.tick reports level:warn (not ring-only) when gather fails, and never pushes", async () => {
	const dir = await tmpDir();
	const pushed: unknown[] = [];
	const reports: AutomationReport[] = [];
	const loop = new EpisodeLoop({
		repos: () => ["/repo"],
		stateDir: dir,
		gather: async () => {
			throw new Error("boom");
		},
		notifyPush: (p) => void pushed.push(p),
		now: () => new Date("2026-07-15T12:00:00Z").getTime(),
		recordFor: () => (r) => reports.push(r),
	});

	await loop.tick();

	expect(pushed).toHaveLength(0);
	expect(reports).toHaveLength(1);
	expect(reports[0]?.level).toBe("warn");
	expect(reports[0]?.filed).toBe(0);
});

test("EpisodeLoop.tick reports level:warn when the save itself fails (stateDir unwritable)", async () => {
	const dir = await tmpDir();
	const notAFile = path.join(dir, "not-a-dir");
	await fs.writeFile(notAFile, "x"); // a FILE where the loop will try to mkdir a directory

	const reports: AutomationReport[] = [];
	const loop = new EpisodeLoop({
		repos: () => ["/repo"],
		stateDir: notAFile,
		gather: async () => gatherResult(),
		now: () => new Date("2026-07-15T12:00:00Z").getTime(),
		recordFor: () => (r) => reports.push(r),
	});

	await loop.tick();

	expect(reports).toHaveLength(1);
	expect(reports[0]?.level).toBe("warn");
	expect(reports[0]?.filed).toBe(0);
});

test("EpisodeLoop.tick is reentrancy-safe: an overlapping call while one is in flight is a no-op", async () => {
	const dir = await tmpDir();
	let gatherCalls = 0;
	const loop = new EpisodeLoop({
		repos: () => ["/repo"],
		stateDir: dir,
		gather: async () => {
			gatherCalls++;
			await new Promise((r) => setTimeout(r, 20));
			return gatherResult();
		},
		now: () => new Date("2026-07-15T12:00:00Z").getTime(),
	});
	const first = loop.tick();
	const second = loop.tick(); // fires while `first` is still running
	await Promise.all([first, second]);
	expect(gatherCalls).toBe(1);
});

test("an orphaned markdown half (crash between md and meta writes) reads as NOT generated — the next tick retries", async () => {
	const dir = await tmpDir();
	const built = buildEpisode(baseInput());
	expect(await saveEpisode(dir, "/repo", built)).toBe(true);
	expect(episodeExists(dir, "/repo", built.id)).toBe(true);
	// simulate the crash: meta sidecar gone, markdown orphaned
	const { rm } = await import("node:fs/promises");
	const meta = (await import("node:fs/promises")).readdir;
	const repoDir = (await meta(dir + "/episodes"))[0];
	await rm(`${dir}/episodes/${repoDir}/${built.id}.json`);
	expect(episodeExists(dir, "/repo", built.id)).toBe(false);
});

test("EpisodeLoop derives its repo set LIVE each tick — a repo added after construction gets its episode without a restart", async () => {
	const dir = await tmpDir();
	const reports: AutomationReport[] = [];
	const liveRepos: string[] = ["/repo"];
	const generated: string[] = [];
	const loop = new EpisodeLoop({
		repos: () => [...liveRepos],
		stateDir: dir,
		gather: async (repo) => {
			generated.push(repo);
			return gatherResult();
		},
		now: () => new Date("2026-07-15T12:00:00Z").getTime(),
		recordFor: () => (r) => reports.push(r),
	});
	await loop.tick();
	expect(generated).toEqual(["/repo"]);
	liveRepos.push("/late-added"); // no restart, no re-construction
	await loop.tick();
	expect(generated).toContain("/late-added");
});

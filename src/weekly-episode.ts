/**
 * weekly-episode.ts — the state-of-the-codebase brief (comprehension lane, concern 09).
 *
 * Once a week, per repo, a durable deterministic markdown brief is assembled from
 * already-recorded narrative atoms: mental-model deltas (`FeatureDecision.source ===
 * "model-delta"`, concern 05), symptom cards (concern 05/07), the comprehension-debt
 * top-10 (concern 03's `computeFog`/`topDebt`), and observed-only test provenance (the
 * same "no observed test runs recorded" honesty line `pr-body.ts` uses — receipts carry
 * no command/outcome, so nothing here may invent one). DESIGN.md "Episode composition":
 * a zero-token deterministic PROJECTION of atoms that are already agent-authored, not an
 * LLM composition step (declared follow-up).
 *
 * `buildEpisode` is pure: no I/O, no `Date.now()` inside its own rendering (the optional
 * `now` input only stamps `meta.generatedAt`, never the markdown text), so the same
 * inputs always produce byte-identical markdown — the determinism test's contract.
 *
 * Storage mirrors `symptoms.ts`'s per-record-file + readdir-index idiom: one markdown
 * file plus a sidecar JSON meta (schema-validated on read, same "persisted state is a
 * real trust boundary" reasoning) at `<stateDir>/episodes/<repoHash>/<isoWeek>.md|.json`.
 * `EPISODE_SCHEMA_VERSION` means a version bump lets an old artifact be RE-RENDERED from
 * its recorded meta, not render-broken — the ndrstnd cache-versioning pattern.
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import { Schema } from "effect";
import type { AutomationRecorder, AutomationReport } from "./automation-log.ts";
import type { FileFogEntry } from "./comprehension-fog.ts";
import { getStorageBackend } from "./dal/storage.ts";
import { evidenceFilePath } from "./decision-evidence.ts";
import { errText } from "./err-text.ts";
import { normalizeRepoPath } from "./project-registry.ts";
import type { PushPayload } from "./push.ts";
import type { TestExecutionEntry } from "./pr-body.ts";
import { decodeJsonWith } from "./schema/external-json.ts";
import { isoWeekKey, type SymptomEntry } from "./symptoms.ts";
import type { FeatureDecision } from "./types.ts";

export const EPISODE_SCHEMA_VERSION = 1;

const DAY_MS = 24 * 60 * 60 * 1000;
const DIR = "episodes";

/** One caller-declared "we know about this and chose not to include it" entry — same shape as
 *  `pr-body.ts`'s `OmittedEntry`, kept as its own type here since episodes are a different module
 *  with a different (never-omitted) Not-covered contract. */
export interface OmittedEntry {
	title: string;
	reason: string;
}

/** Concern 10 forward-compat (DESIGN.md "ask→fabric" / this concern's point 5): a prior answer
 *  whose referenced files changed enough since it was given that it may be stale. This concern only
 *  RENDERS the section when the input is present; concern 10 is the producer. */
export interface StaleAnswerEntry {
	id: string;
	question: string;
}

export interface BuildEpisodeInput {
	repo: string;
	/** ISO 8601 week id, e.g. `"2026-W29"` (`isoWeekKey` in `symptoms.ts`). */
	isoWeek: string;
	/** Every `source:"model-delta"` decision to render this week — NOT pre-capped; this module never
	 *  drops a delta (unlike `pr-body.ts`'s per-PR cap — a weekly digest is the wide-angle view). */
	deltas: FeatureDecision[];
	/** Symptom cards recorded this week for this repo. */
	symptoms: SymptomEntry[];
	/** The comprehension-debt top-10 (`topDebt(computeFog(...), 10)`) — already ranked/capped by the
	 *  caller; this module renders it verbatim. */
	fogTop: FileFogEntry[];
	/** Test runs the caller can prove were actually observed. Honestly empty today (no persisted
	 *  structure captures command+outcome — see `pr-body.ts`'s module doc); kept as a real input for
	 *  interface symmetry with a future producer, never fabricated here. */
	testExecutions: TestExecutionEntry[];
	/** Ids of every digest visible for this repo — counted, NEVER quoted (full transcripts stay off
	 *  the BM25 corpus; a digest's content is a different retrieval surface entirely). */
	digestIds: string[];
	/** Caller-supplied "we know about this and chose not to include it" entries (e.g. non-model-delta
	 *  decisions that exist but aren't mental-model atoms) — folded into the always-present Not-covered
	 *  section alongside this module's own structural digest-count line. */
	omitted: OmittedEntry[];
	/** Concern 10 populates this; absent (not merely empty) means "not wired yet" and is itself
	 *  counted in Not-covered. An empty array (defined, zero entries) means "checked, none stale" and
	 *  renders its own declared line instead — the same "producer said zero" vs "no producer"
	 *  distinction the rest of this lane draws everywhere else. */
	staleAnswers?: StaleAnswerEntry[];
	/** Epoch ms stamped into `meta.generatedAt` only — NEVER read by the markdown renderer, so two
	 *  calls with identical `deltas`/`symptoms`/`fogTop`/etc. at different wall-clock times still
	 *  produce byte-identical markdown. Defaults to `Date.now()`. */
	now?: number;
}

export interface EpisodeMeta {
	version: number;
	id: string;
	repo: string;
	isoWeek: string;
	windowStart: number;
	windowEnd: number;
	generatedAt: number;
	/** First paragraph + top-3 debt files ONLY (DESIGN.md concern 3: "full markdown NEVER in the BM25
	 *  corpus") — the one field `fabric.ts`'s `FabricEpisodeFact` projects. */
	excerpt: string;
	digestCount: number;
	hasStaleAnswers: boolean;
}

export interface BuiltEpisode {
	id: string;
	markdown: string;
	meta: EpisodeMeta;
}

const EpisodeMetaSchema = Schema.Struct({
	version: Schema.Number,
	id: Schema.String,
	repo: Schema.String,
	isoWeek: Schema.String,
	windowStart: Schema.Number,
	windowEnd: Schema.Number,
	generatedAt: Schema.Number,
	excerpt: Schema.String,
	digestCount: Schema.Number,
	hasStaleAnswers: Schema.Boolean,
});

// ── ISO-week boundary math ──────────────────────────────────────────────────────────────────────

/**
 * `{ start, end }` (epoch ms, `end` exclusive) for an ISO 8601 week id — the inverse of
 * `isoWeekKey` (symptoms.ts). Handles year rollover by construction: ISO week 1 of a year is
 * defined as the week containing that year's first Thursday, so its Monday can fall in the
 * PREVIOUS calendar year (e.g. `2026-W01`'s Monday is `2025-12-29`), and a year's last week
 * likewise can spill into January — both fall out of the same Jan-4 anchor computation `isoWeekKey`
 * itself uses, so the two functions can never disagree about where a week starts.
 * @substrate exported for tests only — `EpisodeLoop.tick` and `previousCompleteIsoWeek` (below, same
 * file) are the production callers; the year-rollover math is asserted directly against known dates
 * rather than only through a live tick, mirroring `symptoms.ts`'s `isoWeekKey` doc.
 */
export function isoWeekBounds(isoWeek: string): { start: number; end: number } {
	const m = /^(\d{4})-W(\d{2})$/.exec(isoWeek);
	if (!m) throw new Error(`invalid ISO week id: ${isoWeek}`);
	const year = Number(m[1]);
	const week = Number(m[2]);
	const jan4 = Date.UTC(year, 0, 4);
	const jan4DayNum = (new Date(jan4).getUTCDay() + 6) % 7; // Mon=0..Sun=6
	const week1Monday = jan4 - jan4DayNum * DAY_MS;
	const start = week1Monday + (week - 1) * 7 * DAY_MS;
	return { start, end: start + 7 * DAY_MS };
}

/**
 * The ISO week id immediately before the week containing `now` — the most recently FULLY elapsed
 * week. `EpisodeLoop`'s tick generates for this week, never the current partial one (DESIGN.md
 * "Weekly episode trigger": durable idempotency over a real calendar week, not an in-memory timer).
 * @substrate exported for tests only — `EpisodeLoop.tick` (same file) is the one production caller;
 * the year-boundary crossing is asserted directly.
 */
export function previousCompleteIsoWeek(now: Date): string {
	const current = isoWeekKey(now);
	const { start } = isoWeekBounds(current);
	return isoWeekKey(new Date(start - 1));
}

// ── delta grouping ──────────────────────────────────────────────────────────────────────────────

/** "Area" a delta belongs to: the directory of its first evidence entry (line-range suffix
 *  stripped via `evidenceFilePath`, reused from `decision-evidence.ts` rather than reimplemented).
 *  A model-delta decision always carries evidence (`validateModelDelta` requires it), so `"unfiled"`
 *  is a defensive fallback, never the common case. A root-level file (`path.dirname` === ".")
 *  groups under its own name rather than a bare ".", which is not an actionable area label. */
function deltaArea(d: FeatureDecision): string {
	const first = (d.evidence ?? [])[0];
	if (!first?.trim()) return "unfiled";
	const file = evidenceFilePath(first).trim();
	if (!file) return "unfiled";
	const dir = path.dirname(file);
	return dir === "." ? file : dir;
}

function groupDeltasByArea(deltas: FeatureDecision[]): Map<string, FeatureDecision[]> {
	const byArea = new Map<string, FeatureDecision[]>();
	for (const d of deltas) {
		const area = deltaArea(d);
		const bucket = byArea.get(area);
		if (bucket) bucket.push(d);
		else byArea.set(area, [d]);
	}
	return byArea;
}

function formatDeltaBullet(d: FeatureDecision): string {
	const evidence = (d.evidence ?? []).filter((e) => e.trim().length > 0);
	const anchor = evidence.length > 0 ? ` — evidence: \`${evidence.join(", ")}\`` : "";
	return `- ${d.text.trim()}${anchor}`;
}

// ── section rendering ───────────────────────────────────────────────────────────────────────────

function renderDeltaSection(deltas: FeatureDecision[]): string {
	if (deltas.length === 0) return "## What changed in the mental model\nno mental-model deltas recorded this week";
	const byArea = groupDeltasByArea(deltas);
	const blocks = [...byArea.keys()].sort().map((area) => `### ${area}\n${byArea.get(area)!.map(formatDeltaBullet).join("\n")}`);
	return `## What changed in the mental model\n${blocks.join("\n\n")}`;
}

function renderSymptomsSection(symptoms: SymptomEntry[]): string | undefined {
	if (symptoms.length === 0) return undefined; // most weeks fix nothing worth a symptom card
	const bullets = symptoms.map((s) => `- ${s.symptom} — where to look: ${s.whereToLook.join(", ")}`).join("\n");
	return `## New known symptoms\n${bullets}`;
}

function renderFogSection(fogTop: FileFogEntry[]): string {
	if (fogTop.length === 0) return "## Comprehension debt top-10\nno comprehension-debt data recorded for this repo yet";
	const header = "| File | Debt | State | Changes since seen |\n| --- | --- | --- | --- |";
	const rows = fogTop.map((f) => `| \`${f.file}\` | ${f.debt.toFixed(2)} | ${f.state} | ${f.changesSinceSeen} |`).join("\n");
	return `## Comprehension debt top-10\n${header}\n${rows}`;
}

function renderVerifiedSection(testExecutions: TestExecutionEntry[]): string {
	const lines =
		testExecutions.length > 0
			? testExecutions.map((t) => `- \`${t.command}\` — ${t.outcome} (observed in ${t.source})`).join("\n")
			: "no observed test runs recorded";
	return `## Verified this week\n${lines}`;
}

interface StaleAnswersResult {
	section?: string;
	notCoveredNote?: OmittedEntry;
}

/** Undefined (no producer yet) vs. defined-empty (checked, zero stale) are different facts and get
 *  different treatment — see `BuildEpisodeInput.staleAnswers`'s doc. */
function renderStaleAnswersSection(staleAnswers: StaleAnswerEntry[] | undefined): StaleAnswersResult {
	if (staleAnswers === undefined) {
		return { notCoveredNote: { title: "stale-answer resurfacing", reason: "not wired yet — concern 10 populates this input" } };
	}
	if (staleAnswers.length === 0) {
		return { section: "## Your questions whose answers may be stale\nno stale answers this week" };
	}
	return { section: `## Your questions whose answers may be stale\n${staleAnswers.map((s) => `- ${s.question}`).join("\n")}` };
}

/** ALWAYS rendered, never omitted — the concern's "REQUIRED, never empty-silent" contract. Every
 *  digest visible for this repo is counted here (its content is NEVER quoted, full stop, so this
 *  line is the one place that omission is ever disclosed), plus whatever the caller declared. */
function renderNotCoveredSection(omitted: OmittedEntry[], digestCount: number, staleNote: OmittedEntry | undefined): string {
	const all = [...omitted];
	all.push({
		title: `${digestCount} session digest${digestCount === 1 ? "" : "s"} generated this week`,
		reason: "full transcripts stay off the BM25 corpus and are not quoted here — see the daemon's digest store or fabric search",
	});
	if (staleNote) all.push(staleNote);
	return `## Not covered\n${all.map((o) => `- ${o.title} — ${o.reason}`).join("\n")}`;
}

function leadParagraph(deltaCount: number, areaCount: number, fogTop: FileFogEntry[]): string {
	const parts = [`${deltaCount} mental-model delta${deltaCount === 1 ? "" : "s"} across ${areaCount} area${areaCount === 1 ? "" : "s"} this week.`];
	const topFile = fogTop[0]?.file;
	if (topFile) parts.push(`Top comprehension-debt file: \`${topFile}\`.`);
	return parts.join(" ");
}

function buildExcerpt(lead: string, fogTop: FileFogEntry[]): string {
	const top3 = fogTop.slice(0, 3).map((f) => f.file);
	return top3.length > 0 ? `${lead} Top debt: ${top3.join(", ")}.` : lead;
}

/**
 * Pure projection: already-recorded teaching atoms → one week's markdown brief. Every section is
 * either present-with-real-content, present-with-a-declared-empty-line, or (symptoms/stale-answers
 * only) entirely omitted-and-counted — never silently blank. Same inputs (everything but `now`)
 * always produce byte-identical `markdown`.
 * @substrate exported for tests only — `EpisodeLoop.tick` (same file) is the one production caller;
 * the determinism/section-rendering/Not-covered-honesty contract is asserted directly against this
 * pure function rather than only through a live tick.
 */
export function buildEpisode(input: BuildEpisodeInput): BuiltEpisode {
	const { repo, isoWeek, deltas, symptoms, fogTop, testExecutions, digestIds, omitted, staleAnswers } = input;
	const repoNorm = normalizeRepoPath(repo);
	const { start: windowStart, end: windowEnd } = isoWeekBounds(isoWeek);
	const areaCount = groupDeltasByArea(deltas).size;
	const lead = leadParagraph(deltas.length, areaCount, fogTop);
	const stale = renderStaleAnswersSection(staleAnswers);

	const sections: string[] = [`# Weekly episode — ${repoNorm} — ${isoWeek}`, lead, renderDeltaSection(deltas)];
	const symptomSection = renderSymptomsSection(symptoms);
	if (symptomSection) sections.push(symptomSection);
	sections.push(renderFogSection(fogTop));
	if (stale.section) sections.push(stale.section);
	sections.push(renderVerifiedSection(testExecutions));
	sections.push(renderNotCoveredSection(omitted, digestIds.length, stale.notCoveredNote));

	const meta: EpisodeMeta = {
		version: EPISODE_SCHEMA_VERSION,
		id: isoWeek,
		repo: repoNorm,
		isoWeek,
		windowStart,
		windowEnd,
		generatedAt: input.now ?? Date.now(),
		excerpt: buildExcerpt(lead, fogTop),
		digestCount: digestIds.length,
		hasStaleAnswers: (staleAnswers?.length ?? 0) > 0,
	};
	return { id: isoWeek, markdown: sections.join("\n\n"), meta };
}

// ── storage (readdir idiom, mirrors symptoms.ts) ───────────────────────────────────────────────

/** Stable, directory-safe id for a repo's episode subtree — repo paths contain `/`, which can't be
 *  a directory segment itself. Normalized first so `/srv/app` and `/srv/app/` share one bucket.
 *  @substrate exported for tests only — `mdFile`/`metaFile`/`EpisodeLoop`'s push tag (same file) are
 *  the production callers; hash stability is asserted directly. */
export function episodeRepoHash(repo: string): string {
	return createHash("sha1").update(normalizeRepoPath(repo)).digest("hex").slice(0, 16);
}

/** Mirrors `symptoms.ts`'s `sanitizeId` — an isoWeek id is always machine-generated
 *  (`"YYYY-Www"`), but nothing stops a future caller from handing this a raw string. */
function sanitizeId(id: string): string {
	return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function mdFile(stateDir: string, repo: string, isoWeek: string): string {
	return path.join(stateDir, DIR, episodeRepoHash(repo), `${sanitizeId(isoWeek)}.md`);
}

function metaFile(stateDir: string, repo: string, isoWeek: string): string {
	return path.join(stateDir, DIR, episodeRepoHash(repo), `${sanitizeId(isoWeek)}.json`);
}

/** Whether this repo's artifact for `isoWeek` already exists — `EpisodeLoop`'s idempotency check.
 *  @substrate exported for tests only — `EpisodeLoop.tick` (same file) is the one production caller;
 *  the idempotency decision (exists ⇒ skip) is asserted directly. */
export function episodeExists(stateDir: string, repo: string, isoWeek: string): boolean {
	return getStorageBackend().exists(mdFile(stateDir, repo, isoWeek));
}

/** Durable write of both the markdown and its sidecar meta. Returns false (never throws) on any
 *  write failure — a caller must never believe an episode was saved when a restart will disagree.
 *  @substrate exported for tests only — `EpisodeLoop.tick` (same file) is the one production caller;
 *  the round-trip/idempotency contract is asserted directly against a real temp state dir. */
export async function saveEpisode(stateDir: string, repo: string, episode: BuiltEpisode): Promise<boolean> {
	try {
		const b = getStorageBackend();
		await b.writeDurable(mdFile(stateDir, repo, episode.id), episode.markdown);
		await b.writeDurable(metaFile(stateDir, repo, episode.id), JSON.stringify(episode.meta, null, 2));
		return true;
	} catch {
		return false;
	}
}

/** Never throws: a missing/corrupt markdown file reads as "no such episode". Not exported — the
 *  public read surface is `readEpisode` (markdown+meta together) and `listEpisodes` (meta only); no
 *  caller outside this file ever needs the markdown half alone. */
async function readEpisodeMarkdown(stateDir: string, repo: string, isoWeek: string): Promise<string | undefined> {
	try {
		return await getStorageBackend().readText(mdFile(stateDir, repo, isoWeek));
	} catch {
		return undefined;
	}
}

/** Never throws: a missing/corrupt meta file reads as "no such episode", not a crashed daemon. Not
 *  exported — `readEpisode`/`listEpisodes` (same file) are the only callers; corruption handling is
 *  asserted through those, mirroring `readEpisodeMarkdown`'s doc above. */
async function readEpisodeMeta(stateDir: string, repo: string, isoWeek: string): Promise<EpisodeMeta | undefined> {
	try {
		const raw = await getStorageBackend().readText(metaFile(stateDir, repo, isoWeek));
		if (raw === undefined) return undefined;
		return (decodeJsonWith(EpisodeMetaSchema, raw) as EpisodeMeta | null) ?? undefined;
	} catch {
		return undefined;
	}
}

/** The full record (markdown + meta) for one episode, or `undefined` if either half is missing —
 *  a half-written artifact is treated as absent rather than served partially. */
export async function readEpisode(stateDir: string, repo: string, isoWeek: string): Promise<(EpisodeMeta & { markdown: string }) | undefined> {
	const [markdown, meta] = await Promise.all([readEpisodeMarkdown(stateDir, repo, isoWeek), readEpisodeMeta(stateDir, repo, isoWeek)]);
	if (markdown === undefined || meta === undefined) return undefined;
	return { ...meta, markdown };
}

/** Newest-week-first index of every episode meta recorded for `repo` — readdir over the sidecar
 *  `.json` files (the digest idiom), skipping any entry that fails to decode rather than failing
 *  the whole listing. ISO week ids sort correctly lexically (zero-padded `Www`, year-prefixed), so
 *  a plain string sort is a real newest-first order with no date parsing. */
export async function listEpisodes(stateDir: string, repo: string): Promise<EpisodeMeta[]> {
	const b = getStorageBackend();
	const dir = path.join(stateDir, DIR, episodeRepoHash(repo));
	const names = await b.readdir(dir).catch(() => [] as string[]);
	const out: EpisodeMeta[] = [];
	for (const name of names.filter((n) => n.endsWith(".json"))) {
		const meta = await readEpisodeMeta(stateDir, repo, name.slice(0, -5));
		if (meta) out.push(meta);
	}
	return out.sort((a, b2) => b2.isoWeek.localeCompare(a.isoWeek));
}

// ── EpisodeLoop (uniform loop shape, mirrors scout.ts's/opportunity.ts's constructor+start+stop+tick) ──

/** Everything one repo's target-week generation needs beyond `repo`/`isoWeek`/`now` (which the loop
 *  itself supplies) — `squad-manager.ts` owns turning a repo + time window into these from live
 *  daemon state (featureStore's model-delta decisions, symptoms, receipts+attention→fog, fabric's
 *  digest ids). */
export type EpisodeGatherResult = Omit<BuildEpisodeInput, "repo" | "isoWeek" | "now">;

export interface EpisodeLoopDeps {
	repo: string;
	stateDir: string;
	/** Resolve one target week's inputs. A rejection is treated as a contained tick failure (logged,
	 *  reported `level:"warn"`), never an uncaught throw. */
	gather: (window: { start: number; end: number }) => Promise<EpisodeGatherResult>;
	/** One push per generation (DESIGN.md "Push at motivation"; this concern's point 5) — the caller
	 *  supplies the actual `PushService.notify` call so this module never owns a PushService instance
	 *  or a subscription list itself (staleness-free by construction: nothing here caches subs).
	 *  Best-effort: a failure here never fails the generation that already landed on disk. */
	notifyPush?: (payload: PushPayload) => Promise<void> | void;
	now?: () => number;
	log?: (msg: string) => void;
	/**
	 * Observability sink — one MEANINGFUL report per actual generation (`filed:1` ⇒
	 * `automation-log.ts`'s `isMeaningful` persists it). The common "target week's artifact already
	 * exists" tick reports all-zero counts with no `skipReason`/`level` set, so it stays ring-only by
	 * construction — an HOURLY tick chasing a WEEKLY deliverable would otherwise spool ~167 no-op
	 * lines/week/repo to `automation.jsonl` forever. A gather/save failure DOES set `level:"warn"` (a
	 * real problem, not a heartbeat) so it persists despite `filed:0`.
	 */
	record?: AutomationRecorder;
}

export class EpisodeLoop {
	private readonly deps: EpisodeLoopDeps;
	private timer?: Timer;
	private running = false;

	constructor(deps: EpisodeLoopDeps) {
		this.deps = deps;
	}

	start(intervalMs: number): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.tick().catch((e) => (this.deps.log ?? (() => {}))(`tick error (contained): ${errText(e)}`)), intervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	async tick(): Promise<void> {
		if (this.running) return;
		this.running = true;
		const log = this.deps.log ?? (() => {});
		const clock = this.deps.now ?? Date.now;
		const t0 = clock();
		let report: AutomationReport = { durationMs: 0, found: 0, filed: 0 };
		let targetWeek: string | undefined;
		try {
			targetWeek = previousCompleteIsoWeek(new Date(clock()));
			if (episodeExists(this.deps.stateDir, this.deps.repo, targetWeek)) {
				report = { durationMs: clock() - t0, found: 0, filed: 0 }; // ring-only: nothing new this tick
				return;
			}
			// A missing artifact for the target week IS a found candidate, regardless of what happens next.
			let gathered: EpisodeGatherResult;
			try {
				gathered = await this.deps.gather(isoWeekBounds(targetWeek));
			} catch (e) {
				log(`gather failed for ${this.deps.repo}/${targetWeek}: ${errText(e)}`);
				report = { durationMs: clock() - t0, found: 1, filed: 0, level: "warn", detail: `gather failed for ${targetWeek}` };
				return;
			}
			const episode = buildEpisode({ repo: this.deps.repo, isoWeek: targetWeek, now: clock(), ...gathered });
			const ok = await saveEpisode(this.deps.stateDir, this.deps.repo, episode);
			if (!ok) {
				log(`save failed for ${this.deps.repo}/${targetWeek}`);
				report = { durationMs: clock() - t0, found: 1, filed: 0, level: "warn", detail: `save failed for ${targetWeek}` };
				return;
			}
			report = { durationMs: clock() - t0, found: 1, filed: 1, detail: `generated episode for ${targetWeek}` };
			if (this.deps.notifyPush) {
				try {
					await this.deps.notifyPush({
						title: "weekly brief ready",
						body: "Tap to open glance — the weekly state-of-the-codebase brief is ready.",
						url: `/#/episodes/${episode.id}`,
						// Own namespace (never `done:`/bare agent id, per push.ts's voiceDonePayload doc) so a
						// "brief ready" toast can never debounce-eat or be eaten by an unactioned "needs you".
						tag: `episode:${episodeRepoHash(this.deps.repo)}:${episode.id}`,
					});
				} catch (e) {
					log(`push failed for ${this.deps.repo}/${targetWeek}: ${errText(e)}`);
				}
			}
		} catch (e) {
			log(`tick failed for ${this.deps.repo}: ${errText(e)}`);
			report = { durationMs: clock() - t0, found: 0, filed: 0, level: "warn", detail: `tick failed: ${errText(e)}` };
		} finally {
			this.running = false;
			this.deps.record?.(report);
		}
	}
}

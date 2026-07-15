/**
 * The symptom-card store — comprehension lane, concern 05 ("teaching producers").
 *
 * DESIGN.md: *"a signal is named by what it measures"* extends to defect memory too. A symptom card is
 * recorded by the FIXING unit, at fix time, phrased the way an OPERATOR would observe the defect
 * ("daemon healthy but dispatch stalled") — never as the fix itself ("added a null check in dispatch.ts").
 * That framing is what lets a future doctor-check failure or a search hit match a NEW occurrence of an
 * old symptom to the file(s) that fixed it last time, without the reader having to already know the
 * internals.
 *
 * Producer-first, same as `answers.ts`: recorded here via `squad_record_symptom`, projected everywhere
 * else (doctor's `remedy` field, `glance symptom`, fabric/⌘K search) by later concerns. Nothing here
 * renders anything — this module is the write path and the read-by-id/list path only.
 *
 * Mechanical quality floor on `whereToLook` (RT1-11/RT2-14's "symptom repo keyspace mismatch" and "zero
 * quality enforcement" findings): each entry must be either a `glance …` command string, or an existing
 * repo-relative path that is *not* a bare top-level directory — "Where to look: src/" is exactly the
 * kind of unfalsifiable pointer this floor exists to reject. `classifyWhereToLookEntry` is pure (takes
 * the stat result as `kind`, never touches the filesystem itself) so it is trivially unit-testable;
 * `statWhereToLookEntry` is the one place that resolves a real path against the unit's repo root.
 *
 * Storage mirrors `answers.ts`: one JSON record per symptom at `<stateDir>/symptoms/<id>.json` via the
 * active `StorageBackend`, decoded with a real Schema (persisted state survives daemon upgrades, so the
 * shape check is a genuine trust boundary), ids sanitized before ever reaching a path join.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Schema } from "effect";
import { getStorageBackend } from "./dal/storage.ts";
import { normalizeRepoPath } from "./project-registry.ts";
import { decodeJsonWith } from "./schema/external-json.ts";

export interface SymptomEntry {
	/** Stable id — also the filename. `symptomId(...)` (hash of normalized text + agentId + ISO week),
	 *  so retrying the same call within one week is idempotent while a recurrence months later gets a
	 *  fresh record (query-time grouping handles cross-week dedup display, not the id). */
	id: string;
	/** Operator-facing phrasing of the defect, e.g. "daemon healthy but dispatch stalled" — never the
	 *  fix ("added a null check in dispatch.ts"). Min 20 chars (`validateSymptomText`). */
	symptom: string;
	/** 1–5 entries: an existing repo-relative path (not a bare top-level directory) or a `glance …`
	 *  command string. See `classifyWhereToLookEntry`. */
	whereToLook: string[];
	/** The unit's repo path at record time — no identity↔path mapping needed (RT1-11). Compared via
	 *  `normalizeRepoPath` everywhere, from day one. */
	repo: string;
	fixedBy: {
		agentId?: string;
		runId?: string;
		/** Not known at record time (recording happens mid-run, before any PR exists) — populated by a
		 *  later projection step when the fix lands. Never fabricated here. */
		prNumber?: number;
	};
	/** Epoch ms at record time. */
	landedAt: number;
}

const SymptomSchema = Schema.Struct({
	id: Schema.String,
	symptom: Schema.String,
	whereToLook: Schema.Array(Schema.String),
	repo: Schema.String,
	fixedBy: Schema.Struct({
		agentId: Schema.optional(Schema.String),
		runId: Schema.optional(Schema.String),
		prNumber: Schema.optional(Schema.Number),
	}),
	landedAt: Schema.Number,
});

const DIR = "symptoms";

export const MIN_SYMPTOM_LEN = 20;
export const MIN_WHERE_TO_LOOK = 1;
export const MAX_WHERE_TO_LOOK = 5;

function file(stateDir: string, id: string): string {
	return path.join(stateDir, DIR, `${sanitizeId(id)}.json`);
}

/** Ids are derived from a hash (see `symptomId`), but any id reaching a path join is a path traversal
 *  waiting to happen — mirrors `answers.ts`'s `sanitizeId`. */
function sanitizeId(id: string): string {
	return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function normalizeSymptomText(s: string): string {
	return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * ISO 8601 week id, e.g. `"2026-W29"` — the Monday-start, first-Thursday-owns-week-1 convention.
 * Deterministic given a UTC instant; never reads the system timezone.
 * @substrate exported for tests only — `symptomId` (below, same file) is the one production caller;
 * week-boundary stability is asserted directly against known dates rather than through the hash.
 */
export function isoWeekKey(date: Date): string {
	const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
	d.setUTCDate(d.getUTCDate() - dayNum + 3); // shift to this ISO week's Thursday
	const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
	const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
	firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
	const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
	return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * `id = hash(normalized symptom + agentId + ISO-week)` (RT2-14): a retry of the SAME call within the
 * same week overwrites in place rather than duplicating, but the same symptom text recurring months
 * later gets its own record — the whole point of a symptom card is "this happened again", and
 * collapsing every recurrence into one row would erase that signal. Query-time grouping (a later
 * concern's projection) handles "newest first, same text" display dedup.
 */
export function symptomId(symptom: string, agentId: string | undefined, at: Date = new Date()): string {
	const key = `${normalizeSymptomText(symptom)}\0${agentId ?? ""}\0${isoWeekKey(at)}`;
	return createHash("sha1").update(key).digest("hex").slice(0, 20);
}

/** Never throws: a corrupt or missing symptom reads as "no such symptom", not a crashed daemon. */
export async function readSymptom(stateDir: string, id: string): Promise<SymptomEntry | undefined> {
	try {
		const raw = await getStorageBackend().readText(file(stateDir, id));
		if (raw === undefined) return undefined;
		return (decodeJsonWith(SymptomSchema, raw) as SymptomEntry | null) ?? undefined;
	} catch {
		return undefined;
	}
}

/** Newest first. A record that fails to decode is skipped, not fatal. `repo` is compared via
 *  `normalizeRepoPath` on BOTH sides (RT1-11's keyspace-mismatch class), from day one. */
export async function listSymptoms(stateDir: string, opts: { repo?: string } = {}): Promise<SymptomEntry[]> {
	const b = getStorageBackend();
	const names = await b.readdir(path.join(stateDir, DIR)).catch(() => [] as string[]);
	const wantRepo = opts.repo !== undefined ? normalizeRepoPath(opts.repo) : undefined;
	const out: SymptomEntry[] = [];
	for (const name of names.filter((n) => n.endsWith(".json"))) {
		const s = await readSymptom(stateDir, name.slice(0, -5));
		if (!s) continue;
		if (wantRepo !== undefined && normalizeRepoPath(s.repo) !== wantRepo) continue;
		out.push(s);
	}
	return out.sort((x, y) => y.landedAt - x.landedAt);
}

/** Durable, atomic; `repo` is stored normalized so every reader can compare byte-for-byte. Returns
 *  false when the write failed — a caller must never tell the agent a symptom was saved when the next
 *  restart will disagree. */
export async function saveSymptom(stateDir: string, entry: SymptomEntry): Promise<boolean> {
	try {
		const normalized: SymptomEntry = { ...entry, repo: normalizeRepoPath(entry.repo) };
		await getStorageBackend().writeDurable(file(stateDir, entry.id), JSON.stringify(normalized, null, 2));
		return true;
	} catch {
		return false;
	}
}

// ── whereToLook mechanical floor ────────────────────────────────────────────────────────────────

export interface SymptomRejection {
	ok: false;
	/** Machine-stable name of the violated rule, so the agent can self-correct. */
	rule: string;
	message: string;
}
export interface SymptomAccepted {
	ok: true;
}
export type SymptomValidation = SymptomAccepted | SymptomRejection;

/** Recognizes a `glance …` command string — accepted without a filesystem stat check. */
const GLANCE_COMMAND_RE = /^glance(\s|$)/i;

/** Symptom text floor: a real minimum length, so "fixed it" or "bug gone" doesn't qualify — the whole
 *  point is operator-observable phrasing with enough substance to be searchable later. */
export function validateSymptomText(symptom: string): SymptomValidation {
	if (symptom.trim().length < MIN_SYMPTOM_LEN) {
		return {
			ok: false,
			rule: "symptom-text-too-short",
			message: `symptom must be at least ${MIN_SYMPTOM_LEN} characters, phrased as the operator would observe it (e.g. "daemon healthy but dispatch stalled")`,
		};
	}
	return { ok: true };
}

/** 1–5 entries, per DESIGN.md — enough to be useful, capped so the tool can't be used to dump an
 *  unbounded file list. */
export function validateWhereToLookCount(whereToLook: string[]): SymptomValidation {
	if (whereToLook.length < MIN_WHERE_TO_LOOK) {
		return { ok: false, rule: "symptom-where-to-look-count", message: "whereToLook must have at least 1 entry" };
	}
	if (whereToLook.length > MAX_WHERE_TO_LOOK) {
		return { ok: false, rule: "symptom-where-to-look-count", message: `whereToLook accepts at most ${MAX_WHERE_TO_LOOK} entries` };
	}
	return { ok: true };
}

/** What `statWhereToLookEntry` found on disk for one entry — `"missing"` when the stat failed. */
export type WhereToLookStat = "file" | "dir" | "missing";

/**
 * The mechanical floor for ONE `whereToLook` entry, given what a stat already found. Pure — never
 * touches the filesystem itself, so tests drive every branch without a real repo.
 *
 * A `glance …` command string is accepted outright (no stat applies). Otherwise the entry must exist
 * (`kind !== "missing"`), and if it's a DIRECTORY it must be at least two path segments deep — a bare
 * top-level directory ("src/", "src") is exactly the "Where to look: src/" slop DESIGN.md names. An
 * existing FILE is accepted at any depth (a single top-level file like "Makefile" is a real, specific
 * pointer even though it's shallow).
 */
export function classifyWhereToLookEntry(entry: string, kind: WhereToLookStat): SymptomValidation {
	const trimmed = entry.trim();
	if (!trimmed) {
		return { ok: false, rule: "symptom-where-to-look-empty", message: "whereToLook entries cannot be blank" };
	}
	if (GLANCE_COMMAND_RE.test(trimmed)) return { ok: true };
	if (kind === "missing") {
		return {
			ok: false,
			rule: "symptom-where-to-look-missing",
			message: `"${trimmed}" does not exist in this repo — whereToLook entries must be a real path or a \`glance …\` command`,
		};
	}
	const normalized = trimmed.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
	const depth = normalized.split("/").filter(Boolean).length;
	if (kind === "dir" && depth < 2) {
		return {
			ok: false,
			rule: "symptom-where-to-look-bare-dir",
			message: `"${trimmed}" is a bare top-level directory — point at a specific file or a path at least two levels deep`,
		};
	}
	return { ok: true };
}

/** Stat one `whereToLook` entry against `repoRoot`. Never throws: any stat failure (including a
 *  command-string entry, for which no stat is ever attempted) reads as `"missing"`. */
export async function statWhereToLookEntry(repoRoot: string, entry: string): Promise<WhereToLookStat> {
	const trimmed = entry.trim();
	if (GLANCE_COMMAND_RE.test(trimmed)) return "file"; // short-circuited by classifyWhereToLookEntry before this matters
	const normalized = trimmed.replace(/^\.\//, "").replace(/^\/+/, "");
	if (!normalized) return "missing";
	try {
		const st = await fs.stat(path.join(repoRoot, normalized));
		return st.isDirectory() ? "dir" : "file";
	} catch {
		return "missing";
	}
}

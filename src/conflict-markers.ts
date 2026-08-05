/**
 * Conflict-marker gate (#330, per #327's resolution; hardened in gauntlet round 1 against #351).
 * A cheap textual scan for LIVE git conflict-marker lines that made it into a land — git's own
 * structural conflict detection only fires on an ACTUAL unresolved merge, never on marker debris a
 * resolver (or a careless human) left BEHIND in content that git considers perfectly mergeable.
 * AUTORESOLVE's LLM resolver is exactly the failure mode this closes: it writes files that pass
 * typecheck+test — a `.md`/`.json`/`.txt` file with marker lines still compiles/parses fine.
 *
 * Round-1 gauntlet (dual-lineage, codex + grok) found the first cut trusted a raw `git diff` too
 * much and covered only one of three land paths. Fixes, grouped by the same finding numbers as the
 * gauntlet report:
 *
 *   (1/9) SCAN THE RIGHT THING. The first cut scanned `merge-base(baseRef,branch)..branch` — a
 *   branch's OWN historical diff since its (possibly stale) fork point. That over-scans: content
 *   that independently converged onto the current target between the fork and land time reads as
 *   "newly added" even though the actual merge introduces nothing for it. Every range-based scan
 *   here now takes an explicit `(fromRef, toRef)` pair representing what the land ACTUALLY
 *   introduces relative to the CURRENT target — the caller supplies the pre-merge target tip and
 *   the post-merge (or scratch-merge) result, never a merge-base. `landAgentPr`'s scratch worktree
 *   already gives PR mode this for free (`origin/<default>..HEAD` in the scratch tree).
 *   (2) COVER ALL LAND PATHS. The in-place early-return in `landAgentImpl` (worktree === repo) used
 *   to commit before any gate ran — {@link conflictMarkerReasonStaged} scans the STAGED diff right
 *   after `git add`, before the commit. PR mode ({@link conflictMarkerReasonForRange} against the
 *   scratch merge) closes the complete production-path bypass that was the round's CRITICAL finding.
 *   (3/4) HARDEN THE DIFF INVOCATION. `-c color.ui=false` neutralizes an inherited/malicious
 *   `color.ui=always` that would wrap every line in ANSI escapes so no line starts with a literal
 *   `+`/`diff --git` — the parser would then see zero markers. `--text` forces a textual diff
 *   regardless of a `.gitattributes` `-diff`/`binary` attribute that would otherwise make git treat
 *   a path as binary and omit its content entirely.
 *   (5/6) ROBUST MARKER DETECTION. `conflict-marker-size` is a `.gitattributes`-configurable integer
 *   (git's default is 7); the regexes now match VARIABLE-width runs (`{7,}`) of the marker character
 *   so a `conflict-marker-size=10` config doesn't dodge an exact 7-char match. The diff3/zdiff3 base
 *   marker (`|||||||`) is now detected unconditionally, same variable width.
 *   (7) ALLOWLIST. A narrow path allowlist (`tests/fixtures/**`, `*.patch`/`*.rej`/`*.diff`) plus an
 *   in-file exempt token ({@link MARKER_EXEMPT_TOKEN}) covers legitimate marker-carrying content
 *   (a fixture teaching about markers, a patch file, this very module's own docs) that added-lines-
 *   only alone doesn't protect once full-file scanning (next point) is in play.
 *   (8) The AUTORESOLVE site now does a FULL-FILE scan of resolver-touched files
 *   ({@link conflictMarkerReasonForFiles}), not an added-lines diff — a resolver that inserts
 *   unresolved arms INSIDE an old teaching triple (reusing pre-existing marker lines as context)
 *   would slip past an added-lines-only scan there. Safe now specifically because the allowlist (7)
 *   exempts the legitimate marker content full-file scanning would otherwise false-positive on.
 *
 * ESCAPE HATCHES (both, now — round-1 folded the two options the ticket offered into one design
 * instead of picking just one): (a) the path/token allowlist above, for content that must exist as
 * committed source, and (b) added-lines-only scanning at the ordinary/PR-mode sites, so a marker-
 * looking line that already existed on the target before this land is never flagged there (the
 * AUTORESOLVE site trades this one away deliberately, per (8) above, in exchange for the allowlist).
 */

import { envBool } from "./config.ts";
import { classifyProbeFailure } from "./classify-probe-failure.ts";
import { errText } from "./err-text.ts";
import { GIT_HARDEN_ARGS, GIT_HARDEN_ENV } from "./git-harden.ts";

/** On by default — a structural git conflict and marker debris left in mergeable content are
 *  different signals; set OMP_SQUAD_CONFLICT_MARKER_GATE=0 to disable (old behavior). */
export function conflictMarkerGateEnabled(): boolean {
	return envBool("OMP_SQUAD_CONFLICT_MARKER_GATE", true);
}

/**
 * Hardened, colorless, textual git invocation (gauntlet #3/#4). `GIT_HARDEN_ARGS` already
 * neutralizes hooks/pager/external-diff; `-c color.ui=false` additionally refuses an inherited (or
 * repo-committed) `color.ui=always` that would otherwise wrap every diff line in ANSI escapes and
 * hide every marker from a column-anchored regex. Callers that need `--text` (forcing a textual diff
 * past a `.gitattributes` `-diff`/binary attribute) pass it themselves via `args`.
 */
function git(args: string[], cwd: string): Promise<{ code: number; stdout: string }> {
	const proc = Bun.spawn(["git", ...GIT_HARDEN_ARGS, "-c", "color.ui=false", ...args], { cwd, env: { ...process.env, ...GIT_HARDEN_ENV }, stdout: "pipe", stderr: "ignore" });
	return Promise.all([new Response(proc.stdout).text(), proc.exited]).then(([stdout, code]) => ({ code, stdout }));
}

/** A blocking reason wrapping a probe failure — never blames the branch, always names the gate as the
 *  source of the refusal and points at its one env hatch. Mirrors land-risk.ts's own helper. */
function probeFailureReason(detail: string): string {
	const { reason } = classifyProbeFailure({ kind: "spawn-error", detail });
	return `conflict-markers gate: could not scan for conflict markers (${reason}) — refusing to land rather than guessing it's clean. (OMP_SQUAD_CONFLICT_MARKER_GATE=0 disables this gate.)`;
}

/**
 * Real git conflict-marker line shapes — VARIABLE width (gauntlet #5/#6): `.gitattributes` can set
 * `conflict-marker-size` per path (git's own default is 7), so an exact 7-char match misses a
 * repo/path configured wider. `{7,}` catches the default and any wider configured size. Anchored to
 * the START of the line so ordinary prose that merely MENTIONS a run of these characters mid-sentence
 * never matches; start/end/base markers always carry a trailing label in real git output, but the
 * label is treated as optional (`(?:\s|$)`) rather than required, so a bare run still counts.
 */
export const MARKER_START_RE = /^<{7,}(?:\s|$)/;
export const MARKER_MID_RE = /^={7,}$/;
export const MARKER_END_RE = /^>{7,}(?:\s|$)/;
/** diff3/zdiff3's "common ancestor" marker — round-1 finding #6: previously never checked at all. */
export const MARKER_BASE_RE = /^\|{7,}(?:\s|$)/;

type MarkerKind = "start" | "mid" | "end" | "base";

function classifyMarkerLine(s: string): MarkerKind | undefined {
	if (MARKER_START_RE.test(s)) return "start";
	if (MARKER_END_RE.test(s)) return "end";
	if (MARKER_BASE_RE.test(s)) return "base";
	if (MARKER_MID_RE.test(s)) return "mid";
	return undefined;
}

interface RawHit {
	line: string;
	kind: MarkerKind;
}

// ── allowlist (gauntlet #7) ─────────────────────────────────────────────────────────────────────

/** Fixture/patch paths that legitimately carry marker text as their actual payload. Narrow and
 *  auditable by design — widen only with a specific, named reason, never a broad glob. */
const ALLOWLISTED_PATH_RE = /(^|\/)tests\/fixtures\//i;
const ALLOWLISTED_EXT_RE = /\.(patch|rej|diff)$/i;

function isAllowlistedPath(file: string): boolean {
	return ALLOWLISTED_PATH_RE.test(file) || ALLOWLISTED_EXT_RE.test(file);
}

/**
 * In-file exempt token (gauntlet #7's second half): a file whose content contains this EXACT string
 * anywhere is exempted from the scan entirely — covers docs that must show real marker syntax as
 * teaching material (this module's own doc comments avoid the token so they never need it; a file
 * that genuinely needs to display markers, e.g. a `--verify` grep example, adds this token once).
 * Deliberately a plain substring (not a comment syntax) so it works in any file type, JSON included.
 */
export const MARKER_EXEMPT_TOKEN = "glance-conflict-marker-check:allow";

// ── shared hit-filtering: allowlist + exempt-token + the mid-marker co-occurrence rule ───────────

/**
 * A bare `=======` (`mid`) is genuinely ambiguous with a Markdown Setext H1 underline
 * (`Title\n=======`) — on its own it would false-positive on ordinary docs. Real conflict debris
 * (standard OR diff3/zdiff3) always has a `start`, `end`, or `base` line SOMEWHERE among the flagged
 * lines; a `mid` hit is only kept when at least one of those is ALSO present, which loses no real
 * detection power while eliminating the Markdown false positive.
 */
function applyMidCoOccurrenceRule(hits: RawHit[]): RawHit[] {
	const hasUnambiguous = hits.some((h) => h.kind !== "mid");
	return hasUnambiguous ? hits : hits.filter((h) => h.kind !== "mid");
}

interface MarkerHit {
	file: string;
	line: string;
}

const HIT_LIST_CAP = 8;
const HIT_LINE_TRUNCATE = 120;

function formatReason(subject: string, hits: MarkerHit[]): string {
	const shown = hits
		.slice(0, HIT_LIST_CAP)
		.map((h) => `${h.file}: ${h.line.length > HIT_LINE_TRUNCATE ? `${h.line.slice(0, HIT_LINE_TRUNCATE)}…` : h.line}`)
		.join("; ");
	const more = hits.length > HIT_LIST_CAP ? ` (+${hits.length - HIT_LIST_CAP} more)` : "";
	return (
		`conflict-markers gate: ${subject} carries live conflict-marker line(s): ${shown}${more} — refusing to land ` +
		`(git's own structural conflict check doesn't catch marker debris a resolver or human left in otherwise-mergeable content). ` +
		`(OMP_SQUAD_CONFLICT_MARKER_GATE=0 disables this gate.)`
	);
}

/** Fetch a file's full content at `ref` (`git show ref:path`; pass `""` for the INDEX — `git show
 *  :path` reads stage 0) — used for the exempt-token check on a diff-flagged file and by the
 *  full-file scan. Returns undefined on any failure (deleted path, binary blob) — callers treat that
 *  as "can't confirm exemption", never as "exempt". */
async function showFile(repo: string, ref: string, file: string): Promise<string | undefined> {
	const r = await git(["show", `${ref}:${file}`], repo);
	return r.code === 0 ? r.stdout : undefined;
}

// ── parsing a unified diff into per-file, per-kind hits ───────────────────────────────────────────

/** Parse a `git diff --unified=0` patch and return every ADDED (`+`-prefixed) line that matches one
 *  of the four marker shapes, grouped by file. */
function parseAddedLinesByFile(diffText: string): Map<string, RawHit[]> {
	const byFile = new Map<string, RawHit[]>();
	let currentFile = "(unknown file)";
	for (const rawLine of diffText.split("\n")) {
		if (rawLine.startsWith("diff --git a/")) {
			// "diff --git a/old-path b/new-path" — the b/ side is the path the content lands at (a
			// rename's new name); a/-only removed files never contribute an ADDED line anyway.
			const m = /^diff --git a\/.+ b\/(.+)$/.exec(rawLine);
			if (m) currentFile = m[1];
			continue;
		}
		if (rawLine.startsWith("+++ ") || rawLine.startsWith("--- ")) continue; // file headers, not content
		if (!rawLine.startsWith("+")) continue; // only newly ADDED lines
		const content = rawLine.slice(1);
		const kind = classifyMarkerLine(content);
		if (!kind) continue;
		const arr = byFile.get(currentFile) ?? [];
		arr.push({ line: content, kind });
		byFile.set(currentFile, arr);
	}
	return byFile;
}

/** Apply the allowlist + exempt-token + mid-co-occurrence filters to a per-file hit map, returning
 *  the final flat hit list. `contentRef` is the ref to `git show` a flagged file's content from for
 *  the exempt-token check (the diff's "to" side — the content actually landing; `""` for the index). */
async function resolveHits(repo: string, contentRef: string, byFile: Map<string, RawHit[]>): Promise<MarkerHit[]> {
	const out: MarkerHit[] = [];
	for (const [file, rawHits] of byFile) {
		if (isAllowlistedPath(file)) continue;
		const kept = applyMidCoOccurrenceRule(rawHits);
		if (kept.length === 0) continue;
		const content = await showFile(repo, contentRef, file);
		if (content?.includes(MARKER_EXEMPT_TOKEN)) continue;
		for (const h of kept) out.push({ file, line: h.line });
	}
	return out;
}

// ── public API ──────────────────────────────────────────────────────────────────────────────────

/**
 * Live conflict-marker line(s) that land ADDS between `fromRef` (the CURRENT target tip — e.g. local
 * mode's pre-merge `head0`, or PR mode's freshly-fetched `origin/<default>`) and `toRef` (the
 * post-merge/scratch-merge result — typically `"HEAD"` in whichever checkout just received the
 * merge), or `undefined` when none are found. Scans only lines ADDED by the diff (gauntlet #1/#9:
 * this is deliberately NOT a merge-base diff — a merge-base scan over-reads a branch's own history
 * and can re-flag content that independently converged onto the current target by land time; a
 * direct `fromRef..toRef` range reflects exactly what THIS land introduces, no more).
 *
 * `fromRef` is always an ancestor of `toRef` by construction here (both call sites compute `toRef`
 * BY MERGING onto `fromRef`), so this needs no merge-base probe and none of land-risk.ts's
 * orphan/shallow-clone edge cases — a plain two-ref diff is always well-defined.
 */
export async function conflictMarkerReasonForRange(repo: string, fromRef: string, toRef: string): Promise<string | undefined> {
	try {
		// --text: gauntlet #4 — force a textual diff even if a `.gitattributes` `-diff`/binary attribute
		// would otherwise make git omit a path's content entirely (an agent-writable file, so untrusted).
		const diff = await git(["diff", "--no-ext-diff", "--text", "--unified=0", `${fromRef}..${toRef}`], repo);
		if (diff.code !== 0) return probeFailureReason(`diff ${fromRef}..${toRef} exited ${diff.code}`);
		const byFile = parseAddedLinesByFile(diff.stdout);
		if (byFile.size === 0) return undefined;
		const hits = await resolveHits(repo, toRef, byFile);
		if (hits.length === 0) return undefined;
		return formatReason(`this land (${fromRef}..${toRef})`, hits);
	} catch (err) {
		return probeFailureReason(errText(err));
	}
}

/**
 * The in-place land path (`landAgentImpl`'s `worktree === repo` branch, gauntlet #2): live conflict-
 * marker line(s) currently STAGED (the index vs. `HEAD`) in `repo`, or `undefined` when none. Must be
 * called AFTER `git add` and BEFORE the commit — the in-place path used to commit and report success
 * before any gate ever ran.
 */
export async function conflictMarkerReasonStaged(repo: string): Promise<string | undefined> {
	try {
		const diff = await git(["diff", "--no-ext-diff", "--text", "--unified=0", "--cached"], repo);
		if (diff.code !== 0) return probeFailureReason(`diff --cached exited ${diff.code}`);
		const byFile = parseAddedLinesByFile(diff.stdout);
		if (byFile.size === 0) return undefined;
		// The staged content IS the working tree's index right now — read it back via `git show :path`
		// (the `:0` stage) for the exempt-token check, not a ref.
		const hits = await resolveHits(repo, "", byFile);
		if (hits.length === 0) return undefined;
		return formatReason("the staged commit", hits);
	} catch (err) {
		return probeFailureReason(errText(err));
	}
}

/**
 * The AUTORESOLVE path (gauntlet #8): a FULL-FILE scan of `files` as they exist at `ref` — not an
 * added-lines diff. A resolver that inserts unresolved arms INSIDE an old teaching triple (reusing
 * pre-existing marker lines the diff would treat as unchanged context) would slip past an
 * added-lines-only scan; a full-file read catches it. Safe against false positives specifically
 * because the allowlist exempts legitimate marker-carrying content that a full scan would otherwise
 * flag.
 */
export async function conflictMarkerReasonForFiles(repo: string, ref: string, files: readonly string[]): Promise<string | undefined> {
	try {
		const byFile = new Map<string, RawHit[]>();
		for (const file of new Set(files)) {
			if (isAllowlistedPath(file)) continue;
			const content = await showFile(repo, ref, file);
			if (content === undefined) continue; // deleted / unreadable — nothing to scan
			if (content.includes(MARKER_EXEMPT_TOKEN)) continue;
			const rawHits: RawHit[] = [];
			for (const line of content.split("\n")) {
				const kind = classifyMarkerLine(line);
				if (kind) rawHits.push({ line, kind });
			}
			const kept = applyMidCoOccurrenceRule(rawHits);
			if (kept.length > 0) byFile.set(file, kept);
		}
		if (byFile.size === 0) return undefined;
		const hits: MarkerHit[] = [];
		for (const [file, rawHits] of byFile) for (const h of rawHits) hits.push({ file, line: h.line });
		return formatReason(`the resolver's output on ${ref}`, hits);
	} catch (err) {
		return probeFailureReason(errText(err));
	}
}

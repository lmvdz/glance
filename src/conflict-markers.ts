/**
 * Conflict-marker gate (#330, per #327's resolution; hardened in gauntlet round 1 and the
 * delta-verify round against #351). A cheap textual scan for LIVE git conflict-marker lines that
 * made it into a land — git's own structural conflict detection only fires on an ACTUAL unresolved
 * merge, never on marker debris a resolver (or a careless human) left BEHIND in content that git
 * considers perfectly mergeable. AUTORESOLVE's LLM resolver is exactly the failure mode this closes:
 * it writes files that pass typecheck+test — a `.md`/`.json`/`.txt` file with marker lines still
 * compiles/parses fine.
 *
 * THE THREAT MODEL (why there is no agent-settable exemption of any kind): the diff being scanned is
 * AUTHORED BY THE THING THE GATE GUARDS AGAINST — an agent (or its resolver) that left live markers
 * behind. Round 1 shipped a path allowlist and an in-file exempt token as escape hatches for
 * legitimate marker-carrying content. The delta-verify round (dual-lineage, both CRITICAL) found the
 * obvious consequence: an agent can single-handedly satisfy either one. A token is just a string in
 * the diff the agent controls — `conflict-markers.ts` even contained the token's own literal value,
 * so debris added to THIS file would have self-exempted. A path allowlist is just a location the
 * agent controls — write real debris under `tests/fixtures/` and it merges. Both are DELETED. The
 * only exemption left is `LandOpts.conflictMarkerGate: false` — the SAME force-land authority that
 * already overrides the stale-branch and land-risk gates, set only by a human's explicit Force action
 * (`squad-manager.ts`'s `conflictMarkerGate: !force`), never by anything the candidate diff can write.
 * Legitimate literal-marker content (a git tutorial doc, a fixture for this gate's own tests) lands
 * through that human path, exactly like any other deliberately-unusual land.
 *
 * Round-1 gauntlet (dual-lineage, codex + grok) found the first cut trusted a raw `git diff` too much
 * and covered only one of three land paths. Fixes, grouped by the same finding numbers as the
 * gauntlet report:
 *   (1/9) SCAN THE RIGHT THING. Every range-based scan takes an explicit `(fromRef, toRef)` pair
 *   representing what the land ACTUALLY introduces relative to the CURRENT target — never a
 *   merge-base diff over a branch's own (possibly stale) history, which over-scans content that
 *   independently converged onto the target by land time.
 *   (2) COVER ALL LAND PATHS. {@link conflictMarkerReasonStaged} covers the in-place early-return
 *   (`landAgentImpl`'s `worktree === repo` branch, which used to commit before any gate ran).
 *   {@link conflictMarkerReasonForRange} against PR mode's scratch merge closes the CRITICAL
 *   production-path bypass (PR mode ran no check at all).
 *   (3/4) HARDEN THE DIFF INVOCATION. `-c color.ui=false` neutralizes an inherited/malicious
 *   `color.ui=always` that would wrap every line in ANSI escapes so no line starts with a literal
 *   `+`/`diff --git`. `--text` forces a textual diff regardless of a `.gitattributes` `-diff`/binary
 *   attribute that would otherwise make git omit a path's content entirely.
 *   (5/6) ROBUST MARKER DETECTION. `conflict-marker-size` is `.gitattributes`-configurable (git's
 *   default is 7); the regexes match VARIABLE-width runs (`{7,}`). The diff3/zdiff3 base marker
 *   (`|||||||`) is detected unconditionally, same variable width.
 *   (8) The AUTORESOLVE site ({@link conflictMarkerReasonForFiles}) does a FULL-FILE scan of
 *   resolver-touched files, not an added-lines diff — a resolver that inserts unresolved arms INSIDE
 *   an old teaching triple (reusing pre-existing marker lines as context) would slip past an
 *   added-lines-only scan there.
 *
 * Delta-verify round (dual-lineage) on round 1's own output:
 *   (1, CRITICAL, both lineages) The path allowlist and `MARKER_EXEMPT_TOKEN` were both agent-settable
 *   exemptions — DELETED (see THE THREAT MODEL above). Every path fails closed now; force-land is the
 *   only way through.
 *   (2, codex) `attemptAutoResolve`'s file-gathering (`land.ts`) used non-NUL `git diff --name-only`,
 *   which quotes/escapes any path `core.quotePath` considers unusual (default: non-ASCII, e.g.
 *   `docs/é.md`) — the escaped string then entered `touchedFiles` in a form `git show` can never
 *   resolve, silently skipping that file's scan. Fixed with `-z` (NUL-separated raw bytes).
 *   (codex, LOW) {@link conflictMarkerReasonForFiles} used to treat an unreadable touched-file path
 *   (`git show` failing) as "nothing to scan" — fail-OPEN. It now refuses instead: an unreadable file
 *   can't be PROVEN clean, so it is never silently waved through.
 *
 * ESCAPE HATCH: there is exactly one, and it is not settable by the candidate diff — a human's
 * explicit force-land (`LandOpts.conflictMarkerGate: false`), OR the operator-level
 * `OMP_SQUAD_CONFLICT_MARKER_GATE=0` kill switch. Added-lines-only scanning at the range-based sites
 * still means a marker-looking line that already existed on the target before this land is never
 * flagged there — that is a scope limit (only NEW lines are judged), not an exemption anyone sets.
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

/**
 * A bare `=======` (`mid`) is genuinely ambiguous with a Markdown Setext H1 underline
 * (`Title\n=======`) — on its own it would false-positive on ordinary docs. Real conflict debris
 * (standard OR diff3/zdiff3) always has a `start`, `end`, or `base` line SOMEWHERE among the flagged
 * lines; a `mid` hit is only kept when at least one of those is ALSO present, which loses no real
 * detection power while eliminating the Markdown false positive. This is a DETECTION-accuracy rule,
 * not an exemption — it never makes a genuine marker triple pass.
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
		`(git's own structural conflict check doesn't catch marker debris a resolver or human left in otherwise-mergeable content; ` +
		`no path or in-file token can exempt this — force-land is the only way through). ` +
		`(OMP_SQUAD_CONFLICT_MARKER_GATE=0 disables this gate.)`
	);
}

/** Fetch a file's full content at `ref` (`git show ref:path`; pass `""` for the INDEX — `git show
 *  :path` reads stage 0). Returns undefined on any failure (deleted path, binary blob, unreadable
 *  object) — callers must treat that as "cannot verify", never as "nothing to scan". */
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

/** Apply the mid-co-occurrence detection rule to a per-file hit map and flatten to the final hit
 *  list. No allowlist, no exempt token (delta-verify round, finding #1) — every file that survives
 *  the co-occurrence rule is reported, full stop. */
function flattenHits(byFile: Map<string, RawHit[]>): MarkerHit[] {
	const out: MarkerHit[] = [];
	for (const [file, rawHits] of byFile) {
		const kept = applyMidCoOccurrenceRule(rawHits);
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
		const hits = flattenHits(byFile);
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
		const hits = flattenHits(byFile);
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
 * added-lines-only scan; a full-file read catches it.
 *
 * A touched file this can't READ (delta-verify round, codex LOW) refuses the land outright rather
 * than silently skipping it — an unreadable path can't be proven clean, and "couldn't check" must
 * never collapse to "assume it's fine" for content a resolver just wrote.
 */
export async function conflictMarkerReasonForFiles(repo: string, ref: string, files: readonly string[]): Promise<string | undefined> {
	try {
		const byFile = new Map<string, RawHit[]>();
		for (const file of new Set(files)) {
			const content = await showFile(repo, ref, file);
			if (content === undefined) return probeFailureReason(`could not read ${file} at ${ref} (git show failed) — cannot confirm it is free of conflict-marker debris`);
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

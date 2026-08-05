/**
 * Conflict-marker gate (#330, per #327's resolution): a cheap textual scan over a branch's changed
 * files for LIVE git conflict-marker lines (`<<<<<<< `, `=======`, `>>>>>>> `) that made it into a
 * land's diff. Git's own structural conflict detection (a nonzero `git merge` exit code) only fires
 * on an ACTUAL unresolved merge — it says nothing about marker debris a resolver (or a careless
 * human) left BEHIND in content that git considers perfectly mergeable. AUTORESOLVE's LLM resolver
 * (land.ts's `attemptAutoResolve`/`defaultResolver`) is exactly the failure mode this closes: it
 * writes files that pass typecheck+test — a `.md`/`.json`/`.txt` file with marker lines still
 * compiles/parses fine — while carrying an unresolved conflict a human would spot instantly. This is
 * the textual grep the squad skill has long documented under `--verify`; the code lagged the claim.
 *
 * ESCAPE HATCH (the documented one, per the ticket): this only scans the diff's ADDED lines between
 * the merge base and `branch` — never a file's full committed contents. A file that already carried a
 * marker-looking line BEFORE this land (an old fixture, prose in a doc explaining the pattern) is
 * untouched by history and never flagged; only a NEWLY introduced marker line fails the gate. Of the
 * two options the ticket allowed (added-lines-only vs. a small path allowlist), added-lines-only is
 * the tighter one and the one this module implements. A legitimate NEW fixture that needs to
 * demonstrate real marker text (a test teaching about this very check) should write that content at
 * TEST-RUN TIME — `fs.writeFile` inside a throwaway git repo, as `tests/conflict-markers.test.ts`
 * does — rather than commit it as literal source, which then never appears in any real land's diff.
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

function git(args: string[], cwd: string): Promise<{ code: number; stdout: string }> {
	const proc = Bun.spawn(["git", ...GIT_HARDEN_ARGS, ...args], { cwd, env: { ...process.env, ...GIT_HARDEN_ENV }, stdout: "pipe", stderr: "ignore" });
	return Promise.all([new Response(proc.stdout).text(), proc.exited]).then(([stdout, code]) => ({ code, stdout: stdout.trim() }));
}

/** A blocking reason wrapping a probe failure — never blames the branch, always names the gate as the
 *  source of the refusal and points at its one env hatch. Mirrors land-risk.ts's own helper. */
function probeFailureReason(detail: string): string {
	const { reason } = classifyProbeFailure({ kind: "spawn-error", detail });
	return `conflict-markers gate: could not scan for conflict markers (${reason}) — refusing to land rather than guessing it's clean. (OMP_SQUAD_CONFLICT_MARKER_GATE=0 disables this gate.)`;
}

/** Real git conflict-marker line shapes — the 7-marker-char run git itself writes, anchored to the
 *  START of the line so ordinary prose that merely MENTIONS `<<<<<<<` mid-sentence never matches. */
export const MARKER_START_RE = /^<<<<<<< /;
export const MARKER_MID_RE = /^=======$/;
export const MARKER_END_RE = /^>>>>>>> /;

interface MarkerHit {
	file: string;
	line: string;
	/** Which of the three shapes matched — the MID shape alone is ambiguous (see below), so it is
	 *  filtered post-hoc rather than reported unconditionally like start/end are. */
	kind: "start" | "mid" | "end";
}

const HIT_LIST_CAP = 8;
const HIT_LINE_TRUNCATE = 120;

/** Parse a `git diff --unified=0` patch and return every ADDED (`+`-prefixed) line that matches one
 *  of the three marker shapes, tagged by shape — the escape hatch lives entirely in this "added lines
 *  only" scope: a marker-looking line that already existed before this branch never appears here. */
function scanAddedLines(diffText: string): MarkerHit[] {
	const hits: MarkerHit[] = [];
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
		if (!rawLine.startsWith("+")) continue; // only newly ADDED lines — never pre-existing content
		const content = rawLine.slice(1);
		if (MARKER_START_RE.test(content)) hits.push({ file: currentFile, line: content, kind: "start" });
		else if (MARKER_END_RE.test(content)) hits.push({ file: currentFile, line: content, kind: "end" });
		else if (MARKER_MID_RE.test(content)) hits.push({ file: currentFile, line: content, kind: "mid" });
	}
	return hits;
}

/**
 * `start`/`end` lines (`<<<<<<< ref` / `>>>>>>> ref`) are distinctive enough that nothing legitimate
 * produces them — reported unconditionally. A bare `=======` (`mid`) is genuinely ambiguous: it is
 * also exactly a Markdown Setext H1 underline (`Title\n=======`), so on its own it would false-positive
 * on ordinary docs. Real conflict debris always has a `start` or `end` line SOMEWHERE in the same
 * file's added lines; a `mid` hit is only reported when the file also added one of those, which loses
 * no real detection power (a lone injected `=======` with no matching markers isn't conflict debris)
 * while eliminating the Markdown false positive.
 */
function findMarkerHits(diffText: string): MarkerHit[] {
	const all = scanAddedLines(diffText);
	const filesWithStartOrEnd = new Set(all.filter((h) => h.kind !== "mid").map((h) => h.file));
	return all.filter((h) => h.kind !== "mid" || filesWithStartOrEnd.has(h.file));
}

/**
 * Live conflict-marker line(s) that `branch` ADDS relative to `baseRef` (default `"HEAD"` — local
 * mode's main tip; the auto-resolve path passes its post-rebase `head0`, so this reads the
 * RESOLVER's own output, not the pre-conflict branch), or `undefined` when none are found.
 *
 * A probe failure (git couldn't compute the diff) also returns a reason: an uncomputable diff proves
 * nothing about the branch's content either way, so this fails closed exactly like a genuine finding
 * rather than waving an unscannable branch through as "no markers found". Unlike land-risk.ts's own
 * merge-base probe, this gate does not need to distinguish an orphan branch from a shallow clone —
 * both leave nothing to scan, and "fail closed, refuse" is the correct, and simpler, answer either way.
 */
export async function conflictMarkerReason(repo: string, branch: string, baseRef = "HEAD"): Promise<string | undefined> {
	try {
		const mb = await git(["merge-base", baseRef, branch], repo);
		if (mb.code !== 0 || !mb.stdout) return probeFailureReason(`merge-base(${baseRef}, ${branch}) exited ${mb.code} with no output`);
		const diff = await git(["diff", "--no-ext-diff", "--unified=0", `${mb.stdout}..${branch}`], repo);
		if (diff.code !== 0) return probeFailureReason(`diff ${mb.stdout}..${branch} exited ${diff.code}`);
		const hits = findMarkerHits(diff.stdout);
		if (hits.length === 0) return undefined;
		const shown = hits
			.slice(0, HIT_LIST_CAP)
			.map((h) => `${h.file}: ${h.line.length > HIT_LINE_TRUNCATE ? `${h.line.slice(0, HIT_LINE_TRUNCATE)}…` : h.line}`)
			.join("; ");
		const more = hits.length > HIT_LIST_CAP ? ` (+${hits.length - HIT_LIST_CAP} more)` : "";
		return (
			`conflict-markers gate: ${branch} adds live conflict-marker line(s): ${shown}${more} — refusing to land ` +
			`(git's own structural conflict check doesn't catch marker debris a resolver or human left in otherwise-mergeable content). ` +
			`(OMP_SQUAD_CONFLICT_MARKER_GATE=0 disables this gate.)`
		);
	} catch (err) {
		return probeFailureReason(errText(err));
	}
}

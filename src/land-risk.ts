/**
 * Land blast-radius gate (plans/policy-and-cost-gates/ concern C-LAND, research #3).
 *
 * A large or sensitive-path diff should not AUTO-land into main unattended — it is exactly the kind
 * of change a human should glance at before it merges. This computes the BRANCH'S OWN change set
 * (`<merge-base(HEAD,branch)>..<branch>`) — a different axis from `staleBranchReason` (which measures
 * OVERLAP with newer main work) and from the post-merge regression gate (which measures test
 * monotonicity). Off by default; bypassed by the human Land path via `LandOpts.riskOverride`, so the
 * button always works (the "ASK" = a human resolves).
 *
 * FAIL-CLOSED on a probe failure (eap-borrows/04-fail-closed-wave-1, finding #7): a git probe that
 * can't compute the diff proves NOTHING about blast radius either way — the OLD behavior returned
 * `undefined` (no block) on ANY error, so a corrupted git dir or a bogus branch name silently gave
 * every branch a clean bill of health. Now a probe failure blocks auto-land exactly like a genuine
 * risk finding (`riskOverride` still the human hatch; the gate is still off by default). It routes
 * through the SAME `landFailureCount`/observer-bug-filing path a real risk finding does, so a
 * persistently failing probe surfaces to a human instead of retrying forever unseen.
 */

import { envBool, envInt } from "./config.ts";
import { classifyProbeFailure } from "./classify-probe-failure.ts";
import { errText } from "./err-text.ts";
import { GIT_HARDEN_ARGS, GIT_HARDEN_ENV } from "./git-harden.ts";

/** OFF by default — an operator opts in during rollout, like OMP_SQUAD_REGRESSION_GATE. */
export function landRiskGateEnabled(): boolean {
	return envBool("OMP_SQUAD_LAND_RISK_GATE", false);
}

/** Auto-land is blocked once the branch changes at least this many files (env-tunable). */
function maxDiffFiles(): number {
	return envInt("OMP_SQUAD_LAND_MAX_DIFF_FILES", 40);
}

/** Sensitive PATHS whose unattended modification warrants a human glance — secrets, env, CI/CD,
 *  release/deploy config, dependency lockfiles, infra. Mirrors the spirit of squad-manager's RISKY_RE
 *  (which classifies destructive request TEXT) but matches changed FILE paths. */
const RISKY_PATH_RE =
	/(^|\/)\.env($|\.|\/)|(^|\/)\.github\/workflows\/|(^|\/)(Dockerfile|docker-compose)|(^|\/)(package-lock\.json|bun\.lock|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock)$|(^|\/)(secrets?|credentials?)(\/|\.)|(^|\/)\.?(deploy|release|infra|terraform|k8s|kubernetes|helm)(\/|\.)|(^|\/)id_(rsa|ed25519)($|\.)/i;

const LIST_CAP = 8;

function git(args: string[], cwd: string): Promise<{ code: number; stdout: string }> {
	const proc = Bun.spawn(["git", ...GIT_HARDEN_ARGS, ...args], { cwd, env: { ...process.env, ...GIT_HARDEN_ENV }, stdout: "pipe", stderr: "ignore" });
	return Promise.all([new Response(proc.stdout).text(), proc.exited]).then(([stdout, code]) => ({ code, stdout: stdout.trim() }));
}

/** A blocking reason wrapping a probe failure — never blames the branch, always names the gate as the
 *  source of the refusal and points at the human hatches (force-land, disabling the gate). */
function probeFailureReason(detail: string): string {
	const { reason } = classifyProbeFailure({ kind: "spawn-error", detail });
	return `land-risk gate: could not compute a blast radius (${reason}) — refusing to auto-land rather than guessing it's safe. (OMP_SQUAD_LAND_RISK_GATE=0 disables this gate; force-land bypasses it.)`;
}

/**
 * Cross-lineage review (grok-4.5) of the merge-base carve-out below: `git merge-base` signals BOTH
 * "genuinely unrelated histories" AND "truncated history on a shallow clone" via the SAME exit-1 +
 * empty-stdout pair — nothing distinguishes them from the caller's side. A shallow clone can never
 * trust the carve-out below, since the "missing" ancestor may simply not have been fetched; treat that
 * case as an ordinary probe failure (fail closed) instead of guessing which one it is.
 */
async function isShallowRepo(repo: string): Promise<boolean> {
	const r = await git(["rev-parse", "--is-shallow-repository"], repo);
	return r.code === 0 && r.stdout === "true";
}

/**
 * Cross-lineage review (grok-4.5) of the merge-base carve-out below: this gate exists to bound a
 * branch's BLAST RADIUS before an unattended merge, so "no common ancestor" is the opposite of safe —
 * with no merge base, `<merge-base>..<branch>` is uncomputable and the honest reading is MAXIMUM
 * uncertainty (the diff could be the entire branch). Unlike `land.ts`'s `staleBranchReason` (where no
 * common ancestor genuinely means no silent-clobber risk — the merge itself will surface the problem),
 * this gate runs BEFORE any merge is attempted specifically to catch a risky diff early, so it must
 * block rather than wave an unknowable branch through. Worded distinctly from `probeFailureReason` on
 * purpose: this is a branch/history property (an orphan or grafted branch), not a git spawn/tool
 * failure, so `retryable: false` at the call site is correct — retrying won't grow a shared history.
 */
function unknownBlastRadiusReason(branch: string, baseRef: string): string {
	return (
		`land-risk gate: ${branch} has no common ancestor with ${baseRef} — the blast radius is UNKNOWABLE ` +
		`(the diff is uncomputable), so this gate treats it as the maximum: the whole branch. Left for a ` +
		`human Land review — force-land to override. (OMP_SQUAD_LAND_RISK_GATE=0 disables this gate.)`
	);
}

/**
 * A human-readable reason this branch is too large / too sensitive to AUTO-land, or `undefined` when
 * it's genuinely safe. A probe failure (git couldn't compute the diff) ALSO returns a reason — see
 * the fail-closed note above; it is never conflated with "safe" again. `baseRef` defaults to `HEAD`
 * (local mode's main tip); PR mode can pass `origin/<default>`.
 */
export async function landRiskReason(repo: string, branch: string, baseRef = "HEAD"): Promise<string | undefined> {
	try {
		const mb = await git(["merge-base", baseRef, branch], repo);
		// Finding #5 (code-review fixlist, same shape as land.ts's staleBranchReason finding #4):
		// `git merge-base` signals "no common ancestor" via EXIT 1 + empty stdout — it never exits 0
		// with empty stdout. Folding that into `mb.code !== 0` treated a genuine orphan/grafted branch
		// exactly like a real probe failure, hardcoding a "spawn-error" refusal that told the operator
		// to disable the gate for a branch that was never unsafe to begin with. Only a bare exit 1 with
		// nothing on stdout is that carve-out; any other nonzero exit (deleted ref, corrupt repo, etc.)
		// still fails closed below.
		//
		// Cross-lineage review (grok-4.5, eap-borrows) on the line this replaced (`return undefined`):
		// for THIS gate specifically, "not a probe failure" does not mean "safe" — see
		// `unknownBlastRadiusReason`'s doc above. A shallow clone gets the SAME exit-1/empty-stdout
		// signal for a merely-unfetched ancestor, so it is routed through the ordinary probe-failure
		// path instead (can't discriminate ⇒ fail closed, not "maximum blast radius" wording, since the
		// ambiguity here is a git-plumbing limitation, not a property of the branch's own history).
		if (mb.code === 1 && !mb.stdout) {
			if (await isShallowRepo(repo)) return probeFailureReason(`merge-base(${baseRef}, ${branch}) reported no common ancestor in a SHALLOW clone — cannot distinguish an unrelated history from an unfetched one`);
			return unknownBlastRadiusReason(branch, baseRef);
		}
		if (mb.code !== 0 || !mb.stdout) return probeFailureReason(`merge-base(${baseRef}, ${branch}) exited ${mb.code} with no output`);
		const diff = await git(["diff", "--no-ext-diff", "--name-only", `${mb.stdout}..${branch}`], repo);
		if (diff.code !== 0) return probeFailureReason(`diff ${mb.stdout}..${branch} exited ${diff.code}`);
		const files = diff.stdout.split("\n").filter(Boolean);
		if (files.length === 0) return undefined;

		const risky = files.filter((f) => RISKY_PATH_RE.test(f));
		if (risky.length > 0) {
			const shown = risky.slice(0, LIST_CAP).join(", ");
			const more = risky.length > LIST_CAP ? ` (+${risky.length - LIST_CAP} more)` : "";
			return `land-risk gate: ${branch} modifies sensitive path(s): ${shown}${more}. Left for a human Land review — force-land to override. (OMP_SQUAD_LAND_RISK_GATE=0 disables this gate.)`;
		}
		const cap = maxDiffFiles();
		if (files.length >= cap) {
			return `land-risk gate: ${branch} changes ${files.length} files (≥ ${cap}) — a large unattended merge. Left for a human Land review — force-land to override. (OMP_SQUAD_LAND_MAX_DIFF_FILES raises the cap; OMP_SQUAD_LAND_RISK_GATE=0 disables this gate.)`;
		}
		return undefined;
	} catch (err) {
		return probeFailureReason(errText(err));
	}
}

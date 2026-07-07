/**
 * Land blast-radius gate (plans/policy-and-cost-gates/ concern C-LAND, research #3).
 *
 * A large or sensitive-path diff should not AUTO-land into main unattended — it is exactly the kind
 * of change a human should glance at before it merges. This computes the BRANCH'S OWN change set
 * (`<merge-base(HEAD,branch)>..<branch>`) — a different axis from `staleBranchReason` (which measures
 * OVERLAP with newer main work) and from the post-merge regression gate (which measures test
 * monotonicity). Off by default; fail-open (any probe failure ⇒ no block); bypassed by the human Land
 * path via `LandOpts.riskOverride`, so the button always works (the "ASK" = a human resolves).
 */

import { envInt } from "./config.ts";
import { GIT_HARDEN_ARGS, GIT_HARDEN_ENV } from "./git-harden.ts";

/** OFF by default — an operator opts in during rollout, like OMP_SQUAD_REGRESSION_GATE. */
export function landRiskGateEnabled(): boolean {
	return process.env.OMP_SQUAD_LAND_RISK_GATE === "1";
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

/**
 * A human-readable reason this branch is too large / too sensitive to AUTO-land, or `undefined` when
 * it's safe (or the gate can't compute a verdict — never blocks on its own probe failures). `baseRef`
 * defaults to `HEAD` (local mode's main tip); PR mode can pass `origin/<default>`.
 */
export async function landRiskReason(repo: string, branch: string, baseRef = "HEAD"): Promise<string | undefined> {
	try {
		const mb = await git(["merge-base", baseRef, branch], repo);
		if (mb.code !== 0 || !mb.stdout) return undefined;
		const diff = await git(["diff", "--no-ext-diff", "--name-only", `${mb.stdout}..${branch}`], repo);
		if (diff.code !== 0) return undefined;
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
	} catch {
		return undefined;
	}
}

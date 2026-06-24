/**
 * Git supply-chain hardening, spread onto every daemon `git` call (read and write).
 *
 * A repo's own config can hijack plain git to run arbitrary code
 * (core.fsmonitor, diff.external, hooks, a pager). When we touch an untrusted
 * clone, these args/env neutralize those vectors and never prompt or page.
 * They also force commit/tag signing OFF: a global commit.gpgsign=true would
 * otherwise block the daemon's own commits (e.g. worktree WIP preservation) on
 * an interactive GPG pinentry with no TTY. `-c` beats any config file, and a
 * gpgsign override is a harmless no-op on read-only commands.
 * Ported from recall's _GIT_HARDENING / _GIT_ENV.
 */

export const GIT_HARDEN_ARGS: string[] = [
	"-c",
	"core.fsmonitor=",
	"-c",
	"diff.external=",
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.pager=cat",
	"-c",
	"commit.gpgsign=false",
	"-c",
	"tag.gpgsign=false",
];

export const GIT_HARDEN_ENV: Record<string, string> = {
	GIT_TERMINAL_PROMPT: "0",
	GIT_PAGER: "cat",
	PAGER: "cat",
};

export interface HardenedGitResult {
	code: number;
	stdout: string;
	stderr: string;
}

// ponytail: single hardened-git boundary — every read-only git call routes through
// here so the neutralizing `-c` flags + env can never be forgotten at a call site.
// stdout is returned VERBATIM (porcelain whitespace-significant, diffs newline-significant);
// callers trim only where safe.
export async function hardenedGit(args: string[], opts?: { cwd?: string }): Promise<HardenedGitResult> {
	const proc = Bun.spawn(["git", ...GIT_HARDEN_ARGS, ...args], {
		cwd: opts?.cwd,
		env: { ...process.env, ...GIT_HARDEN_ENV },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}

export function hardenedGitSync(args: string[], opts?: { cwd?: string }): HardenedGitResult {
	const r = Bun.spawnSync(["git", ...GIT_HARDEN_ARGS, ...args], {
		cwd: opts?.cwd,
		env: { ...process.env, ...GIT_HARDEN_ENV },
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

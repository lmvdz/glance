/**
 * Thin `gh` CLI wrapper — mirrors land.ts's `git()` helper, but for GitHub's own CLI, which has a
 * distinct binary/auth/config surface from git itself. No GIT_HARDEN_ARGS/env here: those neutralize
 * git's OWN untrusted-repo-config attack surface (fsmonitor/diff.external/hooks/pager), which doesn't
 * apply to a separate binary with its own auth store.
 */

export interface GhRun {
	code: number;
	stdout: string;
	stderr: string;
}

async function ghRaw(args: string[], cwd: string): Promise<GhRun> {
	const proc = Bun.spawn(["gh", ...args], { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function gh(args: string[], cwd: string): Promise<GhRun> {
	return ghRaw(args, cwd);
}

/** Parse `gh`'s `--json` output; undefined on a non-zero exit or unparsable body — never throws. */
export async function ghJson<T>(args: string[], cwd: string): Promise<T | undefined> {
	const r = await ghRaw(args, cwd);
	if (r.code !== 0) return undefined;
	try {
		return JSON.parse(r.stdout) as T;
	} catch {
		return undefined;
	}
}

/** Feature-detect: is `gh` installed and authenticated in a way that can run at all. */
export async function ghAvailable(cwd = process.cwd()): Promise<boolean> {
	const r = await ghRaw(["auth", "status"], cwd);
	return r.code === 0;
}

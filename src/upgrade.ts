/**
 * Self-upgrade — the one-click "Upgrade" the dashboard exposes. Three steps:
 *
 *   gitState(repo)   — is the daemon's checkout behind its remote? (read-only)
 *   pullLatest(repo) — fetch + fast-forward to the upstream, never forcing
 *   reexecDaemon()   — spawn a fresh detached daemon so the new backend loads
 *
 * Because squad agents are detached, re-execing the daemon is safe — no agent
 * is lost — so this never drains or stops agents.
 */

interface GitRun {
	code: number;
	stdout: string;
	stderr: string;
}

// Raw run: stdout/stderr are returned VERBATIM so SHAs / branch names survive
// untouched. Call sites trim only where trimming is safe (single-token output).
async function git(args: string[], cwd: string): Promise<GitRun> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}

export interface GitState {
	branch: string;
	ahead: number;
	behind: number;
	dirty: boolean;
	upstream?: string;
	head: string;
}

/**
 * Best-effort snapshot of `repo` vs its upstream. NEVER throws and NEVER
 * fetches — it reports what the local checkout already knows, so call
 * `pullLatest` (or a plain fetch) first if you need fresh ahead/behind counts.
 * A non-git directory (or a repo with no commits) degrades to a zeroed object.
 */
export async function gitState(repo: string): Promise<GitState> {
	const state: GitState = { branch: "", ahead: 0, behind: 0, dirty: false, head: "" };
	try {
		const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], repo);
		if (branch.code !== 0) return state;
		state.branch = branch.stdout.trim();

		const head = await git(["rev-parse", "--short", "HEAD"], repo);
		if (head.code === 0) state.head = head.stdout.trim();

		const status = await git(["status", "--porcelain"], repo);
		state.dirty = status.code === 0 && status.stdout.trim().length > 0;

		const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], repo);
		if (upstream.code === 0) {
			state.upstream = upstream.stdout.trim();
			// behind = commits on upstream not on HEAD (left), ahead = the reverse (right).
			const counts = await git(["rev-list", "--left-right", "--count", "@{u}...HEAD"], repo);
			if (counts.code === 0) {
				const [left, right] = counts.stdout.trim().split(/\s+/);
				const behind = Number(left);
				const ahead = Number(right);
				if (Number.isFinite(behind)) state.behind = behind;
				if (Number.isFinite(ahead)) state.ahead = ahead;
			}
		}
	} catch {
		// Degrade silently — gitState is a status probe, never a hard dependency.
	}
	return state;
}

export interface PullResult {
	ok: boolean;
	updated: boolean;
	from?: string;
	to?: string;
	detail: string;
}

/**
 * Fetch, then fast-forward `repo` to its upstream — but ONLY when the working
 * tree is clean, an upstream exists, and we are actually behind. NEVER forces
 * and NEVER touches a dirty tree, so a half-finished local edit is always safe.
 */
export async function pullLatest(repo: string): Promise<PullResult> {
	const inside = await git(["rev-parse", "--is-inside-work-tree"], repo);
	if (inside.code !== 0) return { ok: false, updated: false, detail: "not a git repository" };

	const fetch = await git(["fetch"], repo);
	if (fetch.code !== 0) {
		return { ok: false, updated: false, detail: `git fetch failed: ${(fetch.stderr || fetch.stdout).trim()}` };
	}

	// fetch never touches the working tree, but a merge would — refuse on dirty.
	const status = await git(["status", "--porcelain"], repo);
	if (status.code === 0 && status.stdout.trim().length > 0) {
		return { ok: false, updated: false, detail: "working tree is dirty — refusing to pull" };
	}

	const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], repo);
	if (upstream.code !== 0) return { ok: false, updated: false, detail: "no upstream configured" };

	const counts = await git(["rev-list", "--left-right", "--count", "@{u}...HEAD"], repo);
	const behind = counts.code === 0 ? Number(counts.stdout.trim().split(/\s+/)[0]) || 0 : 0;
	if (behind <= 0) return { ok: true, updated: false, detail: "already up to date" };

	const from = (await git(["rev-parse", "--short", "HEAD"], repo)).stdout.trim();
	const merge = await git(["merge", "--ff-only", "@{u}"], repo);
	if (merge.code !== 0) {
		return { ok: false, updated: false, from, detail: `fast-forward merge failed: ${(merge.stderr || merge.stdout).trim()}` };
	}
	const to = (await git(["rev-parse", "--short", "HEAD"], repo)).stdout.trim();
	return { ok: true, updated: true, from, to, detail: `updated ${from} → ${to}` };
}

export interface ReexecResult {
	ok: boolean;
	pid?: number;
	detail: string;
}

/**
 * Spawn a fresh, fully detached daemon (its own session, no inherited stdio)
 * and unref it so this process owes it nothing. Returns the new pid.
 *
 * IMPORTANT: this does NOT stop the current daemon. The CALLER must release the
 * listening port (close the HTTP server) and then exit AFTER a successful
 * reexec — otherwise the new daemon cannot bind the port. We deliberately never
 * call process.exit here, leaving shutdown ordering to the caller.
 */
export function reexecDaemon(opts: { cmd: string[]; cwd: string; env?: Record<string, string> }): ReexecResult {
	try {
		const proc = Bun.spawn({
			cmd: opts.cmd,
			cwd: opts.cwd,
			env: { ...process.env, ...opts.env },
			stdio: ["ignore", "ignore", "ignore"],
			detached: true,
		});
		proc.unref();
		return { ok: true, pid: proc.pid, detail: `spawned detached daemon pid ${proc.pid}` };
	} catch (err) {
		return { ok: false, detail: `reexec failed: ${err instanceof Error ? err.message : String(err)}` };
	}
}

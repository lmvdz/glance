/**
 * Cross-host repo identity.
 *
 * Two operators on different machines check out the *same* project at different
 * absolute paths, so a host-local path can't identify a repo across the tailnet.
 * We key federation (leases, collisions) on the normalized git origin URL
 * instead: `git@github.com:acme/app.git`, `https://github.com/acme/app`, and
 * `ssh://git@github.com/acme/app.git` all collapse to `github.com/acme/app`.
 *
 * Repos with no `origin` (e.g. a local-only checkout) fall back to `name:<dir>`
 * — best-effort, advisory only.
 */

import * as path from "node:path";

/** Collapse any git remote URL form to `host/owner/repo` (lowercased, no scheme/credentials/.git). */
export function normalizeGitUrl(url: string): string {
	let u = url.trim().replace(/\/+$/, "");
	if (u.endsWith(".git")) u = u.slice(0, -4);
	// scp-like syntax: [user@]host:owner/repo
	const scp = u.match(/^[\w.+-]+@([\w.-]+):(.+)$/);
	if (scp) return `${scp[1].toLowerCase()}/${scp[2].replace(/^\/+/, "").replace(/(?:\.git)?\/*$/, "").toLowerCase()}`;
	// url syntax: scheme://[user[:pass]@]host[:port]/path
	const m = u.match(/^[a-zA-Z][\w+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/);
	if (m) return `${m[1].toLowerCase()}/${m[2].replace(/(?:\.git)?\/*$/, "").toLowerCase()}`;
	return u.replace(/\/+$/, "").toLowerCase();
}

/** Stable cross-host identity for a repo path: its normalized origin, or `name:<basename>` when there is no origin. */
export function repoIdentity(repoPath: string): string {
	try {
		// `config --get` returns the raw configured URL (no insteadOf rewrite), so two hosts that cloned the same origin agree on identity.
		const r = Bun.spawnSync(["git", "-C", repoPath, "config", "--get", "remote.origin.url"], { stdout: "pipe", stderr: "ignore" });
		if (r.exitCode === 0) {
			const out = r.stdout.toString().trim();
			if (out.length > 0) return normalizeGitUrl(out);
		}
	} catch {
		/* not a git repo / git missing — fall through to the path-based identity */
	}
	return `name:${path.basename(path.resolve(repoPath))}`;
}

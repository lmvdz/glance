/**
 * Cross-host repo identity — normalizeGitUrl + repoIdentity.
 *
 * The federation collision/lease keying (federation.ts, leases.ts) groups by
 * these identities, so this is the contract that makes two hosts working one
 * GitHub repo at different paths agree they're on the same repo.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeGitUrl, repoIdentity } from "../src/repo-identity.ts";

const tmpDirs: string[] = [];

afterEach(async () => {
	for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
	tmpDirs.length = 0;
});

async function gitRepoWithOrigin(origin: string): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "rid-"));
	tmpDirs.push(repo);
	const run = async (args: string[]): Promise<void> => {
		await Bun.spawn(["git", "-C", repo, ...args], { stdout: "ignore", stderr: "ignore" }).exited;
	};
	await run(["init", "-q"]);
	await run(["remote", "add", "origin", origin]);
	return repo;
}

// ── normalizeGitUrl ───────────────────────────────────────────────────────────

test("normalizeGitUrl collapses scp/https/ssh forms of one origin to a single identity", () => {
	expect(normalizeGitUrl("git@github.com:acme/app.git")).toBe("github.com/acme/app");
	expect(normalizeGitUrl("https://github.com/acme/app")).toBe("github.com/acme/app");
	expect(normalizeGitUrl("ssh://git@github.com/acme/app.git")).toBe("github.com/acme/app");
});

test("normalizeGitUrl is case-insensitive and strips credentials, ports and trailing slashes", () => {
	expect(normalizeGitUrl("https://github.com/Acme/App.git")).toBe("github.com/acme/app");
	expect(normalizeGitUrl("https://user:tok@gitlab.com:443/acme/app.git/")).toBe("gitlab.com/acme/app");
});

test("normalizeGitUrl keeps distinct repos distinct", () => {
	expect(normalizeGitUrl("git@github.com:acme/app.git")).not.toBe(normalizeGitUrl("git@github.com:acme/other.git"));
	expect(normalizeGitUrl("git@github.com:acme/app.git")).not.toBe(normalizeGitUrl("git@gitlab.com:acme/app.git"));
});

// ── repoIdentity ──────────────────────────────────────────────────────────────

test("repoIdentity collapses two checkouts of the same origin at different paths to one id", async () => {
	const origin = "git@github.com:acme/shared.git";
	const a = await gitRepoWithOrigin(origin);
	const b = await gitRepoWithOrigin(origin); // a *different* absolute path, same origin
	expect(a).not.toBe(b);
	expect(repoIdentity(a)).toBe("github.com/acme/shared");
	expect(repoIdentity(a)).toBe(repoIdentity(b)); // cross-host identity is path-independent
});

test("repoIdentity separates two repos with different origins", async () => {
	const a = await gitRepoWithOrigin("git@github.com:acme/one.git");
	const b = await gitRepoWithOrigin("git@github.com:acme/two.git");
	expect(repoIdentity(a)).not.toBe(repoIdentity(b));
});

test("repoIdentity falls back to name:<basename> for an origin-less / non-git path", () => {
	const p = path.join(os.tmpdir(), "rid-noorigin-fixed-basename");
	expect(repoIdentity(p)).toBe(`name:${path.basename(p)}`);
});

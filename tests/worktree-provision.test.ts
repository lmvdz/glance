/**
 * Spawn-time dependency provisioning (factory-spawn-provisioning incident): every dispatched
 * unit's worktree used to be a bare `git worktree add` with NO node_modules — the verify-loop
 * gate (`bun run check && bun run test`) could never pass, tripping escalate's visit cap on every
 * single dispatch. `installNodeModules` is the shared bounded-install primitive (also reused by
 * land-pr.ts's `installScratchDeps`); `provisionWorktreeDeps` layers on top of it: root install +
 * a nested `webapp/`-style package (this repo's own split root/webapp bun.lock layout), non-fatal
 * on failure (logs, never throws) so a flaky install can never block a spawn.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { installNodeModules, provisionWorktreeDeps } from "../src/worktree.ts";

async function tmp(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "glance-wt-provision-"));
}

describe("installNodeModules", () => {
	test("skips a non-bun dir (no package.json) without error", async () => {
		const dir = await tmp();
		try {
			expect(await installNodeModules(dir)).toBeNull();
			expect(existsSync(path.join(dir, "node_modules"))).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("provisions node_modules for a real bun package", async () => {
		const dir = await tmp();
		try {
			await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "wt-fixture", version: "0.0.0", dependencies: { typescript: "6.0.3" } }));
			const err = await installNodeModules(dir);
			expect(err).toBeNull();
			expect(existsSync(path.join(dir, "node_modules", ".bin", "tsc"))).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("a real install failure returns a truncated error string instead of throwing", async () => {
		const dir = await tmp();
		try {
			// A dependency that can never resolve — bun install exits non-zero.
			await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "wt-fixture-bad", version: "0.0.0", dependencies: { "glance-does-not-exist-xyz": "999.999.999" } }));
			const err = await installNodeModules(dir);
			expect(err).not.toBeNull();
			expect(err).toContain(dir); // identifies which dir failed
			expect(err!.length).toBeLessThan(500); // bounded, not the raw unbounded bun install output
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);
});

describe("provisionWorktreeDeps", () => {
	test("never throws even when both root and webapp installs fail", async () => {
		const dir = await tmp();
		try {
			await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "root", dependencies: { "glance-does-not-exist-xyz": "999.999.999" } }));
			await mkdir(path.join(dir, "webapp"));
			await writeFile(path.join(dir, "webapp", "package.json"), JSON.stringify({ name: "webapp", dependencies: { "glance-webapp-does-not-exist-xyz": "999.999.999" } }));
			const logs: string[] = [];
			await provisionWorktreeDeps(dir, (m) => logs.push(m));
			expect(logs.length).toBe(2); // both failures logged loudly
			expect(logs.some((l) => l.includes(dir))).toBe(true);
			expect(logs.some((l) => l.includes(path.join(dir, "webapp")))).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("installs a nested webapp/ package that a root-only install would never reach", async () => {
		const dir = await tmp();
		try {
			await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "root", version: "0.0.0" })); // no deps — no-op root install
			await mkdir(path.join(dir, "webapp"));
			await writeFile(path.join(dir, "webapp", "package.json"), JSON.stringify({ name: "webapp", version: "0.0.0", dependencies: { typescript: "6.0.3" } }));
			await provisionWorktreeDeps(dir);
			expect(existsSync(path.join(dir, "webapp", "node_modules", ".bin", "tsc"))).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("no-ops silently for a dir with no package.json at all (non-bun repo)", async () => {
		const dir = await tmp();
		try {
			const logs: string[] = [];
			await provisionWorktreeDeps(dir, (m) => logs.push(m));
			expect(logs.length).toBe(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("warm fast-path: a tree that already has node_modules is skipped, not re-installed (HIGH 1a)", async () => {
		const dir = await tmp();
		try {
			// An UNRESOLVABLE dependency: if the warm skip failed to fire, bun install would run, fail,
			// and log — so zero logs proves the install was never attempted, not that it succeeded.
			await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "warm", dependencies: { "glance-does-not-exist-xyz": "999.999.999" } }));
			await mkdir(path.join(dir, "node_modules")); // pre-provisioned (addWorktree symlink / prior pass / agent's own install)
			await mkdir(path.join(dir, "webapp"));
			await writeFile(path.join(dir, "webapp", "package.json"), JSON.stringify({ name: "warm-webapp", dependencies: { "glance-webapp-does-not-exist-xyz": "999.999.999" } }));
			await mkdir(path.join(dir, "webapp", "node_modules"));
			const logs: string[] = [];
			await provisionWorktreeDeps(dir, (m) => logs.push(m));
			expect(logs.length).toBe(0); // both installs skipped warm — neither unresolvable dep was ever fetched
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);
});

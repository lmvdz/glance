/**
 * Guards scratch-merge dep provisioning: `mkScratchWorktree` is a bare `git worktree add`
 * with no node_modules, so a bun repo's acceptance/regression gate that shells out to a
 * project-local binary (tsc, `bun run <script>`) died with `command not found` (exit 127)
 * and blocked a landable branch. installScratchDeps must populate node_modules for a bun
 * repo and no-op for a non-bun one.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { installScratchDeps } from "../src/land-pr.ts";

async function tmp(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "glance-scratch-deps-"));
}

describe("installScratchDeps", () => {
	test("skips a non-bun repo (no package.json) without error", async () => {
		const dir = await tmp();
		try {
			expect(await installScratchDeps(dir)).toBeNull();
			expect(existsSync(path.join(dir, "node_modules"))).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("provisions node_modules so a project-local bin resolves in the scratch tree", async () => {
		const dir = await tmp();
		try {
			// A bun package that pins a real (cache-warm) dependency exposing a bin. `typescript`
			// ships `tsc` — exactly the binary the failing acceptance gate could not find.
			await writeFile(
				path.join(dir, "package.json"),
				JSON.stringify({ name: "scratch-fixture", version: "0.0.0", dependencies: { typescript: "6.0.3" } }),
			);
			const err = await installScratchDeps(dir);
			expect(err).toBeNull();
			// The bin the gate needs now exists in the scratch tree.
			expect(existsSync(path.join(dir, "node_modules", ".bin", "tsc"))).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);
});

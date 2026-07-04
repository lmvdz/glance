/**
 * State-dir resolution (src/state-dir.ts) — the ~/.omp/squad → ~/.glance migration contract:
 * env override always wins; an existing ~/.glance wins over legacy; a legacy-only install
 * KEEPS using ~/.omp/squad (state is never orphaned); a fresh machine gets ~/.glance; and
 * the fs-probed default is memoized per process so a mid-run mkdir can't flip the answer.
 * All fs cases run against throwaway temp "homes" — the real home dir is never touched.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { protectedStateRoots, resolveStateDir, resolveStateDirFrom, stateDirCandidates } from "../src/state-dir.ts";

function tempHome(setup?: (home: string) => void): string {
	const home = mkdtempSync(path.join(tmpdir(), "glance-home-"));
	setup?.(home);
	return home;
}

describe("resolveStateDirFrom (pure core)", () => {
	test("GLANCE_STATE_DIR wins over everything, including an existing legacy dir", () => {
		const home = tempHome((h) => mkdirSync(path.join(h, ".omp", "squad"), { recursive: true }));
		try {
			expect(resolveStateDirFrom({ GLANCE_STATE_DIR: "/custom/state", OMP_SQUAD_STATE_DIR: "/other" }, home)).toBe("/custom/state");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("legacy OMP_SQUAD_STATE_DIR env is honored when GLANCE_STATE_DIR is unset", () => {
		expect(resolveStateDirFrom({ OMP_SQUAD_STATE_DIR: "/legacy/env" }, tempHome())).toBe("/legacy/env");
	});

	test("an empty env value counts as unset", () => {
		const home = tempHome();
		try {
			expect(resolveStateDirFrom({ GLANCE_STATE_DIR: "", OMP_SQUAD_STATE_DIR: "" }, home)).toBe(path.join(home, ".glance"));
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("existing ~/.glance wins over an existing legacy ~/.omp/squad", () => {
		const home = tempHome((h) => {
			mkdirSync(path.join(h, ".glance"), { recursive: true });
			mkdirSync(path.join(h, ".omp", "squad"), { recursive: true });
		});
		try {
			expect(resolveStateDirFrom({}, home)).toBe(path.join(home, ".glance"));
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("legacy-only install keeps ~/.omp/squad — state is never orphaned", () => {
		const home = tempHome((h) => mkdirSync(path.join(h, ".omp", "squad"), { recursive: true }));
		try {
			expect(resolveStateDirFrom({}, home)).toBe(path.join(home, ".omp", "squad"));
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a bare ~/.omp WITHOUT squad/ does not count as a legacy install", () => {
		const home = tempHome((h) => mkdirSync(path.join(h, ".omp", "agent"), { recursive: true }));
		try {
			expect(resolveStateDirFrom({}, home)).toBe(path.join(home, ".glance"));
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("fresh machine (neither dir) defaults to ~/.glance", () => {
		const home = tempHome();
		try {
			expect(resolveStateDirFrom({}, home)).toBe(path.join(home, ".glance"));
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("resolveStateDir (process env)", () => {
	// tests/setup.ts pins OMP_SQUAD_STATE_DIR to a temp dir for the whole suite, so the env
	// branch (which is read fresh on every call — no memoization) is what these exercise.
	test("honors the suite's OMP_SQUAD_STATE_DIR override", () => {
		expect(resolveStateDir()).toBe(process.env.OMP_SQUAD_STATE_DIR!);
	});

	test("GLANCE_STATE_DIR wins over OMP_SQUAD_STATE_DIR, per call", () => {
		const prev = process.env.GLANCE_STATE_DIR;
		process.env.GLANCE_STATE_DIR = "/canonical/state";
		try {
			expect(resolveStateDir()).toBe("/canonical/state");
		} finally {
			if (prev === undefined) delete process.env.GLANCE_STATE_DIR;
			else process.env.GLANCE_STATE_DIR = prev;
		}
		expect(resolveStateDir()).toBe(process.env.OMP_SQUAD_STATE_DIR!);
	});
});

describe("memoization (subprocess with a scratch HOME)", () => {
	// The fs-probed default must be resolved ONCE per process: a mid-run `mkdir ~/.glance`
	// on a legacy install must not flip presence/leases/proof to a second directory. Run in
	// a subprocess so we control HOME and start with a cold cache.
	test("a mid-run mkdir of ~/.glance cannot flip a legacy resolution", async () => {
		const home = tempHome((h) => mkdirSync(path.join(h, ".omp", "squad"), { recursive: true }));
		const script = [
			'import { mkdirSync } from "node:fs";',
			'import * as path from "node:path";',
			'import * as os from "node:os";',
			'import { resolveStateDir } from "./src/state-dir.ts";',
			"const first = resolveStateDir();",
			'mkdirSync(path.join(os.homedir(), ".glance"), { recursive: true });',
			"const second = resolveStateDir();",
			"console.log(JSON.stringify({ first, second }));",
		].join("\n");
		try {
			const env = { ...process.env, HOME: home } as Record<string, string>;
			delete env.GLANCE_STATE_DIR;
			delete env.OMP_SQUAD_STATE_DIR;
			const proc = Bun.spawn(["bun", "-e", script], { cwd: path.resolve(import.meta.dir, ".."), env, stdout: "pipe", stderr: "pipe" });
			const out = await new Response(proc.stdout).text();
			expect(await proc.exited).toBe(0);
			const { first, second } = JSON.parse(out.trim()) as { first: string; second: string };
			expect(first).toBe(path.join(home, ".omp", "squad"));
			expect(second).toBe(first);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	}, 20_000);
});

describe("protectedStateRoots", () => {
	test("covers the resolved dir plus BOTH default locations (mixed-version fencing)", () => {
		const home = tempHome();
		try {
			const roots = protectedStateRoots(home);
			const { glance, legacy } = stateDirCandidates(home);
			expect(roots).toContain(resolveStateDir()); // env override (suite temp dir)
			expect(roots).toContain(glance);
			expect(roots).toContain(legacy);
			expect(new Set(roots).size).toBe(roots.length); // deduped
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

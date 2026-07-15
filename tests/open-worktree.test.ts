/**
 * open-worktree — the fleet→ground gesture (fleet-ide-bridge B02).
 * Load-bearing properties: unit matching never guesses between units; the spawn
 * is argv-array (shell metacharacters stay literal tokens); opener resolution
 * order is template → terax → code → copy-path; a /mnt/ (Windows-interop)
 * opener gets a translated ARGUMENT, not a translated binary.
 */
import { describe, expect, test } from "bun:test";
import { matchUnit, openRouteDecision, openWorktree } from "../src/open-worktree.ts";

const roster = [
	{ id: "abc123", name: "web-ui", worktree: "/wt/web-ui", branch: "feat/web-ui" },
	{ id: "abd999", name: "api", worktree: "/wt/api", branch: "feat/api" },
];

describe("matchUnit", () => {
	test("precedence: id, then name, then branch, then unique id prefix", () => {
		expect(matchUnit(roster, "abc123")?.name).toBe("web-ui");
		expect(matchUnit(roster, "api")?.id).toBe("abd999");
		expect(matchUnit(roster, "feat/web-ui")?.id).toBe("abc123");
		expect(matchUnit(roster, "abc")?.id).toBe("abc123");
	});

	test("ambiguous prefix is a miss, never a guess", () => {
		expect(matchUnit(roster, "ab")).toBeNull();
		expect(matchUnit(roster, "nope")).toBeNull();
	});

	test("duplicate names/branches refuse instead of first-wins (grok review finding)", () => {
		const dupes = [...roster, { id: "zzz111", name: "web-ui", worktree: "/wt/other", branch: "feat/api" }];
		expect(matchUnit(dupes, "web-ui")).toBeNull();
		expect(matchUnit(dupes, "feat/api")).toBeNull();
		expect(matchUnit(dupes, "abc123")?.worktree).toBe("/wt/web-ui"); // exact id still wins
	});
});

describe("openRouteDecision", () => {
	test("guard order: 404 unknown; 403 in db mode WITHOUT invoking the opener, path still in body", () => {
		let spawnCalls = 0;
		const openFn = () => {
			spawnCalls++;
			return { path: "/wt/x", spawned: true, argv: ["ed", "/wt/x"] };
		};
		expect(openRouteDecision(undefined, false, openFn).status).toBe(404);
		const denied = openRouteDecision({ worktree: "/wt/x" }, true, openFn);
		expect(denied.status).toBe(403);
		expect(denied.body.path).toBe("/wt/x");
		expect(spawnCalls).toBe(0);
		const ok = openRouteDecision({ worktree: "/wt/x" }, false, openFn);
		expect(ok.status).toBe(200);
		expect(ok.body).toMatchObject({ spawned: true, opener: "ed" });
		expect(spawnCalls).toBe(1);
	});
});

function deps(overrides: Partial<Parameters<typeof openWorktree>[1] & object> = {}) {
	const spawned: string[][] = [];
	const envs: Record<string, string>[] = [];
	return {
		spawned,
		envs,
		deps: {
			env: {} as Record<string, string | undefined>,
			which: (_bin: string) => null as string | null,
			toWindowsPath: (p: string) => `WIN(${p})`,
			isDir: (_p: string) => true,
			spawnFn: (argv: string[], env: Record<string, string>) => {
				spawned.push(argv);
				envs.push(env);
				return true;
			},
			...overrides,
		},
	};
}

describe("openWorktree", () => {
	test("template: whitespace-split argv, {path} substituted, shell metachars stay literal", () => {
		const { spawned, deps: d } = deps({ env: { OMP_SQUAD_OPEN_CMD: "myed --reuse $(evil) {path}" }, which: () => "/usr/local/bin/myed" });
		const out = openWorktree("/wt/web-ui", d);
		expect(out.spawned).toBe(true);
		expect(spawned[0]).toEqual(["myed", "--reuse", "$(evil)", "/wt/web-ui"]);
	});

	test("template without {path} gets the path appended", () => {
		const { spawned, deps: d } = deps({ env: { OMP_SQUAD_OPEN_CMD: "myed" }, which: () => "/usr/local/bin/myed" });
		openWorktree("/wt/api", d);
		expect(spawned[0]).toEqual(["myed", "/wt/api"]);
	});

	test("resolution order: terax before code; code when terax absent", () => {
		const { spawned, deps: d } = deps({ which: (bin: string) => (bin === "code" ? "/usr/bin/code" : null) });
		const out = openWorktree("/wt/api", d);
		expect(out.argv?.[0]).toBe("code");
		expect(spawned).toHaveLength(1);
		const both = deps({ which: (bin: string) => (bin === "terax" ? "/usr/local/bin/terax" : "/usr/bin/code") });
		expect(openWorktree("/wt/api", both.deps).argv?.[0]).toBe("terax");
	});

	test("no opener: spawned=false, path returned to copy, hint present", () => {
		const { spawned, deps: d } = deps();
		const out = openWorktree("/wt/api", d);
		expect(out).toMatchObject({ spawned: false, argv: null, path: "/wt/api" });
		expect(out.hint).toContain("OMP_SQUAD_OPEN_CMD");
		expect(spawned).toHaveLength(0);
	});

	test("/mnt/ opener gets a translated argument", () => {
		const { spawned, deps: d } = deps({ which: (bin: string) => (bin === "terax" ? "/mnt/c/Program Files/terax/terax.exe" : null) });
		const out = openWorktree("/wt/web-ui", d);
		expect(spawned[0]).toEqual(["terax", "WIN(/wt/web-ui)"]);
		expect(out.path).toBe("WIN(/wt/web-ui)");
	});

	test("spawn failure is honest", () => {
		const { deps: d } = deps({ which: () => "/usr/bin/code", spawnFn: () => false });
		const out = openWorktree("/wt/api", d);
		expect(out.spawned).toBe(false);
		expect(out.hint).toContain("spawn failed");
	});
});

// Codex review: the worktree path is DATA handed to an arbitrary opener. If it could be
// relative, dash-leading, or nonexistent it would arrive as an editor OPTION (or, under a
// `sh -c {path}` template, as CODE). And a spawned editor must not inherit the daemon's keys.
describe("openWorktree hardening", () => {
	test("refuses a non-absolute, dash-leading, or nonexistent worktree — nothing spawns", () => {
		for (const [path, isDir] of [
			["relative/path", true],
			["-R /etc", true],
			["/wt/gone", false],
		] as const) {
			const { spawned, deps: d } = deps({ which: () => "/usr/bin/code", isDir: () => isDir });
			const out = openWorktree(path, d);
			expect(out.spawned).toBe(false);
			expect(out.argv).toBeNull();
			expect(out.hint).toContain("absolute existing directory");
			expect(spawned).toHaveLength(0);
		}
	});

	test("refuses a template that puts {path} in the executable position", () => {
		const { spawned, deps: d } = deps({ env: { OMP_SQUAD_OPEN_CMD: "{path}" }, which: () => "/x" });
		const out = openWorktree("/wt/api", d);
		expect(out.spawned).toBe(false);
		expect(out.hint).toContain("executable position");
		expect(spawned).toHaveLength(0);
	});

	test("the spawned editor gets a GUI-safe env, not the daemon's secrets", () => {
		const { envs, deps: d } = deps({
			env: {
				OMP_SQUAD_OPEN_CMD: "code {path}",
				PATH: "/usr/bin",
				HOME: "/home/u",
				DISPLAY: ":0",
				LC_ALL: "C",
				XDG_RUNTIME_DIR: "/run/u",
				ANTHROPIC_API_KEY: "sk-secret",
				OMP_SQUAD_TOKEN: "daemon-token",
				GITHUB_TOKEN: "ghp_secret",
			},
			which: () => "/usr/bin/code",
		});
		openWorktree("/wt/api", d);
		expect(envs[0]).toEqual({ PATH: "/usr/bin", HOME: "/home/u", DISPLAY: ":0", LC_ALL: "C", XDG_RUNTIME_DIR: "/run/u" });
	});
});

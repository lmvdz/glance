/**
 * harness-hooks — foreign harness CLIs self-report liveness (fleet-ide-bridge B03).
 *
 * Load-bearing properties:
 *  - We EDIT A HUMAN'S CONFIG. The merge must preserve every foreign hook and every other
 *    settings key byte-for-byte, and uninstall must restore the file exactly.
 *  - The daemon is the scope authority: a session outside every registered project never
 *    becomes a presence row, and `/repo-evil` must not match project `/repo`.
 *  - An UNVERIFIED harness is never written to — we do not guess at a config schema.
 */
import { describe, expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { harnessEventDecision, harnessHooksInstalled, installHarnessHooks, uninstallHarnessHooks } from "../src/harness-hooks.ts";

/** A home dir holding a config that ALREADY has the user's own hooks + settings. */
async function homeWithConfig(settings: Record<string, unknown>) {
	const home = await fsp.mkdtemp(path.join(os.tmpdir(), "hh-home-"));
	const state = await fsp.mkdtemp(path.join(os.tmpdir(), "hh-state-"));
	const file = path.join(home, ".claude", "settings.json");
	await fsp.mkdir(path.dirname(file), { recursive: true });
	await fsp.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
	const read = async () => JSON.parse(await fsp.readFile(file, "utf8")) as Record<string, unknown>;
	const cleanup = async () => {
		await fsp.rm(home, { recursive: true, force: true });
		await fsp.rm(state, { recursive: true, force: true });
	};
	return { home, state, file, read, cleanup };
}

const PROJECTS = ["/home/u/repo", "/home/u/repo/packages/inner"];

describe("scope: the daemon decides, never the client", () => {
	test("cwd inside a registered project claims presence; deepest project wins", () => {
		expect(harnessEventDecision({ harness: "claude-code", event: "start", sessionId: "s1", cwd: "/home/u/repo/src" }, PROJECTS)).toMatchObject({
			action: "claim",
			repo: "/home/u/repo",
			agent: "claude-code:s1",
		});
		expect(harnessEventDecision({ harness: "claude-code", event: "prompt", sessionId: "s1", cwd: "/home/u/repo/packages/inner/x" }, PROJECTS)).toMatchObject({
			repo: "/home/u/repo/packages/inner",
		});
	});

	test("claim id is a HASH of the session — a traversal sessionId can never become a path", () => {
		const evil = harnessEventDecision({ harness: "claude-code", event: "start", sessionId: "../../../../etc/cron.d/x", cwd: "/home/u/repo" }, PROJECTS);
		expect(evil.action).toBe("claim");
		if (evil.action !== "claim") throw new Error("unreachable");
		expect(evil.claimId).toMatch(/^harness-[0-9a-f]{24}$/); // no slashes, no dots — pure hex
		// start and stop of the SAME session resolve to the SAME id (so release finds the row)
		const stop = harnessEventDecision({ harness: "claude-code", event: "stop", sessionId: "../../../../etc/cron.d/x", cwd: "/home/u/repo" }, PROJECTS);
		expect(stop.action === "release" && stop.claimId).toBe(evil.claimId);
		// different sessions → different ids
		const other = harnessEventDecision({ harness: "claude-code", event: "start", sessionId: "s2", cwd: "/home/u/repo" }, PROJECTS);
		expect(other.action === "claim" && other.claimId).not.toBe(evil.claimId);
	});

	test("same session id under DIFFERENT harnesses gets distinct rows (no cross-harness eviction)", () => {
		const a = harnessEventDecision({ harness: "claude-code", event: "start", sessionId: "shared", cwd: "/home/u/repo" }, PROJECTS);
		const b = harnessEventDecision({ harness: "codex", event: "start", sessionId: "shared", cwd: "/home/u/repo" }, PROJECTS);
		expect(a.action === "claim" && a.claimId).not.toBe(b.action === "claim" && b.claimId);
	});

	test("stop releases; start/prompt/attention all mean alive", () => {
		expect(harnessEventDecision({ harness: "claude-code", event: "stop", sessionId: "s1", cwd: "/home/u/repo" }, PROJECTS)).toMatchObject({
			action: "release",
			repo: "/home/u/repo",
		});
		for (const event of ["start", "prompt", "attention"] as const) {
			expect(harnessEventDecision({ harness: "claude-code", event, sessionId: "s1", cwd: "/home/u/repo" }, PROJECTS).action).toBe("claim");
		}
	});

	test("a session outside every registered project is dropped — no roster of unrelated work", () => {
		const out = harnessEventDecision({ harness: "claude-code", event: "start", sessionId: "s1", cwd: "/home/u/personal" }, PROJECTS);
		expect(out).toMatchObject({ action: "drop" });
	});

	test("path-segment aware: /repo-evil is not inside /repo", () => {
		const ev = (cwd: string) => harnessEventDecision({ harness: "claude-code", event: "start", sessionId: "s", cwd }, PROJECTS);
		expect(ev("/home/u/repo-evil/src").action).toBe("drop");
		expect(ev("/home/u/repo")).toMatchObject({ action: "claim", repo: "/home/u/repo" });
		expect(ev("/home/u/repo/a/b")).toMatchObject({ action: "claim", repo: "/home/u/repo" });
	});

	test("malformed and relative-cwd events are dropped", () => {
		expect(harnessEventDecision({ harness: "", event: "start", sessionId: "s", cwd: "/home/u/repo" }, PROJECTS).action).toBe("drop");
		expect(harnessEventDecision({ harness: "c", event: "start", sessionId: "", cwd: "/home/u/repo" }, PROJECTS).action).toBe("drop");
		expect(harnessEventDecision({ harness: "c", event: "start", sessionId: "s", cwd: "relative/path" }, PROJECTS).action).toBe("drop");
	});
});

// We EDIT A HUMAN'S CONFIG — these run through the real installers against a real file.
describe("config surgery: never clobber what the human already had", () => {
	const foreign = {
		model: "opus",
		permissions: { allow: ["Bash"] },
		hooks: {
			SessionStart: [{ hooks: [{ type: "command", command: "/their/own-session-start.sh" }] }],
			PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/their/guard.sh" }] }],
		},
	};

	test("install keeps every foreign key + hook and adds all four of ours", async () => {
		const h = await homeWithConfig(foreign);
		try {
			await installHarnessHooks(h.state, 4200, h.home);
			const after = await h.read();
			expect(after.model).toBe("opus");
			expect(after.permissions).toEqual({ allow: ["Bash"] });
			const hooks = after.hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
			// their SessionStart hook survives; ours sits alongside it
			expect(hooks.SessionStart[0].hooks[0].command).toBe("/their/own-session-start.sh");
			// an event we never touch is byte-identical, matcher intact
			expect(hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: "/their/guard.sh" }] }] as never);
			for (const [event, arg] of [["SessionStart", "start"], ["UserPromptSubmit", "prompt"], ["Notification", "attention"], ["Stop", "stop"]] as const) {
				// the shim path is QUOTED (spaces in a home dir must not split the command)
				expect(hooks[event].some((g) => g.hooks.some((x) => /"[^"]*glance-harness-shim\.sh" /.test(x.command) && x.command.endsWith(` ${arg}`)))).toBe(true);
			}
		} finally {
			await h.cleanup();
		}
	});

	test("install is idempotent, and uninstall restores the original byte-for-byte", async () => {
		const h = await homeWithConfig(foreign);
		try {
			await installHarnessHooks(h.state, 4200, h.home);
			const once = await h.read();
			await installHarnessHooks(h.state, 4200, h.home);
			expect(await h.read()).toEqual(once); // no duplicate entries on re-run

			await uninstallHarnessHooks(h.state, h.home);
			expect(await h.read()).toEqual(foreign);
		} finally {
			await h.cleanup();
		}
	});

	test("a config we cannot parse is REFUSED, not clobbered", async () => {
		const home = await fsp.mkdtemp(path.join(os.tmpdir(), "hh-home-"));
		const state = await fsp.mkdtemp(path.join(os.tmpdir(), "hh-state-"));
		try {
			const file = path.join(home, ".claude", "settings.json");
			await fsp.mkdir(path.dirname(file), { recursive: true });
			const corrupt = '{ "model": "opus", // a comment their editor left\n  "hooks": {} ';
			await fsp.writeFile(file, corrupt);

			const reports = await installHarnessHooks(state, 4200, home);
			expect(reports.find((r) => r.harness === "claude-code")).toMatchObject({ installed: false });
			expect(reports.find((r) => r.harness === "claude-code")?.reason).toContain("not valid JSON");
			expect(await fsp.readFile(file, "utf8")).toBe(corrupt); // byte-for-byte untouched

			await uninstallHarnessHooks(state, home);
			expect(await fsp.readFile(file, "utf8")).toBe(corrupt);
			expect((await harnessHooksInstalled(home)).find((p) => p.harness === "claude-code")?.ok).toBe(false);
		} finally {
			await fsp.rm(home, { recursive: true, force: true });
			await fsp.rm(state, { recursive: true, force: true });
		}
	});

	test("uninstall from a config with no hooks of ours leaves no orphan `hooks` key", async () => {
		const h = await homeWithConfig({ model: "opus" });
		try {
			await uninstallHarnessHooks(h.state, h.home);
			expect(await h.read()).toEqual({ model: "opus" });
		} finally {
			await h.cleanup();
		}
	});

	test("a foreign hook merely CONTAINING the shim name is not mistaken for ours", async () => {
		// A user whose own hook greps for our shim file must keep it across install+uninstall.
		const foreignRef = { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "grep glance-harness-shim.sh /tmp/audit.log" }] }] } };
		const h = await homeWithConfig(foreignRef);
		try {
			await installHarnessHooks(h.state, 4200, h.home);
			await uninstallHarnessHooks(h.state, h.home);
			expect(await h.read()).toEqual(foreignRef); // their grep-hook survived untouched
		} finally {
			await h.cleanup();
		}
	});

	test("a state dir with a space still round-trips (quoted shim path, tolerant match)", async () => {
		const home = await fsp.mkdtemp(path.join(os.tmpdir(), "hh-home-"));
		// the shim lives in the state dir — a space HERE is what would split an unquoted command
		const stateParent = await fsp.mkdtemp(path.join(os.tmpdir(), "hh-sp-"));
		const state = path.join(stateParent, "App Support");
		await fsp.mkdir(state, { recursive: true });
		const file = path.join(home, ".claude", "settings.json");
		await fsp.mkdir(path.dirname(file), { recursive: true });
		await fsp.writeFile(file, JSON.stringify({ model: "opus" }, null, 2));
		try {
			await installHarnessHooks(state, 4200, home);
			const after = JSON.parse(await fsp.readFile(file, "utf8"));
			// path is quoted so the space can't split it
			expect(after.hooks.SessionStart[0].hooks[0].command).toMatch(/^"[^"]*App Support[^"]*glance-harness-shim\.sh" start$/);
			// doctor still recognizes the quoted form as ours
			expect((await harnessHooksInstalled(home)).find((p) => p.harness === "claude-code")?.ok).toBe(true);
			// and uninstall finds+removes it despite the quote
			await uninstallHarnessHooks(state, home);
			expect(JSON.parse(await fsp.readFile(file, "utf8"))).toEqual({ model: "opus" });
		} finally {
			await fsp.rm(home, { recursive: true, force: true });
			await fsp.rm(stateParent, { recursive: true, force: true });
		}
	});

	test("a non-array hook group is left as-is, never throws", async () => {
		const weird = { hooks: { SessionStart: "not-an-array" as unknown } };
		const h = await homeWithConfig(weird);
		try {
			const reports = await installHarnessHooks(h.state, 4200, h.home);
			// claude install still succeeds for the events it CAN touch; the malformed one is skipped
			expect(reports.find((r) => r.harness === "claude-code")?.installed).toBe(true);
			expect((await h.read()).hooks).toMatchObject({ SessionStart: "not-an-array" });
		} finally {
			await h.cleanup();
		}
	});
});

describe("the generated shim escapes hostile values (run through /bin/sh)", () => {
	test("a cwd with a doublequote produces valid JSON, not a broken body", async () => {
		const state = await fsp.mkdtemp(path.join(os.tmpdir(), "hh-esc-"));
		try {
			// Serve the shim's POST at a local socket and capture the body it sends.
			const bodies: string[] = [];
			const server = Bun.serve({
				port: 0,
				async fetch(req) {
					bodies.push(await req.text());
					return new Response("ok");
				},
			});
			await installHarnessHooks(state, server.port, os.tmpdir()); // writes the shim keyed to this port
			const shim = path.join(state, "glance-harness-shim.sh");
			// Run the shim from a directory whose name contains a doublequote and a backslash.
			const nastyDir = path.join(state, 'we"ird\\dir');
			await fsp.mkdir(nastyDir, { recursive: true });
			const proc = Bun.spawn(["/bin/sh", shim, "start"], { cwd: nastyDir, env: { CLAUDE_SESSION_ID: 'sess"injected' } });
			await proc.exited;
			await Bun.sleep(200); // the curl runs backgrounded (`&`)
			server.stop(true);
			expect(bodies.length).toBe(1);
			const parsed = JSON.parse(bodies[0]); // MUST parse — escaping worked
			expect(parsed.cwd).toContain('we"ird');
			expect(parsed.sessionId).toBe('sess"injected');
		} finally {
			await fsp.rm(state, { recursive: true, force: true });
		}
	});
});

describe("install/uninstall against a real filesystem", () => {
	test("writes the shim, wires claude, refuses unverified harnesses, and round-trips", async () => {
		const home = await fsp.mkdtemp(path.join(os.tmpdir(), "hh-home-"));
		const state = await fsp.mkdtemp(path.join(os.tmpdir(), "hh-state-"));
		try {
			const settings = path.join(home, ".claude", "settings.json");
			await fsp.mkdir(path.dirname(settings), { recursive: true });
			await fsp.writeFile(settings, JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "/theirs.sh" }] }] } }, null, 2));

			const reports = await installHarnessHooks(state, 4200, home);
			expect(reports.find((r) => r.harness === "claude-code")?.installed).toBe(true);
			// unverified harnesses are SKIPPED with a reason — never written blind
			for (const h of ["codex", "gemini"]) {
				const r = reports.find((x) => x.harness === h);
				expect(r?.installed).toBe(false);
				expect(r?.reason).toBeTruthy();
			}
			// the shim exists and is executable
			const shim = path.join(state, "glance-harness-shim.sh");
			const stat = await fsp.stat(shim);
			expect(stat.mode & 0o111).toBeGreaterThan(0);
			const script = await fsp.readFile(shim, "utf8");
			expect(script).toContain("127.0.0.1:4200/api/harness-events");
			expect(script).toContain("exit 0"); // never fails a human's session
			// the ACTUAL token path is embedded (not a runtime $GLANCE_STATE_DIR that the user's
			// shell never sets — that would silently send no token and 401)
			expect(script).toContain(path.join(state, "access-token"));
			expect(script).not.toContain("$GLANCE_STATE_DIR");
			expect(script).toContain("esc()"); // JSON-escapes interpolated values

			// doctor sees it wired
			const probed = await harnessHooksInstalled(home);
			expect(probed.find((p) => p.harness === "claude-code")?.ok).toBe(true);
			expect(probed.find((p) => p.harness === "codex")?.ok).toBe(false);

			// their pre-existing Stop hook survived install
			const after = JSON.parse(await fsp.readFile(settings, "utf8"));
			expect(after.hooks.Stop.some((g: { hooks: Array<{ command: string }> }) => g.hooks.some((h) => h.command === "/theirs.sh"))).toBe(true);

			await uninstallHarnessHooks(state, home);
			const restored = JSON.parse(await fsp.readFile(settings, "utf8"));
			expect(restored).toEqual({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "/theirs.sh" }] }] } });
			expect(await fsp.exists(shim)).toBe(false);
			expect((await harnessHooksInstalled(home)).find((p) => p.harness === "claude-code")?.ok).toBe(false);
		} finally {
			await fsp.rm(home, { recursive: true, force: true });
			await fsp.rm(state, { recursive: true, force: true });
		}
	});
});

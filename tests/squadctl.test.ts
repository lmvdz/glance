import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const SCRIPT = path.join(import.meta.dir, "..", "scripts", "squadctl.sh");

// Drive the script's internal `_pidof` (lock-pid parse + liveness) against a
// temp state dir — no real daemon involved. Pin BOTH env spellings: env-compat may
// have mirrored the suite's OMP_SQUAD_STATE_DIR onto GLANCE_STATE_DIR in this
// process, and GLANCE_STATE_DIR wins inside the script.
async function pidof(stateDir: string): Promise<string> {
	const { stdout } = await run("bash", [SCRIPT, "_pidof"], { env: { ...process.env, GLANCE_STATE_DIR: stateDir, OMP_SQUAD_STATE_DIR: stateDir } });
	return stdout.trim();
}

const DEAD = 2147483647; // > pid_max: kill -0 always ESRCH

describe("squadctl _pidof", () => {
	test("returns the live daemon pid, not ppid, regardless of field order", async () => {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "squadctl-"));
		try {
			// ppid first + dead, pid second + alive (this test process): a parser that
			// grabbed ppid would print nothing (dead); the correct one prints our pid.
			const lock = { ppid: DEAD, pid: process.pid, host: os.hostname(), startedAt: Date.now() };
			await fsp.writeFile(path.join(dir, "daemon.lock"), JSON.stringify(lock));
			expect(await pidof(dir)).toBe(String(process.pid));
		} finally {
			await fsp.rm(dir, { recursive: true, force: true });
		}
	});

	test("stale lock (owner gone) reports nothing", async () => {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "squadctl-"));
		try {
			await fsp.writeFile(path.join(dir, "daemon.lock"), JSON.stringify({ pid: DEAD, host: os.hostname() }));
			expect(await pidof(dir)).toBe("");
		} finally {
			await fsp.rm(dir, { recursive: true, force: true });
		}
	});

	test("no lock file reports nothing", async () => {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "squadctl-"));
		try {
			expect(await pidof(dir)).toBe("");
		} finally {
			await fsp.rm(dir, { recursive: true, force: true });
		}
	});

	// grok #350 F2: a live daemon owned by ANOTHER uid fails `kill -0` with EPERM, which the old
	// daemon_pid misread as "dead" — clearing the way for cmd_start/cmd_restart to launch a SECOND
	// daemon over a live one (the two-owner window). pid 1 (init/systemd) is the portable fixture:
	// for a non-root test process it is alive-but-unsignalable (EPERM), so before the fix _pidof
	// returned "" and after it returns "1" via the /proc fallback. As root, kill -0 1 succeeds and it
	// returns "1" anyway — the assertion holds either way, and specifically exercises the /proc branch
	// when non-root. Skipped where /proc/1 is absent (no procfs, e.g. macOS).
	test("EPERM (alive-but-unsignalable, other-uid) reads as ALIVE, not dead", async () => {
		let hasProc1 = false;
		try {
			await fsp.access("/proc/1");
			hasProc1 = true;
		} catch {
			/* no procfs — skip */
		}
		if (!hasProc1) return;
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "squadctl-"));
		try {
			await fsp.writeFile(path.join(dir, "daemon.lock"), JSON.stringify({ pid: 1, host: os.hostname(), startedAt: Date.now() }));
			expect(await pidof(dir)).toBe("1");
		} finally {
			await fsp.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("squadctl state-dir resolution (mirrors src/state-dir.ts)", () => {
	// Run _pidof with a scratch HOME and NO state-dir env: the script must probe
	// ~/.glance → legacy ~/.omp/squad → ~/.glance, same order as the daemon.
	async function pidofWithHome(home: string): Promise<string> {
		const env = { ...process.env, HOME: home } as NodeJS.ProcessEnv;
		delete env.GLANCE_STATE_DIR;
		delete env.OMP_SQUAD_STATE_DIR;
		const { stdout } = await run("bash", [SCRIPT, "_pidof"], { env });
		return stdout.trim();
	}

	const lockFor = (pid: number) => JSON.stringify({ pid, host: os.hostname(), startedAt: Date.now() });

	test("legacy-only home resolves ~/.omp/squad", async () => {
		const home = await fsp.mkdtemp(path.join(os.tmpdir(), "squadctl-home-"));
		try {
			await fsp.mkdir(path.join(home, ".omp", "squad"), { recursive: true });
			await fsp.writeFile(path.join(home, ".omp", "squad", "daemon.lock"), lockFor(process.pid));
			expect(await pidofWithHome(home)).toBe(String(process.pid));
		} finally {
			await fsp.rm(home, { recursive: true, force: true });
		}
	});

	test("~/.glance wins when both dirs exist", async () => {
		const home = await fsp.mkdtemp(path.join(os.tmpdir(), "squadctl-home-"));
		try {
			await fsp.mkdir(path.join(home, ".glance"), { recursive: true });
			await fsp.mkdir(path.join(home, ".omp", "squad"), { recursive: true });
			await fsp.writeFile(path.join(home, ".glance", "daemon.lock"), lockFor(process.pid));
			await fsp.writeFile(path.join(home, ".omp", "squad", "daemon.lock"), lockFor(DEAD));
			expect(await pidofWithHome(home)).toBe(String(process.pid));
		} finally {
			await fsp.rm(home, { recursive: true, force: true });
		}
	});
});

import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const SCRIPT = path.join(import.meta.dir, "..", "scripts", "squadctl.sh");

// Drive the script's internal `_pidof` (lock-pid parse + liveness) against a
// temp state dir — no real daemon involved.
async function pidof(stateDir: string): Promise<string> {
	const { stdout } = await run("bash", [SCRIPT, "_pidof"], { env: { ...process.env, OMP_SQUAD_STATE_DIR: stateDir } });
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
});

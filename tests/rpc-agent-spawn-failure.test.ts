/**
 * Real-component half of the console-chat daemon-crash regression (see
 * tests/console-prompt-spawn-failure.test.ts for the SquadManager-level half).
 *
 * Reproduces the actual low-level mechanism: a harness bin that can never come up (a bogus binary, or
 * one that always dies before emitting `{"type":"ready"}`) drives `RpcAgent.start()` through its real
 * spawn choreography — `spawnHost()` (a detached `agent-host` process) → the host's own `Bun.spawn` of
 * the harness bin → the socket handshake → `waitReady()`. This proves `start()` reliably REJECTS (never
 * hangs, never silently resolves) for a broken harness — the exact promise `SquadManager.ensureConnected`
 * awaits and (before the fix) let escape uncaught from `applyCommand`'s "prompt" case, which the daemon's
 * WS handler fires fire-and-forget — turning this rejection into a process-crashing unhandled rejection.
 *
 * Mirrors rpc-agent-respawn.test.ts's fake-bin pattern (OMPSQ-188), but the fake harness here NEVER
 * recovers — every cold-start attempt within the budget dies before ready, so `start()` must eventually
 * give up and reject rather than retry forever.
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcAgent } from "../src/rpc-agent.ts";
import { hostAlive } from "../src/agent-host.ts";

const tmps: string[] = [];
const hosts: import("bun").Subprocess[] = [];
afterAll(async () => {
	for (const h of hosts) h.kill();
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

const HOST_ENTRY = path.join(import.meta.dir, "..", "src", "agent-host-main.ts");

/** A fake "omp" that comes up as a host child but HANGS forever without ever emitting `{"type":"ready"}`
 *  (reads stdin so it stays alive, killable by SIGTERM). Makes the host bind its socket and stay live —
 *  the exact "attached to a host that never becomes ready" shape whose orphan `stop()` must reap. */
const HANGS_FOREVER_OMP = `#!/usr/bin/env bun
for await (const _ of Bun.stdin.stream()) { /* swallow, never emit ready, never exit */ }
`;

async function waitFor(pred: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await pred()) return true;
		await Bun.sleep(50);
	}
	return await pred();
}

/** A fake "omp" that always exits immediately, before ever emitting a ready frame — simulates a
 *  permanently broken harness (missing dependency, bad flag, corrupted install, …), not a transient
 *  cold-start flake. */
const ALWAYS_DIES_OMP = `#!/usr/bin/env bun
process.exit(17);
`;

/** A bin path that does not exist at all — the simplest "harness can't start" shape (bogus bin). */
function bogusBinPath(dir: string): string {
	return path.join(dir, "definitely-does-not-exist-omp");
}

test(
	"RpcAgent.start() rejects (never hangs) when the harness bin does not exist",
	async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-bogus-bin-"));
		tmps.push(dir);
		const socket = path.join(dir, "agent.sock");
		const a = new RpcAgent({ id: `bogus-${Date.now().toString(36)}`, cwd: dir, bin: bogusBinPath(dir), socket, approvalMode: "yolo", thinking: "minimal" });
		try {
			await expect(a.start(3_000)).rejects.toThrow();
		} finally {
			expect(a.isReady).toBe(false);
			await a.stop().catch(() => {});
		}
	},
	15_000,
);

test(
	"RpcAgent.start() rejects (never hangs) when the harness always dies before ready",
	async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-dead-bin-"));
		tmps.push(dir);
		const binPath = path.join(dir, "fake-omp-dies.ts");
		await fs.writeFile(binPath, ALWAYS_DIES_OMP);
		await fs.chmod(binPath, 0o755);

		const socket = path.join(dir, "agent.sock");
		const a = new RpcAgent({ id: `dies-${Date.now().toString(36)}`, cwd: dir, bin: binPath, socket, approvalMode: "yolo", thinking: "minimal" });
		try {
			await expect(a.start(3_000)).rejects.toThrow();
			expect(a.isReady).toBe(false);
			expect(a.isAlive).toBe(false);
		} finally {
			await a.stop().catch(() => {});
		}
	},
	15_000,
);

test(
	"RpcAgent.stop() reaps a real attached host that never became ready — NO live host/socket survives",
	async () => {
		// This is the zombie the cross-lineage review flagged: settling a spawn failure into "error"
		// without stopping the driver leaves a live agent-host + socket behind. `settleSpawnFailure`
		// (the shared prompt/set-model/restart/createWithId path) calls exactly this `stop()`; this
		// proves that call actually tears a REAL orphan host down (the console-prompt-spawn-failure
		// tests prove every settle path invokes it).
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-zombie-"));
		tmps.push(dir);
		const binPath = path.join(dir, "fake-omp-hangs.ts");
		await fs.writeFile(binPath, HANGS_FOREVER_OMP);
		await fs.chmod(binPath, 0o755);
		const socket = path.join(dir, "agent.sock");
		const id = `zombie-${Date.now().toString(36)}`;

		// Spawn a REAL detached agent-host whose omp child hangs → host binds the socket and stays live.
		const host = Bun.spawn([process.execPath, HOST_ENTRY, "--id", id, "--cwd", dir, "--socket", socket, "--bin", binPath], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		hosts.push(host);
		expect(await waitFor(() => hostAlive(socket), 5_000)).toBe(true); // host is up + accepting connections

		// Attach to it and wait for ready — which never comes, so start() rejects (single-shot attach path).
		const a = new RpcAgent({ id, cwd: dir, bin: binPath, socket, approvalMode: "yolo", thinking: "minimal" });
		await expect(a.start(1_500)).rejects.toThrow();
		expect(a.isReady).toBe(false);
		// The zombie is real: without a stop, this host + socket would linger forever.
		expect(await hostAlive(socket)).toBe(true);

		// settleSpawnFailure's stop() must reap it: host exits, socket file removed.
		await a.stop();
		expect(await waitFor(async () => !(await hostAlive(socket)), 5_000)).toBe(true); // no live host survives
		expect(await waitFor(async () => !(await fileExists(socket)), 5_000)).toBe(true); // no socket file survives
	},
	20_000,
);

async function fileExists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}

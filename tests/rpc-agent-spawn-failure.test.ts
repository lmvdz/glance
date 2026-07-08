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

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

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

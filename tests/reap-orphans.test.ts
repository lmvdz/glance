/**
 * reapOrphanHosts — the phantom-host fix. A detached agent-host whose agent is no longer in the
 * roster (left by a crash, re-exec, or re-spawn under a fresh id) must be shut down so omp processes
 * don't accumulate. Roster hosts (and a workflow's inner `<id>-wf` host whose owner is live) survive;
 * dead socket files are removed. Uses fake unix listeners — no real omp.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hostAlive, reapOrphanHosts } from "../src/agent-host.ts";

const servers: { stop: () => void }[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) {
		try {
			s.stop();
		} catch {
			/* already stopped */
		}
	}
});

/** A stand-in host: a unix listener that "exits" (stops listening) when it receives the shutdown frame. */
function fakeHost(dir: string, id: string): string {
	const unix = path.join(dir, `${id}.sock`);
	const server = Bun.listen<undefined>({
		unix,
		socket: {
			data: (_s, chunk) => {
				if (chunk.toString().includes("shutdown")) {
					try {
						server.stop();
					} catch {
						/* noop */
					}
				}
			},
			open: () => {},
			close: () => {},
			error: () => {},
		},
	});
	servers.push(server);
	return unix;
}

test("reapOrphanHosts: shuts down live orphans, keeps roster + workflow hosts, removes dead sockets", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reap-"));
	const keepSock = fakeHost(dir, "keep"); // live + in roster → survives
	fakeHost(dir, "orphan"); // live + NOT in roster → reaped
	const wfSock = fakeHost(dir, "wfowner-wf"); // inner workflow host; owner "wfowner" is live → kept
	const deadSock = path.join(dir, "dead.sock");
	await fs.writeFile(deadSock, ""); // a stale socket FILE with no listener → removed

	const reaped = await reapOrphanHosts(new Set(["keep", "wfowner"]), dir);

	expect(reaped).toContain("orphan");
	expect(reaped).not.toContain("keep");
	expect(reaped).not.toContain("wfowner-wf");
	expect(await hostAlive(keepSock)).toBe(true); // roster host untouched
	expect(await hostAlive(wfSock)).toBe(true); // workflow inner host kept (owner live)
	expect(await Bun.file(deadSock).exists()).toBe(false); // dead socket file removed

	await fs.rm(dir, { recursive: true, force: true });
});

test("reapOrphanHosts: empty/missing dir is a no-op (never throws)", async () => {
	const missing = path.join(os.tmpdir(), `reap-missing-${Date.now()}`);
	expect(await reapOrphanHosts(new Set(["x"]), missing)).toEqual([]);
});

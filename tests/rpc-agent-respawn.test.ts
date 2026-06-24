/**
 * Regression for OMPSQ-188: a freshly-spawned agent-host whose omp child dies during cold start
 * ("exited before ready") must NOT permanently kill the agent. Under load this routinely turned the
 * acceptance gate red against code that is actually fine. start() now retries the fresh-spawn path
 * within its deadline; this proves the recovery without spending any model tokens.
 *
 * A fake "omp" (driven through RpcAgent's `bin` override) serves long enough to be attached to, then
 * dies before ready on its FIRST spawn (the load flake), and comes up ready + answers get_state on the
 * respawn. If the retry/reset/socket-identity logic were removed, start() would throw "agent exited
 * before ready" and this test would fail. The attempt counter is baked into the script (not passed via
 * env) because env does not reliably propagate through the daemon→detached-host→omp spawn chain.
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

function fakeOmp(stateFile: string): string {
	return `#!/usr/bin/env bun
const stateFile = ${JSON.stringify(stateFile)};
let n = 0;
try { n = Number(await Bun.file(stateFile).text()) || 0; } catch {}
n += 1;
await Bun.write(stateFile, String(n));
if (n < 2) { await Bun.sleep(500); process.exit(1); } // first cold start: host serves + client attaches, then omp dies before ready
console.log(JSON.stringify({ type: "ready" }));
const decoder = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
	buf += decoder.decode(chunk, { stream: true });
	let nl;
	while ((nl = buf.indexOf("\\n")) >= 0) {
		const line = buf.slice(0, nl).trim();
		buf = buf.slice(nl + 1);
		if (!line) continue;
		let f; try { f = JSON.parse(line); } catch { continue; }
		if (f.type === "get_state") console.log(JSON.stringify({ type: "response", id: f.id, success: true, command: "get_state", data: { sessionId: "fake-session" } }));
	}
}
`;
}

test(
	"RpcAgent.start respawns the host when omp dies before ready on cold start",
	async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-respawn-"));
		tmps.push(dir);
		const stateFile = path.join(dir, "attempts");
		const binPath = path.join(dir, "fake-omp.ts");
		await fs.writeFile(binPath, fakeOmp(stateFile));
		await fs.chmod(binPath, 0o755);

		const socket = path.join(dir, "agent.sock");
		const a = new RpcAgent({ id: `respawn-${Date.now().toString(36)}`, cwd: dir, bin: binPath, socket, approvalMode: "yolo", thinking: "minimal" });
		try {
			await a.start(20_000); // first spawn attaches then dies; the retry must bring up the second
			expect(a.isReady).toBe(true);
			const state = await a.getState();
			expect(state.sessionId).toBe("fake-session");
			// Two host spawns: the dead cold start + the successful respawn.
			expect(Number(await fs.readFile(stateFile, "utf8"))).toBe(2);
		} finally {
			await a.stop();
		}
	},
	40_000,
);

/**
 * SandboxAgentDriver — verified against a REAL local container (docker-gated).
 *
 * A minimal fake-omp RPC server runs inside an `oven/bun` container; the driver
 * reaches it over `docker exec -i` and speaks omp's newline-JSON protocol. This
 * proves the sandbox transport + container lifecycle (run → exec → rm) without
 * needing omp/auth/tokens in the image. The real-omp path (the driver's default
 * agentCommand) was proven on the host in the Phase-C live run.
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SandboxAgentDriver } from "../src/sandbox-agent-driver.ts";

let hasDocker = false;
try {
	hasDocker = (await Bun.spawn(["docker", "version"], { stdout: "ignore", stderr: "ignore" }).exited) === 0;
} catch {
	hasDocker = false;
}

const IMAGE = "oven/bun:1.1-slim";

/** A tiny omp `--mode rpc` protocol server: ready, get_state, bash, and a prompt turn. */
const FAKE_OMP = String.raw`
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
emit({ type: "ready" });
let buf = "";
process.stdin.on("data", (ch) => {
  buf += ch;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let cmd; try { cmd = JSON.parse(line); } catch { continue; }
    const id = cmd.id;
    switch (cmd.type) {
      case "get_state": emit({ type: "response", id, command: "get_state", success: true, data: { thinkingLevel: undefined, isStreaming: false, isCompacting: false, steeringMode: "all", followUpMode: "all", interruptMode: "immediate", sessionId: "sbx", autoCompactionEnabled: false, messageCount: 0, queuedMessageCount: 0, todoPhases: [] } }); break;
      case "bash": emit({ type: "response", id, command: "bash", success: true, data: { stdout: "sandboxed", exitCode: 0 } }); break;
      case "prompt":
        emit({ type: "agent_start" });
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ran in sandbox" } });
        emit({ type: "message_end" });
        emit({ type: "agent_end" });
        emit({ type: "response", id, command: "prompt", success: true, data: { agentInvoked: true } });
        break;
      default: if (id) emit({ type: "response", id, command: cmd.type, success: true });
    }
  }
});
`;

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function fakeOmpDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sbx-"));
	tmps.push(dir);
	await fs.writeFile(path.join(dir, "fake-omp.ts"), FAKE_OMP);
	return dir;
}

test.skipIf(!hasDocker)(
	"SandboxAgentDriver: drives an agent inside a real container (ready, get_state, bash, prompt turn)",
	async () => {
		const dir = await fakeOmpDir();
		const driver = new SandboxAgentDriver({
			id: `t${Date.now().toString(36)}`,
			image: IMAGE,
			mount: dir,
			workdir: "/work",
			agentCommand: () => ["bun", "/work/fake-omp.ts"],
		});
		const frames: string[] = [];
		driver.on("event", (f: { type?: string }) => {
			if (f.type) frames.push(f.type);
		});
		try {
			await driver.start(60_000);
			expect(driver.isReady).toBe(true);
			const state = await driver.getState();
			expect(state.sessionId).toBe("sbx"); // spoke RPC into the container and back
			const bash = await driver.send<{ stdout: string }>({ type: "bash", command: "echo hi" });
			expect(bash.stdout).toBe("sandboxed");
			await driver.prompt("do the thing");
			expect(frames).toContain("agent_start");
			expect(frames).toContain("agent_end");
		} finally {
			await driver.stop();
		}
	},
	90_000,
);

test.skipIf(!hasDocker)(
	"SandboxAgentDriver: stop() removes the container",
	async () => {
		const dir = await fakeOmpDir();
		const driver = new SandboxAgentDriver({ id: `t${Date.now().toString(36)}rm`, image: IMAGE, mount: dir, agentCommand: () => ["bun", "/work/fake-omp.ts"] });
		await driver.start(60_000);
		const exists = async () => (await Bun.spawn(["docker", "inspect", driver.container], { stdout: "ignore", stderr: "ignore" }).exited) === 0;
		expect(await exists()).toBe(true); // container is up while the agent runs
		await driver.stop();
		expect(await exists()).toBe(false); // and removed on stop
	},
	90_000,
);

test.skipIf(!hasDocker)(
	"SandboxAgentDriver: start() removes the container when the agent never becomes ready",
	async () => {
		// Agent command exits immediately without ever emitting `ready` → start() rejects.
		const driver = new SandboxAgentDriver({ id: `t${Date.now().toString(36)}leak`, image: IMAGE, agentCommand: () => ["true"] });
		await expect(driver.start(60_000)).rejects.toThrow();
		const exists = async () => (await Bun.spawn(["docker", "inspect", driver.container], { stdout: "ignore", stderr: "ignore" }).exited) === 0;
		expect(await exists()).toBe(false); // no leaked container on the error path
	},
	90_000,
);

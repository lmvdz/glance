/**
 * AcpAgentDriver — driven against a FAKE in-process ACP agent.
 *
 * A tiny ACP *agent* server (newline-delimited JSON-RPC 2.0) is written to a temp file
 * and launched as the driver's child via the injectable `command` (`["bun", <path>]`).
 * No real auggie, no account, no tokens — this proves the ACP transport + the mapping
 * to the manager's normalized frames end to end. The fake answers initialize/session/new,
 * streams agent_message_chunk + tool_call updates, raises a session/request_permission it
 * blocks on, and replies to session/prompt (end_turn) or session/cancel (cancelled).
 */

import { once } from "node:events";
import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AcpAgentDriver } from "../src/acp-agent-driver.ts";

/** A minimal ACP agent: handshake, a streamed prompt turn, a blocking permission request, cancel. */
const FAKE_ACP = String.raw`
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const update = (u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: u } });
let buf = "";
let promptId = null;
let reqId = 1000;
process.stdin.on("data", (ch) => {
  buf += ch;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    // Response from the client (the driver) to our request_permission — echo the outcome, then finish.
    if (msg.id !== undefined && msg.method === undefined) {
      const o = (msg.result && msg.result.outcome) || {};
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "PERM:" + o.outcome + ":" + (o.optionId || "") } });
      if (promptId !== null) { send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } }); promptId = null; }
      continue;
    }
    const { id, method } = msg;
    switch (method) {
      case "initialize":
        send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: {} } });
        break;
      case "session/new":
        send({ jsonrpc: "2.0", id, result: { sessionId: "s1" } });
        break;
      case "session/prompt":
        promptId = id;
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } });
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } });
        update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "read file", kind: "read" });
        send({ jsonrpc: "2.0", id: ++reqId, method: "session/request_permission", params: {
          sessionId: "s1",
          toolCall: { toolCallId: "t1", title: "read file", kind: "read" },
          options: [
            { optionId: "allow-1", name: "Allow", kind: "allow_once" },
            { optionId: "reject-1", name: "Reject", kind: "reject_once" },
          ],
        } });
        break;
      case "session/cancel":
        if (promptId !== null) { send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } }); promptId = null; }
        break;
      default:
        if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
    }
  }
});
`;

interface Frame {
	type?: string;
	assistantMessageEvent?: { type?: string; delta?: string };
	toolName?: string;
	intent?: string;
}

const tmps: string[] = [];
const drivers: AcpAgentDriver[] = [];
afterAll(async () => {
	for (const d of drivers) await d.stop().catch(() => {});
	for (const f of tmps) await fs.rm(f, { recursive: true, force: true }).catch(() => {});
});

async function fakeDriver(): Promise<{ driver: AcpAgentDriver; events: Frame[] }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-"));
	tmps.push(dir);
	const script = path.join(dir, "fake-acp.ts");
	await fs.writeFile(script, FAKE_ACP);
	const driver = new AcpAgentDriver({ id: "t", cwd: dir, command: ["bun", script] });
	drivers.push(driver);
	const events: Frame[] = [];
	driver.on("event", (f: Frame) => events.push(f));
	return { driver, events };
}

test("AcpAgentDriver: streamed chunks reassemble; tool_call → tool_execution_start; permission → ui + respondUi", async () => {
	const { driver, events } = await fakeDriver();
	const uiP = once(driver, "ui");
	await driver.start(30_000);
	expect(driver.isReady).toBe(true);

	const turn = driver.prompt("hi");
	const [ui] = await uiP; // blocks until the fake raises session/request_permission

	// 3. permission → a confirm UI request is emitted
	expect(ui.type).toBe("extension_ui_request");
	expect(ui.method).toBe("confirm");
	expect(typeof ui.id).toBe("string");

	driver.respondUi(ui.id, { confirmed: true }); // selects the allow_once option
	await turn; // fake finishes the turn once it receives the outcome

	const deltas = events.filter((e) => e.type === "message_update").map((e) => e.assistantMessageEvent?.delta ?? "");
	// 1. streamed agent_message_chunk deltas reassemble + agent_start/message_end/agent_end bracket the turn
	expect(deltas[0] + deltas[1]).toBe("Hello");
	const types = events.map((e) => e.type);
	expect(types[0]).toBe("agent_start");
	expect(types).toContain("message_end");
	expect(types.at(-1)).toBe("agent_end");

	// 2. tool_call → tool_execution_start with toolName/intent derived from the ACP update
	const tool = events.find((e) => e.type === "tool_execution_start");
	expect(tool).toBeDefined();
	expect(tool?.toolName).toBe("read");
	expect(tool?.intent).toBe("read file");

	// 3 (cont). respondUi sent the right ACP outcome — the fake echoed it back as a chunk
	expect(deltas.join("")).toContain("PERM:selected:allow-1");
}, 30_000);

test("AcpAgentDriver: abort() cancels the in-flight turn and agent_end fires", async () => {
	const { driver, events } = await fakeDriver();
	const uiP = once(driver, "ui");
	await driver.start(30_000);

	const turn = driver.prompt("hi");
	await uiP; // a turn is in flight, waiting on the permission gate
	await driver.abort(); // session/cancel → the fake resolves the prompt with stopReason cancelled
	await turn; // resolves rather than hanging

	expect(events.map((e) => e.type).at(-1)).toBe("agent_end");
}, 30_000);

test("AcpAgentDriver: getState() returns a structurally valid RpcSessionState", async () => {
	const { driver } = await fakeDriver();
	await driver.start(30_000);

	const s = await driver.getState();
	expect(s.sessionId).toBe("s1");
	expect(s.thinkingLevel).toBeUndefined();
	expect(typeof s.isStreaming).toBe("boolean");
	expect(typeof s.isCompacting).toBe("boolean");
	expect(s.steeringMode).toBe("all");
	expect(s.followUpMode).toBe("all");
	expect(s.interruptMode).toBe("immediate");
	expect(typeof s.autoCompactionEnabled).toBe("boolean");
	expect(typeof s.messageCount).toBe("number");
	expect(typeof s.queuedMessageCount).toBe("number");
	expect(Array.isArray(s.todoPhases)).toBe(true);
}, 30_000);

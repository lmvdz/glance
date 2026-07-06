/**
 * AcpAgentDriver hardening (plans/harness-agnostic-drivers, concerns 05/08):
 * - pickOption FAILS CLOSED (a kind-less option never silently allows a denied call) + least-privilege
 * - end-to-end against a FAKE ACP agent (no live binary): initialize → capability event → session/new →
 *   set_mode (approval) → prompt → streamed text_delta. Proves the driver state machine offline.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AcpAgentDriver, pickOption } from "../src/acp-agent-driver.ts";

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

// ── pickOption: fail-closed + least-privilege ────────────────────────────────

test("pickOption matches the requested polarity by kind", () => {
	const opts = [{ optionId: "a", kind: "allow_once" }, { optionId: "b", kind: "reject_once" }];
	expect(pickOption(opts, true)).toBe("a");
	expect(pickOption(opts, false)).toBe("b");
});

test("pickOption prefers least privilege within a polarity (allow_once over allow_always)", () => {
	const opts = [{ optionId: "always", kind: "allow_always" }, { optionId: "once", kind: "allow_once" }];
	expect(pickOption(opts, true)).toBe("once");
});

test("pickOption FAILS CLOSED on kind-less options — never falls back to options[0]", () => {
	// A non-compliant adapter emits options with no `kind`. Old code returned options[0] — a fail-open
	// coin-flip that could allow a denied call. New code returns undefined ⇒ respondUi cancels.
	const kindless = [{ optionId: "x" }, { optionId: "y" }];
	expect(pickOption(kindless, true)).toBeUndefined();
	expect(pickOption(kindless, false)).toBeUndefined();
});

test("pickOption returns undefined when the requested polarity is absent (fail closed)", () => {
	const onlyAllow = [{ optionId: "a", kind: "allow_once" }];
	expect(pickOption(onlyAllow, false)).toBeUndefined(); // asked to reject, no reject option → cancel
});

// ── fake ACP agent: full handshake + streaming, no live binary ───────────────

const FAKE_ACP = `
const enc = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") enc({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false } } });
    else if (msg.method === "session/new") enc({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s1", modes: [{ id: "auto", name: "auto-approve" }] } });
    else if (msg.method === "session/set_mode") enc({ jsonrpc: "2.0", id: msg.id, result: {} });
    else if (msg.method === "session/prompt") {
      enc({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } } });
      enc({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
  }
});
`;

async function writeFake(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fake-acp-"));
	tmps.push(dir);
	const p = path.join(dir, "fake-acp.ts");
	await fs.writeFile(p, FAKE_ACP);
	return p;
}

test("AcpAgentDriver drives a fake ACP agent end-to-end: handshake, capability event, set_mode, streamed delta", async () => {
	const fake = await writeFake();
	const driver = new AcpAgentDriver({ id: "t", cwd: process.cwd(), command: ["bun", fake], approvalMode: "yolo" });

	let advertised: unknown;
	driver.on("acpcapabilities", (c) => { advertised = c; });
	const events: Array<Record<string, unknown>> = [];
	driver.on("event", (e) => events.push(e as Record<string, unknown>));

	await driver.start(10_000);
	expect(driver.isReady).toBe(true);
	expect(advertised).toEqual({ loadSession: false }); // narrowing/observability from initialize

	await driver.prompt("do a thing");

	// The fake's session/update agent_message_chunk was translated into omp's message_update/text_delta.
	const delta = events.find((e) => e.type === "message_update");
	expect(delta).toBeDefined();
	expect((delta!.assistantMessageEvent as { delta?: string }).delta).toBe("hi");
	expect(events.some((e) => e.type === "agent_start")).toBe(true);
	expect(events.some((e) => e.type === "agent_end")).toBe(true);

	await driver.stop();
});

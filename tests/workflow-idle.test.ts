/**
 * An agent node must finish even when omp never emits `agent_end` (e.g. after auto-compaction on a
 * very long loop). The executor's idle fallback detects the inner loop went idle (isStreaming false,
 * after it was seen active) and resolves the turn, so a finished run can't hang on its node until the
 * hours-long turn timeout. Driven via an injected scheduler — deterministic, no real timers.
 */

import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";
import type { AgentDriver } from "../src/agent-driver.ts";
import type { RpcSessionState } from "../src/types.ts";
import { SingleAgentExecutor } from "../src/workflow/executor.ts";
import type { RunContext, WorkflowNode } from "../src/workflow/types.ts";

function sessionState(isStreaming: boolean): RpcSessionState {
	return { thinkingLevel: undefined, isStreaming, isCompacting: false, steeringMode: "all", followUpMode: "all", interruptMode: "immediate", sessionId: "fake", autoCompactionEnabled: false, messageCount: 0, queuedMessageCount: 0, todoPhases: [] };
}

/** Streams text but NEVER emits agent_end; reports streaming for the first poll, idle thereafter. */
class NoEndAgent extends EventEmitter implements AgentDriver {
	private polls = 0;
	get isReady(): boolean {
		return true;
	}
	get isAlive(): boolean {
		return true;
	}
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async prompt(message: string): Promise<void> {
		this.emit("event", { type: "agent_start" });
		this.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `did ${message.slice(0, 4)}` } });
		// deliberately no agent_end
	}
	abort(): Promise<unknown> {
		return Promise.resolve();
	}
	getState(): Promise<RpcSessionState> {
		this.polls++;
		return Promise.resolve(sessionState(this.polls <= 1));
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

/** Emits agent_end synchronously — the primary path. */
class EndAgent extends NoEndAgent {
	async prompt(): Promise<void> {
		this.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } });
		this.emit("event", { type: "agent_end" });
	}
}

const flush = async (): Promise<void> => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

test("runAgent: idle fallback resolves the turn when agent_end is never emitted", async () => {
	const agent = new NoEndAgent();
	let check: (() => void) | undefined;
	const exec = new SingleAgentExecutor({
		cwd: "/tmp",
		acquireAgent: () => Promise.resolve(agent),
		emit: () => {},
		gate: () => Promise.resolve(""),
		scheduleIdleCheck: (fn) => {
			check = fn;
			return { cancel: () => {} };
		},
	});
	const node: WorkflowNode = { id: "implement", kind: "agent", label: "Implement", prompt: "the work", attrs: {} };
	const pending = exec.runAgent(node, { goal: "ship it", vars: {} });
	await flush(); // let runAgent await acquireAgent and reach awaitTurn (which sets up the scheduler)
	expect(check).toBeDefined();
	// 1 streaming poll primes the "was active" guard, then IDLE_TICKS idle polls trip the fallback.
	for (let i = 0; i < 8; i++) {
		check?.();
		await flush();
	}
	const result = await pending;
	expect(result.outcome).toBe("succeeded");
	expect(result.text).toContain("did");
});

test("runAgent: resolves on agent_end (primary path) without the idle scheduler firing", async () => {
	let polled = false;
	const exec = new SingleAgentExecutor({
		cwd: "/tmp",
		acquireAgent: () => Promise.resolve(new EndAgent()),
		emit: () => {},
		gate: () => Promise.resolve(""),
		scheduleIdleCheck: () => {
			polled = true; // capturing only; the fn is never invoked
			return { cancel: () => {} };
		},
	});
	const result = await exec.runAgent({ id: "n", kind: "agent", prompt: "x", attrs: {} }, { goal: "g", vars: {} });
	expect(result.outcome).toBe("succeeded");
	expect(result.text).toBe("done");
	expect(polled).toBe(true); // scheduler was set up, but agent_end resolved first (its callback never ran)
});

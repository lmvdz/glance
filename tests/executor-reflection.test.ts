/**
 * SingleAgentExecutor reflexion wiring (agentic-learning-loop concern 04): the "fixup" node injects
 * a fenced root-cause note from its 2nd visit onward, refutes an unchanged failure instead of
 * re-guessing, respects the OMP_SQUAD_REFLEXION flag, and never fires for a non-"fixup" node.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import type { RpcSessionState } from "../src/types.ts";
import { SingleAgentExecutor } from "../src/workflow/executor.ts";
import type { RunContext, WorkflowNode } from "../src/workflow/types.ts";

class RecordingDriver extends EventEmitter implements AgentDriver {
	readonly messages: string[] = [];
	private ready = false;
	get isReady(): boolean {
		return this.ready;
	}
	get isAlive(): boolean {
		return this.ready;
	}
	async start(): Promise<void> {
		this.ready = true;
	}
	async stop(): Promise<void> {
		this.ready = false;
	}
	async prompt(message: string): Promise<void> {
		this.messages.push(message);
		this.emit("event", { type: "agent_end" });
	}
	abort(): Promise<unknown> {
		return Promise.resolve();
	}
	getState(): Promise<RpcSessionState> {
		return Promise.resolve({ thinkingLevel: undefined, isStreaming: false, isCompacting: false, steeringMode: "all", followUpMode: "all", interruptMode: "immediate", sessionId: "rec", autoCompactionEnabled: false, messageCount: 0, queuedMessageCount: 0, todoPhases: [] });
	}
	setSessionName(): Promise<unknown> {
		return Promise.resolve();
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

const fixupNode = (maxVisits?: number): WorkflowNode => ({ id: "fixup", kind: "agent", label: "Fixup", prompt: "fix it", maxVisits, attrs: {} });
const otherNode = (): WorkflowNode => ({ id: "implement", kind: "agent", label: "Implement", prompt: "do it", attrs: {} });

/** The real engine threads ONE RunContext (and its `vars`) through an entire run — the attempt
 *  counter and `lastOutput` both ride `ctx.vars`, so tests must reuse one ctx across calls, not
 *  mint a fresh one per turn (a fresh object would silently reset the attempt counter to 0 every time). */
function newCtx(): RunContext {
	return { goal: "G", vars: {} };
}
function withOutput(ctx: RunContext, output: string): RunContext {
	ctx.vars.lastOutput = output;
	return ctx;
}

function tmp(): string {
	return mkdtempSync(path.join(os.tmpdir(), "executor-reflect-"));
}

afterEach(() => {
	delete process.env.OMP_SQUAD_REFLEXION;
});

function makeExecutor(agent: RecordingDriver, stateDir: string) {
	return new SingleAgentExecutor({
		cwd: "/tmp/wt",
		acquireAgent: async () => agent,
		emit: () => {},
		gate: async () => "",
		reflection: { stateDir, repo: "/repo", agentId: "a1", llm: async () => ({ rootCause: "flaky assertion", whatToDoDifferently: "widen the tolerance" }) },
	});
}

describe("reflexion — flag gating", () => {
	test("flag off (default): no reflection note even on the 2nd fixup visit", async () => {
		const dir = tmp();
		try {
			const agent = new RecordingDriver();
			const ex = makeExecutor(agent, dir);
			const ctx = newCtx();
			await ex.runAgent(fixupNode(3), withOutput(ctx, "boom v1"));
			await ex.runAgent(fixupNode(3), withOutput(ctx, "boom v2"));
			expect(agent.messages[1]).not.toContain("Likely root cause");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("reflexion — fixup node, flag on", () => {
	test("no note on the FIRST fixup visit (raw output alone is often enough)", async () => {
		process.env.OMP_SQUAD_REFLEXION = "1";
		const dir = tmp();
		try {
			const agent = new RecordingDriver();
			const ex = makeExecutor(agent, dir);
			await ex.runAgent(fixupNode(3), withOutput(newCtx(), "boom v1"));
			expect(agent.messages[0]).not.toContain("Likely root cause");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("injects a FENCED root-cause note from the 2nd fixup visit onward", async () => {
		process.env.OMP_SQUAD_REFLEXION = "1";
		const dir = tmp();
		try {
			const agent = new RecordingDriver();
			const ex = makeExecutor(agent, dir);
			const ctx = newCtx();
			await ex.runAgent(fixupNode(4), withOutput(ctx, "boom v1"));
			await ex.runAgent(fixupNode(4), withOutput(ctx, "boom v2 (still failing, different output)"));
			expect(agent.messages[1]).toContain("===== BEGIN reflection (untrusted data) =====");
			expect(agent.messages[1]).toContain("flaky assertion");
			expect(agent.messages[1]).toContain("widen the tolerance");
			expect(agent.messages[1]).toContain("===== END reflection =====");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an UNCHANGED failure output refutes the prior hypothesis instead of re-guessing", async () => {
		process.env.OMP_SQUAD_REFLEXION = "1";
		const dir = tmp();
		try {
			const agent = new RecordingDriver();
			let llmCalls = 0;
			const ex = new SingleAgentExecutor({
				cwd: "/tmp/wt",
				acquireAgent: async () => agent,
				emit: () => {},
				gate: async () => "",
				reflection: {
					stateDir: dir,
					repo: "/repo",
					agentId: "a1",
					llm: async () => {
						llmCalls++;
						return { rootCause: "guess #1", whatToDoDifferently: "try X" };
					},
				},
			});
			const ctx = newCtx();
			await ex.runAgent(fixupNode(5), withOutput(ctx, "boom, same every time"));
			await ex.runAgent(fixupNode(5), withOutput(ctx, "boom, same every time")); // identical output ⇒ guess #1 generated + injected here
			await ex.runAgent(fixupNode(5), withOutput(ctx, "boom, same every time")); // still identical ⇒ refutation, no new llm call

			expect(llmCalls).toBe(1); // only ONE reflect() call across attempts 2 and 3
			expect(agent.messages[2]).toContain("did NOT fix this");
			expect(agent.messages[2]).toContain("guess #1");
			expect(agent.messages[2]).not.toContain("try X"); // refutation framing, not the original suggestion re-injected
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// ── identity safety (noisegate-compaction concern 03, red-team RT2-1) ────────────────────────────
	//
	// A REAL oversized failing output now reaches `lastOutput` via runCommand's `reduceOutput`, which
	// appends a `[N bytes omitted — full: <path>]` pointer carrying a FRESH ts+nonce on every single
	// reduction — even when the underlying failure text is byte-identical. Before `identityNormalize`
	// was wired into `hashOutput`'s input here, that alone defeated refutation on every oversized retry:
	// the raw strings never matched, so the SAME reproduced failure looked like a brand-new one forever.

	test("(concern 03) refutation still fires when only the offload POINTER NONCE differs between two oversized-failure visits", async () => {
		process.env.OMP_SQUAD_REFLEXION = "1";
		const dir = tmp();
		try {
			const agent = new RecordingDriver();
			let llmCalls = 0;
			const ex = new SingleAgentExecutor({
				cwd: "/tmp/wt",
				acquireAgent: async () => agent,
				emit: () => {},
				gate: async () => "",
				reflection: {
					stateDir: dir,
					repo: "/repo",
					agentId: "a1",
					llm: async () => {
						llmCalls++;
						return { rootCause: "guess #1", whatToDoDifferently: "try X" };
					},
				},
			});
			const ctx = newCtx();
			// Same underlying failure tail every time; only the offload pointer's ts+nonce differs, exactly
			// as two REAL `reduceOutput` calls on identical input would produce.
			const body = "SAME FAILURE TAIL: assertion failed at line 42\n".repeat(50);
			const reducedA = `${body}\n[1234 bytes omitted — full: /tmp/state/gate-logs/a1/1700000000000-aaaaaaaa-executor-steer.log]`;
			const reducedB = `${body}\n[1234 bytes omitted — full: /tmp/state/gate-logs/a1/1700000005000-bbbbbbbb-executor-steer.log]`;

			await ex.runAgent(fixupNode(5), withOutput(ctx, reducedA)); // 1st visit: no reflection yet
			await ex.runAgent(fixupNode(5), withOutput(ctx, reducedA)); // 2nd visit: reflects, stores guess #1
			await ex.runAgent(fixupNode(5), withOutput(ctx, reducedB)); // 3rd visit: DIFFERENT raw string, same normalized content

			expect(llmCalls).toBe(1); // no second guess — the nonce-only difference must not look like progress
			expect(agent.messages[2]).toContain("did NOT fix this");
			expect(agent.messages[2]).toContain("guess #1");
			expect(agent.messages[2]).not.toContain("try X");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("(concern 03) a GENUINELY different oversized failure still gets a fresh reflection, not a false refutation", async () => {
		process.env.OMP_SQUAD_REFLEXION = "1";
		const dir = tmp();
		try {
			const agent = new RecordingDriver();
			let llmCalls = 0;
			const ex = new SingleAgentExecutor({
				cwd: "/tmp/wt",
				acquireAgent: async () => agent,
				emit: () => {},
				gate: async () => "",
				reflection: {
					stateDir: dir,
					repo: "/repo",
					agentId: "a1",
					llm: async () => {
						llmCalls++;
						return { rootCause: `guess #${llmCalls}`, whatToDoDifferently: "try something" };
					},
				},
			});
			const ctx = newCtx();
			const reducedA = `assertion failed: X != Y\n[500 bytes omitted — full: /tmp/state/gate-logs/a1/1700000000000-aaa-executor-steer.log]`;
			// A DIFFERENT core failure, with its own (also pointer-shaped) offload line — identityNormalize
			// must strip the pointer without collapsing genuinely distinct failures into "the same".
			const reducedB = `assertion failed: totally unrelated message Z\n[500 bytes omitted — full: /tmp/state/gate-logs/a1/1700000009000-bbb-executor-steer.log]`;

			await ex.runAgent(fixupNode(5), withOutput(ctx, reducedA)); // 1st visit
			await ex.runAgent(fixupNode(5), withOutput(ctx, reducedA)); // 2nd visit: reflects (guess #1)
			await ex.runAgent(fixupNode(5), withOutput(ctx, reducedB)); // 3rd visit: genuinely different failure

			expect(llmCalls).toBe(2); // a real change in the failure ⇒ a NEW reflect() call, not a refutation
			expect(agent.messages[2]).not.toContain("did NOT fix this");
			expect(agent.messages[2]).toContain("guess #2");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("skips the LAST visit before the node's overflow tier (no point reflecting right before escalate)", async () => {
		process.env.OMP_SQUAD_REFLEXION = "1";
		const dir = tmp();
		try {
			const agent = new RecordingDriver();
			const ex = makeExecutor(agent, dir);
			const node = fixupNode(3); // maxVisits 3: visits 1,2 reflect-eligible, visit 3 is the last try
			const ctx = newCtx();
			await ex.runAgent(node, withOutput(ctx, "v1"));
			await ex.runAgent(node, withOutput(ctx, "v2"));
			expect(agent.messages[1]).toContain("Likely root cause"); // 2nd visit: reflects
			await ex.runAgent(node, withOutput(ctx, "v3"));
			expect(agent.messages[2]).not.toContain("Likely root cause"); // 3rd (last) visit: skipped
			expect(agent.messages[2]).not.toContain("did NOT fix this");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("(M1) a fixup node with NO explicit maxVisits still reflects on the 2nd attempt (guard falls back to the engine cap, not undefined)", async () => {
		process.env.OMP_SQUAD_REFLEXION = "1";
		const dir = tmp();
		try {
			const agent = new RecordingDriver();
			const ex = makeExecutor(agent, dir);
			const node = fixupNode(undefined); // hand-authored: no maxVisits — must NOT fall through to "reflect forever incl. last visit"
			const ctx = newCtx();
			await ex.runAgent(node, withOutput(ctx, "v1"));
			await ex.runAgent(node, withOutput(ctx, "v2"));
			// The defensive fallback (?? DEFAULT_FIXUP_VISIT_CAP=50) leaves attempts 2..49 eligible, so the
			// 2nd attempt here still reflects — the fix only bounds the FAR end (attempt 50), which a sane
			// loop never reaches; it never regresses the common early attempts.
			expect(agent.messages[1]).toContain("Likely root cause");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("never fires for a non-fixup node id, even with identical shape", async () => {
		process.env.OMP_SQUAD_REFLEXION = "1";
		const dir = tmp();
		try {
			const agent = new RecordingDriver();
			const ex = makeExecutor(agent, dir);
			const ctx = newCtx();
			await ex.runAgent(otherNode(), withOutput(ctx, "boom v1"));
			await ex.runAgent(otherNode(), withOutput(ctx, "boom v2"));
			expect(agent.messages[1]).not.toContain("Likely root cause");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a reflect() failure (llm throws) degrades to no note, never blocks the turn", async () => {
		process.env.OMP_SQUAD_REFLEXION = "1";
		const dir = tmp();
		try {
			const agent = new RecordingDriver();
			const ex = new SingleAgentExecutor({
				cwd: "/tmp/wt",
				acquireAgent: async () => agent,
				emit: () => {},
				gate: async () => "",
				reflection: {
					stateDir: dir,
					repo: "/repo",
					agentId: "a1",
					llm: async () => {
						throw new Error("model unreachable");
					},
				},
			});
			const ctx = newCtx();
			await ex.runAgent(fixupNode(4), withOutput(ctx, "v1"));
			await expect(ex.runAgent(fixupNode(4), withOutput(ctx, "v2"))).resolves.toEqual(expect.objectContaining({ outcome: "succeeded" }));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

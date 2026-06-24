import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { AgentDriver } from "../src/agent-driver.ts";
import type { RpcSessionState } from "../src/types.ts";
import { SingleAgentExecutor, type SingleAgentExecutorOptions } from "../src/workflow/executor.ts";
import type { RunContext, WorkflowNode } from "../src/workflow/types.ts";

/** Minimal AgentDriver that records the exact message each prompt receives, then ends the turn. */
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
  setModel(): Promise<unknown> {
    return Promise.resolve();
  }
  setThinkingLevel(): Promise<unknown> {
    return Promise.resolve();
  }
  respondUi(): void {}
  respondHostTool(): void {}
}

const node = (id: string): WorkflowNode => ({ id, kind: "agent", label: id, prompt: `do ${id}`, attrs: {} });
const ctx = (): RunContext => ({ goal: "G", vars: {} });

function makeExecutor(agent: RecordingDriver, decoratePrompt?: SingleAgentExecutorOptions["decoratePrompt"]): SingleAgentExecutor {
  return new SingleAgentExecutor({ cwd: process.cwd(), acquireAgent: async () => agent, emit: () => {}, gate: async () => "Revise", decoratePrompt });
}

describe("executor feed-forward", () => {
  test("folds review comments into the first agent node after a gate — exactly once", async () => {
    const agent = new RecordingDriver();
    const ex = makeExecutor(agent, () => "--- Reviewer comments to address ---\n- fix the scope");
    await ex.humanGate(node("approve"), ["Approve", "Revise"], ctx());
    await ex.runAgent(node("plan"), ctx());
    expect(agent.messages[0]).toContain("fix the scope");
    // The same comments must NOT re-inject on the next node (one shared thread).
    await ex.runAgent(node("implement"), ctx());
    expect(agent.messages[1]).not.toContain("fix the scope");
  });

  test("no gate → no decoration", async () => {
    const agent = new RecordingDriver();
    const ex = makeExecutor(agent, () => "SHOULD-NOT-APPEAR");
    await ex.runAgent(node("plan"), ctx());
    expect(agent.messages[0]).not.toContain("SHOULD-NOT-APPEAR");
    expect(agent.messages[0]).toContain("do plan");
  });

  test("decoratePrompt returning undefined adds nothing after a gate", async () => {
    const agent = new RecordingDriver();
    const ex = makeExecutor(agent, () => undefined);
    await ex.humanGate(node("approve"), ["Approve"], ctx());
    await ex.runAgent(node("to_plane"), ctx());
    expect(agent.messages[0]).toContain("do to_plane");
  });
});

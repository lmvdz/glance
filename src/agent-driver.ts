/**
 * AgentDriver — the runtime contract the SquadManager programs against.
 *
 * Extracted verbatim from the surface RpcAgent already exposed, so that a second
 * fleet class (FlueServiceDriver, for commissioned Flue workers) can drop in
 * without touching the manager's status derivation, transcript, or federation.
 *
 * Both drivers are EventEmitters speaking the same omp-shaped event vocabulary:
 *   - "ready"                      driver is live and accepting commands
 *   - "event"   (frame)            AgentSessionEvent-ish (agent_start, message_update,
 *                                  message_end, tool_execution_start, agent_end, …)
 *   - "ui"      (RpcExtensionUIRequest)  interactive request needing a human answer
 *   - "hosttool"(call)             host tool call needing a result
 *   - "exit"    ({code, signal})   backing process/worker ended
 *   - "stderr"  (text)             diagnostic line
 */

import type { EventEmitter } from "node:events";
import type { RpcExtensionUIRequest, RpcSessionState } from "./types.ts";

/** A host-executed tool advertised to the runtime (omp `set_host_tools`). The model
 *  may then call it; the call surfaces back as a "hosttool" event for the host to answer. */
export interface HostToolDef {
	name: string;
	description: string;
	/** JSON Schema for the tool arguments. */
	parameters: Record<string, unknown>;
	label?: string;
	hidden?: boolean;
}

export interface AgentDriver extends EventEmitter {
	/** True once the driver has emitted "ready". */
	readonly isReady: boolean;
	/** True while the backing process/worker is usable. */
	readonly isAlive: boolean;
	/** Local OS pid of the backing omp/pi child process, when the driver has one (RpcAgent, from the
	 *  agent-host meta frame). Undefined for drivers with no local child (ACP/sandbox/flue/workflow).
	 *  Used to release file leases (leases.ts) keyed `omp:<pid>` — that is exactly the session string
	 *  lease-hook.ts mints from its OWN `process.pid` inside the child, i.e. this same pid — when the
	 *  agent is removed, so a dead agent never leaves a lease behind for the manager to reason about. */
	readonly pid?: number;

	/** Bring the driver live; resolve on "ready" (or reject on early failure/timeout). */
	start(timeoutMs?: number): Promise<void>;
	/** Tear down; never throws. */
	stop(): Promise<void>;
	/** Disconnect but leave the backing process running (daemon restart/upgrade). Optional. */
	detach?(): void;

	/** Begin a unit of work. omp: an agent turn. flue: invoke the worker's workflow. */
	prompt(message: string): Promise<void>;
	/** Interrupt in-flight work. omp: abort the turn. flue: cancel the run. */
	abort(): Promise<unknown>;

	/** Current session snapshot (todos / context / model / streaming). flue: synthetic. */
	getState(): Promise<RpcSessionState>;

	/** Label the session. Optional — no-op for drivers without a session name. */
	setSessionName?(name: string): Promise<unknown>;

	/** Switch the session model to a fuzzy spec (e.g. "opus", "claude-sonnet-4-5"). Optional. */
	setModel?(spec: string): Promise<unknown>;
	/** Available runtime models, when the backing harness exposes them. */
	getAvailableModels?(): Promise<{ models?: unknown[] }>;
	/** Switch the session reasoning effort (minimal|low|medium|high|xhigh). Optional. */
	setThinkingLevel?(level: string): Promise<unknown>;

	/** Register host-executed tools with the runtime so the model can call them. Optional —
	 *  a no-op for drivers whose runtime has no host-tool channel. */
	setHostTools?(tools: HostToolDef[]): void;

	/** Answer an extension UI request. No-op for non-interactive drivers. */
	respondUi(requestId: string, payload: { value?: string; confirmed?: boolean; cancelled?: true }): void;
	/** Complete a host tool call. No-op for non-interactive drivers. */
	respondHostTool(callId: string, text: string, isError?: boolean): void;
}

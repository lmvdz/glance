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

export interface AgentDriver extends EventEmitter {
	/** True once the driver has emitted "ready". */
	readonly isReady: boolean;
	/** True while the backing process/worker is usable. */
	readonly isAlive: boolean;

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

	/** Answer an extension UI request. No-op for non-interactive drivers. */
	respondUi(requestId: string, payload: { value?: string; confirmed?: boolean; cancelled?: true }): void;
	/** Complete a host tool call. No-op for non-interactive drivers. */
	respondHostTool(callId: string, text: string, isError?: boolean): void;
}

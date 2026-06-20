/**
 * RpcAgent — owns one `omp --mode rpc` child process and speaks the
 * newline-delimited JSON protocol documented in omp's rpc.md.
 *
 * We deliberately re-implement the thin transport (rather than importing the
 * heavyweight `RpcClient`) so omp-squad stays decoupled from omp's internal
 * module graph and survives `omp update`. We import omp's RPC *types*
 * (erased at runtime) to stay faithful to the wire contract.
 */

import { EventEmitter } from "node:events";
import type { Subprocess } from "bun";
import type {
	ApprovalMode,
	ThinkingLevel,
	RpcExtensionUIRequest,
	RpcSessionState,
} from "./types.ts";

export interface RpcAgentOptions {
	cwd: string;
	model?: string;
	approvalMode?: ApprovalMode;
	thinking?: ThinkingLevel;
	/** Extra CLI args appended verbatim. */
	extraArgs?: string[];
	/** Override the omp binary (defaults to `omp` on PATH). */
	bin?: string;
}

type ResponseFrame = {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
};

type HostToolCallFrame = {
	type: "host_tool_call";
	id: string;
	toolCallId: string;
	toolName: string;
	arguments: unknown;
};

type Pending = {
	resolve: (data: unknown) => void;
	reject: (err: Error) => void;
};

/**
 * Events emitted:
 *  - "ready"                       child wrote the ready frame
 *  - "event"   (frame)             any AgentSessionEvent (agent_start, message_update, …)
 *  - "ui"      (RpcExtensionUIRequest)  extension UI request
 *  - "hosttool"(HostToolCallFrame) host tool call needing a result
 *  - "exit"    ({code, signal})    child exited
 *  - "stderr"  (text)              child stderr line
 *  - "rawerror"(Error)             parse / transport error
 */
export class RpcAgent extends EventEmitter {
	private proc?: Subprocess<"pipe", "pipe", "pipe">;
	private readonly opts: RpcAgentOptions;
	private seq = 0;
	private readonly pending = new Map<string, Pending>();
	private buf = "";
	private ready = false;
	private exited = false;

	constructor(opts: RpcAgentOptions) {
		super();
		this.opts = opts;
	}

	get isReady(): boolean {
		return this.ready;
	}
	get isAlive(): boolean {
		return !!this.proc && !this.exited;
	}
	get pid(): number | undefined {
		return this.proc?.pid;
	}

	/** Spawn the child and resolve once the `ready` frame arrives (or reject on early exit/timeout). */
	async start(timeoutMs = 30_000): Promise<void> {
		const args = ["--mode", "rpc", "--cwd", this.opts.cwd];
		if (this.opts.model) args.push("--model", this.opts.model);
		if (this.opts.approvalMode) args.push("--approval-mode", this.opts.approvalMode);
		if (this.opts.thinking) args.push("--thinking", this.opts.thinking);
		if (this.opts.extraArgs) args.push(...this.opts.extraArgs);

		const proc = Bun.spawn([this.opts.bin ?? "omp", ...args], {
			cwd: this.opts.cwd,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, PI_RPC_EMIT_TITLE: "0" },
		});
		this.proc = proc;

		void this.pumpStdout(proc.stdout);
		void this.pumpStderr(proc.stderr);
		void proc.exited.then((code) => {
			this.exited = true;
			const signal = proc.signalCode ?? undefined;
			for (const [, p] of this.pending) p.reject(new Error("agent exited"));
			this.pending.clear();
			this.emit("exit", { code, signal });
		});

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error(`omp --mode rpc did not become ready within ${timeoutMs}ms`));
			}, timeoutMs);
			const onReady = () => {
				cleanup();
				resolve();
			};
			const onExit = () => {
				cleanup();
				reject(new Error("omp --mode rpc exited before ready"));
			};
			const cleanup = () => {
				clearTimeout(timer);
				this.off("ready", onReady);
				this.off("exit", onExit);
			};
			this.once("ready", onReady);
			this.once("exit", onExit);
		});
	}

	private async pumpStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		try {
			for await (const chunk of stream) {
				this.buf += decoder.decode(chunk, { stream: true });
				let nl: number;
				while ((nl = this.buf.indexOf("\n")) >= 0) {
					const line = this.buf.slice(0, nl).trim();
					this.buf = this.buf.slice(nl + 1);
					if (line) this.handleLine(line);
				}
			}
		} catch (err) {
			this.emit("rawerror", err instanceof Error ? err : new Error(String(err)));
		}
	}

	private async pumpStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		let acc = "";
		try {
			for await (const chunk of stream) {
				acc += decoder.decode(chunk, { stream: true });
				let nl: number;
				while ((nl = acc.indexOf("\n")) >= 0) {
					const line = acc.slice(0, nl);
					acc = acc.slice(nl + 1);
					if (line.trim()) this.emit("stderr", line);
				}
			}
		} catch {
			/* stderr best-effort */
		}
	}

	private handleLine(line: string): void {
		let frame: { type?: string; [k: string]: unknown };
		try {
			frame = JSON.parse(line);
		} catch {
			// Non-JSON noise on stdout — surface as stderr-ish.
			this.emit("stderr", line);
			return;
		}
		const t = frame.type;
		switch (t) {
			case "ready":
				this.ready = true;
				this.emit("ready");
				return;
			case "response": {
				const r = frame as ResponseFrame;
				if (r.id && this.pending.has(r.id)) {
					const p = this.pending.get(r.id)!;
					this.pending.delete(r.id);
					if (r.success) p.resolve(r.data);
					else p.reject(new Error(r.error || `command ${r.command} failed`));
				}
				return;
			}
			case "extension_ui_request":
				this.emit("ui", frame as RpcExtensionUIRequest);
				return;
			case "host_tool_call":
				this.emit("hosttool", frame as HostToolCallFrame);
				return;
			case "host_tool_cancel":
			case "host_uri_request":
			case "host_uri_cancel":
				// Not driven by omp-squad surfaces; let the child time out / handle defaults.
				this.emit("event", frame);
				return;
			default:
				// Everything else (agent_start, message_update, tool_execution_*, etc.)
				this.emit("event", frame);
				return;
		}
	}

	private write(obj: unknown): void {
		if (!this.proc || this.exited) return;
		this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
		this.proc.stdin.flush();
	}

	/** Send a command and await its correlated response. */
	send<T = unknown>(cmd: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
		if (!this.proc || this.exited) return Promise.reject(new Error("agent not running"));
		const id = `sq_${++this.seq}`;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`command ${String(cmd.type)} timed out`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (d) => {
					clearTimeout(timer);
					resolve(d as T);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
			this.write({ ...cmd, id });
		});
	}

	/** Fire-and-forget (used for UI responses / host-tool results that have no `response`). */
	sendRaw(obj: unknown): void {
		this.write(obj);
	}

	// ── Convenience wrappers ──────────────────────────────────────────────────

	getState(): Promise<RpcSessionState> {
		return this.send<RpcSessionState>({ type: "get_state" });
	}

	async prompt(message: string): Promise<void> {
		// While streaming the child requires a streamingBehavior; default to steering.
		try {
			await this.send({ type: "prompt", message });
		} catch (err) {
			// Retry as a steer if it rejected for needing streamingBehavior.
			if (err instanceof Error && /streamingBehavior|streaming/i.test(err.message)) {
				await this.send({ type: "prompt", message, streamingBehavior: "steer" });
				return;
			}
			throw err;
		}
	}

	steer(message: string): Promise<unknown> {
		return this.send({ type: "steer", message });
	}

	abort(): Promise<unknown> {
		return this.send({ type: "abort" });
	}

	setSessionName(name: string): Promise<unknown> {
		return this.send({ type: "set_session_name", name });
	}

	bash(command: string): Promise<unknown> {
		return this.send({ type: "bash", command });
	}

	/** Answer an extension_ui_request. */
	respondUi(requestId: string, payload: { value?: string; confirmed?: boolean; cancelled?: true }): void {
		this.sendRaw({ type: "extension_ui_response", id: requestId, ...payload });
	}

	/** Complete a host_tool_call. */
	respondHostTool(callId: string, text: string, isError = false): void {
		this.sendRaw({
			type: "host_tool_result",
			id: callId,
			isError,
			result: { content: [{ type: "text", text }] },
		});
	}

	async stop(): Promise<void> {
		if (!this.proc || this.exited) return;
		try {
			this.proc.stdin.end();
		} catch {
			/* ignore */
		}
		this.proc.kill();
		try {
			await Promise.race([this.proc.exited, Bun.sleep(2000)]);
		} catch {
			/* ignore */
		}
		if (!this.exited) {
			try {
				this.proc.kill(9 as never);
			} catch {
				/* ignore */
			}
		}
	}
}

export type { HostToolCallFrame };

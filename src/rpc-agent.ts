/**
 * RpcAgent — the daemon-side client for one agent, talking to a detached
 * `agent-host` over a Unix domain socket (NOT a direct child anymore).
 *
 * `start()` attaches to an existing host if its socket is live (so the daemon
 * reconnects to surviving agents after a restart/upgrade), otherwise spawns a
 * fresh detached host and connects. The public surface is unchanged — it still
 * implements `AgentDriver` (same events, same convenience methods) — only the
 * transport moved from child stdio to a socket. omp RPC *types* are imported
 * type-only to stay faithful to the wire contract.
 */

import { EventEmitter } from "node:events";
import * as path from "node:path";
import type { Socket } from "bun";
import type { AgentDriver } from "./agent-driver.ts";
import { socketPathFor } from "./agent-host.ts";
import type { ApprovalMode, RpcExtensionUIRequest, RpcSessionState, ThinkingLevel } from "./types.ts";

export interface RpcAgentOptions {
	/** Stable id (socket path derives from it). Omit for a transient auto-generated id. */
	id?: string;
	cwd: string;
	model?: string;
	approvalMode?: ApprovalMode;
	thinking?: ThinkingLevel;
	/** Override the omp binary the host launches (defaults to `omp` on PATH). */
	bin?: string;
	/** Socket path override (defaults to socketPathFor(id)). */
	socket?: string;
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

const HOST_ENTRY = path.join(import.meta.dir, "agent-host-main.ts");

/**
 * Events emitted:
 *  - "ready"                        host's omp child is live
 *  - "event"   (frame)              any AgentSessionEvent (agent_start, message_update, …)
 *  - "ui"      (RpcExtensionUIRequest)  extension UI request
 *  - "hosttool"(HostToolCallFrame)  host tool call needing a result
 *  - "exit"    ({code})             the omp child / host ended
 *  - "stderr"  (text)               diagnostic line
 */
export class RpcAgent extends EventEmitter implements AgentDriver {
	private sock?: Socket<undefined>;
	private readonly opts: RpcAgentOptions;
	private readonly socketPath: string;
	private readonly id: string;
	private seq = 0;
	private readonly pending = new Map<string, Pending>();
	private buf = "";
	private ready = false;
	private exited = false;
	private detaching = false;
	private hostPid?: number;

	constructor(opts: RpcAgentOptions) {
		super();
		this.opts = opts;
		this.id = opts.id ?? `omp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
		this.socketPath = opts.socket ?? socketPathFor(this.id);
	}

	get isReady(): boolean {
		return this.ready;
	}
	get isAlive(): boolean {
		return !!this.sock && !this.exited;
	}
	get pid(): number | undefined {
		return this.hostPid;
	}

	/**
	 * Attach to a live host, or spawn a detached one, then resolve once ready.
	 *
	 * The fresh-spawn path is retried within `timeoutMs`: under load a just-spawned host's omp child
	 * can die during cold start ("exited before ready"), which is transient — the host then removes its
	 * own socket and exits, so respawning a clean host recovers it. Without this a single load-induced
	 * cold-start death permanently killed the agent and turned the acceptance gate red against code that
	 * is actually fine (OMPSQ-188). The ATTACH path stays single-shot: a dead host we attached to is a
	 * real failure, never something to respawn over.
	 */
	async start(timeoutMs = 30_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		const left = () => Math.max(0, deadline - Date.now());
		if (await this.connect()) {
			await this.waitReady(left());
			return;
		}
		let lastErr: unknown;
		while (left() > 0) {
			this.resetForRespawn();
			this.spawnHost();
			if (!(await this.connectWithRetry(left()))) {
				lastErr = new Error(`agent host for ${this.id} did not come up`);
				break; // connectWithRetry exhausted the whole budget — no time left to respawn
			}
			try {
				await this.waitReady(left());
				return;
			} catch (e) {
				lastErr = e; // omp died during cold start — drop the dead socket and respawn if budget remains
				if (left() > 0) await Bun.sleep(200);
			}
		}
		throw lastErr ?? new Error(`agent host for ${this.id} did not come up`);
	}

	private spawnHost(): void {
		const cmd = [process.execPath, HOST_ENTRY, "--id", this.id, "--cwd", this.opts.cwd, "--socket", this.socketPath];
		if (this.opts.model) cmd.push("--model", this.opts.model);
		if (this.opts.approvalMode) cmd.push("--approval", this.opts.approvalMode);
		if (this.opts.thinking) cmd.push("--thinking", this.opts.thinking);
		if (this.opts.bin) cmd.push("--bin", this.opts.bin);
		const proc = Bun.spawn(cmd, { cwd: this.opts.cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
		proc.unref();
	}

	private async connect(): Promise<boolean> {
		try {
			// Bind handlers to the resolved socket identity: after a respawn a late close/data event
			// from a previous (dead) host must not mutate this client's state for the new socket.
			const sock = await Bun.connect<undefined>({
				unix: this.socketPath,
				socket: {
					data: (s, chunk) => {
						if (s === this.sock) this.onData(chunk);
					},
					close: (s) => {
						if (s === this.sock) this.onClose();
					},
					error: () => {},
				},
			});
			this.sock = sock;
			return true;
		} catch {
			return false;
		}
	}

	private async connectWithRetry(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (await this.connect()) return true;
			await Bun.sleep(120);
		}
		return false;
	}

	/** Clear per-attempt state (dead socket, ready/exit flags, parse buffer, pending calls) so start()
	 *  can respawn a fresh host cleanly after a cold-start death. */
	private resetForRespawn(): void {
		try {
			this.sock?.end();
		} catch {
			/* ignore */
		}
		this.sock = undefined;
		this.ready = false;
		this.exited = false;
		this.buf = "";
		for (const [, p] of this.pending) p.reject(new Error("agent host respawned"));
		this.pending.clear();
	}

	private waitReady(timeoutMs: number): Promise<void> {
		if (this.ready) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error(`agent ${this.opts.id} not ready within ${timeoutMs}ms`));
			}, timeoutMs);
			const onReady = () => {
				cleanup();
				resolve();
			};
			const onExit = () => {
				cleanup();
				reject(new Error("agent exited before ready"));
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

	private onData(chunk: Buffer | Uint8Array): void {
		this.buf += Buffer.from(chunk).toString();
		let nl: number;
		while ((nl = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, nl).trim();
			this.buf = this.buf.slice(nl + 1);
			if (line) this.handleLine(line);
		}
	}

	private onClose(): void {
		this.sock = undefined;
		// A deliberate detach (daemon shutdown) leaves the host alive — not an exit.
		if (this.detaching || this.exited) return;
		this.exited = true;
		for (const [, p] of this.pending) p.reject(new Error("agent connection lost"));
		this.pending.clear();
		this.emit("exit", { code: 1 });
	}

	private handleLine(line: string): void {
		let frame: { type?: string; __sq?: string; [k: string]: unknown };
		try {
			frame = JSON.parse(line);
		} catch {
			this.emit("stderr", line);
			return;
		}
		if (frame.__sq === "meta") {
			if (typeof frame.pid === "number") this.hostPid = frame.pid;
			if (frame.ready === true && !this.ready) {
				this.ready = true;
				this.emit("ready");
			}
			if (frame.exited !== false && frame.exited !== undefined && !this.exited) {
				this.exited = true;
				this.emit("exit", { code: typeof frame.exited === "number" ? frame.exited : 0 });
			}
			return;
		}
		switch (frame.type) {
			case "ready":
				if (!this.ready) {
					this.ready = true;
					this.emit("ready");
				}
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
			default:
				this.emit("event", frame);
				return;
		}
	}

	private write(obj: unknown): void {
		if (!this.sock) return;
		try {
			this.sock.write(`${JSON.stringify(obj)}\n`);
		} catch {
			/* socket gone */
		}
	}

	/** Send a command and await its correlated response. */
	send<T = unknown>(cmd: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
		if (!this.sock || this.exited) return Promise.reject(new Error("agent not connected"));
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

	/** Fire-and-forget (UI responses / host-tool results have no `response`). */
	sendRaw(obj: unknown): void {
		this.write(obj);
	}

	// ── AgentDriver convenience wrappers ──────────────────────────────────────

	getState(): Promise<RpcSessionState> {
		return this.send<RpcSessionState>({ type: "get_state" });
	}

	/** Fetch available slash commands (builtin + skills + extensions). Used on reattach,
	 *  where omp's startup `available_commands_update` push may predate our reconnection. */
	getAvailableCommands(): Promise<{ commands?: unknown[] }> {
		return this.send<{ commands?: unknown[] }>({ type: "get_available_commands" });
	}

	async prompt(message: string): Promise<void> {
		try {
			await this.send({ type: "prompt", message });
		} catch (err) {
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

	/** Switch the session model to a fuzzy spec, resolved against omp's available models. */
	async setModel(spec: string): Promise<unknown> {
		const { models } = await this.send<{ models: ModelInfo[] }>({ type: "get_available_models" });
		const m = pickModel(models, spec);
		if (!m) throw new Error(`no available model matches "${spec}"`);
		return this.send({ type: "set_model", provider: m.provider, modelId: m.id });
	}

	setThinkingLevel(level: string): Promise<unknown> {
		return this.send({ type: "set_thinking_level", level });
	}

	respondUi(requestId: string, payload: { value?: string; confirmed?: boolean; cancelled?: true }): void {
		this.sendRaw({ type: "extension_ui_response", id: requestId, ...payload });
	}

	respondHostTool(callId: string, text: string, isError = false): void {
		this.sendRaw({ type: "host_tool_result", id: callId, isError, result: { content: [{ type: "text", text }] } });
	}

	/** Disconnect but LEAVE the host + omp running (daemon shutdown / upgrade). */
	detach(): void {
		this.detaching = true;
		try {
			this.sock?.end();
		} catch {
			/* ignore */
		}
		this.sock = undefined;
	}

	/** Terminate the agent entirely: tell the host to kill omp and exit. */
	async stop(): Promise<void> {
		if (this.sock) {
			this.write({ __sq: "shutdown" });
			await Bun.sleep(150);
			try {
				this.sock.end();
			} catch {
				/* ignore */
			}
			this.sock = undefined;
		}
		this.exited = true;
	}
}

export type { HostToolCallFrame };

interface ModelInfo {
	provider: string;
	id: string;
}

/** Fuzzy-match a model spec ("opus", "claude-sonnet-4-5", "anthropic/claude-opus") to an available model. */
export function pickModel(models: ModelInfo[], spec: string): ModelInfo | undefined {
	const s = spec.trim().toLowerCase();
	if (!s) return undefined;
	const full = (m: ModelInfo): string => `${m.provider}/${m.id}`.toLowerCase();
	const exact = models.find((m) => full(m) === s || m.id.toLowerCase() === s);
	if (exact) return exact;
	if (s.includes("/")) {
		const [p, id] = s.split("/", 2);
		const scoped = models.find((m) => m.provider.toLowerCase() === p && m.id.toLowerCase().includes(id ?? ""));
		if (scoped) return scoped;
	}
	return models.find((m) => m.id.toLowerCase().includes(s)) ?? models.find((m) => full(m).includes(s));
}

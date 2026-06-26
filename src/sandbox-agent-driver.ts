/**
 * SandboxAgentDriver — runs an agent INSIDE a container (fabro's "off your laptop"
 * isolation), reached over `docker exec -i`'s stdio with omp's newline-JSON RPC.
 * Same `AgentDriver` contract as RpcAgent, so a sandboxed agent joins the roster /
 * TUI / web / workflows like any other — `kind` stays "omp-operator", only the
 * transport + execution location differ.
 *
 * Lifecycle: `start()` launches a fresh `--name` container (`sleep infinity`),
 * optionally bind-mounting the worktree at `workdir` (process + network isolation,
 * files still reviewable on the host), then `docker exec -i` the agent command and
 * speaks JSONL over its stdio. `stop()` removes the container; `detach()` leaves it
 * running. The agent command is injectable so tests drive a fake-omp server in a
 * real container without omp/tokens; the default targets a real `omp --mode rpc`.
 */

import { EventEmitter } from "node:events";
import type { Subprocess } from "bun";
import type { AgentDriver } from "./agent-driver.ts";
import { pickModel } from "./rpc-agent.ts";
import type { ApprovalMode, RpcExtensionUIRequest, RpcSessionState, ThinkingLevel } from "./types.ts";
import { gitNoSignEnv } from "./git-harden.ts";

export interface SandboxAgentOptions {
	/** Roster id; names the container `omp-sbx-<id>`. */
	id: string;
	/** Container image to run the agent in (e.g. an omp-provisioned image, or oven/bun for tests). */
	image: string;
	/** Working dir inside the container (the agent cwd). Default `/work`. */
	workdir?: string;
	/** Host path bind-mounted at `workdir` (usually the agent's worktree). */
	mount?: string;
	model?: string;
	approvalMode?: ApprovalMode;
	thinking?: ThinkingLevel;
	/** docker binary override. */
	docker?: string;
	/** Extra `docker run` args — e.g. `["--network=none"]` for network isolation. */
	runArgs?: string[];
	/** Build the in-container agent argv. Default: `omp --mode rpc`. Tests inject a fake-omp server. */
	agentCommand?: (o: { workdir: string; model?: string; approvalMode?: ApprovalMode; thinking?: ThinkingLevel }) => string[];
}

interface ModelInfo {
	provider: string;
	id: string;
}

type ResponseFrame = { type: "response"; id?: string; command: string; success: boolean; data?: unknown; error?: string };
type HostToolCallFrame = { type: "host_tool_call"; id: string; toolCallId: string; toolName: string; arguments: unknown };
type Pending = { resolve: (data: unknown) => void; reject: (err: Error) => void };

export class SandboxAgentDriver extends EventEmitter implements AgentDriver {
	readonly container: string;
	private readonly opts: SandboxAgentOptions;
	private readonly docker: string;
	private readonly workdir: string;
	private proc?: Subprocess<"pipe", "pipe", "pipe">;
	private seq = 0;
	private readonly pending = new Map<string, Pending>();
	private buf = "";
	private ready = false;
	private exited = false;
	private detaching = false;

	constructor(opts: SandboxAgentOptions) {
		super();
		this.opts = opts;
		this.docker = opts.docker ?? "docker";
		this.workdir = opts.workdir ?? "/work";
		this.container = `omp-sbx-${opts.id}`;
	}

	get isReady(): boolean {
		return this.ready;
	}
	get isAlive(): boolean {
		return !!this.proc && !this.exited;
	}

	async start(timeoutMs = 60_000): Promise<void> {
		await this.docker_(["rm", "-f", this.container]).catch(() => {}); // clear any stale container
		const runArgs = ["run", "-d", "--name", this.container, "-w", this.workdir];
		if (this.opts.mount) runArgs.push("-v", `${this.opts.mount}:${this.workdir}`);
		if (this.opts.runArgs) runArgs.push(...this.opts.runArgs);
		runArgs.push(this.opts.image, "sleep", "infinity");
		const created = await this.docker_(runArgs);
		if (created.code !== 0) throw new Error(`docker run failed: ${(created.stderr || created.stdout).trim().slice(0, 200)}`);

		try {
			const build = this.opts.agentCommand ?? defaultAgentCommand;
			const cmd = build({ workdir: this.workdir, model: this.opts.model, approvalMode: this.opts.approvalMode, thinking: this.opts.thinking });
			const noSign = Object.entries(gitNoSignEnv({})).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
			const proc = Bun.spawn([this.docker, "exec", "-i", "-e", "PI_RPC_EMIT_TITLE=0", ...noSign, this.container, ...cmd], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			this.proc = proc;
			void this.pumpStdout(proc.stdout);
			void this.pumpStderr(proc.stderr);
			void proc.exited.then((code) => {
				this.exited = true;
				for (const [, p] of this.pending) p.reject(new Error("sandbox agent exited"));
				this.pending.clear();
				if (!this.detaching) this.emit("exit", { code });
			});

			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					cleanup();
					reject(new Error(`sandboxed omp did not become ready within ${timeoutMs}ms`));
				}, timeoutMs);
				const onReady = () => {
					cleanup();
					resolve();
				};
				const onExit = () => {
					cleanup();
					reject(new Error("sandboxed omp exited before ready"));
				};
				const cleanup = () => {
					clearTimeout(timer);
					this.off("ready", onReady);
					this.off("exit", onExit);
				};
				this.once("ready", onReady);
				this.once("exit", onExit);
			});
			this.sendRaw({ type: "set_subagent_subscription", level: "progress" });
		} catch (err) {
			// start() failed after the container was created — don't leak it.
			try {
				this.proc?.kill();
			} catch {
				/* ignore */
			}
			this.proc = undefined;
			this.exited = true;
			await this.docker_(["rm", "-f", this.container]).catch(() => {});
			throw err;
		}
	}

	private async docker_(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
		const proc = Bun.spawn([this.docker, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		return { code: await proc.exited, stdout, stderr };
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
			this.emit("stderr", line);
			return;
		}
		switch (frame.type) {
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
			default:
				this.emit("event", frame);
				return;
		}
	}

	private write(obj: unknown): void {
		if (!this.proc || this.exited) return;
		this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
		this.proc.stdin.flush();
	}

	send<T = unknown>(cmd: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
		if (!this.proc || this.exited) return Promise.reject(new Error("sandbox agent not running"));
		const id = `sbx_${++this.seq}`;
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

	sendRaw(obj: unknown): void {
		this.write(obj);
	}

	getState(): Promise<RpcSessionState> {
		return this.send<RpcSessionState>({ type: "get_state" });
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

	abort(): Promise<unknown> {
		return this.send({ type: "abort" });
	}

	setSessionName(name: string): Promise<unknown> {
		return this.send({ type: "set_session_name", name });
	}

	async setModel(spec: string): Promise<unknown> {
		const { models } = await this.send<{ models: ModelInfo[] }>({ type: "get_available_models" });
		const m = pickModel(models, spec);
		if (!m) throw new Error(`no available model matches "${spec}"`);
		return this.send({ type: "set_model", provider: m.provider, modelId: m.id });
	}

	getAvailableModels(): Promise<{ models?: unknown[] }> {
		return this.send<{ models?: unknown[] }>({ type: "get_available_models" });
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

	/** Disconnect the exec but leave the container running (reattachable). */
	detach(): void {
		this.detaching = true;
		try {
			this.proc?.kill();
		} catch {
			/* ignore */
		}
		this.proc = undefined;
	}

	/** Terminate: stop the exec and remove the container. */
	async stop(): Promise<void> {
		try {
			this.proc?.kill();
		} catch {
			/* ignore */
		}
		this.proc = undefined;
		this.exited = true;
		await this.docker_(["rm", "-f", this.container]).catch(() => {});
	}
}

function defaultAgentCommand(o: { workdir: string; model?: string; approvalMode?: ApprovalMode; thinking?: ThinkingLevel }): string[] {
	const argv = ["omp", "--mode", "rpc", "--cwd", o.workdir];
	if (o.model) argv.push("--model", o.model);
	if (o.approvalMode) argv.push("--approval-mode", o.approvalMode);
	if (o.thinking) argv.push("--thinking", o.thinking);
	return argv;
}

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
import { existsSync } from "node:fs";
import { errText } from "./err-text.ts";
import * as path from "node:path";
import type { Socket } from "bun";
import type { AgentDriver, HostToolDef } from "./agent-driver.ts";
import { socketPathFor } from "./agent-host.ts";
import { Result } from "effect";
import type { ApprovalMode, RpcExtensionUIRequest, RpcSessionState, ThinkingLevel } from "./types.ts";
import { decodeHostToolCall, decodeResponseFrame, type HostToolCallFrame } from "./schema/agent-host-frame.ts";
import { harnessAuthEnv, scrubbedSpawnEnv } from "./spawn-env.ts";

export interface RpcAgentOptions {
	/** Stable id (socket path derives from it). Omit for a transient auto-generated id. */
	id?: string;
	cwd: string;
	model?: string;
	approvalMode?: ApprovalMode;
	thinking?: ThinkingLevel;
	appendSystemPrompt?: string;
	/** Override the omp binary the host launches (defaults to `omp` on PATH). */
	bin?: string;
	/** Harness name (omp-rpc family: "omp" | "pi" | …). Threaded to the host so it builds the right
	 *  approval-flag dialect (`--approval-mode` vs `--approve`) and extension set for this binary. */
	harness?: string;
	/** Socket path override (defaults to socketPathFor(id)). */
	socket?: string;
}

// ResponseFrame / HostToolCallFrame are defined + validated in ./schema/agent-host-frame.ts

type Pending = {
	resolve: (data: unknown) => void;
	reject: (err: Error) => void;
};

const HOST_ENTRY = path.join(import.meta.dir, "agent-host-main.ts");
/**
 * The `bun agent-host-main.ts` process is spawned with THIS directory as its cwd — never the tenant
 * worktree. Bun auto-loads a `bunfig.toml` from a process's spawn cwd and RUNS its `preload` scripts
 * before the entry file's own imports execute (verified empirically: `bun <absolute-entry-path>` run
 * from a cwd containing `bunfig.toml` executes that cwd's preload regardless of the entry path form).
 * `agent-host-main.ts`'s only use of `--cwd` is to hand `opts.cwd` to `runAgentHost`, which uses it
 * solely for the tenant's own omp/pi child (spawned through `scrubbedSpawnEnv` — see agent-host.ts) —
 * so a tenant worktree committing `bunfig.toml` + a preload script must never get to run inside THIS
 * process: that would bypass the scrub one level up, before it ever applies. `HOST_ENTRY` is always an
 * absolute path, so moving this process's cwd here does not change what gets loaded — only where a
 * hostile `bunfig.toml` could be picked up from, and this directory is part of the daemon's own trusted
 * checkout, never tenant content. (This process's OWN env is a separate concern from its cwd — see
 * `hostSpawnEnv` below: it used to carry the daemon's full, unscrubbed env too, which is what let a
 * same-uid tenant recover DATABASE_URL/BETTER_AUTH_SECRET/the voice master key straight out of this
 * process's own `/proc/<pid>/environ`, bunfig hole or not.)
 */
const HOST_SPAWN_CWD = path.dirname(HOST_ENTRY);

/**
 * The environment `bun agent-host-main.ts` itself boots with — the OUTER spawn below, one level above
 * the tenant omp/pi child agent-host.ts's own `scrubbedSpawnEnv` call already scrubs. Before this fix
 * `spawnHost` passed `{ ...process.env }` verbatim: the daemon's FULL environment — `DATABASE_URL`,
 * `BETTER_AUTH_SECRET`, and the voice boot secret (`OMP_SQUAD_SECRETS_KEY`/`GLANCE_SECRETS_KEY`, which
 * secrets.ts deletes from the DAEMON's own `process.env` at boot but can never retroactively erase from
 * an ALREADY-SPAWNED process's environ) — reaching a process any same-uid tenant child can read back
 * out of `/proc/<host-pid>/environ`, the kernel's immutable snapshot of a process's environ at exec
 * time. Cross-lineage audit (round 2, both codex and grok independently): decrypt every org's voice key
 * or forge a cross-org session from there.
 *
 * Routes the outer spawn through the SAME `scrubbedSpawnEnv` the inner child already uses, narrowed to
 * exactly what `agent-host-main.ts` and its transitive imports (`env-compat.ts`, `agent-host.ts`,
 * `harness-registry.ts`, `git-harden.ts`, `spawn-env.ts`, `state-dir.ts`) actually read from
 * `process.env` — grepped, not guessed:
 *   - `state-dir.ts`'s `resolveStateDir()` (via `squadSocketDir`/`pruneStaleSockets`, called inside
 *     `runAgentHost` for opportunistic stale-socket GC) reads `GLANCE_STATE_DIR`/`OMP_SQUAD_STATE_DIR`
 *     directly. Both names are `OMP_SQUAD_*`/`GLANCE_*`-prefixed, so `scrubbedSpawnEnv`'s shared
 *     prefix-denial rule (isSquadEnvCompatKey) strips them like any other daemon-namespaced var —
 *     re-admitted explicitly here, since this is trusted DAEMON config (an operator/test path override),
 *     never tenant-controlled content. Without this, a daemon running with a custom state dir (every
 *     test run — tests/setup.ts sets `OMP_SQUAD_STATE_DIR` to an isolated temp dir) spawns a host that
 *     resolves the DEFAULT `~/.glance` for its own socket-dir GC instead — silently wrong in tests, and
 *     in a real deployment a host that scans/prunes the wrong directory entirely (up to and including
 *     the operator's real `~/.glance` if a differently-configured daemon shares the machine).
 *   - `harness-registry.ts`'s `resolveBin`/`globalDefaultHarness` (which read `GLANCE_BIN`/`GLANCE_HARNESS`)
 *     are NOT on this path — `squad-manager.ts` resolves the binary BEFORE constructing `RpcAgent` and
 *     hands it down as `opts.bin`/the `--bin` flag, so the host process itself never needs those vars.
 *   - `agent-host.ts`'s own `harnessAuthEnv(process.env, opts.harness, opts.model)` call — one level
 *     further in, building the INNER child's env — reads the HOST's OWN `process.env` at that point, so
 *     the host process itself must already carry whatever single provider credential the tenant child
 *     will need. Narrowed here the SAME way (`harnessAuthEnv` with the SAME harness/model the daemon
 *     already knows about this agent), so the outer spawn never carries a wider credential grant than
 *     the inner one it exists to forward — never the other six providers' keys.
 * Pure and exported so the exact env this spawn gets can be asserted without a real process (spawn-env
 * test style already used elsewhere) — `spawnHost` below is the only production caller.
 *
 * @substrate exported for tests only — spawn-env.test.ts asserts this multi-tenant-secrets boundary
 * directly (DATABASE_URL/BETTER_AUTH_SECRET/the voice master key absent, GLANCE_STATE_DIR/provider
 * credential narrowing correct) instead of only through a real, slower end-to-end host spawn.
 */
export function hostSpawnEnv(source: NodeJS.ProcessEnv, harness?: string, model?: string): Record<string, string> {
	const inject: Record<string, string> = { ...harnessAuthEnv(source, harness, model) };
	const stateDir = source.GLANCE_STATE_DIR ?? source.OMP_SQUAD_STATE_DIR;
	if (stateDir) {
		inject.GLANCE_STATE_DIR = stateDir;
		inject.OMP_SQUAD_STATE_DIR = stateDir;
	}
	return scrubbedSpawnEnv(source, inject);
}

/**
 * Events emitted:
 *  - "ready"                        host's omp child is live
 *  - "event"   (frame)              any AgentSessionEvent (agent_start, message_update, …)
 *  - "ui"      (RpcExtensionUIRequest)  extension UI request
 *  - "hosttool"(HostToolCallFrame)  host tool call needing a result
 *  - "exit"    ({code})             the omp child / host ended
 *  - "stderr"  (text)               diagnostic line
 *  - "replayComplete" ()            the host finished writing its ring replay to THIS connection
 *                                    (agent-host.ts's `{"__sq":"replay_complete"}` marker, sent last —
 *                                    used by SquadManager's reattach settle gate to know precisely when
 *                                    to stop suppressing transition/pending recording, instead of
 *                                    guessing with a fixed tick).
 */
/**
 * `posix_spawn` returns ENOENT for a missing EXECUTABLE and for a missing WORKING DIRECTORY, and Bun's
 * error text names the executable either way. So a unit whose worktree vanished reported:
 *
 *     ENOENT: no such file or directory, posix_spawn '/…/bun/bin/bun.exe'
 *
 * — pointing at a 92 MB binary that plainly exists, and which the daemon itself is running from. The
 * operator's reasonable next question ("why are we executing bun.exe when we're on WSL?") is a dead end:
 * the `.exe` is just Volta's filename for a Linux ELF. Meanwhile the real cause — the cwd — is unnamed,
 * and `create()`'s failed-start cleanup then removes the worktree, destroying the evidence.
 *
 * Say which one is missing. An error that misidentifies its own cause costs more than the failure did.
 */
export function diagnoseSpawnFailure(err: unknown, exe: string, cwd: string): string {
	const text = errText(err);
	if (!text.includes("ENOENT")) return text;
	const exeMissing = !existsSync(exe);
	const cwdMissing = !existsSync(cwd);
	if (cwdMissing && !exeMissing) return `spawn failed: the working directory does not exist — ${cwd} (the executable ${exe} is present; posix_spawn reports ENOENT for a missing cwd but names the executable)`;
	if (exeMissing && !cwdMissing) return `spawn failed: the executable does not exist — ${exe}`;
	if (exeMissing && cwdMissing) return `spawn failed: neither the executable (${exe}) nor the working directory (${cwd}) exists`;
	// Both present: a race (the directory was removed between the check and the spawn), or an ENOENT from
	// somewhere else entirely. Never claim to know which — say what we verified.
	return `${text} — but both the executable (${exe}) and the working directory (${cwd}) exist as of this check; the cwd may have been removed concurrently`;
}

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
		if (this.opts.appendSystemPrompt) cmd.push("--append-system-prompt", this.opts.appendSystemPrompt);
		if (this.opts.bin) cmd.push("--bin", this.opts.bin);
		if (this.opts.harness) cmd.push("--harness", this.opts.harness);
		// env is passed EXPLICITLY as a SCRUBBED snapshot of the live process.env (hostSpawnEnv, above):
		// Bun.spawn without `env` inherits the process's ORIGINAL environ, silently dropping runtime
		// mutations (verified: a var set via `process.env.X = …` is invisible to a default-env child), so
		// `process.env` is still read explicitly here — just narrowed before the child ever sees it. The
		// test preload's hermetic model source (tests/setup.ts's dummy ANTHROPIC_API_KEY) — and any
		// operator tooling that adjusts env in-process before spawning agents — must still reach the host
		// (via `harnessAuthEnv` in `hostSpawnEnv`), or omp boots model-less and every spawn times out
		// inside the gate sandbox while "working" on logged-in hosts. `cwd` below is `HOST_SPAWN_CWD`, not
		// `this.opts.cwd` — see the doc on `HOST_SPAWN_CWD` above: this process must never load a
		// tenant-controlled `bunfig.toml`, independent of and in addition to the env now being scrubbed.
		//
		// A worktree that vanished before its host spawns is a real, previously-seen incident (OMPSQ-188)
		// — checked explicitly here (rather than relying on Bun.spawn's own ENOENT, which now names
		// HOST_SPAWN_CWD, not the tenant cwd, since that's what this spawn actually uses) so the
		// diagnostic still names the tenant worktree as the cause.
		if (!existsSync(this.opts.cwd)) {
			throw new Error(diagnoseSpawnFailure(new Error(`ENOENT: no such file or directory, posix_spawn '${cmd[0]}'`), cmd[0] as string, this.opts.cwd));
		}
		let proc: ReturnType<typeof Bun.spawn>;
		try {
			proc = Bun.spawn(cmd, { cwd: HOST_SPAWN_CWD, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true, env: hostSpawnEnv(process.env, this.opts.harness, this.opts.model) });
		} catch (err) {
			throw new Error(diagnoseSpawnFailure(err, cmd[0] as string, HOST_SPAWN_CWD));
		}
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
		if (frame.__sq === "replay_complete") {
			this.emit("replayComplete");
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
				const decoded = decodeResponseFrame(frame);
				if (Result.isFailure(decoded)) return; // malformed response — drop
				const r = decoded.success;
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
			case "host_tool_call": {
				const decoded = decodeHostToolCall(frame);
				if (Result.isFailure(decoded)) return; // malformed tool call — drop, never execute garbage
				this.emit("hosttool", decoded.success);
				return;
			}
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

	/** Advertise host-executed tools to omp so the model can call them (omp `set_host_tools`). */
	setHostTools(tools: HostToolDef[]): void {
		this.sendRaw({ type: "set_host_tools", tools });
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

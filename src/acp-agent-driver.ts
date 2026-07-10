/**
 * AcpAgentDriver — runs an ACP-speaking coding-agent runtime (`auggie --acp`, and
 * Claude Code / Codex via ACP) behind the same `AgentDriver` seam that `RpcAgent`
 * uses for `omp --mode rpc`. The runtime is a child process; the driver is the ACP
 * *client* (editor side) and speaks newline-delimited JSON-RPC 2.0 over the child's
 * stdio. It is bidirectional: the driver SENDS requests (initialize, session/new,
 * session/prompt) and RECEIVES notifications (session/update) and requests
 * (session/request_permission, fs/*, terminal/*) it must answer.
 *
 * The transport mirrors SandboxAgentDriver's spawn / pump / line / write scaffolding
 * verbatim; only the wire protocol differs (ACP JSON-RPC vs omp's newline-JSON). It
 * emits the SAME normalized frames the SquadManager already consumes, so an ACP
 * runtime joins the roster / TUI / web / status / receipts unchanged — only the
 * transport and the agent runtime differ.
 *
 * One driver, N harnesses: the child command comes from the harness registry
 * (`gemini --acp`, `opencode acp`, `npx claude-code-acp`, `codex-acp`, `auggie --acp`).
 * It is injectable so tests drive a fake in-process ACP agent without a real binary /
 * account / tokens.
 *
 * Spec-settled (no live binary needed): newline-delimited JSON-RPC framing, and the fixed
 * permission-option kind enum (allow_once|allow_always|reject_once|reject_always) — pickOption
 * fails CLOSED on a non-compliant kind-less option. Still live-verification-gated (concern 08,
 * carry `ponytail:` until a real payload confirms): usage_update / plan field names, and the
 * per-harness session-mode ids used for approval mapping.
 */

import { EventEmitter } from "node:events";
import type { Subprocess } from "bun";
import type { TodoPhase, TodoStatus } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { AgentDriver } from "./agent-driver.ts";
import { toAcpMcpServers } from "./mcp-config.ts";
import type { McpServerSpec, RpcSessionState } from "./types.ts";

export interface AcpAgentDriverOptions {
	/** Roster id (identity only; the transport needs no name). */
	id?: string;
	/** Working dir handed to the ACP runtime as the session cwd. */
	cwd: string;
	/** Model spec passed through to the runtime's CLI (e.g. "opus"). */
	model?: string;
	/** Injectable child argv. Default: `buildAcpCommand(model)`. Tests inject a fake ACP agent. */
	command?: string[];
	/** Approval intent from the manager. Mapped best-effort to an ACP session mode after session/new
	 *  (`yolo` → an auto-approve mode); ACP's setSessionMode is `unstable_`, so a missing/failing call
	 *  falls back silently to the per-call session/request_permission round-trip.
	 *
	 *  OPERATOR NOTE: every ACP `session/request_permission` is gate-class — a human answers it, and no
	 *  supervisor ever will. So a NON-yolo ACP unit needs a human present at each tool permission. That
	 *  is what "ask me" means, and it is the point (R7). For hands-off, spawn `yolo`: the driver then
	 *  answers from the operator's own instruction, deterministically, which is what dispatch does.
	 *  (grok-4.5) */
	approvalMode?: string;
	/** omp-squad context (fabric primer + tool-grant scoping + profile memory) the manager composed.
	 *  ACP has no system-prompt slot, so this is only used when `contextInjection` opts in — see below. */
	appendSystemPrompt?: string;
	/** How `appendSystemPrompt` reaches the agent. "none" (default, honest): the agent runs UNSCOPED —
	 *  ACP has no system-prompt channel. "prompt": prepend it as a leading content block on the first
	 *  turn (opt-in via OMP_SQUAD_ACP_CONTEXT=prompt — lossy: mixes trusted scoping into the user turn,
	 *  no prompt-caching). "mcp": serving the fabric primer / tool-grant TEXT itself via a synthetic MCP
	 *  context server — still not wired (distinct from `mcpServers` below, which attaches REAL
	 *  profile-selected MCP servers and IS wired via `session/new`). */
	contextInjection?: "none" | "prompt" | "mcp";
	/** MCP servers resolved for this unit's profile (plans/agent-profiles/02-skills-mcp-binding.md) —
	 *  translated to the ACP wire shape and handed to `session/new`'s `mcpServers` (see `mcpServers()`
	 *  below). This is ACP's only spec-blessed context/capability channel; distinct from
	 *  `contextInjection`, which is about the fabric primer / tool-grant prompt text, not real MCP tools. */
	mcpServers?: McpServerSpec[];
}

type Pending = { resolve: (data: unknown) => void; reject: (err: Error) => void };

/** ACP PermissionOption (subset we use). `kind` ∈ {allow_once,allow_always,reject_once,reject_always}. */
interface PermissionOption {
	optionId: string;
	name?: string;
	kind?: string;
}

/** Best-effort token usage, shaped for the manager's RunAccumulator (`message_end.usage`). */
interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
}

/** Default child argv: `auggie --acp [--model <m>]`.
 * ponytail: auggie's ACP entrypoint is `auggie --acp` (+ optional `--model`), per Augment docs;
 * not exercised against a live binary here — swap if the real CLI differs. */
export function buildAcpCommand(model?: string): string[] {
	return ["auggie", "--acp", ...(model ? ["--model", model] : [])];
}

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function asString(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
	return typeof v === "number" ? v : undefined;
}

/** ACP plan entries → one synthetic TodoPhase (ACP has no phase concept).
 * ponytail: plan entry field names (`content`/`title`, `status`) inferred from the schema;
 * verify against a live `auggie --acp`. */
function parsePlan(entries: unknown): TodoPhase[] {
	if (!Array.isArray(entries)) return [];
	const tasks = entries.flatMap((e): { content: string; status: TodoStatus }[] => {
		if (!isObj(e)) return [];
		const content = asString(e.content) ?? asString(e.title);
		if (!content) return [];
		const s = asString(e.status);
		const status: TodoStatus = s === "in_progress" || s === "completed" ? s : "pending";
		return [{ content, status }];
	});
	return tasks.length ? [{ name: "plan", tasks }] : [];
}

/** ACP usage_update → manager-shaped Usage, best-effort.
 * ponytail: ACP usage_update field names unconfirmed against a live auggie; map the common
 * token counters under both camelCase variants and leave the rest undefined. */
function parseUsage(update: Record<string, unknown>): Usage {
	return {
		input: asNumber(update.inputTokens) ?? asNumber(update.input),
		output: asNumber(update.outputTokens) ?? asNumber(update.output),
		cacheRead: asNumber(update.cacheReadTokens) ?? asNumber(update.cacheRead),
		cacheWrite: asNumber(update.cacheWriteTokens) ?? asNumber(update.cacheWrite),
		totalTokens: asNumber(update.totalTokens),
	};
}

/** Pick an option id matching the allow/reject decision by `kind`. FAILS CLOSED: the ACP kind enum is
 *  fixed (`allow_once|allow_always|reject_once|reject_always`), so if NO option matches the requested
 *  polarity (e.g. a non-compliant adapter emitted kind-less options) we return undefined and let
 *  respondUi cancel — never fall back to `options[0]`, which could be the OPPOSITE polarity and silently
 *  allow a call the operator denied (the fail-open coin-flip). Within a polarity, prefer the
 *  least-privilege option (`allow_once` over `allow_always`). */
export function pickOption(options: PermissionOption[], allow: boolean): string | undefined {
	const prefix = allow ? "allow" : "reject";
	const once = options.find((o) => o.kind === `${prefix}_once`);
	const match = once ?? options.find((o) => o.kind?.startsWith(prefix));
	return match?.optionId;
}

function parseOptions(v: unknown): PermissionOption[] {
	if (!Array.isArray(v)) return [];
	const out: PermissionOption[] = [];
	for (const o of v) {
		if (isObj(o) && typeof o.optionId === "string") {
			out.push({ optionId: o.optionId, name: asString(o.name), kind: asString(o.kind) });
		}
	}
	return out;
}

function summarize(toolCall: Record<string, unknown>): string {
	const title = asString(toolCall.title);
	const kind = asString(toolCall.kind);
	if (!title) return "Allow this action?";
	return kind ? `${kind}: ${title}` : title;
}

export class AcpAgentDriver extends EventEmitter implements AgentDriver {
	private readonly opts: AcpAgentDriverOptions;
	private proc?: Subprocess<"pipe", "pipe", "pipe">;
	private buf = "";
	private seq = 0;
	/** Outbound JSON-RPC requests awaiting a response, keyed by stringified id. */
	private readonly pending = new Map<string, Pending>();
	/** Inbound permission requests awaiting a `respondUi`, keyed by the minted UI id. */
	private readonly permits = new Map<string, { jsonrpcId: string | number; options: PermissionOption[] }>();
	private sessionId?: string;
	private ready = false;
	private exited = false;
	private detaching = false;
	private streaming = false;
	private lastUsage?: Usage;
	private todoPhases: TodoPhase[] = [];
	/** Whether the opt-in context block has already been prepended (first turn only). */
	private contextInjected = false;

	constructor(opts: AcpAgentDriverOptions) {
		super();
		this.opts = opts;
	}

	get isReady(): boolean {
		return this.ready;
	}
	get isAlive(): boolean {
		return !!this.proc && !this.exited;
	}

	async start(timeoutMs = 60_000): Promise<void> {
		const cmd = this.opts.command ?? buildAcpCommand(this.opts.model);
		const proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		this.proc = proc;
		void this.pumpStdout(proc.stdout);
		void this.pumpStderr(proc.stderr);
		void proc.exited.then((code) => {
			this.exited = true;
			for (const [, p] of this.pending) p.reject(new Error("acp agent exited"));
			this.pending.clear();
			if (!this.detaching) this.emit("exit", { code });
		});

		// JSON-RPC handshake: initialize → session/new. send() rejects on timeout / early exit,
		// so a failed handshake surfaces as a rejected start() just like the sandbox driver.
		const init = await this.send(
			"initialize",
			{
				protocolVersion: 1,
				// We decline client-side fs/terminal (the runtime uses its own fs); a runtime that needs
				// editor-mediated fs would require implementing fs/read_text_file etc. in handleRequest.
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
				clientInfo: { name: "omp-squad", version: "1" },
			},
			timeoutMs,
		);
		// Surface what the agent actually advertised — the static registry descriptor is a CEILING; a real
		// server may support less (e.g. no session/load). The manager logs this so a degraded mode is
		// explainable ("this gemini-cli doesn't support resume") instead of a silent surprise.
		if (isObj(init) && isObj(init.agentCapabilities)) this.emit("acpcapabilities", init.agentCapabilities);
		const sess = await this.send("session/new", { cwd: this.opts.cwd, mcpServers: this.mcpServers() }, timeoutMs);
		this.sessionId = isObj(sess) ? asString(sess.sessionId) : undefined;
		// Best-effort approval mode: ACP's set-mode is `unstable_`, so map yolo → an advertised auto-approve
		// mode when one exists, and fall back silently to the per-call session/request_permission round-trip
		// otherwise. Never fatal.
		await this.applyApprovalMode(isObj(sess) ? sess : {});
		this.ready = true;
		this.emit("ready");
	}

	/** MCP servers handed to the agent at session/new — the profile's resolved `McpServerSpec[]`
	 *  translated to the ACP wire shape (see `toAcpMcpServers`, src/mcp-config.ts, the one place both
	 *  harness families' translation logic lives). Empty when the unit's profile attaches no servers. */
	private mcpServers(): unknown[] {
		return toAcpMcpServers(this.opts.mcpServers);
	}

	/** Best-effort map of the manager's approval intent onto an ACP session mode. Only `yolo` is actionable
	 *  (auto-approve); stricter modes rely on the per-call permission round-trip, which already works. */
	private async applyApprovalMode(sess: Record<string, unknown>): Promise<void> {
		if (this.opts.approvalMode !== "yolo" || !this.sessionId) return;
		const modes = Array.isArray(sess.modes) ? sess.modes : Array.isArray(sess.availableModes) ? sess.availableModes : [];
		// Pick a mode whose id/name reads as auto-approve / bypass / yolo — discovered from what the agent
		// advertised, never assumed.
		const auto = modes.find((m) => {
			const s = `${isObj(m) ? (asString(m.id) ?? "") : ""} ${isObj(m) ? (asString(m.name) ?? "") : ""}`.toLowerCase();
			return /auto|yolo|bypass|accept|always/.test(s);
		});
		const modeId = isObj(auto) ? (asString(auto.id) ?? asString(auto.name)) : undefined;
		if (!modeId) return;
		try {
			await this.send("session/set_mode", { sessionId: this.sessionId, modeId }, 10_000);
		} catch {
			/* unstable_ upstream — the per-call permission round-trip covers approvals if this isn't supported */
		}
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

	// Framing is settled: the ACP transport spec MANDATES newline-delimited JSON over stdio (messages
	// must not contain embedded newlines), so pumpStdout's newline splitter is spec-correct for any
	// compliant agent — no Content-Length variant to handle.
	private handleLine(line: string): void {
		let msg: unknown;
		try {
			msg = JSON.parse(line);
		} catch {
			this.emit("stderr", line);
			return;
		}
		if (!isObj(msg)) {
			this.emit("stderr", line);
			return;
		}
		const id = msg.id;
		const method = asString(msg.method);
		const hasId = id !== undefined && id !== null;
		if (hasId && method) {
			// Inbound request (agent → client): we must reply.
			if (typeof id === "string" || typeof id === "number") this.handleRequest(id, method, msg.params);
			return;
		}
		if (hasId) {
			// Response to one of our outbound requests.
			this.resolvePending(id, msg);
			return;
		}
		if (method) {
			// Notification (no reply expected).
			this.handleNotification(method, msg.params);
		}
	}

	private resolvePending(id: unknown, msg: Record<string, unknown>): void {
		const key = String(id);
		const p = this.pending.get(key);
		if (!p) return;
		this.pending.delete(key);
		const err = msg.error;
		if (err !== undefined) {
			const message = isObj(err) ? (asString(err.message) ?? "ACP request failed") : "ACP request failed";
			p.reject(new Error(message));
			return;
		}
		p.resolve(msg.result);
	}

	private handleNotification(method: string, params: unknown): void {
		if (method !== "session/update" || !isObj(params)) return;
		const update = params.update;
		if (!isObj(update)) return;
		switch (asString(update.sessionUpdate)) {
			case "agent_message_chunk": {
				const content = update.content;
				if (isObj(content) && content.type === "text") {
					const text = asString(content.text);
					if (text !== undefined) {
						this.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
					}
				}
				return;
			}
			case "tool_call": {
				const title = asString(update.title);
				const kind = asString(update.kind);
				this.emit("event", { type: "tool_execution_start", toolName: kind ?? title ?? "tool", intent: title });
				return;
			}
			case "plan":
				this.todoPhases = parsePlan(update.entries);
				return;
			case "usage_update":
				this.lastUsage = parseUsage(update);
				return;
			default:
				// ponytail: agent_thought_chunk / tool_call_update / current_mode_update streamed but
				// unused by the manager; map them when the UI needs thoughts or live tool status.
				return;
		}
	}

	private handleRequest(id: string | number, method: string, params: unknown): void {
		if (method === "session/request_permission") {
			const p = isObj(params) ? params : {};
			const toolCall = isObj(p.toolCall) ? p.toolCall : {};
			const options = parseOptions(p.options);

			// The operator said `yolo`. Honor it HERE, deterministically, from their own instruction — do not
			// route it to a model that decides whether to approve. `applyApprovalMode` normally prevents these
			// requests from ever arriving, but ACP's setSessionMode is `unstable_`: when it is missing or the
			// agent advertises no auto mode, the harness falls back to asking per call. That fallback used to
			// land in the auto-supervisor's lap.
			if (this.opts.approvalMode === "yolo") {
				const optionId = pickOption(options, true);
				if (optionId) {
					this.write({ jsonrpc: "2.0", id, result: { outcome: { outcome: "selected", optionId } } });
					return;
				}
				// Fails CLOSED: a non-compliant agent emitted kind-less options, so allow cannot be told from
				// reject, and a guessed polarity could approve what the operator would have denied. A human
				// decides — but LOUDLY. The operator asked for hands-off, and an unattended unit that waits
				// forever WITHOUT SAYING WHY is the "can't finish" failure this project exists to kill. A
				// `notify` frame becomes a real attention row, so the stall surfaces as "needs you". (grok-4.5)
				this.emit("ui", {
					type: "extension_ui_request",
					id: `acpnotify_${++this.seq}`,
					method: "notify",
					notifyType: "warning",
					message: `--approval yolo cannot be honored for this permission: the agent offered no ACP option "kind" (allow_once|allow_always|reject_once|reject_always), so allow cannot be distinguished from reject. Waiting for a human.`,
				});
			}

			const uiId = `acpui_${++this.seq}`;
			this.permits.set(uiId, { jsonrpcId: id, options });
			this.emit("ui", {
				type: "extension_ui_request",
				id: uiId,
				method: "confirm",
				title: asString(toolCall.title) ?? "Permission requested",
				message: summarize(toolCall),
				// An ACP `session/request_permission` IS an approval gate: the harness stopped because it may
				// not grant itself this action. A HUMAN answers it.
				//
				// It was not marked as one. `gateClass` was decided by a string prefix — `gate_` on the id, or
				// a `GATE:` title — both conventions of omp's own RPC. ACP ids are `acpui_<n>` and the title
				// comes from the tool call, so EVERY permission request from every ACP harness (claude-code,
				// codex, opencode, gemini, grok) failed the test and became eligible for the auto-supervisor,
				// whose system prompt reads "When in doubt inside the worktree, approve." The classifier was
				// written for one harness and never revisited when glance became harness-agnostic.
				//
				// This is R7 of the founding brief, exactly: "the safety story is inverted — autonomy is
				// opt-out, safety is opt-in."
				gateClass: true,
			});
			return;
		}
		// fs/read_text_file | fs/write_text_file | terminal/* | unknown → not supported.
		// ponytail: we advertised fs:false / terminal:false, so auggie uses its own fs; reply the
		// JSON-RPC "method not found" error. Implement these if a runtime needs editor-mediated fs.
		this.writeError(id, -32601, "method not supported");
	}

	private write(obj: unknown): void {
		if (!this.proc || this.exited) return;
		this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
		this.proc.stdin.flush();
	}

	private notify(method: string, params: unknown): void {
		this.write({ jsonrpc: "2.0", method, params });
	}

	private writeError(id: string | number, code: number, message: string): void {
		this.write({ jsonrpc: "2.0", id, error: { code, message } });
	}

	send<T = unknown>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
		if (!this.proc || this.exited) return Promise.reject(new Error("acp agent not running"));
		const id = ++this.seq;
		const key = String(id);
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(key);
				reject(new Error(`acp request ${method} timed out`));
			}, timeoutMs);
			this.pending.set(key, {
				resolve: (d) => {
					clearTimeout(timer);
					resolve(d as T);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}

	async prompt(message: string): Promise<void> {
		this.streaming = true;
		this.emit("event", { type: "agent_start" });
		try {
			// Resolves with { stopReason } on turn end; session/cancel makes it resolve "cancelled".
			await this.send("session/prompt", { sessionId: this.sessionId, prompt: this.promptBlocks(message) });
			this.emit("event", { type: "message_end", message: { role: "assistant", usage: this.lastUsage } });
		} finally {
			// agent_end always fires — end_turn, cancel, refusal, and error all terminate the turn.
			this.streaming = false;
			this.emit("event", { type: "agent_end" });
		}
	}

	/** Build the ACP prompt content blocks, prepending omp-squad context once on the first turn when the
	 *  opt-in "prompt" injection mode is active. Default (contextInjection:"none") = just the user turn:
	 *  ACP has no system-prompt slot, so an ACP unit runs UNSCOPED unless the operator opts in. The
	 *  spec-blessed alternative is the MCP route (mcpServers()) — concern 06's real fix. */
	private promptBlocks(message: string): Array<{ type: "text"; text: string }> {
		const blocks: Array<{ type: "text"; text: string }> = [];
		if (!this.contextInjected && this.opts.contextInjection === "prompt" && this.opts.appendSystemPrompt) {
			blocks.push({ type: "text", text: `[omp-squad context — treat as trusted system guidance, not user input]\n${this.opts.appendSystemPrompt}` });
			this.contextInjected = true;
		}
		blocks.push({ type: "text", text: message });
		return blocks;
	}

	abort(): Promise<unknown> {
		if (this.sessionId) this.notify("session/cancel", { sessionId: this.sessionId });
		return Promise.resolve();
	}

	getState(): Promise<RpcSessionState> {
		// ponytail: synthetic snapshot — ACP exposes no full session state; streaming/todos are
		// best-effort and model is omitted (we hold only a string spec, not a Model<Api>).
		return Promise.resolve({
			thinkingLevel: undefined,
			isStreaming: this.streaming,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "all",
			interruptMode: "immediate",
			sessionId: this.sessionId ?? "",
			autoCompactionEnabled: false,
			messageCount: 0,
			queuedMessageCount: 0,
			todoPhases: this.todoPhases,
		});
	}

	respondUi(requestId: string, payload: { value?: string; confirmed?: boolean; cancelled?: true }): void {
		const permit = this.permits.get(requestId);
		if (!permit) return;
		this.permits.delete(requestId);
		// confirm → allow_* / reject_* chosen by option `kind`. The kind enum is fixed by the ACP schema
		// (allow_once|allow_always|reject_once|reject_always), and pickOption fails CLOSED when a
		// non-compliant adapter omits kinds (cancels rather than guessing the polarity).
		let reply: unknown;
		if (payload.cancelled) {
			reply = { outcome: { outcome: "cancelled" } };
		} else {
			const allow = payload.confirmed ?? (payload.value === "yes" || payload.value === "true");
			const optionId = pickOption(permit.options, allow);
			reply = optionId !== undefined ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
		}
		this.write({ jsonrpc: "2.0", id: permit.jsonrpcId, result: reply });
	}

	respondHostTool(): void {
		// ACP has no host-tool channel here; no-op.
	}

	detach(): void {
		this.detaching = true;
		try {
			this.proc?.kill();
		} catch {
			/* ignore */
		}
		this.proc = undefined;
	}

	async stop(): Promise<void> {
		if (this.streaming && this.sessionId) this.notify("session/cancel", { sessionId: this.sessionId });
		try {
			this.proc?.kill();
		} catch {
			/* ignore */
		}
		this.proc = undefined;
		this.exited = true;
	}
}

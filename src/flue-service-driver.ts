/**
 * FlueServiceDriver — adapts a commissioned Flue worker to the AgentDriver
 * contract, so a `flue-service` fleet member behaves like any other agent in
 * the SquadManager (status, transcript, federation) without new manager code.
 *
 * A "turn" here is one bounded workflow invocation: `prompt(msg)` runs the
 * worker's workflow with `{ text: msg }` (or `msg` parsed as JSON) and emits
 * omp-shaped frames around it — agent_start → message_update → message_end →
 * agent_end — which the manager's existing onAgentEvent maps to working → idle.
 *
 * The invocation is injectable (`buildInvocation`) so tests can drive a fixture
 * worker without the Flue toolchain; the default targets the real `flue run`.
 */

import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import * as path from "node:path";
import type { Subprocess } from "bun";
import type { AgentDriver } from "./agent-driver.ts";
import { allProviderAuthEnv, scrubbedSpawnEnv } from "./spawn-env.ts";
import { truncateLabel } from "./text-util.ts";
import type { RpcSessionState } from "./types.ts";

export interface FlueInvocation {
	bin: string;
	args: string[];
}

export interface FlueServiceOptions {
	/** Worker project directory (the invocation cwd). */
	dir: string;
	/** Flue workflow module name to invoke. */
	workflow: string;
	/** Run target. */
	target: "node" | "cloudflare";
	/** Override how the worker is invoked. Default: local `flue run`. */
	buildInvocation?: (payload: unknown) => FlueInvocation;
}

export class FlueServiceDriver extends EventEmitter implements AgentDriver {
	readonly dir: string;
	readonly workflow: string;
	readonly target: "node" | "cloudflare";
	private readonly buildInvocation: (payload: unknown) => FlueInvocation;
	private ready = false;
	private alive = true;
	private streaming = false;
	private child?: Subprocess<"ignore", "pipe", "pipe">;
	/** Last parsed workflow result (for inspection). */
	lastResult: unknown;

	constructor(opts: FlueServiceOptions) {
		super();
		this.dir = opts.dir;
		this.workflow = opts.workflow;
		this.target = opts.target;
		this.buildInvocation = opts.buildInvocation ?? ((payload) => this.defaultInvocation(payload));
	}

	get isReady(): boolean {
		return this.ready;
	}
	get isAlive(): boolean {
		return this.alive;
	}

	async start(): Promise<void> {
		this.ready = true;
		this.alive = true;
		this.emit("ready");
	}

	async stop(): Promise<void> {
		this.alive = false;
		this.ready = false;
		this.killChild();
		// No "exit" emit: a flue-service has no persistent process, and removal/kill
		// is driven explicitly by the manager.
	}

	/** Invoke the worker's workflow once; stream its result as agent frames. */
	async prompt(message: string): Promise<void> {
		const payload = parsePayload(message);
		const inv = this.buildInvocation(payload);
		this.streaming = true;
		this.emit("event", { type: "agent_start" });
		this.emit("event", { type: "tool_execution_start", toolName: `flue:${this.workflow}`, intent: truncateLabel(JSON.stringify(payload), 60) });
		try {
			const { stdout, stderr, code } = await this.exec(inv);
			if (code !== 0) {
				throw new Error(`flue run exited ${code}: ${truncateLabel(stderr || stdout, 200)}`);
			}
			const result = extractLastJsonObject(stdout);
			this.lastResult = result;
			const text = result !== undefined ? JSON.stringify(result, null, 2) : stdout.trim() || "(no output)";
			this.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
			this.emit("event", { type: "message_end" });
			this.streaming = false;
			this.emit("event", { type: "agent_end" });
		} catch (err) {
			this.streaming = false;
			this.emit("event", { type: "agent_end" });
			throw err instanceof Error ? err : new Error(String(err));
		}
	}

	abort(): Promise<unknown> {
		this.killChild();
		return Promise.resolve();
	}

	/** Synthetic snapshot: a flue-service has no todos / context window. */
	getState(): Promise<RpcSessionState> {
		return Promise.resolve({
			thinkingLevel: undefined,
			isStreaming: this.streaming,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "all",
			interruptMode: "immediate",
			sessionId: this.workflow,
			autoCompactionEnabled: false,
			messageCount: 0,
			queuedMessageCount: 0,
			todoPhases: [],
		});
	}

	setSessionName(): Promise<unknown> {
		return Promise.resolve();
	}

	// A `flue run` invocation surfaces no interactive UI / host-tool requests to us.
	respondUi(): void {}
	respondHostTool(): void {}

	private defaultInvocation(payload: unknown): FlueInvocation {
		const args = ["run", this.workflow, "--target", this.target, "--payload", JSON.stringify(payload)];
		const localBin = path.join(this.dir, "node_modules", ".bin", "flue");
		return existsSync(localBin) ? { bin: localBin, args } : { bin: "npx", args: ["flue", ...args] };
	}

	private async exec(inv: FlueInvocation): Promise<{ stdout: string; stderr: string; code: number }> {
		// `inv.bin` prefers the worker repo's OWN node_modules/.bin/flue (defaultInvocation, above) —
		// this is a tenant-agent spawn site like agent-host/omp-call/acp-agent-driver, running
		// repo-supplied code that must not see the daemon's DATABASE_URL / OMP_SQUAD_*/GLANCE_* secrets.
		// Route through the same scrub. `allProviderAuthEnv()` (NOT the narrowing `harnessAuthEnv`): a flue
		// worker's `.flue/agents` config picks its own model/vendor AT RUNTIME, independent of anything the
		// daemon knows about this commission, so there is no harness or model to narrow by — narrowing to
		// DEFAULT_PROVIDER would silently break every non-Anthropic flue workflow. This is the one deliberate
		// full-provider-grant exception (see allProviderAuthEnv's doc); the residual (a flue worker sees every
		// provider key) is the same same-uid tenant exposure the sandbox workstream owns, no worse than the
		// pre-scrub full-env inheritance this call site used to have.
		const proc = Bun.spawn([inv.bin, ...inv.args], {
			cwd: this.dir,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: scrubbedSpawnEnv(process.env, allProviderAuthEnv()),
		});
		this.child = proc;
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const code = await proc.exited;
		this.child = undefined;
		return { stdout, stderr, code };
	}

	private killChild(): void {
		try {
			this.child?.kill();
		} catch {
			/* ignore */
		}
		this.child = undefined;
	}
}

/** Treat a JSON-looking message as a payload object; otherwise wrap as `{ text }`. */
export function parsePayload(message: string): unknown {
	const t = message.trim();
	if (t.startsWith("{") || t.startsWith("[")) {
		try {
			return JSON.parse(t);
		} catch {
			/* not JSON — fall through */
		}
	}
	return { text: message };
}

/**
 * Extract the workflow result from `flue run` stdout: the result prints as a
 * pretty JSON object at column 0, after banner lines. Scan from the end for a
 * line starting with `{` and brace-match the first complete object.
 */
export function extractLastJsonObject(text: string): unknown {
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].startsWith("{") || lines[i].startsWith("[")) {
			const parsed = parseLeadingJson(lines.slice(i).join("\n"));
			if (parsed !== undefined) return parsed;
		}
	}
	return parseLeadingJson(text.trimStart());
}

/** Parse the first complete JSON value at the start of `s` via brace/bracket matching. */
function parseLeadingJson(s: string): unknown {
	let depth = 0;
	let inStr = false;
	let esc = false;
	let started = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (inStr) {
			if (esc) esc = false;
			else if (c === "\\") esc = true;
			else if (c === '"') inStr = false;
			continue;
		}
		if (c === '"') inStr = true;
		else if (c === "{" || c === "[") {
			depth++;
			started = true;
		} else if (c === "}" || c === "]") {
			depth--;
			if (started && depth === 0) {
				try {
					return JSON.parse(s.slice(0, i + 1));
				} catch {
					return undefined;
				}
			}
		}
	}
	return undefined;
}


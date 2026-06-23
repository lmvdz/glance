/**
 * Auto-supervisor — a standing pub/sub loop that answers managed agents'
 * pending input requests automatically, so the human never has to intervene.
 *
 * It subscribes to the daemon's WebSocket; whenever an agent enters status
 * "input" (i.e. its `pending[]` is non-empty), the supervisor consults ANOTHER
 * omp agent — a one-shot `omp -p --mode json` invocation wearing the
 * SUPERVISOR_SYSTEM prompt — to decide the answer, then submits it back over
 * the same socket as an `{type:"answer"}` command. The fleet keeps moving with
 * zero human action.
 *
 * Decision bias is APPROVE/advance: squad agents run in ISOLATED git worktrees
 * that are reviewed (diff) before they ever land on main, so auto-approving
 * normal development actions is safe — the worktree is the blast radius.
 *
 * The pure decision helpers (chooseFallback / parseDecision / formatRequestPrompt)
 * are side-effect-free and are what the test suite targets; `decide` and
 * `startSupervisor` add the omp spawn + the live socket around them.
 *
 * FILE MODE ONLY: this is a single global WS client that authenticates with the
 * file-mode bearer token (readToken + the `ompsq-token` subprotocol). DB mode's
 * WS requires a per-org session, so index.ts gates `startSupervisor` on `!dbHandle`;
 * DB-mode auto-supervision is the per-org, in-process `maybeAutoSupervise` inside
 * each SquadManager (no external WS client). See plans/mt-isolation/05-lifecycle.md.
 */

import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDTO, ClientCommand, PendingRequest, SquadEvent, TranscriptEntry } from "./types.ts";
import { decideTyped, extractJsonObject } from "./omp-call.ts";

/** Options that escape the worktree and are clearly destructive should be denied; everything else advances. */
export const SUPERVISOR_SYSTEM = [
	"You are an autonomous operator-proxy for a fleet of coding agents.",
	"Each agent works in its OWN isolated git worktree on a feature branch, and every change is reviewed via diff before it is ever landed on main. The worktree is the blast radius.",
	"Your job: keep the agents moving WITHOUT a human. Read the blocked request and the recent transcript, then return the answer that best advances the work.",
	"Policy:",
	"- APPROVE normal development actions (edits, reads, running tests/builds, installing deps, committing inside the worktree, spawning subagents) and choose the gate option that advances the task.",
	"- DENY only clearly destructive or irreversible actions that ESCAPE the worktree — e.g. force-pushing to main, deleting unrelated data, publishing a release, touching another repo or production. When in doubt inside the worktree, approve.",
	"- For an open question, give the single most reasonable, concrete answer that lets the agent proceed; do not ask the human anything.",
	'ALWAYS reply with STRICT JSON and nothing else: {"value": "<answer>"}.',
	'For a confirm the value is "yes" or "no". For a select the value is EXACTLY one of the offered options. For input/editor/tool the value is concise text.',
].join("\n");

/** Options whose text reads as an advance/approve gate. */
const APPROVE_RE = /approve|yes|allow|continue|proceed|confirm|accept/i;
/** Strings that mean "go ahead" when normalizing a confirm answer. */
const TRUTHY_RE = /^(yes|y|true|approve|allow|ok|okay)$/i;

const DECIDE_TIMEOUT_MS = 60_000;
const TRANSCRIPT_TIMEOUT_MS = 10_000;
const TRANSCRIPT_TAIL = 12;

/**
 * Deterministic decision used when the model is unavailable or returns junk.
 * Bias is to APPROVE / advance.
 *
 * ponytail: auto-approval is safe ONLY because squad agents live in isolated git
 * worktrees reviewed before merge — the worktree bounds the damage. Ceiling: if
 * non-worktree (in-place / production) agents are ever supervised, tighten this
 * policy (e.g. deny-by-default for confirms, require an allowlist of select gates).
 */
export function chooseFallback(req: PendingRequest): string {
	switch (req.kind) {
		case "confirm":
			return "yes";
		case "select": {
			const options = req.options ?? [];
			if (options.length === 0) return "";
			return options.find((o) => APPROVE_RE.test(o)) ?? options[0];
		}
		case "input":
		case "editor":
			return "continue";
		default:
			// Host-tool requests (source === "tool", kind === tool name) and anything unknown.
			return "";
	}
}

/** Read the answer field (.value, else .answer) and coerce a primitive to a string. */
function pickValue(obj: Record<string, unknown>): string | undefined {
	const v = obj.value ?? obj.answer;
	if (v === undefined || v === null) return undefined;
	if (typeof v === "string") return v;
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	return undefined;
}

/** Snap a free value to one of the offered options: case-insensitive exact, else substring either way; else undefined. */
function snapToOption(value: string, options: string[]): string | undefined {
	const v = value.trim().toLowerCase();
	if (!v) return undefined;
	const exact = options.find((o) => o.toLowerCase() === v);
	if (exact !== undefined) return exact;
	return options.find((o) => {
		const lo = o.toLowerCase();
		return lo.includes(v) || v.includes(lo);
	});
}

/**
 * Parse the model's output into a submit-ready answer string. Tolerant of fenced
 * blocks / prose; falls back to chooseFallback on any parse failure. For a select
 * it MUST NEVER return an out-of-options value.
 */
export function parseDecision(raw: string, req: PendingRequest): string {
	const obj = extractJsonObject(raw);
	const value = obj ? pickValue(obj) : undefined;
	if (value === undefined) return chooseFallback(req);
	switch (req.kind) {
		case "confirm":
			return TRUTHY_RE.test(value.trim()) ? "yes" : "no";
		case "select":
			return snapToOption(value, req.options ?? []) ?? chooseFallback(req);
		default:
			// input / editor / host-tool: free text the agent consumes verbatim.
			return value;
	}
}

/** Build the user prompt handed to the answerer: the request, its options, and recent transcript context. */
export function formatRequestPrompt(req: PendingRequest, context: string): string {
	const lines: string[] = [
		"A managed coding agent is blocked waiting for an answer. Decide it.",
		"",
		`Request kind: ${req.kind}`,
		`Title: ${req.title}`,
	];
	if (req.message) lines.push(`Message: ${req.message}`);
	if (req.placeholder) lines.push(`Placeholder/prefill: ${req.placeholder}`);
	if (req.options && req.options.length > 0) {
		lines.push("Options:");
		req.options.forEach((o, i) => lines.push(`  ${i + 1}. ${o}`));
	}
	lines.push("", "Recent transcript (oldest first, most recent last):", context.trim() || "(no transcript context available)", "");
	lines.push(
		'Respond with STRICT JSON only: {"value": "<answer>"}.',
		"- For a select, value MUST be exactly one of the options listed above (copy it verbatim).",
		'- For a confirm, value MUST be "yes" or "no".',
		"- For input/editor/tool, value is concise text that lets the agent proceed.",
	);
	return lines.join("\n");
}

/** Pull text content out of one assistant message object (ignores user/tool/thinking). */
function textOfMessage(msg: unknown): string {
	if (typeof msg !== "object" || msg === null) return "";
	const m = msg as Record<string, unknown>;
	if (m.role !== "assistant" || !Array.isArray(m.content)) return "";
	return m.content
		.map((c) => (typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text" ? String((c as Record<string, unknown>).text ?? "") : ""))
		.join("")
		.trim();
}

/**
 * Extract the assistant's FINAL text from an `omp --mode json` stdout stream
 * (one JSON event per line). Returns the last non-empty assistant text seen —
 * `message_end` / `turn_end` carry a single `message`; `agent_end` carries the
 * full `messages[]`. Tolerant of partial lines and unknown event shapes.
 */
function extractAssistantText(stdout: string): string {
	let last = "";
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let evt: unknown;
		try {
			evt = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (typeof evt !== "object" || evt === null) continue;
		const e = evt as Record<string, unknown>;
		if (Array.isArray(e.messages)) {
			for (let i = e.messages.length - 1; i >= 0; i--) {
				const t = textOfMessage(e.messages[i]);
				if (t) {
					last = t;
					break;
				}
			}
		} else if (e.message !== undefined) {
			const t = textOfMessage(e.message);
			if (t) last = t;
		}
	}
	return last;
}

/**
 * Consult the answerer agent for a decision. Spawns a one-shot
 * `omp -p --mode json --smol --system-prompt <SUPERVISOR_SYSTEM> <prompt>`
 * (uses `--model <opts.model>` instead of `--smol` when given). Never throws:
 * non-zero exit / timeout / empty output / parse failure all degrade to
 * chooseFallback(req).
 */
export async function decide(req: PendingRequest, context: string, opts?: { model?: string }): Promise<string> {
	const prompt = formatRequestPrompt(req, context);
	const args = ["-p", "--mode", "json", ...(opts?.model ? ["--model", opts.model] : ["--smol"]), "--system-prompt", SUPERVISOR_SYSTEM, prompt];
	return decideTyped<string>({
		args,
		timeoutMs: DECIDE_TIMEOUT_MS,
		parse: (out) => {
			const t = extractAssistantText(out);
			return t.trim() ? parseDecision(t, req) : undefined;
		},
		fallback: chooseFallback(req),
	});
}

/** The daemon auto-generates a bearer token on boot; read it the same way the CLI does (empty if absent). */
function readToken(): string {
	try {
		const dir = process.env.OMP_SQUAD_STATE_DIR || path.join(os.homedir(), ".omp", "squad");
		return readFileSync(path.join(dir, "access-token"), "utf8").trim();
	} catch {
		return "";
	}
}

/** Fetch the last ~12 transcript entries as flat decision context (best-effort; empty string on any failure). */
async function fetchContext(base: string, id: string, token: string): Promise<string> {
	try {
		const res = await fetch(`${base}/api/agents/${encodeURIComponent(id)}/transcript`, {
			headers: token ? { Authorization: `Bearer ${token}` } : {},
			signal: AbortSignal.timeout(TRANSCRIPT_TIMEOUT_MS),
		});
		if (!res.ok) return "";
		const entries = (await res.json()) as TranscriptEntry[];
		return entries
			.slice(-TRANSCRIPT_TAIL)
			.map((e) => `[${e.kind}] ${e.text}`)
			.join("\n");
	} catch {
		return "";
	}
}

/**
 * Start the standing supervisor loop. Opens the daemon WebSocket, and for every
 * agent that reports status "input", decides + submits an answer for each pending
 * request not already answered or in-flight. Reconnects with backoff on close.
 * Returns a stop() that closes the socket and clears timers.
 */
export function startSupervisor(opts: { port?: number; dryRun?: boolean; model?: string } = {}): () => void {
	const port = opts.port ?? 7878;
	const dryRun = opts.dryRun ?? false;
	const token = readToken();
	const base = `http://127.0.0.1:${port}`;
	const wsUrl = `ws://127.0.0.1:${port}/ws`;

	// ponytail: `answered` grows by one entry per request handled (requestIds are
	// unique and never reappear once answered). Low-volume for a control plane;
	// ceiling = unbounded over a very long-lived process. Upgrade path: evict ids
	// for agents that leave the roster (a `removed` event) if it ever matters.
	const answered = new Set<string>();
	const inflight = new Set<string>();

	let ws: WebSocket | undefined;
	let stopped = false;
	let backoff = 500;
	let reconnectTimer: Timer | undefined;

	const log = (line: string): void => void process.stdout.write(`${line}\n`);

	const resolveRequest = async (agent: AgentDTO, req: PendingRequest): Promise<void> => {
		let value: string;
		try {
			const context = await fetchContext(base, agent.id, token);
			value = await decide(req, context, opts.model ? { model: opts.model } : undefined);
		} catch {
			// decide() never throws, but fetchContext/await guards belt-and-suspenders.
			value = chooseFallback(req);
		}
		answered.add(req.id); // mark before send so a roster re-broadcast can't double-handle
		log(`supervised ${agent.name} [${req.kind}] "${req.title}" -> ${value}`);
		if (dryRun) return;
		if (ws && ws.readyState === WebSocket.OPEN) {
			try {
				ws.send(JSON.stringify({ type: "answer", id: agent.id, requestId: req.id, value } satisfies ClientCommand));
			} catch {
				answered.delete(req.id); // send failed mid-flight → retry on the next event
			}
		} else {
			answered.delete(req.id); // socket not open → retry when the roster replays on reconnect
		}
	};

	const handleAgent = (agent: AgentDTO): void => {
		if (agent.status !== "input") return;
		for (const req of agent.pending) {
			if (answered.has(req.id) || inflight.has(req.id)) continue;
			inflight.add(req.id);
			void resolveRequest(agent, req).finally(() => inflight.delete(req.id));
		}
	};

	const onMessage = (data: unknown): void => {
		let evt: SquadEvent;
		try {
			evt = JSON.parse(typeof data === "string" ? data : String(data)) as SquadEvent;
		} catch {
			return;
		}
		if (evt.type === "roster") for (const a of evt.agents) handleAgent(a);
		else if (evt.type === "agent") handleAgent(evt.agent);
	};

	const connect = (): void => {
		if (stopped) return;
		const sock = new WebSocket(wsUrl, token ? ["ompsq-token", token] : []);
		ws = sock;
		sock.addEventListener("open", () => {
			backoff = 500;
			log(`auto-supervisor connected to ${wsUrl}`);
		});
		sock.addEventListener("message", (ev: MessageEvent) => onMessage(ev.data));
		sock.addEventListener("error", () => {
			try {
				sock.close();
			} catch {
				/* already closing */
			}
		});
		sock.addEventListener("close", () => {
			if (stopped) return;
			reconnectTimer = setTimeout(connect, backoff);
			reconnectTimer.unref?.();
			backoff = Math.min(backoff * 2, 10_000);
		});
	};

	connect();

	return () => {
		stopped = true;
		clearTimeout(reconnectTimer);
		try {
			ws?.close();
		} catch {
			/* already closed */
		}
	};
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	let port = 7878;
	let dryRun = false;
	let model: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--port") port = Number(args[++i]) || port;
		else if (a === "--dry-run") dryRun = true;
		else if (a === "--model") model = args[++i];
	}
	const stop = startSupervisor({ port, dryRun, model });
	process.stdout.write(`auto-supervisor watching ws://127.0.0.1:${port}/ws${dryRun ? " (dry-run)" : ""}${model ? ` model=${model}` : ""}\n`);
	const shutdown = (): void => {
		stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	await new Promise<void>(() => {}); // run until SIGINT/SIGTERM
}

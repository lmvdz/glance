/**
 * `glance here` — attach a casual chat thread to the current directory, in this terminal
 * (plans/daily-onramp/02-glance-here-terminal.md).
 *
 * The on-ramp: zero ceremony. This is a pure CLIENT over the daemon's existing HTTP surface —
 * `POST /api/console` (with `harness:"claude-code"` so the session runs on the operator's OWN
 * claude login/config, not the daemon's default omp harness, and `ephemeral:true` so the cwd is
 * registered as a project only for the session's lifetime), `POST /api/command {type:"prompt"}`
 * per turn, and a short-interval delta poll of `GET /api/agents/:id/transcript?since=<seq>` for
 * streaming display (the polling shape supervisor.ts already uses). No WebSocket dependency.
 *
 * Prewarm (concern 01's measured numbers): session creation costs ~2.6s warm / ~4.9s on a fresh
 * daemon ON TOP of the ~2.4s model floor — so creation fires the moment the REPL opens and never
 * blocks input. Prompts typed before the session is ready are queued and flushed on attach, hiding
 * the whole setup cost behind the operator's own typing (priority 1 of the concern-01
 * recommendation; the per-project keep-warm pool is priority 2, deliberately deferred until the
 * harness-spawn slice is re-measured on the claude harness — see the concern doc's caveat).
 *
 * Fail-closed: a non-git cwd is refused with a pointer at `git init`, never silently run in-place
 * (OMPSQ-40 — casual sessions run in standard worktrees). The transcript's streaming entries
 * MUTATE in place on the server (squad-manager's updateAssistantStream), so the delta cursor only
 * advances past FINALIZED entries; running ones are re-fetched and their new complete lines
 * printed incrementally (TranscriptRenderer below — the unit-tested seam).
 */

import * as fsp from "node:fs/promises";
import { openSync } from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { base, parseArgs, readAccessToken, stateDirPath, tokenHeader } from "./cli-args.ts";
import type { AgentDTO, TranscriptEntry } from "./types.ts";

// ── ANSI (the inline subset of tui.ts's palette — no alt-screen, scrollback stays yours) ────────
const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const dim = (s: string): string => `${ESC}2m${s}${RESET}`;
const bold = (s: string): string => `${ESC}1m${s}${RESET}`;
const cyan = (s: string): string => `${ESC}96m${s}${RESET}`;
const red = (s: string): string => `${ESC}91m${s}${RESET}`;
const green = (s: string): string => `${ESC}92m${s}${RESET}`;
const yellow = (s: string): string => `${ESC}93m${s}${RESET}`;

/** The harness a casual session rides unless overridden: the operator's own claude login/config. */
export const HERE_HARNESS = "claude-code";

// ── HTTP client (injectable fetch so the REPL logic is testable without a daemon) ───────────────

export interface HereSessionInfo {
	agentId: string;
	repo: string;
	ephemeral: boolean;
}

export class HereClient {
	constructor(
		readonly baseUrl: string,
		private readonly headers: () => Record<string, string> = tokenHeader,
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	private req(pathname: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response> {
		return this.fetchImpl(`${this.baseUrl}${pathname}`, {
			...init,
			headers: { "content-type": "application/json", ...this.headers() },
			signal: init?.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : undefined,
		});
	}

	/** Anything that answers HTTP counts — auth problems surface later with their own message. */
	async reachable(): Promise<boolean> {
		try {
			await this.req("/api/agents", { timeoutMs: 1500 });
			return true;
		} catch {
			return false;
		}
	}

	async createSession(opts: { repo: string; harness?: string; model?: string }): Promise<HereSessionInfo> {
		const res = await this.req("/api/console", {
			method: "POST",
			body: JSON.stringify({ repo: opts.repo, harness: opts.harness ?? HERE_HARNESS, model: opts.model, ephemeral: true }),
		});
		if (!res.ok) throw new Error((await res.text().catch(() => "")) || `the daemon refused the session (${res.status})`);
		return (await res.json()) as HereSessionInfo;
	}

	private async command(cmd: Record<string, unknown>): Promise<void> {
		const res = await this.req("/api/command", { method: "POST", body: JSON.stringify(cmd) });
		if (!res.ok) throw new Error((await res.text().catch(() => "")) || `command failed (${res.status})`);
	}

	prompt(id: string, message: string): Promise<void> {
		return this.command({ type: "prompt", id, message });
	}

	answer(id: string, requestId: string, value: string): Promise<void> {
		return this.command({ type: "answer", id, requestId, value });
	}

	interrupt(id: string): Promise<void> {
		return this.command({ type: "interrupt", id });
	}

	async transcriptSince(id: string, since: number): Promise<TranscriptEntry[]> {
		const res = await this.req(`/api/agents/${encodeURIComponent(id)}/transcript?since=${since}`);
		if (!res.ok) throw new Error(`transcript fetch failed (${res.status})`);
		return (await res.json()) as TranscriptEntry[];
	}

	async agent(id: string): Promise<AgentDTO | undefined> {
		const res = await this.req("/api/agents");
		if (!res.ok) throw new Error(`roster fetch failed (${res.status})`);
		const agents = (await res.json()) as AgentDTO[];
		return agents.find((a) => a.id === id);
	}

	async release(repo: string): Promise<void> {
		await this.req("/api/console/release", { method: "POST", body: JSON.stringify({ repo }), timeoutMs: 3000 });
	}
}

// ── Transcript → terminal lines (pure-ish, unit-tested) ─────────────────────────────────────────

interface EntryState {
	printed: number; // chars of `text` already emitted (assistant/system)
	announced: boolean; // one-time marker emitted (tool/thinking)
	done: boolean;
}

/** One assistant paragraph prints plain; tools/thinking print as one-line dim markers. */
function toolMarker(e: TranscriptEntry): string {
	const name = e.tool?.name ?? e.text.split(/\s/)[0] ?? "tool";
	return e.tool?.isError ? dim(`  ⚙ ${name} ${red("failed")}`) : dim(`  ⚙ ${name}`);
}

/**
 * Streaming display over a mutate-in-place transcript. Server-side, a running assistant entry is
 * appended ONCE and then grows (same seq, status "running" → "ok"), so:
 *   - `since` (the delta cursor handed to the server) only advances past entries that are DONE —
 *     running entries are re-fetched every poll and their newly-complete lines printed;
 *   - per-seq state tracks how much text is already on the terminal, so nothing prints twice.
 * `take()` returns full terminal lines, ready to print above a readline prompt.
 */
export class TranscriptRenderer {
	private readonly live = new Map<number, EntryState>();
	private floor = 0;
	private maxSeen = 0;

	/** The `?since=` cursor for the next poll. */
	get since(): number {
		return this.floor;
	}

	/** True while any streaming entry is still growing — the REPL polls fast while this holds. */
	get streaming(): boolean {
		for (const s of this.live.values()) if (!s.done) return true;
		return false;
	}

	take(entries: TranscriptEntry[]): string[] {
		const out: string[] = [];
		for (const e of entries) {
			const seq = e.seq ?? 0;
			if (seq <= this.floor && !this.live.has(seq)) continue;
			this.maxSeen = Math.max(this.maxSeen, seq);
			const s = this.live.get(seq) ?? { printed: 0, announced: false, done: false };
			this.render(e, s, out);
			s.done = e.status !== "running";
			this.live.set(seq, s);
		}
		// Advance the cursor to just below the OLDEST still-running entry (seqs are manager-global,
		// so they gap — never walk +1). With nothing running, everything seen is final.
		let oldestRunning: number | undefined;
		for (const [seq, s] of this.live) if (!s.done) oldestRunning = oldestRunning === undefined ? seq : Math.min(oldestRunning, seq);
		this.floor = oldestRunning !== undefined ? oldestRunning - 1 : Math.max(this.floor, this.maxSeen);
		for (const [seq, s] of this.live) if (s.done && seq <= this.floor) this.live.delete(seq);
		return out;
	}

	private render(e: TranscriptEntry, s: EntryState, out: string[]): void {
		switch (e.kind) {
			case "user":
				return; // the operator just typed it — echoing it back is noise
			case "thinking":
				if (!s.announced) {
					out.push(dim("  ∴ thinking…"));
					s.announced = true;
				}
				return;
			case "tool":
				if (!s.announced) {
					out.push(toolMarker(e));
					s.announced = true;
				} else if (e.status === "error" || e.tool?.isError) {
					// the marker printed while running; surface the failure it grew into
					if (!s.done) out.push(toolMarker(e));
				}
				return;
			case "assistant":
			case "system": {
				const text = e.kind === "system" ? e.text : (e.text ?? "");
				const final = e.status !== "running";
				// Mutation should only ever APPEND; if a redact pass rewrote the prefix, start over on a
				// fresh line rather than printing a corrupted suffix.
				if (s.printed > text.length) s.printed = 0;
				// Print complete lines as they stream; hold the unfinished tail until the entry finalizes.
				const printable = final ? text.length : text.lastIndexOf("\n") + 1;
				if (printable > s.printed) {
					const chunk = text.slice(s.printed, printable).replace(/\n$/, "");
					if (!s.announced && e.kind === "assistant") {
						out.push(""); // breathe between turns — once per entry, even across a prefix reset
						s.announced = true;
					}
					for (const line of chunk.split("\n")) out.push(e.kind === "system" ? dim(line) : line);
					s.printed = printable;
				}
				return;
			}
		}
	}
}

// ── Session state machine (unit-tested; terminal-free) ──────────────────────────────────────────

export type HereStatus = "connecting" | "ready" | "gone" | "error";

/**
 * The client-side session: queues prompts until the daemon-side create resolves (prewarm P1 —
 * typing is never blocked on setup), routes submits to prompt vs pending-answer, and turns each
 * poll into printable lines. All output flows through `print`; all input through `submit`.
 */
export class HereSession {
	readonly renderer = new TranscriptRenderer();
	private agentId?: string;
	private queued: string[] = [];
	private lastAgent?: AgentDTO;
	private shownPending = new Set<string>();
	private sendInFlight = 0;
	status: HereStatus = "connecting";

	constructor(
		private readonly client: HereClient,
		private readonly print: (line: string) => void,
	) {}

	/** The daemon-side create resolved: flush everything typed while it was starting. */
	attach(agentId: string): void {
		this.agentId = agentId;
		this.status = "ready";
		const queued = this.queued.splice(0);
		for (const message of queued) this.send(message);
	}

	get attached(): boolean {
		return this.agentId !== undefined;
	}

	get queuedCount(): number {
		return this.queued.length;
	}

	/** True while a reply could still arrive — drives the fast poll cadence. */
	get busy(): boolean {
		if (this.sendInFlight > 0 || this.queued.length > 0) return true;
		if (this.renderer.streaming) return true;
		const st = this.lastAgent?.status;
		return st === "working" || st === "starting";
	}

	/** Route a composed line: pending answer first, else a prompt (queued until attached). */
	submit(text: string): void {
		const t = text.trim();
		if (!t) return;
		const pending = this.lastAgent?.pending?.[0];
		if (pending && this.agentId) {
			const value = pending.kind === "confirm" ? (/^y/i.test(t) ? "yes" : "no") : t;
			this.sendInFlight++;
			void this.client
				.answer(this.agentId, pending.id, value)
				.catch((err) => this.print(red(`✗ answer didn't reach the agent: ${msg(err)}`)))
				.finally(() => this.sendInFlight--);
			this.shownPending.add(pending.id);
			return;
		}
		if (!this.agentId) {
			this.queued.push(t);
			this.print(dim("  · queued — sending the moment the session is up"));
			return;
		}
		this.send(t);
	}

	private send(message: string): void {
		if (!this.agentId) return;
		this.sendInFlight++;
		void this.client
			.prompt(this.agentId, message)
			.catch((err) => this.print(red(`✗ message didn't reach the agent: ${msg(err)}`)))
			.finally(() => this.sendInFlight--);
	}

	interrupt(): void {
		if (!this.agentId) return;
		void this.client.interrupt(this.agentId).catch((err) => this.print(red(`✗ couldn't interrupt: ${msg(err)}`)));
	}

	/** One poll tick: print new transcript lines, surface pending requests, notice death. */
	async poll(): Promise<void> {
		if (!this.agentId || this.status === "gone") return;
		const [entries, agent] = await Promise.all([
			this.client.transcriptSince(this.agentId, this.renderer.since),
			this.client.agent(this.agentId),
		]);
		for (const line of this.renderer.take(entries)) this.print(line);
		this.lastAgent = agent;
		if (!agent) {
			this.status = "gone";
			this.print(red("✗ the session was removed on the daemon side — nothing more will arrive here"));
			return;
		}
		if (agent.status === "error") {
			this.status = "error";
			this.print(red(`✗ the session hit an error: ${agent.blockedReason ?? agent.error ?? "unknown"}`));
		} else if (this.status === "error") {
			this.status = "ready"; // it recovered — say nothing, just resume
		}
		for (const p of agent.pending ?? []) {
			if (this.shownPending.has(p.id)) continue;
			this.shownPending.add(p.id);
			const hint = p.kind === "confirm" ? "[y/n]" : p.options?.length ? `[${p.options.join(" / ")}]` : "[type an answer]";
			this.print(yellow(`⛔ needs you: ${p.title}${p.message ? ` — ${p.message}` : ""} ${dim(hint)}`));
		}
	}
}

function msg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// ── Terminal wiring ──────────────────────────────────────────────────────────────────────────────

/** Repo root of `cwd` (through symlinks), or undefined when it isn't inside a git repository. */
async function gitRoot(cwd: string): Promise<string | undefined> {
	try {
		const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], { cwd, stdout: "pipe", stderr: "ignore" });
		const out = (await new Response(proc.stdout).text()).trim();
		await proc.exited;
		if (proc.exitCode !== 0 || !out) return undefined;
		return await fsp.realpath(out);
	} catch {
		return undefined;
	}
}

/** Boot a background daemon (`glance up --no-tui`) with its output in <stateDir>/daemon.log. */
async function bootDaemon(flags: Record<string, string | boolean>, client: HereClient, write: (s: string) => void): Promise<boolean> {
	const stateDir = stateDirPath();
	await fsp.mkdir(stateDir, { recursive: true }).catch(() => {});
	const logPath = path.join(stateDir, "daemon.log");
	const fd = openSync(logPath, "a");
	const entry = path.join(import.meta.dir, "index.ts");
	const args = [process.execPath, entry, "up", "--no-tui", ...(flags.port ? ["--port", String(flags.port)] : [])];
	const started = Date.now();
	const proc = Bun.spawn(args, { stdin: "ignore", stdout: fd, stderr: fd });
	proc.unref();
	const deadline = started + 20_000;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 250));
		if (await client.reachable()) {
			write(`${green("●")} daemon up ${dim(`(${((Date.now() - started) / 1000).toFixed(1)}s · logs: ${logPath})`)}\n`);
			return true;
		}
		if (proc.exitCode !== null && proc.exitCode !== 0) break;
	}
	write(red(`✗ the daemon didn't come up — see ${logPath}\n`));
	return false;
}

const HERE_HELP = `${dim(`  /stop   interrupt the current turn
  /exit   leave — the session stays live in the webapp
  /help   this list`)}
`;

/**
 * `glance here [--model M] [--harness H] [--port N]` — the terminal-attach REPL.
 * Session creation is fired immediately and never blocks the prompt (prewarm P1).
 */
export async function cmdHere(args: string[]): Promise<void> {
	const { flags } = parseArgs(args);
	if (!process.stdin.isTTY) {
		process.stderr.write(`glance here opens an interactive chat, so it needs a terminal.\nFor a one-shot question use: glance ask "…"\n`);
		process.exit(1);
	}

	const repo = await gitRoot(process.cwd());
	if (!repo) {
		process.stderr.write(
			`${red("✗")} ${process.cwd()} isn't inside a git repository.\n` +
				`  glance runs casual sessions in a worktree cut from your repo — no repo, no worktree.\n` +
				`  Fix: ${bold("git init")} here, or cd into a repository.\n`,
		);
		process.exit(1);
	}

	const client = new HereClient(base(flags));
	if (!(await client.reachable())) {
		const rlAsk = readline.createInterface({ input: process.stdin, output: process.stdout });
		const answer = await new Promise<string>((resolve) => rlAsk.question(`No glance daemon on ${base(flags)} — start one in the background? ${dim("[Y/n]")} `, resolve));
		rlAsk.close();
		if (/^n/i.test(answer.trim())) {
			process.stderr.write(`ok — start it yourself with: glance up\n`);
			process.exit(1);
		}
		if (!(await bootDaemon(flags, client, (s) => process.stdout.write(s)))) process.exit(1);
	}

	const token = readAccessToken();
	const url = token ? `${base(flags)}/?token=${token}` : base(flags);
	process.stdout.write(`${bold(cyan("◆ glance here"))} ${dim("·")} ${bold(path.basename(repo))}\n`);
	process.stdout.write(`${dim(`  webapp: ${url}`)}\n`);
	process.stdout.write(`${dim("  starting a session on your claude login — type now, it sends the moment the session is up")}\n\n`);

	const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${cyan("›")} `, historySize: 500 });
	const printAbove = (line: string): void => {
		process.stdout.write(`\r${ESC}2K${line}\n`);
		rl.prompt(true);
	};

	const session = new HereSession(client, printAbove);
	const startedAt = Date.now();
	let info: HereSessionInfo | undefined;

	// Prewarm P1: create in the background; the prompt below is already live.
	const creating = client
		.createSession({ repo, harness: typeof flags.harness === "string" ? flags.harness : undefined, model: typeof flags.model === "string" ? flags.model : undefined })
		.then((created) => {
			info = created;
			session.attach(created.agentId);
			const t = ((Date.now() - startedAt) / 1000).toFixed(1);
			printAbove(`${green("●")} ready ${dim(`(${t}s · isolated worktree · ${created.agentId})`)}${session.queuedCount === 0 ? "" : ""}`);
		})
		.catch((err) => {
			printAbove(red(`✗ couldn't start the session: ${msg(err)}`));
			printAbove(dim("  nothing was sent — fix the cause and rerun glance here"));
			shutdown(1);
		});

	// Adaptive poll: fast while a turn is in flight, gentle when idle. One tick in flight at a time.
	let closing = false;
	let lostAt: number | undefined;
	const tick = async (): Promise<void> => {
		if (closing) return;
		try {
			await session.poll();
			if (lostAt !== undefined) {
				lostAt = undefined;
				printAbove(`${green("●")} reconnected`);
			}
		} catch {
			if (lostAt === undefined) {
				lostAt = Date.now();
				printAbove(yellow("… lost the daemon — retrying quietly (Ctrl-C to leave)"));
			}
		}
		if (!closing) pollTimer = setTimeout(() => void tick(), session.busy ? 250 : 1200);
	};
	let pollTimer: ReturnType<typeof setTimeout> = setTimeout(() => void tick(), 250);

	const shutdown = (code: number): void => {
		if (closing) return;
		closing = true;
		clearTimeout(pollTimer);
		rl.close();
		const finish = async (): Promise<void> => {
			if (info?.ephemeral) await client.release(info.repo).catch(() => {});
			if (info && code === 0) {
				process.stdout.write(`\n${dim("left the terminal — the session stays live in the webapp:")}\n${dim(`  ${url}`)}\n`);
			}
			process.exit(code);
		};
		void finish();
	};

	rl.on("line", (line) => {
		const t = line.trim();
		if (t === "/exit" || t === "/quit") return shutdown(0);
		if (t === "/help") {
			process.stdout.write(HERE_HELP);
			rl.prompt();
			return;
		}
		if (t === "/stop") {
			session.interrupt();
			rl.prompt();
			return;
		}
		session.submit(t);
		rl.prompt();
	});
	rl.on("SIGINT", () => shutdown(0));
	rl.on("close", () => shutdown(0));
	rl.prompt();
	await creating;
	// Keep the process alive until shutdown() exits it — readline + the poll timer own the loop.
	await new Promise<void>(() => {});
}

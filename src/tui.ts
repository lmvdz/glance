/**
 * Terminal dashboard for a SquadManager.
 *
 * `buildBoard()` is a pure (state) → lines renderer (unit-testable). `SquadTui`
 * is the interactive shell: alt-screen, raw-mode key handling, live redraw on
 * manager events. Width safety borrows pi-tui's truncation helpers so output is
 * consistent with omp's own renderer.
 */

import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { SquadManager } from "./squad-manager.ts";
import type { AgentDTO, AgentStatus, SquadEvent, TranscriptEntry } from "./types.ts";

// ── ANSI ────────────────────────────────────────────────────────────────────
const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const codes: Record<string, string> = {
	dim: "2",
	bold: "1",
	rev: "7",
	gray: "90",
	blue: "94",
	green: "92",
	yellow: "93",
	red: "91",
	cyan: "96",
};
function c(name: keyof typeof codes | (string & {}), s: string): string {
	const code = codes[name] ?? "0";
	return `${ESC}${code}m${s}${RESET}`;
}

const STATUS_COLOR: Record<AgentStatus, string> = {
	idle: "green",
	working: "yellow",
	input: "red",
	error: "red",
	starting: "blue",
	stopped: "gray",
};
const STATUS_DOT: Record<AgentStatus, string> = {
	idle: "●",
	working: "◐",
	input: "⛔",
	error: "✖",
	starting: "○",
	stopped: "◌",
};

export type TuiMode = "nav" | "input";

export interface BoardState {
	agents: AgentDTO[];
	selectedId?: string;
	transcript: TranscriptEntry[];
	mode: TuiMode;
	draft: string;
	/** What the draft will do on Enter: a free prompt, or an answer to a pending request. */
	draftTarget: "prompt" | { requestId: string };
	width: number;
	height: number;
	connected: boolean;
}

function statusRank(s: AgentStatus): number {
	const rank: Record<AgentStatus, number> = { input: 0, working: 1, idle: 2, starting: 3, error: 4, stopped: 5 };
	return rank[s];
}

function pad(s: string, w: number): string {
	const vis = visibleWidth(s);
	return vis >= w ? truncateToWidth(s, w) : s + " ".repeat(w - vis);
}

/** Pure renderer: produce exactly `height` width-safe lines for the current state. */
export function buildBoard(state: BoardState): string[] {
	const { width, height } = state;
	const lines: string[] = [];
	const agents = [...state.agents].sort((a, b) => statusRank(a.status) - statusRank(b.status) || a.name.localeCompare(b.name));
	const needInput = agents.filter((a) => a.status === "input").length;

	// Title bar
	const title = `${c("bold", c("cyan", "omp-squad"))}  ${c("dim", `${agents.length} agents`)}${
		needInput ? c("red", ` · ${needInput} need input`) : ""
	}${state.connected ? "" : c("red", "  [disconnected]")}`;
	lines.push(pad(title, width));
	lines.push(c("gray", "─".repeat(width)));

	// Roster: dot + name + branch + activity + todo + ctx
	const nameW = 16;
	const branchW = 18;
	const metaW = 14;
	const actW = Math.max(10, width - (3 + nameW + branchW + metaW + 4));
	for (const a of agents) {
		const sel = a.id === state.selectedId;
		const dot = c(STATUS_COLOR[a.status], STATUS_DOT[a.status]);
		const name = pad(a.name, nameW);
		const branch = c("dim", pad(a.branch ?? "—", branchW));
		const act = pad(a.activity ?? a.todo?.active ?? (a.error ? `⚠ ${a.error}` : "—"), actW);
		const todo = a.todo ? `${a.todo.done}/${a.todo.total}` : "";
		const ctx = a.contextPct != null ? `${Math.round(a.contextPct * 100)}%` : "";
		const meta = c("dim", pad(`${todo}  ${ctx}`, metaW));
		const row = `${dot} ${sel ? c("bold", name) : name} ${branch} ${act} ${meta}`;
		lines.push(sel ? `${ESC}7m${pad(stripForReverse(row), width)}${RESET}` : pad(row, width));
	}

	// Detail
	const sel = agents.find((a) => a.id === state.selectedId);
	lines.push(c("gray", "─".repeat(width)));
	if (sel) {
		const head = `${c("bold", sel.name)} ${c(STATUS_COLOR[sel.status], `[${sel.status}]`)} ${c("dim", sel.model ?? "")}  ${c("dim", sel.worktree)}`;
		lines.push(pad(head, width));

		const footerLines = sel.pending.length + 2; // pending + separator + input
		const transcriptRows = Math.max(3, height - lines.length - footerLines);
		const tail = state.transcript.slice(-transcriptRows);
		for (const e of tail) lines.push(pad(renderEntry(e, width), width));
		while (lines.length < height - footerLines) lines.push("");

		for (const p of sel.pending) {
			const hint = p.kind === "confirm" ? "[y/n]" : p.kind === "select" ? `[${(p.options ?? []).join("/")}]` : "[Enter to answer]";
			lines.push(pad(c("red", `⛔ ${p.title}${p.message ? ` — ${p.message}` : ""} ${c("dim", hint)}`), width));
		}
	} else {
		lines.push(c("dim", "Select an agent (↑/↓). Enter: prompt · i: interrupt · r: restart · k: kill · q: quit"));
		while (lines.length < height - 1) lines.push("");
	}

	// Input / footer line
	if (state.mode === "input") {
		const label = state.draftTarget === "prompt" ? "prompt" : "answer";
		lines.push(pad(`${c("cyan", `${label}›`)} ${state.draft}${c("rev", " ")}`, width));
	} else {
		lines.push(pad(c("dim", "↑/↓ select · Enter prompt · a answer · i interrupt · r restart · k kill · q quit"), width));
	}

	// Clamp to exactly height
	if (lines.length > height) return lines.slice(0, height);
	while (lines.length < height) lines.push("");
	return lines;
}

function stripForReverse(s: string): string {
	// Reverse-video the whole row: drop inner color codes so the highlight is uniform.
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderEntry(e: TranscriptEntry, width: number): string {
	const who = e.kind.toUpperCase().padEnd(9);
	const colorByKind: Record<string, string> = {
		user: "blue",
		assistant: "green",
		tool: "gray",
		system: "yellow",
		thinking: "gray",
	};
	const text = e.text.replace(/\n/g, " ");
	return `${c(colorByKind[e.kind] ?? "dim", who)} ${truncateToWidth(text, Math.max(1, width - 10))}`;
}

// ── Interactive shell ─────────────────────────────────────────────────────

export class SquadTui {
	private readonly manager: SquadManager;
	private state: BoardState;
	private readonly transcripts = new Map<string, TranscriptEntry[]>();
	private redrawTimer?: Timer;
	private running = false;
	private readonly onEvent: (e: SquadEvent) => void;
	private readonly onKey: (data: Buffer) => void;
	private onQuit?: () => void;

	constructor(manager: SquadManager) {
		this.manager = manager;
		this.state = {
			agents: manager.list(),
			selectedId: manager.list()[0]?.id,
			transcript: [],
			mode: "nav",
			draft: "",
			draftTarget: "prompt",
			width: process.stdout.columns ?? 100,
			height: process.stdout.rows ?? 30,
			connected: true,
		};
		for (const a of this.state.agents) this.transcripts.set(a.id, manager.getTranscript(a.id));
		this.syncSelectedTranscript();
		this.onEvent = (e) => this.handleEvent(e);
		this.onKey = (data) => this.handleKey(data);
	}

	/** Run until the user quits. Resolves on quit. */
	run(): Promise<void> {
		return new Promise<void>((resolve) => {
			this.onQuit = resolve;
			this.running = true;
			this.manager.on("event", this.onEvent);
			process.stdout.write(`${ESC}?1049h${ESC}?25l`); // alt screen, hide cursor
			const onResize = () => {
				this.state.width = process.stdout.columns ?? 100;
				this.state.height = process.stdout.rows ?? 30;
				this.scheduleRedraw();
			};
			process.stdout.on("resize", onResize);
			if (process.stdin.isTTY) {
				process.stdin.setRawMode(true);
				process.stdin.resume();
				process.stdin.on("data", this.onKey);
			}
			this.render();
		});
	}

	private quit(): void {
		if (!this.running) return;
		this.running = false;
		clearTimeout(this.redrawTimer);
		this.manager.off("event", this.onEvent);
		if (process.stdin.isTTY) {
			process.stdin.off("data", this.onKey);
			process.stdin.setRawMode(false);
			process.stdin.pause();
		}
		process.stdout.write(`${ESC}?25h${ESC}?1049l`); // show cursor, leave alt screen
		this.onQuit?.();
	}

	private handleEvent(e: SquadEvent): void {
		switch (e.type) {
			case "roster":
				this.state.agents = e.agents;
				if (!this.state.selectedId) this.state.selectedId = e.agents[0]?.id;
				break;
			case "agent": {
				const i = this.state.agents.findIndex((a) => a.id === e.agent.id);
				if (i >= 0) this.state.agents[i] = e.agent;
				else this.state.agents.push(e.agent);
				if (!this.state.selectedId) this.state.selectedId = e.agent.id;
				break;
			}
			case "removed":
				this.state.agents = this.state.agents.filter((a) => a.id !== e.id);
				this.transcripts.delete(e.id);
				if (this.state.selectedId === e.id) this.state.selectedId = this.state.agents[0]?.id;
				break;
			case "transcript": {
				const arr = this.transcripts.get(e.id) ?? [];
				arr.push(e.entry);
				this.transcripts.set(e.id, arr);
				break;
			}
			case "log":
				break;
		}
		this.syncSelectedTranscript();
		this.scheduleRedraw();
	}

	private syncSelectedTranscript(): void {
		this.state.transcript = this.state.selectedId ? (this.transcripts.get(this.state.selectedId) ?? []) : [];
	}

	private selectedAgent(): AgentDTO | undefined {
		return this.state.agents.find((a) => a.id === this.state.selectedId);
	}

	private moveSelection(delta: number): void {
		const sorted = [...this.state.agents].sort((a, b) => statusRank(a.status) - statusRank(b.status) || a.name.localeCompare(b.name));
		if (!sorted.length) return;
		const idx = Math.max(0, sorted.findIndex((a) => a.id === this.state.selectedId));
		const next = Math.min(sorted.length - 1, Math.max(0, idx + delta));
		this.state.selectedId = sorted[next].id;
		this.syncSelectedTranscript();
	}

	private handleKey(data: Buffer): void {
		const s = data.toString();
		if (this.state.mode === "input") {
			this.handleInputKey(s);
			this.scheduleRedraw();
			return;
		}
		switch (s) {
			case "\x03": // Ctrl-C
			case "q":
				this.quit();
				return;
			case "\x1b[A":
				this.moveSelection(-1);
				break;
			case "\x1b[B":
				this.moveSelection(1);
				break;
			case "\r":
			case "\n":
				this.state.mode = "input";
				this.state.draft = "";
				this.state.draftTarget = "prompt";
				break;
			case "a": {
				const sel = this.selectedAgent();
				if (sel?.pending.length) {
					const p = sel.pending[0];
					if (p.kind === "confirm") break; // answered via y/n below
					this.state.mode = "input";
					this.state.draft = "";
					this.state.draftTarget = { requestId: p.id };
				}
				break;
			}
			case "y":
			case "n": {
				const sel = this.selectedAgent();
				const p = sel?.pending.find((x) => x.kind === "confirm");
				if (sel && p) void this.manager.applyCommand({ type: "answer", id: sel.id, requestId: p.id, value: s === "y" ? "yes" : "no" });
				break;
			}
			case "i": {
				const sel = this.selectedAgent();
				if (sel) void this.manager.applyCommand({ type: "interrupt", id: sel.id });
				break;
			}
			case "r": {
				const sel = this.selectedAgent();
				if (sel) void this.manager.applyCommand({ type: "restart", id: sel.id });
				break;
			}
			case "k": {
				const sel = this.selectedAgent();
				if (sel) void this.manager.applyCommand({ type: "kill", id: sel.id });
				break;
			}
		}
		this.scheduleRedraw();
	}

	private handleInputKey(s: string): void {
		if (s === "\x1b") {
			this.state.mode = "nav";
			this.state.draft = "";
			return;
		}
		if (s === "\r" || s === "\n") {
			const sel = this.selectedAgent();
			const text = this.state.draft.trim();
			this.state.mode = "nav";
			this.state.draft = "";
			if (!sel || !text) return;
			if (this.state.draftTarget === "prompt") {
				void this.manager.applyCommand({ type: "prompt", id: sel.id, message: text });
			} else {
				void this.manager.applyCommand({ type: "answer", id: sel.id, requestId: this.state.draftTarget.requestId, value: text });
			}
			return;
		}
		if (s === "\x7f" || s === "\b") {
			this.state.draft = this.state.draft.slice(0, -1);
			return;
		}
		if (s === "\x03") {
			this.quit();
			return;
		}
		// Append printable characters (ignore other escape sequences).
		if (!s.startsWith("\x1b")) this.state.draft += s;
	}

	private scheduleRedraw(): void {
		if (this.redrawTimer) return;
		this.redrawTimer = setTimeout(() => {
			this.redrawTimer = undefined;
			this.render();
		}, 50);
	}

	private render(): void {
		if (!this.running) return;
		const lines = buildBoard(this.state);
		process.stdout.write(`${ESC}H${ESC}J${lines.join("\r\n")}`);
	}
}

/**
 * Terminal dashboard for a SquadManager — two-level, arrow-driven navigation.
 *
 *   LIST view   ↑/↓ move · → open agent · type a task + Enter = spawn agent
 *   AGENT view  transcript + composer · ← (empty draft) back · /stop /restart /kill
 *
 * `buildBoard()` is a pure (state) → lines renderer (unit-testable). `SquadTui`
 * is the interactive shell: alt-screen, raw-mode keys, live redraw on manager
 * events. Width safety borrows pi-tui's truncation helpers.
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
function c(name: string, s: string): string {
	return `${ESC}${codes[name] ?? "0"}m${s}${RESET}`;
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

export type TuiView = "list" | "agent";

export interface BoardState {
	view: TuiView;
	agents: AgentDTO[];
	selectedId?: string;
	transcript: TranscriptEntry[];
	draft: string;
	/** Lines scrolled up from the bottom in agent view (0 = latest). */
	scroll: number;
	width: number;
	height: number;
	connected: boolean;
	/** Directory new agents are spawned in (the daemon's launch cwd). */
	cwd: string;
}

function statusRank(s: AgentStatus): number {
	const rank: Record<AgentStatus, number> = { input: 0, working: 1, idle: 2, starting: 3, error: 4, stopped: 5 };
	return rank[s];
}

function sortAgents(agents: AgentDTO[]): AgentDTO[] {
	return [...agents].sort((a, b) => statusRank(a.status) - statusRank(b.status) || a.name.localeCompare(b.name));
}

function pad(s: string, w: number): string {
	const vis = visibleWidth(s);
	return vis >= w ? truncateToWidth(s, w) : s + " ".repeat(w - vis);
}

function composerLine(label: string, draft: string, width: number): string {
	return pad(`${c("cyan", `${label}›`)} ${draft}${c("rev", " ")}`, width);
}

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderEntry(e: TranscriptEntry, width: number): string {
	const who = e.kind.toUpperCase().padEnd(9);
	const colorByKind: Record<string, string> = { user: "blue", assistant: "green", tool: "gray", system: "yellow", thinking: "gray" };
	return `${c(colorByKind[e.kind] ?? "dim", who)} ${truncateToWidth(e.text.replace(/\n/g, " "), Math.max(1, width - 10))}`;
}

/** Pure renderer: produce exactly `height` width-safe lines for the current state. */
export function buildBoard(state: BoardState): string[] {
	const { width, height, view } = state;
	const agents = sortAgents(state.agents);
	const need = agents.filter((a) => a.status === "input").length;
	const lines: string[] = [];

	const title = `${c("bold", c("cyan", "omp-squad"))}  ${c("dim", `${agents.length} agents`)}${
		need ? c("red", ` · ${need} need input`) : ""
	}${state.connected ? "" : c("red", "  [disconnected]")}`;
	lines.push(pad(title, width));
	lines.push(c("gray", "─".repeat(width)));

	if (view === "list") {
		const nameW = 16;
		const branchW = 18;
		const metaW = 14;
		const actW = Math.max(10, width - (3 + nameW + branchW + metaW + 4));
		const slots = Math.max(1, height - 4); // title, sep, hint, composer
		const shown = agents.slice(0, slots);
		for (const a of shown) {
			const selRow = a.id === state.selectedId;
			const dot = c(STATUS_COLOR[a.status], STATUS_DOT[a.status]);
			const name = pad(a.name, nameW);
			const branch = c("dim", pad(a.branch ?? "—", branchW));
			const act = pad(a.activity ?? a.todo?.active ?? (a.error ? `⚠ ${a.error}` : "—"), actW);
			const meta = c("dim", pad(`${a.todo ? `${a.todo.done}/${a.todo.total}` : ""}  ${a.contextPct != null ? `${Math.round(a.contextPct * 100)}%` : ""}`, metaW));
			const row = `${dot} ${selRow ? c("bold", name) : name} ${branch} ${act} ${meta}`;
			lines.push(selRow ? `${ESC}7m${pad(stripAnsi(row), width)}${RESET}` : pad(row, width));
		}
		if (!agents.length) lines.push(c("dim", "  No agents yet — type a task below and press Enter to spawn one."));
		while (lines.length < height - 2) lines.push("");
		const short = state.cwd.length > 40 ? `…${state.cwd.slice(-39)}` : state.cwd;
		lines.push(pad(c("dim", `↑/↓ select · → open · Enter = new agent in ${short} · Ctrl-C quit`), width));
		lines.push(composerLine("new", state.draft, width));
	} else {
		const sel = agents.find((a) => a.id === state.selectedId);
		if (!sel) {
			lines.push(c("dim", "agent unavailable — ← back to list"));
			while (lines.length < height - 2) lines.push("");
			lines.push(pad(c("dim", "← back · Ctrl-C quit"), width));
			lines.push(composerLine("", state.draft, width));
		} else {
			const head = `${c("bold", sel.name)} ${c(STATUS_COLOR[sel.status], `[${sel.status}]`)} ${c("dim", sel.model ?? "")}  ${c("dim", sel.worktree)}`;
			lines.push(pad(head, width));
			const transcriptRows = Math.max(1, height - lines.length - sel.pending.length - 2);
			const end = Math.max(0, state.transcript.length - state.scroll);
			const start = Math.max(0, end - transcriptRows);
			for (const e of state.transcript.slice(start, end)) lines.push(pad(renderEntry(e, width), width));
			while (lines.length < height - sel.pending.length - 2) lines.push("");
			for (const p of sel.pending) {
				const hint = p.kind === "confirm" ? "[y/n]" : p.kind === "select" ? `[${(p.options ?? []).join("/")}]` : "[type an answer]";
				lines.push(pad(c("red", `⛔ ${p.title}${p.message ? ` — ${p.message}` : ""} ${c("dim", hint)}`), width));
			}
			lines.push(pad(c("dim", "← back · Enter send · /stop /restart /kill · Ctrl-C quit"), width));
			lines.push(composerLine(sel.pending.length ? "answer" : "", state.draft, width));
		}
	}

	if (lines.length > height) return lines.slice(0, height);
	while (lines.length < height) lines.push("");
	return lines;
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

	constructor(manager: SquadManager, cwd: string = process.cwd()) {
		this.manager = manager;
		this.state = {
			view: "list",
			agents: manager.list(),
			selectedId: manager.list()[0]?.id,
			transcript: [],
			draft: "",
			scroll: 0,
			width: process.stdout.columns ?? 100,
			height: process.stdout.rows ?? 30,
			connected: true,
			cwd,
		};
		for (const a of this.state.agents) this.transcripts.set(a.id, manager.getTranscript(a.id));
		this.syncTranscript();
		this.onEvent = (e) => this.handleEvent(e);
		this.onKey = (data) => this.handleKey(data);
	}

	run(): Promise<void> {
		return new Promise<void>((resolve) => {
			this.onQuit = resolve;
			this.running = true;
			this.manager.on("event", this.onEvent);
			process.stdout.write(`${ESC}?1049h${ESC}?25l`);
			process.stdout.on("resize", () => {
				this.state.width = process.stdout.columns ?? 100;
				this.state.height = process.stdout.rows ?? 30;
				this.scheduleRedraw();
			});
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
		process.stdout.write(`${ESC}?25h${ESC}?1049l`);
		this.onQuit?.();
	}

	private handleEvent(e: SquadEvent): void {
		switch (e.type) {
			case "roster":
				this.state.agents = e.agents;
				if (!this.state.selectedId) this.state.selectedId = sortAgents(e.agents)[0]?.id;
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
				if (this.state.selectedId === e.id) {
					this.state.selectedId = sortAgents(this.state.agents)[0]?.id;
					this.state.view = "list";
				}
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
		this.syncTranscript();
		this.scheduleRedraw();
	}

	private syncTranscript(): void {
		this.state.transcript = this.state.selectedId ? (this.transcripts.get(this.state.selectedId) ?? []) : [];
	}

	private selected(): AgentDTO | undefined {
		return this.state.agents.find((a) => a.id === this.state.selectedId);
	}

	private moveSelection(delta: number): void {
		const sorted = sortAgents(this.state.agents);
		if (!sorted.length) return;
		const idx = Math.max(0, sorted.findIndex((a) => a.id === this.state.selectedId));
		this.state.selectedId = sorted[Math.min(sorted.length - 1, Math.max(0, idx + delta))].id;
		this.syncTranscript();
	}

	private openSelected(): void {
		if (!this.selected()) return;
		this.state.view = "agent";
		this.state.scroll = 0;
		this.syncTranscript();
		if (this.state.selectedId) this.manager.applyCommand({ type: "subscribe", id: this.state.selectedId });
	}

	private spawnFromDraft(): void {
		const task = this.state.draft.trim();
		if (!task) return;
		this.state.draft = "";
		this.manager
			.create({ repo: this.state.cwd, task })
			.then((dto) => {
				this.state.selectedId = dto.id;
				this.state.view = "agent";
				this.state.scroll = 0;
				this.syncTranscript();
				this.scheduleRedraw();
			})
			.catch(() => {});
	}

	private handleKey(data: Buffer): void {
		const s = data.toString();
		if (s === "\x03") return this.quit(); // Ctrl-C
		if (s === "\x1b[A") this.onUp();
		else if (s === "\x1b[B") this.onDown();
		else if (s === "\x1b[C") this.onRight();
		else if (s === "\x1b[D") this.onLeft();
		else if (s === "\x1b") this.onEsc();
		else if (s === "\r" || s === "\n") this.onEnter();
		else if (s === "\x7f" || s === "\b") this.state.draft = this.state.draft.slice(0, -1);
		else {
			const printable = s.replace(/[\x00-\x1f]/g, "");
			if (printable) this.state.draft += printable;
		}
		this.scheduleRedraw();
	}

	private onUp(): void {
		if (this.state.view === "list") this.moveSelection(-1);
		else this.state.scroll = Math.min(this.state.transcript.length, this.state.scroll + 1);
	}

	private onDown(): void {
		if (this.state.view === "list") this.moveSelection(1);
		else this.state.scroll = Math.max(0, this.state.scroll - 1);
	}

	private onRight(): void {
		if (this.state.view === "list") this.openSelected();
	}

	private onLeft(): void {
		if (this.state.view === "agent" && this.state.draft === "") this.state.view = "list";
	}

	private onEsc(): void {
		if (this.state.view === "agent") this.state.view = "list";
		else this.quit();
	}

	private onEnter(): void {
		if (this.state.view === "list") {
			if (this.state.draft.trim()) this.spawnFromDraft();
			else this.openSelected();
			return;
		}
		// agent view
		const sel = this.selected();
		const text = this.state.draft.trim();
		if (!sel) {
			this.state.view = "list";
			return;
		}
		if (text.startsWith("/")) {
			this.runSlash(sel, text);
			this.state.draft = "";
			return;
		}
		if (!text) return;
		this.state.draft = "";
		const pending = sel.pending[0];
		if (pending) {
			const value = pending.kind === "confirm" ? (/^y/i.test(text) ? "yes" : "no") : text;
			this.manager.applyCommand({ type: "answer", id: sel.id, requestId: pending.id, value });
		} else {
			this.manager.applyCommand({ type: "prompt", id: sel.id, message: text });
		}
	}

	private runSlash(sel: AgentDTO, cmd: string): void {
		const verb = cmd.slice(1).trim().toLowerCase();
		if (verb === "stop" || verb === "interrupt") this.manager.applyCommand({ type: "interrupt", id: sel.id });
		else if (verb === "restart") this.manager.applyCommand({ type: "restart", id: sel.id });
		else if (verb === "kill") this.manager.applyCommand({ type: "kill", id: sel.id });
		else if (verb === "back") this.state.view = "list";
		else if (verb === "rm") {
			this.manager.applyCommand({ type: "remove", id: sel.id });
			this.state.view = "list";
		}
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
		process.stdout.write(`${ESC}H${ESC}J${buildBoard(this.state).join("\r\n")}`);
	}
}

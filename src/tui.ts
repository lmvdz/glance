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

import { CURSOR_MARKER, Editor, type EditorTheme, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
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
const KIND_GLYPH: Record<string, string> = { workflow: "⚙", "flue-service": "⚒" };
const KIND_COLOR: Record<string, string> = { workflow: "cyan", "flue-service": "magenta" };

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

/** Nest spawned fan-out branches under their parent workflow; everything else sorts as usual. */
function orderedAgents(all: AgentDTO[]): { agent: AgentDTO; depth: number }[] {
	const ids = new Set(all.map((a) => a.id));
	const roots = sortAgents(all.filter((a) => !a.parentId || !ids.has(a.parentId)));
	const out: { agent: AgentDTO; depth: number }[] = [];
	for (const r of roots) {
		out.push({ agent: r, depth: 0 });
		for (const ch of sortAgents(all.filter((a) => a.parentId === r.id))) out.push({ agent: ch, depth: 1 });
	}
	return out;
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
		const actW = Math.max(10, width - (5 + nameW + branchW + metaW + 4));
		const slots = Math.max(1, height - 4); // title, sep, hint, composer
		for (const { agent: a, depth } of orderedAgents(state.agents).slice(0, slots)) {
			const selRow = a.id === state.selectedId;
			const dot = c(STATUS_COLOR[a.status], STATUS_DOT[a.status]);
			const g = KIND_GLYPH[a.kind];
			const kindMark = g ? c(KIND_COLOR[a.kind] ?? "dim", g) : " ";
			const name = pad((depth ? "└ " : "") + a.name, nameW);
			const branch = c("dim", pad(a.branch ?? "—", branchW));
			const act = pad(a.activity ?? a.todo?.active ?? (a.error ? `⚠ ${a.error}` : "—"), actW);
			const meta = c("dim", pad(`${a.todo ? `${a.todo.done}/${a.todo.total}` : ""}  ${a.contextPct != null ? `${Math.round(a.contextPct * 100)}%` : ""}`, metaW));
			const row = `${dot} ${kindMark} ${selRow ? c("bold", name) : name} ${branch} ${act} ${meta}`;
			lines.push(selRow ? `${ESC}7m${pad(stripAnsi(row), width)}${RESET}` : pad(row, width));
		}
		if (!state.agents.length) lines.push(c("dim", "  No agents yet — type a task below and press Enter to spawn one."));
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

/** Box glyphs + thin-bar cursor for the mounted Editor. Mirrors omp's composer
 *  styling without importing omp's runtime theme module (type-only contract). */
const EDITOR_SYMBOLS = {
	cursor: "›",
	inputCursor: "▏",
	boxRound: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
	boxSharp: { topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘", horizontal: "─", vertical: "│", teeDown: "┬", teeUp: "┴", teeLeft: "┤", teeRight: "├", cross: "┼" },
	table: { topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘", horizontal: "─", vertical: "│", teeDown: "┬", teeUp: "┴", teeLeft: "┤", teeRight: "├", cross: "┼" },
	quoteBorder: "│",
	hrChar: "─",
	spinnerFrames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

const EDITOR_THEME: EditorTheme = {
	borderColor: (s) => c("gray", s),
	hintStyle: (s) => c("dim", s),
	symbols: EDITOR_SYMBOLS,
	selectList: {
		selectedPrefix: (s) => c("cyan", s),
		selectedText: (s) => c("cyan", s),
		description: (s) => c("dim", s),
		scrollInfo: (s) => c("dim", s),
		noMatch: (s) => c("dim", s),
		symbols: EDITOR_SYMBOLS,
	},
};

/** Max visual rows the composer may occupy before it scrolls internally. */
const EDITOR_MAX_LINES = 8;

/** The Editor emits a hardware-cursor APC marker when focused; we paint a
 *  software cursor in the composed frame instead, so drop the marker. */
function stripCursorMarker(line: string): string {
	return line.includes(CURSOR_MARKER) ? line.split(CURSOR_MARKER).join("") : line;
}

export class SquadTui {
	private readonly manager: SquadManager;
	private state: BoardState;
	private readonly transcripts = new Map<string, TranscriptEntry[]>();
	private readonly editor: Editor;
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
		this.editor = this.makeEditor();
		this.onEvent = (e) => this.handleEvent(e);
		this.onKey = (data) => this.handleKey(data);
	}

	/** Build the borderless composer: a real pi-tui Editor (multiline, cursor,
	 *  paste, kill-ring, undo, PageUp/PageDown history) painted as the input row. */
	private makeEditor(): Editor {
		const editor = new Editor(EDITOR_THEME);
		editor.setBorderVisible(false);
		editor.setPaddingX(0);
		editor.focused = true;
		editor.onChange = (text) => {
			this.state.draft = text;
			this.scheduleRedraw();
		};
		editor.onSubmit = (text) => this.submit(text);
		return editor;
	}

	run(): Promise<void> {
		return new Promise<void>((resolve) => {
			this.onQuit = resolve;
			this.running = true;
			this.manager.on("event", this.onEvent);
			process.stdout.write(`${ESC}?1049h${ESC}?25l${ESC}?2004h`);
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
		process.stdout.write(`${ESC}?2004l${ESC}?25h${ESC}?1049l`);
		this.onQuit?.();
	}

	private handleEvent(e: SquadEvent): void {
		switch (e.type) {
			case "roster":
				this.state.agents = e.agents;
				if (!this.state.selectedId) this.state.selectedId = orderedAgents(e.agents)[0]?.agent.id;
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
					this.state.selectedId = orderedAgents(this.state.agents)[0]?.agent.id;
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
		const ordered = orderedAgents(this.state.agents);
		if (!ordered.length) return;
		const idx = Math.max(0, ordered.findIndex((o) => o.agent.id === this.state.selectedId));
		this.state.selectedId = ordered[Math.min(ordered.length - 1, Math.max(0, idx + delta))].agent.id;
		this.syncTranscript();
	}

	private openSelected(): void {
		if (!this.selected()) return;
		this.state.view = "agent";
		this.state.scroll = 0;
		this.syncTranscript();
		if (this.state.selectedId) this.manager.applyCommand({ type: "subscribe", id: this.state.selectedId });
	}

	/** Editor `onSubmit` sink: route the composed text by view + pending state.
	 *  The Editor has already trimmed the value and cleared itself by this point. */
	private submit(text: string): void {
		const t = text.trim();
		if (this.state.view === "list") {
			if (t) {
				this.editor.addToHistory(t);
				this.spawn(t);
			} else {
				this.openSelected();
			}
			this.scheduleRedraw();
			return;
		}
		const sel = this.selected();
		if (!sel) {
			this.state.view = "list";
			this.scheduleRedraw();
			return;
		}
		if (t.startsWith("/")) {
			this.editor.addToHistory(t);
			this.runSlash(sel, t);
			this.scheduleRedraw();
			return;
		}
		if (!t) return;
		this.editor.addToHistory(t);
		const pending = sel.pending[0];
		if (pending) {
			const value = pending.kind === "confirm" ? (/^y/i.test(t) ? "yes" : "no") : t;
			this.manager.applyCommand({ type: "answer", id: sel.id, requestId: pending.id, value });
		} else {
			this.manager.applyCommand({ type: "prompt", id: sel.id, message: t });
		}
		this.scheduleRedraw();
	}

	private spawn(task: string): void {
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

	/** Two-level key router: navigation keys steer the board; everything else
	 *  (typing, backspace, Enter=submit, bracketed paste, Ctrl shortcuts) flows
	 *  straight to the mounted Editor. */
	private handleKey(data: Buffer): void {
		const s = data.toString();
		if (s === "\x03") return this.quit(); // Ctrl-C
		if (s === "\x1b") this.onEsc(); // bare Esc
		else if (s === "\x1b[A") this.onUp();
		else if (s === "\x1b[B") this.onDown();
		else if (s === "\x1b[C") this.onRight();
		else if (s === "\x1b[D") this.onLeft();
		else this.editor.handleInput(s);
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
		else this.editor.handleInput("\x1b[C");
	}

	private onLeft(): void {
		if (this.state.view === "agent" && this.editor.getText() === "") this.state.view = "list";
		else this.editor.handleInput("\x1b[D");
	}

	private onEsc(): void {
		if (this.state.view === "agent") this.state.view = "list";
		else this.quit();
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

	/** Keep the composer's prompt gutter in sync with the current view/pending. */
	private applyEditorChrome(): void {
		const sel = this.selected();
		const answering = this.state.view === "agent" && sel !== undefined && sel.pending.length > 0;
		const label = this.state.view === "list" ? "new" : answering ? "answer" : "";
		this.editor.setPromptGutter(`${c("cyan", `${label}›`)} `);
	}

	/** Compose the frame: `buildBoard` chrome (minus its static composer line)
	 *  with the live mounted Editor painted where the composer used to be. */
	private render(): void {
		if (!this.running) return;
		const { width, height } = this.state;
		this.applyEditorChrome();
		this.editor.setMaxHeight(Math.max(1, Math.min(EDITOR_MAX_LINES, Math.floor(height / 3))));
		const editorLines = this.editor.render(width).map(stripCursorMarker);
		const composerRows = Math.max(1, editorLines.length);
		const chromeHeight = Math.max(3, height - composerRows + 1);
		const chrome = buildBoard({ ...this.state, height: chromeHeight });
		chrome.pop(); // drop buildBoard's static composer; the Editor renders the live one
		const out = [...chrome, ...editorLines];
		if (out.length > height) out.length = height;
		while (out.length < height) out.push("");
		process.stdout.write(`${ESC}H${ESC}J${out.join("\r\n")}`);
	}
}

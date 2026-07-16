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
import { writeOscNotify } from "./osc-notify.ts";
import { escalationPayload } from "./push.ts";
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
/** Working but silent longer than this = stalled. Matches the web (OMPSQ-7) by value. */
const STALL_MS = 120000;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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
	/** Wall clock for stall derivation. Injected so buildBoard stays pure + testable. */
	now: number;
	/** Spinner animation frame counter (advances while an agent is working). */
	frame: number;
	/** Friction-capture mode (plans/daily-dogfood-engine/01): the composer is a one-line gripe prompt —
	 *  Enter logs to the friction ledger, Esc cancels and restores the stashed draft. Toggled by Ctrl-G
	 *  (a printable key like `g` would steal the first keystroke of any draft that starts with it). */
	grr: boolean;
	/** Transient status line (e.g. "✓ logged to the friction ledger") shown in the hint row for a few
	 *  seconds — the TUI's stand-in for a toast. */
	notice?: string;
}

/** True on a validator verdict that must read as a HOLD, never a calm "ready to land" — a `veto`
 *  (semantic rejection) or an `inconclusive` (eap-borrows follow-up 7: the land diff couldn't be
 *  COMPUTED, an environmental git fault). Both can coexist with `landReady:true` (the land attempt that
 *  produced the verdict doesn't clear the staged flag on a blocked/retryable outcome — only a
 *  successful land does), so every "is this actually landable right now" check must exclude both, not
 *  just `veto`. Fail-open fix: treating `verdict !== "veto"` as "safe to land" silently read an
 *  `inconclusive` hold as a pass. */
function isValidatorHeld(a: Pick<AgentDTO, "validation">): boolean {
	const v = a.validation?.verdict;
	return v === "veto" || v === "inconclusive";
}

/**
 * Exception-first ordering — the whole point of the board is "glance and know where to look", so
 * the rows that need a human float up. Ranks on the AGENT, not just its lifecycle status, so an
 * errored agent (previously buried *below* idle), a validator VETO, and a one-tap-landable agent
 * each rise above calm work instead of hiding in the middle.
 */
function agentRank(a: AgentDTO): number {
	if (a.status === "input") return 0; // blocked on your answer
	if (a.status === "error") return 1; // crashed — must not sink below idle
	if (a.landReady && isValidatorHeld(a)) return 2; // green but the judge said no / couldn't say → review
	if (a.landReady) return 3; // one keystroke from landing
	const rest: Record<AgentStatus, number> = { working: 4, idle: 5, starting: 6, stopped: 7, input: 0, error: 1 };
	return rest[a.status] ?? 5;
}

function sortAgents(agents: AgentDTO[]): AgentDTO[] {
	return [...agents].sort((a, b) => agentRank(a) - agentRank(b) || a.name.localeCompare(b.name));
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

// ── Stat-header formatting (mirrors the web dashboard's read-outs by value) ───
function fmtDur(ms: number): string {
	const s = ms / 1000;
	return s < 60 ? `${s.toFixed(1)}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
}
function fmtCost(n: number): string {
	return `$${n.toFixed(4)}`;
}
function fmtTokens(n: number): string {
	return n < 1000 ? `${n}` : n < 1e6 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1e6).toFixed(1)}M`;
}
/** Context-usage colour: red near compaction, yellow when filling, dim otherwise. Matches the web. */
function ctxColor(p: number): string {
	return p > 0.9 ? "red" : p > 0.7 ? "yellow" : "dim";
}

/** Rich agent-view stat header: branch · model · ctx% · cost · tokens · tool-calls · duration. */
function statHeader(sel: AgentDTO, now: number): string {
	const r = sel.receipt;
	const durMs = r?.durationMs ?? (sel.startedAt ? now - sel.startedAt : undefined);
	const parts: string[] = [];
	if (sel.branch) parts.push(c("dim", `⎇ ${sel.branch}`));
	if (sel.model) parts.push(c("dim", sel.model));
	if (sel.contextPct != null) parts.push(c(ctxColor(sel.contextPct), `ctx ${Math.round(sel.contextPct * 100)}%`));
	if (r?.costUsd != null) parts.push(c("dim", fmtCost(r.costUsd)));
	if (r?.tokens != null) parts.push(c("dim", `${fmtTokens(r.tokens)} tok`));
	if (r) parts.push(c("dim", `🔧 ${r.toolCalls}`));
	if (durMs != null) parts.push(c("dim", fmtDur(durMs)));
	return parts.join(c("gray", " · "));
}

/** Landing + authority line for the agent view — the trust state the board used to discard: proof
 *  freshness, the INDEPENDENT validator verdict (a VETO must never be silent), run confidence (and
 *  the propose-only cap it triggers), effective mode, and land-readiness. Empty until there's
 *  anything to say, so a fresh agent's view stays uncluttered. */
function landHeader(sel: AgentDTO): string {
	const parts: string[] = [];
	const vs = sel.verificationState;
	if (vs && vs !== "unknown") parts.push(c(vs === "fresh" ? "green" : vs === "failed" ? "red" : "yellow", `proof ${vs}`));
	const v = sel.validation;
	if (v && v.verdict !== "skipped") {
		if (v.verdict === "veto") parts.push(c("red", `⛔ VETOED${v.rationale ? `: ${v.rationale}` : ""}`));
		else if (v.verdict === "inconclusive") parts.push(c("yellow", "⏳ inconclusive — diff fault, retrying"));
		else if (v.verdict === "pass") parts.push(c("green", "validated ✓"));
		else parts.push(c("dim", "unjudged"));
	}
	if (sel.confidence != null) {
		const low = sel.confidence < 0.4; // mirrors backend confidenceFloor() default
		parts.push(c(low ? "yellow" : "dim", `conf ${Math.round(sel.confidence * 100)}%${low ? " · propose-only" : ""}`));
	}
	if (sel.effectiveMode) parts.push(c("dim", sel.effectiveMode));
	if (sel.landReady && !isValidatorHeld(sel)) parts.push(c("green", "· ready to land"));
	else if (sel.blockedReason) parts.push(c("yellow", `· held: ${sel.blockedReason}`));
	return parts.join(c("gray", " · "));
}

/** Compact right-of-status marker for a list row — the one exception token that most wants a human. */
function rowBadge(a: AgentDTO): string {
	if (a.landReady && a.validation?.verdict === "veto") return c("red", "⛔VETO ");
	if (a.landReady && a.validation?.verdict === "inconclusive") return c("yellow", "⏳HOLD ");
	if (a.landReady) return c("green", "✓LAND ");
	if (a.blockedReason) return c("yellow", "‖HELD ");
	return "";
}

/** Pure renderer: produce exactly `height` width-safe lines for the current state. */
export function buildBoard(state: BoardState): string[] {
	const { width, height, view } = state;
	const agents = sortAgents(state.agents);
	const need = agents.filter((a) => a.status === "input").length;
	const vetoed = agents.filter((a) => a.landReady && a.validation?.verdict === "veto").length;
	const ready = agents.filter((a) => a.landReady && !isValidatorHeld(a)).length;
	const lines: string[] = [];

	const title = `${c("bold", c("cyan", "glance"))}  ${c("dim", `${agents.length} agents`)}${
		need ? c("red", ` · ${need} need input`) : ""
	}${vetoed ? c("red", ` · ${vetoed} vetoed`) : ""}${ready ? c("green", ` · ${ready} ready`) : ""}${state.connected ? "" : c("red", "  [disconnected]")}`;
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
			const stalled = a.status === "working" && state.now - a.lastActivity > STALL_MS;
			const dot = a.status === "working" ? c(STATUS_COLOR.working, SPINNER[state.frame % SPINNER.length]) : c(STATUS_COLOR[a.status], STATUS_DOT[a.status]);
			const g = KIND_GLYPH[a.kind];
			const kindMark = g ? c(KIND_COLOR[a.kind] ?? "dim", g) : " ";
			const name = pad((depth ? "└ " : "") + a.name, nameW);
			const branch = c("dim", pad(a.branch ?? "—", branchW));
			const act = pad(rowBadge(a) + (stalled ? "⏳ " : "") + (a.activity ?? a.todo?.active ?? (a.error ? `⚠ ${a.error}` : "—")), actW);
			const meta = c("dim", pad(`${a.todo ? `${a.todo.done}/${a.todo.total}` : ""}  ${a.contextPct != null ? `${Math.round(a.contextPct * 100)}%` : ""}`, metaW));
			const row = `${dot} ${kindMark} ${selRow ? c("bold", name) : name} ${branch} ${act} ${meta}`;
			lines.push(selRow ? `${ESC}7m${pad(stripAnsi(row), width)}${RESET}` : pad(row, width));
		}
		if (!state.agents.length) lines.push(c("dim", "  No agents yet — type a task below and press Enter to spawn one."));
		while (lines.length < height - 2) lines.push("");
		const short = state.cwd.length > 40 ? `…${state.cwd.slice(-39)}` : state.cwd;
		const navHint = `↑/↓ select · → open · Enter = new agent in ${short} · Ctrl-G gripe · Ctrl-C quit`;
		if (state.grr) lines.push(pad(c("yellow", "grr — what just annoyed you? Enter logs it · Esc cancels"), width));
		else if (state.notice) lines.push(pad(`${state.notice} ${c("dim", navHint)}`, width));
		else lines.push(pad(need ? `${c("red", `⛔ ${need} waiting · press a to answer`)} ${c("dim", navHint)}` : c("dim", navHint), width));
		lines.push(composerLine(state.grr ? "grr" : "new", state.draft, width));
	} else {
		const sel = agents.find((a) => a.id === state.selectedId);
		if (!sel) {
			lines.push(c("dim", "agent unavailable — ← back to list"));
			while (lines.length < height - 2) lines.push("");
			lines.push(pad(c("dim", "← back · Ctrl-C quit"), width));
			lines.push(composerLine("", state.draft, width));
		} else {
			const issue = sel.issue ? c("dim", ` · ${sel.issue.identifier ?? ""} ${sel.issue.name}`) : "";
			const head = `${c("bold", sel.name)} ${c(STATUS_COLOR[sel.status], `[${sel.status}]`)}${issue}`;
			lines.push(pad(head, width));
			lines.push(pad(statHeader(sel, state.now), width));
			const lh = landHeader(sel);
			if (lh) lines.push(pad(lh, width));
			const transcriptRows = Math.max(1, height - lines.length - sel.pending.length - 2);
			const end = Math.max(0, state.transcript.length - state.scroll);
			const start = Math.max(0, end - transcriptRows);
			for (const e of state.transcript.slice(start, end)) lines.push(pad(renderEntry(e, width), width));
			while (lines.length < height - sel.pending.length - 2) lines.push("");
			for (const p of sel.pending) {
				const hint = p.kind === "confirm" ? "[y/n]" : p.kind === "select" ? `[${(p.options ?? []).join("/")}]` : "[type an answer]";
				lines.push(pad(c("red", `⛔ ${p.title}${p.message ? ` — ${p.message}` : ""} ${c("dim", hint)}`), width));
			}
			if (state.grr) lines.push(pad(c("yellow", "grr — what just annoyed you? Enter logs it · Esc cancels"), width));
			else if (state.notice) lines.push(pad(`${state.notice} ${c("dim", "← back · Ctrl-C quit")}`, width));
			else lines.push(pad(c("dim", "← back · Enter send · /stop /restart /kill /grr · Ctrl-C quit"), width));
			lines.push(composerLine(state.grr ? "grr" : sel.pending.length ? "answer" : "", state.draft, width));
		}
	}

	if (lines.length > height) return lines.slice(0, height);
	while (lines.length < height) lines.push("");
	return lines;
}

/** Split a `/verb rest of line` slash command — verb lowercased, arg's own casing preserved
 *  (a gripe is prose, not a keyword). Exported for unit tests. */
export function parseSlash(cmd: string): { verb: string; arg: string } {
	const body = cmd.replace(/^\//, "").trim();
	const space = body.search(/\s/);
	if (space === -1) return { verb: body.toLowerCase(), arg: "" };
	return { verb: body.slice(0, space).toLowerCase(), arg: body.slice(space).trim() };
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
	private spinTimer?: Timer;
	/** Draft stashed while the composer is borrowed as the grr prompt — restored on submit/cancel. */
	private grrStash = "";
	private noticeTimer?: Timer;
	private readonly prevStatus = new Map<string, AgentStatus>();
	private readonly lastBell = new Map<string, number>();
	private seeded = false;

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
			now: Date.now(),
			frame: 0,
			grr: false,
		};
		for (const a of this.state.agents) this.transcripts.set(a.id, manager.getTranscript(a.id));
		for (const a of this.state.agents) this.prevStatus.set(a.id, a.status);
		this.seeded = true;
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
		clearTimeout(this.noticeTimer);
		if (this.spinTimer) { clearInterval(this.spinTimer); this.spinTimer = undefined; }
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
				this.prevStatus.clear();
				for (const a of e.agents) this.prevStatus.set(a.id, a.status);
				this.seeded = true;
				break;
			case "agent": {
				const prev = this.prevStatus.get(e.agent.id);
				const i = this.state.agents.findIndex((a) => a.id === e.agent.id);
				if (i >= 0) this.state.agents[i] = e.agent;
				else this.state.agents.push(e.agent);
				if (!this.state.selectedId) this.state.selectedId = e.agent.id;
				this.signal(e.agent, prev);
				this.prevStatus.set(e.agent.id, e.agent.status);
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

	/** Out-of-band attention signal on a status transition into a blocking/error state:
	 *  terminal bell + desktop-notify sequences (OSC 9 + OSC 777, sanitized). The transition
	 *  rule and payload text are escalationPayload — shared with the web-push lane so the
	 *  two can never drift. Guarded by the initial seed + a per-agent throttle so a
	 *  reconnect/replay never rings a storm. */
	private signal(a: AgentDTO, prev?: AgentStatus): void {
		const payload = escalationPayload(prev, a, this.seeded);
		if (!payload) return;
		const now = Date.now();
		if (now - (this.lastBell.get(a.id) ?? 0) < 2000) return;
		this.lastBell.set(a.id, now);
		process.stdout.write("\x07");
		writeOscNotify(payload.title, payload.body);
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

	/** Jump selection to the next blocked agent (oldest-waiting first) and open it. */
	private jumpToBlocked(): void {
		const blocked = this.state.agents.filter((a) => a.status === "input").sort((x, y) => x.lastActivity - y.lastActivity);
		if (!blocked.length) return;
		const cur = blocked.findIndex((a) => a.id === this.state.selectedId);
		this.state.selectedId = (blocked[(cur + 1) % blocked.length] ?? blocked[0]).id;
		this.openSelected();
	}

	// ── Friction capture (plans/daily-dogfood-engine/01) ──────────────────────
	// Ctrl-G borrows the composer as a one-line gripe prompt; Enter records through the SAME
	// manager write path POST /api/friction uses (recordFriction — the TUI lives in the daemon
	// process, so looping back over HTTP would only add a token round trip to an in-process call),
	// Esc cancels. The in-progress draft is stashed and restored either way — capturing a gripe
	// must never eat the message the operator was mid-typing.

	private toggleGrr(): void {
		if (this.state.grr) {
			this.cancelGrr();
			return;
		}
		this.state.grr = true;
		this.grrStash = this.editor.getText();
		this.editor.setText("");
		this.state.draft = "";
	}

	private cancelGrr(): void {
		this.state.grr = false;
		this.editor.setText(this.grrStash);
		this.state.draft = this.grrStash;
		this.grrStash = "";
	}

	private submitGrr(text: string): void {
		this.state.grr = false;
		const stash = this.grrStash;
		this.grrStash = "";
		this.editor.setText(stash);
		this.state.draft = stash;
		const gripe = text.trim();
		if (!gripe) {
			this.showNotice(c("dim", "· nothing logged — the gripe was empty"));
			return;
		}
		const sel = this.state.view === "agent" ? this.selected() : undefined;
		this.recordFriction(gripe, sel);
	}

	/** Shared by Ctrl-G submit and the /grr slash verb — one call site into the manager. */
	private recordFriction(gripe: string, sel?: AgentDTO): void {
		try {
			this.manager.recordFriction({ repo: sel?.repo ?? this.state.cwd, gripe, context: "tui", agentId: sel?.id });
			this.showNotice(c("green", "✓ logged to the friction ledger"));
		} catch (err) {
			this.showNotice(c("red", `✗ not logged: ${err instanceof Error ? err.message : String(err)}`));
		}
	}

	private showNotice(text: string): void {
		this.state.notice = text;
		clearTimeout(this.noticeTimer);
		this.noticeTimer = setTimeout(() => {
			this.state.notice = undefined;
			this.render();
		}, 3000);
	}

	/** Editor `onSubmit` sink: route the composed text by view + pending state.
	 *  The Editor has already trimmed the value and cleared itself by this point. */
	private submit(text: string): void {
		const t = text.trim();
		if (this.state.grr) {
			this.submitGrr(t);
			this.scheduleRedraw();
			return;
		}
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
		if (s === "\x07") this.toggleGrr(); // Ctrl-G — friction capture, both views
		else if (s === "\x1b") this.onEsc(); // bare Esc
		else if (s === "\x1b[A") this.onUp();
		else if (s === "\x1b[B") this.onDown();
		else if (s === "\x1b[C") this.onRight();
		else if (s === "\x1b[D") this.onLeft();
		else if (s === "a" && !this.state.grr && this.state.view === "list" && this.state.draft === "" && this.state.agents.some((a) => a.status === "input")) this.jumpToBlocked();
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
		if (this.state.grr) this.cancelGrr();
		else if (this.state.view === "agent") this.state.view = "list";
		else this.quit();
	}

	private runSlash(sel: AgentDTO, cmd: string): void {
		const parsed = parseSlash(cmd);
		const verb = parsed.verb;
		// The pre-existing verbs stay argument-less (exactly as before — "/stop something" never
		// interrupted, and silently starting to would be a behavior change smuggled into this diff).
		if (parsed.arg === "") {
			if (verb === "stop" || verb === "interrupt") this.manager.applyCommand({ type: "interrupt", id: sel.id });
			else if (verb === "restart") this.manager.applyCommand({ type: "restart", id: sel.id });
			else if (verb === "kill") this.manager.applyCommand({ type: "kill", id: sel.id });
			else if (verb === "back") this.state.view = "list";
			else if (verb === "rm") {
				this.manager.applyCommand({ type: "remove", id: sel.id });
				this.state.view = "list";
			} else if (verb === "grr") this.toggleGrr(); // bare /grr opens the Ctrl-G prompt
			return;
		}
		// `/grr <text>` — the type-it-inline capture for whoever would rather not leave the text flow.
		if (verb === "grr") this.recordFriction(parsed.arg, sel);
	}

	private scheduleRedraw(): void {
		if (this.redrawTimer) return;
		this.redrawTimer = setTimeout(() => {
			this.redrawTimer = undefined;
			this.render();
		}, 50);
	}

	/** Animate spinners only while an agent is working — advance the frame + redraw,
	 *  stop the timer when nothing is working (no idle CPU burn). */
	private maybeAnimate(): void {
		const working = this.state.agents.some((a) => a.status === "working");
		if (working && !this.spinTimer) this.spinTimer = setInterval(() => { this.state.frame++; this.render(); }, 120);
		else if (!working && this.spinTimer) { clearInterval(this.spinTimer); this.spinTimer = undefined; }
	}

	/** Keep the composer's prompt gutter in sync with the current view/pending. */
	private applyEditorChrome(): void {
		const sel = this.selected();
		const answering = this.state.view === "agent" && sel !== undefined && sel.pending.length > 0;
		const label = this.state.grr ? "grr" : this.state.view === "list" ? "new" : answering ? "answer" : "";
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
		this.state.now = Date.now();
		const chrome = buildBoard({ ...this.state, height: chromeHeight });
		chrome.pop(); // drop buildBoard's static composer; the Editor renders the live one
		const out = [...chrome, ...editorLines];
		if (out.length > height) out.length = height;
		while (out.length < height) out.push("");
		process.stdout.write(`${ESC}H${ESC}J${out.join("\r\n")}`);
		this.maybeAnimate();
	}
}

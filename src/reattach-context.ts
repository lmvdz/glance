/**
 * Restart re-attach — honest casual-session survival across a daemon restart
 * (plans/daily-onramp/04-restart-reattach.md).
 *
 * A `glance here` session rides an ACP harness (claude-code): a direct child spawn with no detached
 * host, so a daemon restart kills it and the boot-restore paths correctly SKIP it (respawning under
 * the dead session's id would fake a resume that never happened — squad-manager's concern-07 skip).
 * What was missing is honesty about the skip: the id simply vanished from the roster, and a client
 * polling it got a bare miss indistinguishable from "id never existed".
 *
 * This module is the pure half of the fix (unit-tested without a manager):
 *   - `buildDeadPlaceholder` — the minimal terminal record a skipped non-resumable session leaves
 *     behind, so `GET /api/agents/:id` and the transcript route can still answer truthfully for a
 *     bounded window after restart. Fail-closed on a corrupt persisted transcript: the placeholder
 *     still exists and says the context is unrecoverable — never a silent hang, never a fabricated
 *     "resumed" state.
 *   - `composePriorContext` — the prior transcript folded into a prompt-ready context block for the
 *     successor session's FIRST prompt (the `decoratePrompt` feed-forward precedent). Capped to a
 *     tail: full replay of an arbitrarily long casual session is unbounded context, not a fix.
 *   - `reattachMarker` — the unmissable system-entry text at the top of the successor session, in
 *     both the CLI REPL and the webapp transcript view (both render system entries). Never silent,
 *     never presented as a seamless resume it isn't (the a192134 dead-agent-honesty lineage).
 */

import { settleRunningEntries } from "./transcript-delta.ts";
import type { PersistedAgent, TranscriptEntry } from "./types.ts";

/** Minimal terminal record of a session a restart killed — answers "what happened to this id?". */
export interface DeadSessionPlaceholder {
	id: string;
	name: string;
	repo: string;
	worktree: string;
	harness?: string;
	/** Why the session is dead, in operator-readable prose (surfaced verbatim by the REPL). */
	deadReason: string;
	/** When the placeholder was recorded (boot time) — starts the bounded answer window. */
	at: number;
	/** The persisted transcript, for the honest re-attach's context tail. Empty when the session
	 *  never spoke or its persisted copy was unreadable (then `deadReason` says so). */
	transcript: TranscriptEntry[];
}

/** How long after a restart a dead session's id still answers truthfully instead of 404ing. The
 *  window is additionally bounded by the daemon process itself (placeholders are in-memory) and by
 *  the first post-boot persist (which drops the dead record from state.json). */
export const DEAD_PLACEHOLDER_TTL_MS = 24 * 60 * 60 * 1000;

/** Tail caps for `composePriorContext` — most-recent turns win the budget. */
export const PRIOR_CONTEXT_MAX_ENTRIES = 30;
export const PRIOR_CONTEXT_MAX_CHARS = 8000;

/** Build the placeholder for a persisted agent the boot paths skipped as non-resumable. Pure and
 *  total: a corrupt/unreadable persisted transcript degrades to an empty tail with the failure named
 *  in `deadReason` (fail-closed honesty), never a throw out of a boot sweep. */
export function buildDeadPlaceholder(p: PersistedAgent, transcript: unknown, now = Date.now()): DeadSessionPlaceholder {
	const harness = p.harness ?? p.runtime;
	let entries: TranscriptEntry[] = [];
	let transcriptNote = "";
	if (transcript === undefined) {
		// Nothing persisted — a session that never produced a transcript. Honest empty tail, no error.
	} else if (Array.isArray(transcript)) {
		entries = transcript.filter((e): e is TranscriptEntry => typeof e === "object" && e !== null && typeof (e as TranscriptEntry).text === "string");
		if (entries.length < transcript.length) transcriptNote = " Parts of its persisted transcript were unreadable; the recovered context may be incomplete.";
	} else {
		transcriptNote = " Its persisted transcript was unreadable, so the prior conversation could not be recovered.";
	}
	// The session is dead by definition here — a `running` entry in the recovered tail can never
	// settle and would read as a live "Working" claim in every placeholder consumer. Terminal record
	// ⇒ terminal entries (mirrors reattachTerminal's settle).
	settleRunningEntries(entries, "cancelled", now);
	return {
		id: p.id,
		name: p.name,
		repo: p.repo,
		worktree: p.worktree,
		harness,
		at: now,
		transcript: entries,
		deadReason: `did not survive a daemon restart — harness "${harness ?? "unknown"}" is not resumable (no detached host to reattach; respawning under the dead session's id would fake a resume that never happened).${transcriptNote}`,
	};
}

/** The prior conversation as a prompt-ready context block for the successor session's first turn,
 *  or undefined when there is nothing worth carrying. Only user/assistant speech is folded (tool
 *  chatter and thinking are noise at this altitude); `displayText` (the user's bare typed text) wins
 *  over the context-augmented `text`. Budgeted from the tail: the caps keep the MOST RECENT turns. */
export function composePriorContext(transcript: TranscriptEntry[]): string | undefined {
	const speech = transcript.filter((e) => (e.kind === "user" || e.kind === "assistant") && typeof e.text === "string" && (e.displayText ?? e.text).trim().length > 0);
	if (speech.length === 0) return undefined;
	const tail = speech.slice(-PRIOR_CONTEXT_MAX_ENTRIES);
	const lines: string[] = [];
	let used = 0;
	for (let i = tail.length - 1; i >= 0; i--) {
		const e = tail[i] as TranscriptEntry;
		const line = `${e.kind === "user" ? "user" : "assistant"}: ${(e.displayText ?? e.text).trim()}`;
		if (lines.length > 0 && used + line.length > PRIOR_CONTEXT_MAX_CHARS) break;
		lines.unshift(line.length > PRIOR_CONTEXT_MAX_CHARS ? `${line.slice(0, PRIOR_CONTEXT_MAX_CHARS - 1)}…` : line);
		used += line.length;
	}
	return [
		"--- Prior session context (recovered after a daemon restart; the previous session could not be resumed) ---",
		...lines,
		"--- End of prior context. The user's new message follows. ---",
	].join("\n");
}

/** The visible seam at the top of the successor session — a system transcript entry, so the CLI
 *  REPL (dim line) and the webapp transcript view both render it. Honest about whether prior
 *  context made it across. */
export function reattachMarker(priorId: string, harness: string, hasContext: boolean): string {
	return hasContext
		? `⟲ session restarted — the previous session (${priorId}) was not resumable (harness "${harness}"); continuing with your prior context.`
		: `⟲ session restarted — the previous session (${priorId}) was not resumable (harness "${harness}") and no prior context could be recovered; starting fresh.`;
}

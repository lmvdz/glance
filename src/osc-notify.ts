/**
 * osc-notify.ts — terminal-native attention lane (plans/fleet-ide-bridge B01).
 *
 * When a unit blocks on a human, the TUI writes desktop-notification escape
 * sequences so any OSC-aware terminal (WezTerm, Kitty, iTerm2, Windows
 * Terminal, urxvt) surfaces a native toast — no daemon round-trip, no deps:
 *
 *   OSC 9    ESC ] 9 ; <text> BEL                         (iTerm2/ConEmu lineage)
 *   OSC 777  ESC ] 777 ; notify ; <title> ; <body> BEL    (urxvt lineage)
 *
 * Deliberately NOT terax's `777;notify;Terax;<agent>;<event>` dialect: its
 * detector drops unknown agent names (agent_detect.rs @ a2c8329), and the
 * cockpit gets richer native notifications from the daemon SSE lane instead.
 *
 * Fields are sanitized before they enter a sequence — an agent-controlled
 * name must never smuggle ESC/BEL and forge further sequences.
 */
import { envBool } from "./config.ts";

const MAX_FIELD = 200;

/** Escape-proof a field: strip C0/C1 controls (ESC, BEL, CSI…), cap length. */
function sanitizeOscText(s: string): string {
	let out = "";
	for (const ch of s) {
		const c = ch.codePointAt(0) ?? 0;
		if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) continue;
		out += ch;
		if (out.length >= MAX_FIELD) break;
	}
	return out;
}

/** Pure: the exact escape sequences for one notification. */
function oscNotifySequences(title: string, body: string): string[] {
	// `;` in the title would shift OSC 777's fields; the body is the last field.
	const t = sanitizeOscText(title).replaceAll(";", ",");
	const b = sanitizeOscText(body);
	return [`\x1b]777;notify;${t};${b}\x07`, `\x1b]9;${b ? `${t}: ${b}` : t}\x07`];
}

/** Write both sequences. Inert when the stream is not a TTY (piped/logged
 *  output stays clean) or when OMP_SQUAD_OSC_NOTIFY=0. Returns whether written. */
export function writeOscNotify(
	title: string,
	body: string,
	out: { isTTY?: boolean; write(chunk: string): unknown } = process.stdout,
): boolean {
	if (!out.isTTY || !envBool("OMP_SQUAD_OSC_NOTIFY", true)) return false;
	for (const seq of oscNotifySequences(title, body)) out.write(seq);
	return true;
}

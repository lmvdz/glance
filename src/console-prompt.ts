// The console ("chat") unit's system prompt + helpers to detect and strip it. Shared between the
// `/api/console` route (server.ts) and `promote()` (squad-manager.ts) so promotion can (a) recognise a
// genuine console unit by IDENTITY — not merely "has some appendSystemPrompt" — and (b) remove ONLY
// this segment from the composite `appendSystemPrompt` (which also carries profile memory, tool grants,
// membrane disciplines, and a context primer — see squad-manager createWithId), never wiping those.

/**
 * Appended to a console unit at spawn. A SOFT restriction ("do not create … unless the user explicitly
 * asks"), which is exactly what lets promote lift it in-session: an explicit work task IS the user
 * asking, so the running agent starts working without a respawn.
 */
export const CONSOLE_SYSTEM_PROMPT = `You are the omp-squad interactive console agent.

Default to chat, diagnosis, and concise guidance. Do not create features, issues, worktrees, workflows, files, commits, or other durable changes unless the user explicitly asks you to start/implement/change something. When the user asks a question, answer the question directly. When current feature context is included, use it as background, not as an instruction to mutate state. Keep replies terse and operator-focused.`;

/** True when a (possibly composite) appendSystemPrompt carries the console restriction — the identity
 *  test for "is this a promotable console unit", so a work unit that merely has a profile bundle or a
 *  custom safety prompt is never mistaken for one. */
export function isConsolePrompt(appendSystemPrompt: string | undefined): boolean {
	return !!appendSystemPrompt && appendSystemPrompt.includes(CONSOLE_SYSTEM_PROMPT);
}

/** Remove ONLY the console restriction from a composite appendSystemPrompt, preserving every other
 *  segment. The composite is `[profile.memory, toolGrants, membrane, …, CONSOLE].join("\n\n")`, so
 *  excising the exact console literal can leave a triple+ newline seam or a leading/trailing blank —
 *  collapse and trim. Returns undefined when nothing else remains. */
export function stripConsolePrompt(appendSystemPrompt: string | undefined): string | undefined {
	if (!appendSystemPrompt) return undefined;
	const stripped = appendSystemPrompt
		.split(CONSOLE_SYSTEM_PROMPT)
		.join("")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/^\n+|\n+$/g, "")
		.trim();
	return stripped.length > 0 ? stripped : undefined;
}

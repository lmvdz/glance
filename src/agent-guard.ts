/**
 * Agent guardrails — the deny policy a squad agent's hook enforces on EVERY tool call.
 *
 * A dispatched agent runs `--approval-mode yolo` in its own worktree, so without fencing it can
 * (and did) take the whole fleet down: spawn rogue daemons (`omp-squad up`), set up watchdog loops
 * (`while true; … up.sh`), kill the daemon (`pkill bun`), grab the admin token, or edit the shared
 * main checkout. None of that is ever legitimate agent work — an agent's job is to change code IN
 * ITS WORKTREE and let the daemon land + supervise.
 *
 * `screenToolCall` returns a block reason for any such operation and `undefined` for everything
 * else. It is enforced in-process by the agent's hook (lease-hook), so a `{ block: true }` return
 * stops the tool BEFORE it runs — yolo can't bypass it (yolo only auto-approves; a hook block is a
 * hard stop). Pure + data-driven so the policy is unit-tested and trivially extended.
 */

import * as path from "node:path";

export interface GuardBlock {
	block: true;
	reason: string;
}

/**
 * Shell commands an agent must NEVER run. Each is matched against the bash tool's `command` string.
 * Scoped to genuinely catastrophic, host-level actions — not ordinary build/test/git work — so false
 * positives are rare and the reason tells the agent exactly why.
 */
const FORBIDDEN_COMMANDS: { re: RegExp; reason: string }[] = [
	// Daemon lifecycle: only the operator/watchdog runs these. An agent doing so spawns a rival daemon.
	{ re: /\bomp-squad\b[^\n]*\b(up|down|restart|stop|reboot|shutdown)\b/, reason: "an agent must not control the squad daemon (omp-squad up/down/restart) — it spawns a rival daemon that fights for the state lock" },
	// (Re)launching the daemon via the launcher script — covers `./up.sh`, `bash …/up.sh`, watchdog loops.
	{ re: /\.\/up\.sh\b/, reason: "an agent must not launch the daemon via up.sh" },
	{ re: /\b(?:bash|sh|source|exec|nohup|setsid|env)\b[^\n]*\bup\.sh\b/, reason: "an agent must not launch the daemon via up.sh (that is the operator/watchdog's job)" },
	// Process killing: an agent in a worktree never needs to mass-kill — it takes out the daemon + siblings.
	{ re: /\b(?:pkill|killall)\b/, reason: "an agent must not mass-kill processes (pkill/killall) — it can take down the daemon and sibling agents" },
	{ re: /\bkill\b[^\n|;&]*\b(?:bun|omp|omp-squad|daemon|squad)\b/, reason: "an agent must not kill the daemon or agent processes" },
	{ re: /\bkill\s+(?:-9|-KILL|-SIGKILL|-s\s*(?:9|KILL|SIGKILL))\b/, reason: "an agent must not SIGKILL processes" },
	// Daemon control files: the launcher, the single-writer lock, and the admin token are off-limits.
	{ re: /\.omp\/squad\/(?:up\.sh|daemon\.lock|access-token)\b/, reason: "an agent must not read or write the daemon control files under ~/.omp/squad (launcher, lock, admin token)" },
];

/** Pull candidate file paths out of an edit/write tool-call input (mirrors the path resolution agents use). */
export function targetFiles(input: Record<string, unknown>): string[] {
	const files = new Set<string>();
	const p = input.path;
	if (typeof p === "string" && p) files.add(p);
	// `edit` patches carry one or more [PATH#TAG] section headers.
	const patch = input.input;
	if (typeof patch === "string") {
		for (const m of patch.matchAll(/\[([^\]\n#]+)#[0-9A-Fa-f]+\]/g)) files.add(m[1]);
	}
	return [...files];
}

/** First target path (if any) that resolves OUTSIDE `worktree`; agents must stay in their own worktree. */
export function escapesWorktree(paths: string[], worktree: string): string | undefined {
	const root = path.resolve(worktree);
	for (const p of paths) {
		const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p);
		const rel = path.relative(root, abs);
		if (rel === "") continue; // the worktree root itself
		if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return p;
	}
	return undefined;
}

/**
 * The deny gate. Returns a block (with a human reason) for a tool call that would touch the
 * daemon/host or escape the worktree; `undefined` to allow. Screens shell commands by the presence
 * of a `command` field (independent of the exact bash tool name) and edit/write by target path.
 */
export function screenToolCall(toolName: string, input: Record<string, unknown>, worktree: string): GuardBlock | undefined {
	const cmd = input.command;
	if (typeof cmd === "string" && cmd.trim()) {
		for (const f of FORBIDDEN_COMMANDS) {
			if (f.re.test(cmd)) return { block: true, reason: `squad guardrail: ${f.reason}` };
		}
	}
	if (toolName === "edit" || toolName === "write") {
		const escaped = escapesWorktree(targetFiles(input), worktree);
		if (escaped) return { block: true, reason: `squad guardrail: ${escaped} is outside this agent's worktree (${path.resolve(worktree)}) — agents must only edit files in their own worktree` };
	}
	return undefined;
}

/**
 * omp lease-hook — soft file leasing with soft-block-with-override.
 *
 * Load it (RpcAgent/agent-host loads it for squad agents; raw sessions via
 * `omp -e lease-hook.ts`). On an edit/write it resolves the target file(s) to
 * repo-relative paths. If another session already holds one and we have not yet
 * warned about it this session, the hook BLOCKS the first attempt: it returns a
 * reason that omp surfaces to the (possibly autonomous) agent in-stream AS AN
 * ERROR, naming the current holder(s). Re-issuing the same edit overrides — the
 * file is now flagged as warned, so the hook claims the lease and lets it run.
 *
 * Still advisory: it blocks at most once per file per session, never blocks an
 * uncontested file, and contended files surface in the command center for the
 * human in the loop. Leases release on session shutdown.
 */

import * as path from "node:path";
import * as os from "node:os";
import { statSync } from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { envBool } from "./config.ts";
import { claimLease, heartbeatSession, holdersOf, LEASE_TTL_MS, releaseSession } from "./leases.ts";
import type { LeaseEntry } from "./leases.ts";
import { hardenedGitSync } from "./git-harden.ts";
import { screenToolCall, targetFiles } from "./agent-guard.ts";
import { type PolicyRule, readPolicyDocSync } from "./policy.ts";
import { protectedStateRoots, resolveStateDir } from "./state-dir.ts";

/**
 * Operator policy rules (C-RULES) for THIS agent's tool calls, read from the daemon's `policy.json`
 * and mtime-cached so a hot tool loop doesn't stat-storm. OFF unless OMP_SQUAD_POLICY_RULES=1 (the
 * daemon mirrors the feature flag into every spawned agent's env). Fail-open: any error ⇒ no rules.
 */
let policyCache: { mtimeMs: number; rules: PolicyRule[] } | undefined;
function policyRulesForAgent(): PolicyRule[] {
	if (!envBool("OMP_SQUAD_POLICY_RULES", false)) return [];
	const dir = resolveStateDir();
	const file = path.join(dir, "policy.json");
	let mtimeMs: number;
	try {
		mtimeMs = statSync(file).mtimeMs;
	} catch {
		policyCache = undefined; // no file ⇒ no rules
		return [];
	}
	if (!policyCache || policyCache.mtimeMs !== mtimeMs) policyCache = { mtimeMs, rules: readPolicyDocSync(dir).rules };
	return policyCache.rules;
}

interface ToolCallEvent {
	toolName: string;
	input: Record<string, unknown>;
}

interface ContestedFile {
	rel: string;
	holders: LeaseEntry[];
}

function git(cwd: string, args: string[]): string | undefined {
	try {
		const r = hardenedGitSync(["-C", cwd, ...args]);
		if (r.code !== 0) return undefined;
		const out = r.stdout.trim();
		return out.length ? out : undefined;
	} catch {
		return undefined;
	}
}


function ago(ts: number): string {
	const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
	return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}

export default function leaseHook(pi: ExtensionAPI): void {
	let repo = process.cwd();
	const home = os.homedir();
	let protectedRoots: string[] = [];
	const session = `omp:${process.pid}`;
	let timer: Timer | undefined;
	const warned = new Set<string>();

	pi.on("session_start", async () => {
		repo = git(process.cwd(), ["rev-parse", "--show-toplevel"]) ?? process.cwd();
		// Protected trees the guard fences this agent out of: the shared MAIN checkout (resolved via the
		// worktree's shared git dir) and the glance state dir (launcher/lock/token + sibling worktrees) —
		// BOTH default locations (~/.glance + legacy ~/.omp/squad) plus any env override, since a
		// mixed-version daemon may still write the other one. The agent's own worktree, though nested
		// under the state dir, is exempt in the guard.
		const commonDir = git(repo, ["rev-parse", "--git-common-dir"]);
		const mainRepo = commonDir ? path.dirname(path.resolve(repo, commonDir)) : repo;
		protectedRoots = [...protectedStateRoots(home), mainRepo];
		timer = setInterval(() => void heartbeatSession(session, repo), Math.min(40_000, Math.floor(LEASE_TTL_MS / 3)));
		timer.unref?.();
	});

	pi.on("tool_call", async (event, ctx) => {
		const ev = event as ToolCallEvent;
		// Guardrail FIRST — hard-block daemon/host control + out-of-worktree edits for EVERY tool call,
		// before the edit/write lease logic below. A yolo agent can't bypass it: a hook block stops the
		// tool before it runs. `repo` is this agent's worktree root (resolved in session_start).
		const fenced = screenToolCall(ev.toolName, ev.input, { worktree: repo, protectedRoots, home, policyRules: policyRulesForAgent() });
		if (fenced) {
			if (ctx.hasUI) await ctx.ui.notify(fenced.reason, "error");
			return fenced;
		}
		if (ev.toolName !== "edit" && ev.toolName !== "write") return undefined;
		const rels: string[] = [];
		for (const f of targetFiles(ev.input)) {
			const abs = path.isAbsolute(f) ? f : path.resolve(repo, f);
			rels.push(path.relative(repo, abs) || f);
		}
		try {
			// First pass: which target files are freshly contested (held by another
			// session and not yet warned about this session)?
			const contested: ContestedFile[] = [];
			for (const rel of rels) {
				if (warned.has(rel)) continue;
				const holders = await holdersOf(repo, rel, session);
				if (holders.length) contested.push({ rel, holders });
			}
			if (contested.length) {
				// Soft-block the first attempt: warn, then return an error to the agent.
				// Do NOT claim leases here — the edit will not run.
				for (const c of contested) {
					warned.add(c.rel);
					if (ctx.hasUI) {
						const o = c.holders[0];
						await ctx.ui.notify(`⚠ ${c.rel} is also being edited by ${o.operator}/${o.session} (${ago(o.heartbeat)})`, "warning");
					}
				}
				const detail = contested
					.map((c) => `${c.rel} held by ${c.holders.map((h) => `${h.operator}/${h.session} (${ago(h.heartbeat)})`).join(", ")}`)
					.join("; ");
				return { block: true, reason: `File lease conflict: ${detail} — re-issue the edit to override.` };
			}
			// No fresh conflict (uncontested, or this is the override re-issue): claim
			// leases on every target and let the edit proceed.
			for (const rel of rels) await claimLease({ repo, file: rel, session });
		} catch {
			/* advisory — a registry error must never block or throw */
		}
		return undefined;
	});

	pi.on("session_shutdown", async () => {
		clearInterval(timer);
		await releaseSession(session, repo).catch(() => {});
	});
}

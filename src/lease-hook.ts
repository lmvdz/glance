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
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { claimLease, heartbeatSession, holdersOf, LEASE_TTL_MS, releaseSession } from "./leases.ts";
import type { LeaseEntry } from "./leases.ts";
import { hardenedGitSync } from "./git-harden.ts";

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

/** Pull candidate file paths out of an edit/write tool call. */
function targetFiles(ev: ToolCallEvent): string[] {
	const files = new Set<string>();
	const p = ev.input.path;
	if (typeof p === "string" && p) files.add(p);
	// `edit` patches carry one or more [PATH#TAG] section headers.
	const patch = ev.input.input;
	if (typeof patch === "string") {
		for (const m of patch.matchAll(/\[([^\]\n#]+)#[0-9A-Fa-f]+\]/g)) files.add(m[1]);
	}
	return [...files];
}

function ago(ts: number): string {
	const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
	return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}

export default function leaseHook(pi: ExtensionAPI): void {
	let repo = process.cwd();
	const session = `omp:${process.pid}`;
	let timer: Timer | undefined;
	const warned = new Set<string>();

	pi.on("session_start", async () => {
		repo = git(process.cwd(), ["rev-parse", "--show-toplevel"]) ?? process.cwd();
		timer = setInterval(() => void heartbeatSession(session, repo), Math.min(40_000, Math.floor(LEASE_TTL_MS / 3)));
		timer.unref?.();
	});

	pi.on("tool_call", async (event, ctx) => {
		const ev = event as ToolCallEvent;
		if (ev.toolName !== "edit" && ev.toolName !== "write") return undefined;
		const rels: string[] = [];
		for (const f of targetFiles(ev)) {
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

/**
 * omp lease-hook — soft, advisory file leasing for any omp session.
 *
 * Load it (RpcAgent/agent-host loads it for squad agents; raw sessions via
 * `omp -e lease-hook.ts`). On an edit/write it CLAIMS a lease on the target
 * file(s); when another session already holds a file, it appends a ⚠ note to
 * the tool result (and notifies in interactive mode) so the agent coordinates.
 * It never blocks — leases are advisory; contended files show up in the command
 * center for the human in the loop.
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { claimLease, heartbeatSession, holdersOf, LEASE_TTL_MS, releaseSession } from "./leases.ts";

interface ToolCallEvent {
	toolName: string;
	input: Record<string, unknown>;
}

function git(cwd: string, args: string[]): string | undefined {
	try {
		const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
		if (r.exitCode !== 0) return undefined;
		const out = r.stdout.toString().trim();
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

	pi.on("session_start", async () => {
		repo = git(process.cwd(), ["rev-parse", "--show-toplevel"]) ?? process.cwd();
		timer = setInterval(() => void heartbeatSession(session, repo), Math.min(40_000, Math.floor(LEASE_TTL_MS / 3)));
		timer.unref?.();
	});

	pi.on("tool_call", async (event, ctx) => {
		const ev = event as ToolCallEvent;
		if (ev.toolName !== "edit" && ev.toolName !== "write") return;
		for (const f of targetFiles(ev)) {
			const abs = path.isAbsolute(f) ? f : path.resolve(repo, f);
			const rel = path.relative(repo, abs) || f;
			try {
				const others = await holdersOf(repo, rel, session);
				if (others.length && ctx.hasUI) {
					const o = others[0];
					await ctx.ui.notify(`⚠ ${rel} is also being edited by ${o.operator}/${o.session} (${ago(o.heartbeat)})`, "warning");
				}
				await claimLease({ repo, file: rel, session });
			} catch {
				/* advisory — never disrupt the edit */
			}
		}
		// Soft lease: never block.
		return undefined;
	});

	pi.on("session_shutdown", async () => {
		clearInterval(timer);
		await releaseSession(session, repo).catch(() => {});
	});
}

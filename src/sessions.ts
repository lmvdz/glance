/**
 * External (non-squad) omp session discovery — hook-free.
 *
 * The presence hook (src/presence-hook.ts) only sees omp sessions that opted in
 * by loading it. A human running plain `omp` in a repo a squad agent is also
 * working stays invisible, so the two collide and produce merge conflicts.
 *
 * This module finds live raw omp processes straight from the OS process table
 * and feeds them into the SAME presence registry the hook writes to, so the web
 * UI and `omp-squad who` surface them next to squad agents — no opt-in needed.
 *
 * ponytail: Linux /proc only. macOS/BSD (no /proc) are unsupported; the upgrade
 * path is `lsof -p` / `ps -o pid,comm,args` parsing behind the same interface.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { claim, PRESENCE_TTL_MS, release } from "./presence.ts";

export interface ExternalSession {
	pid: number;
	repo: string;
	cwd: string;
	startedAt: number;
}

/**
 * PURE classifier: is this argv a raw `omp` session squad should track?
 *
 * True iff some token's basename is exactly the omp entrypoint AND none of the
 * exclusions match: `--mode` (squad's `omp --mode rpc` children), `omp-squad`
 * (the daemon/CLI), `agent-host` (agent hosts).
 */
export function isRawOmpSession(argv: string[]): boolean {
	if (argv.some((t) => t === "--mode" || t.includes("omp-squad") || t.includes("agent-host"))) return false;
	return argv.some((t) => path.basename(t) === "omp");
}

async function gitTopLevel(cwd: string): Promise<string | undefined> {
	try {
		const proc = Bun.spawn(["git", "-C", cwd, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "ignore" });
		const out = await new Response(proc.stdout).text();
		if ((await proc.exited) !== 0) return undefined;
		const top = out.trim();
		return top.length ? top : undefined;
	} catch {
		return undefined;
	}
}

/** Scan /proc for live raw omp sessions. Skips this process and any pid that vanishes mid-scan. */
export async function discoverExternalSessions(): Promise<ExternalSession[]> {
	let pids: string[];
	try {
		pids = await fsp.readdir("/proc");
	} catch {
		return []; // no /proc (non-Linux) — see ponytail note above
	}
	const out: ExternalSession[] = [];
	for (const name of pids) {
		if (!/^\d+$/.test(name)) continue;
		const pid = Number(name);
		if (pid === process.pid) continue;
		try {
			const raw = await fsp.readFile(`/proc/${name}/cmdline`, "utf8");
			const argv = raw.split("\0").filter((t) => t.length > 0);
			if (!isRawOmpSession(argv)) continue;
			const cwd = await fsp.readlink(`/proc/${name}/cwd`);
			const repo = (await gitTopLevel(cwd)) ?? cwd;
			const startedAt = (await fsp.stat(`/proc/${name}`)).ctimeMs;
			out.push({ pid, repo, cwd, startedAt });
		} catch {
			continue; // process exited mid-scan, or perms — ignore and move on
		}
	}
	return out;
}

/**
 * Poll discovery on an interval and mirror live raw omp sessions into the
 * presence registry: claim newly seen pids, release vanished ones. Runs once
 * immediately. Returns a stop function that clears the timer and releases every
 * claim it still holds. Never throws out of the timer.
 *
 * Default interval is < PRESENCE_TTL_MS / 3 so re-claims refresh the heartbeat
 * before the TTL would expire a claim.
 */
export function startExternalSessionTracker(opts?: { intervalMs?: number }): () => void {
	const intervalMs = opts?.intervalMs ?? 25_000;
	// ponytail: assert the heartbeat invariant the doc-comment promises.
	if (intervalMs >= PRESENCE_TTL_MS / 3) throw new Error(`intervalMs ${intervalMs} must be < PRESENCE_TTL_MS/3 (${PRESENCE_TTL_MS / 3})`);
	const tracked = new Map<string, string>(); // claim id -> repo

	const tick = async (): Promise<void> => {
		try {
			const live = await discoverExternalSessions();
			const seen = new Set<string>();
			for (const s of live) {
				const id = `ext:${s.pid}`;
				seen.add(id);
				tracked.set(id, s.repo);
				await claim({ repo: s.repo, agent: `omp:${s.pid}`, source: "omp", id, task: "raw omp session" });
			}
			for (const [id, repo] of [...tracked]) {
				if (seen.has(id)) continue;
				tracked.delete(id);
				await release(id, repo).catch(() => {});
			}
		} catch {
			/* discovery is best-effort; never let the timer throw */
		}
	};

	void tick();
	const timer = setInterval(() => void tick(), intervalMs);
	timer.unref?.();

	return () => {
		clearInterval(timer);
		for (const [id, repo] of tracked) void release(id, repo).catch(() => {});
		tracked.clear();
	};
}

if (import.meta.main) {
	const stop = startExternalSessionTracker();
	process.stdout.write("tracking external omp sessions → presence registry (Ctrl-C to stop)\n");
	const shutdown = (): void => {
		stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	await new Promise<void>(() => {}); // run until SIGINT/SIGTERM
}

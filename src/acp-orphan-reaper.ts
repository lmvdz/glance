/**
 * ACP orphan reaper — restart re-attach's answer to the orphaned adapter chains a daemon kill
 * leaves behind (plans/daily-onramp/04-restart-reattach.md, standing gap from A02's live verify).
 *
 * Why REAP and never REUSE: an ACP harness (claude-code, codex, gemini, …) is a direct child spawn
 * speaking JSON-RPC over the daemon's OWN stdio pipes — no socket, no detached host. When the daemon
 * dies ungracefully (SIGKILL / crash; a graceful stop() already kills the child), the `npx →
 * claude-code-acp` chain reparents to init and idles forever, but its transport died with the daemon
 * process: no future boot can re-dial it, and ACP session/load wouldn't help even where supported —
 * there is no pipe left to speak over. The orphan is pure leaked memory, one chain per killed
 * session, on a daemon Lars restarts hourly. So the next boot reaps it.
 *
 * Why the paranoia: pids recycle, and parallel daemons (scratch-daemon verification runs, DB-mode
 * orgs) each own live adapter chains of their own. A blind kill by pid or a process-name sweep is a
 * cross-daemon data-loss class bug. The reap therefore only ever signals the ONE persisted pid (and
 * its descendants), and only after verifying the live process still matches the argv fingerprint
 * persisted at spawn time — any doubt means no signal at all (fail-closed on the KILL side: the
 * dangerous action is skipped, and the skip is logged).
 *
 * `planReap` is the pure, unit-tested half; `readProcTable`/`reapAcpOrphanChain` are the thin
 * /proc + signal executors (Linux /proc only — elsewhere the reap honestly no-ops).
 */

import * as fsp from "node:fs/promises";

/** One row of the process table, as much as the reaper needs. */
export interface ProcEntry {
	pid: number;
	ppid: number;
	/** NUL bytes replaced with spaces, trimmed. */
	cmdline: string;
}

/**
 * The identity token an adapter argv is recognized by in a live cmdline: the LAST non-flag element
 * (`["npx","-y","@zed-industries/claude-code-acp"]` → the package; `["grok","agent","stdio"]` →
 * "stdio" is too generic, so a minimum length applies and the scan walks left until something
 * distinctive turns up). Undefined when nothing qualifies — the caller must then refuse to kill.
 */
export function distinctiveToken(cmd: string[]): string | undefined {
	for (let i = cmd.length - 1; i >= 0; i--) {
		const a = cmd[i];
		if (a && !a.startsWith("-") && a.length >= 6) return a;
	}
	return undefined;
}

/**
 * Decide exactly which pids to signal for one persisted adapter root. Pure and total.
 *
 * Returns descendants-first order (children die before their parent, so nothing re-parents away
 * mid-sweep), or an empty kill list with the refusal/no-op reason:
 *   - the persisted argv has no distinctive token → refuse (cannot verify identity);
 *   - the pid is gone → nothing to do (the chain died on its own — the common case when the
 *     adapter honors stdin EOF);
 *   - the pid's cmdline does not contain the token → refuse (recycled pid; killing it would hit an
 *     unrelated process).
 */
export function planReap(table: ProcEntry[], rootPid: number, persistedCmd: string[]): { kill: number[]; skip?: string } {
	const token = distinctiveToken(persistedCmd);
	if (!token) return { kill: [], skip: `no distinctive token in the persisted adapter argv [${persistedCmd.join(" ")}] — refusing to kill unverifiable pids` };
	const root = table.find((e) => e.pid === rootPid);
	if (!root) return { kill: [], skip: `pid ${rootPid} is already gone — nothing to reap` };
	if (!root.cmdline.includes(token)) return { kill: [], skip: `pid ${rootPid} no longer matches the persisted adapter argv (cmdline "${root.cmdline.slice(0, 120)}" lacks "${token}") — recycled pid, refusing to kill` };
	const children = new Map<number, number[]>();
	for (const e of table) {
		const sibs = children.get(e.ppid);
		if (sibs) sibs.push(e.pid);
		else children.set(e.ppid, [e.pid]);
	}
	const order: number[] = [];
	const walk = (pid: number): void => {
		for (const c of children.get(pid) ?? []) walk(c);
		order.push(pid);
	};
	walk(rootPid);
	return { kill: order };
}

/** Snapshot /proc into ProcEntry rows; undefined where /proc doesn't exist (non-Linux) — the caller
 *  then no-ops the reap honestly instead of guessing. Races with exiting processes are skipped. */
export async function readProcTable(): Promise<ProcEntry[] | undefined> {
	let names: string[];
	try {
		names = await fsp.readdir("/proc");
	} catch {
		return undefined;
	}
	const out: ProcEntry[] = [];
	for (const n of names) {
		if (!/^\d+$/.test(n)) continue;
		try {
			const cmdline = (await fsp.readFile(`/proc/${n}/cmdline`, "utf8")).replaceAll("\0", " ").trim();
			const stat = await fsp.readFile(`/proc/${n}/stat`, "utf8");
			// Field 4 (ppid) sits after the parenthesized comm, which itself may contain spaces/parens —
			// parse from the LAST ')' (the canonical /proc/pid/stat recipe).
			const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			const ppid = Number(after[1]);
			if (!Number.isFinite(ppid)) continue;
			out.push({ pid: Number(n), ppid, cmdline });
		} catch {
			/* the process exited mid-scan */
		}
	}
	return out;
}

/**
 * Reap one orphaned adapter chain: verify → SIGTERM descendants-first → re-verify after a grace
 * period and SIGKILL only what STILL matches the plan (the re-plan repeats the full identity check,
 * so a pid recycled inside the grace window is never blind-SIGKILLed). Never throws; returns the
 * pids that received SIGTERM. `log` gets one line per skip/refusal so a declined kill is always
 * explained, never silent.
 */
export async function reapAcpOrphanChain(rootPid: number, persistedCmd: string[], log: (line: string) => void, graceMs = 2000): Promise<number[]> {
	const table = await readProcTable();
	if (!table) {
		log(`acp orphan reap skipped for pid ${rootPid} — no /proc on this platform`);
		return [];
	}
	const plan = planReap(table, rootPid, persistedCmd);
	if (plan.skip) {
		log(`acp orphan reap: ${plan.skip}`);
		return [];
	}
	// Belt over the cmdline check: only signal processes we own. (kill() would fail EPERM anyway —
	// this makes the refusal explicit instead of an errno.)
	try {
		const st = await fsp.stat(`/proc/${rootPid}`);
		const uid = (process as { getuid?: () => number }).getuid?.();
		if (uid !== undefined && st.uid !== uid) {
			log(`acp orphan reap: pid ${rootPid} belongs to uid ${st.uid}, not us (${uid}) — refusing to kill`);
			return [];
		}
	} catch {
		return []; // vanished between plan and stat — nothing to do
	}
	const termed: number[] = [];
	for (const pid of plan.kill) {
		try {
			process.kill(pid, "SIGTERM");
			termed.push(pid);
		} catch {
			/* already gone / not ours */
		}
	}
	if (termed.length) {
		const t = setTimeout(() => {
			void (async () => {
				const again = await readProcTable();
				if (!again) return;
				const rePlan = planReap(again, rootPid, persistedCmd);
				for (const pid of rePlan.kill) {
					try {
						process.kill(pid, "SIGKILL");
					} catch {
						/* gone */
					}
				}
			})();
		}, graceMs);
		(t as { unref?: () => void }).unref?.(); // never holds the daemon open
	}
	return termed;
}

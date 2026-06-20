/**
 * omp presence hook — makes ANY omp session discoverable to the squad.
 *
 * Load it so a raw `omp` session announces what repo it's working, e.g.:
 *   omp -e /path/to/omp-squad/src/presence-hook.ts
 * or add the path to your omp `extensions` config. On session start it writes a
 * presence claim for the session's git repo (resolved from cwd), heartbeats
 * while alive, and releases on shutdown — so `omp-squad who <repo>` (and the
 * command center) can see "someone is already working here," even when that
 * someone is a plain omp session, not a squad-managed agent.
 *
 * Fully self-contained and fail-safe: never blocks or throws into the session.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { claim, heartbeat, PRESENCE_TTL_MS, release } from "./presence.ts";

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

export default function presenceHook(pi: ExtensionAPI): void {
	let claimId: string | undefined;
	let claimRepo: string | undefined;
	let timer: Timer | undefined;

	pi.on("session_start", async () => {
		try {
			const cwd = process.cwd();
			const repo = git(cwd, ["rev-parse", "--show-toplevel"]) ?? cwd;
			claimRepo = repo;
			claimId = await claim({
				repo,
				agent: `omp:${process.pid}`,
				branch: git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]),
				source: "omp",
			});
			timer = setInterval(() => {
				if (claimId && claimRepo) void heartbeat(claimId, claimRepo);
			}, Math.min(30_000, Math.floor(PRESENCE_TTL_MS / 3)));
			timer.unref?.();
		} catch {
			/* presence is best-effort; never disrupt the session */
		}
	});

	pi.on("session_shutdown", async () => {
		clearInterval(timer);
		if (claimId && claimRepo) await release(claimId, claimRepo).catch(() => {});
	});
}

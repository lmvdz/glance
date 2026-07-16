#!/usr/bin/env bun
/**
 * console-stopwatch.ts — THROWAWAY measurement harness for plans/daily-onramp/01-console-lane-stopwatch.md.
 * Not wired into bun test, not part of any gate. Measures the EXISTING console lane's
 * dispatch→first-token cost against a scratch daemon:
 *
 *   (a) daemon boot → HTTP-serving + access-token on disk   (only with --boot)
 *   (b) POST /api/console round-trip (agent record + harness process spawned)
 *   (c) create-returns → harness ready (AgentStatus leaves "starting"; transitions give server ts)
 *   (d) prompt POST → first assistant transcript entry (model first token, incl. transcript-poll lag)
 *
 * Usage:
 *   cold:  bun scripts/console-stopwatch.ts --boot --port 7912 --state-dir /tmp/... --repo $PWD --label cold1
 *   warm:  bun scripts/console-stopwatch.ts --port 7911 --state-dir /tmp/... --repo $PWD --label warm1
 *
 * Emits one JSON object on stdout (phases + raw transitions + transcript ts) and exits non-zero on
 * any timeout. With --boot it kills the daemon it spawned before exiting.
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}
const BOOT = process.argv.includes("--boot");
const PORT = Number(arg("port") ?? "7912");
const STATE_DIR = arg("state-dir");
const REPO = arg("repo") ?? process.cwd();
const LABEL = arg("label") ?? "run";
const PROMPT = arg("prompt") ?? "Reply with the single word: pong";
if (!STATE_DIR) {
	console.error("--state-dir required");
	process.exit(2);
}
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(what: string, timeoutMs: number, poll: () => Promise<T | undefined>): Promise<{ value: T; at: number }> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const v = await poll().catch(() => undefined);
		if (v !== undefined) return { value: v, at: Date.now() };
		await sleep(40);
	}
	throw new Error(`timeout waiting for ${what} after ${timeoutMs}ms`);
}

let daemon: ReturnType<typeof Bun.spawn> | undefined;
const t: Record<string, number> = {};

try {
	if (BOOT) {
		t.bootStart = Date.now();
		// Two layers of .env defense (both REQUIRED, discovered live during this measurement):
		//   1. --env-file=/dev/null stops bun's own .env autoload.
		//   2. cwd = STATE_DIR (not the repo): @oh-my-pi/pi-utils/src/env.ts EAGERLY parses
		//      `process.cwd()/.env` at import time with its own parser and writes into Bun.env,
		//      overriding even an explicitly-set empty DATABASE_URL (`!Bun.env[key]` treats "" as
		//      absent). Its parser keeps quotes + trailing inline comments and never expands $HOME,
		//      so the repo's `DATABASE_URL="sqlite:$HOME/..." # comment` line becomes a garbage
		//      relative path — the daemon silently boots DB-mode and creates a junk
		//      `"sqlite:$HOME/...` directory tree in the repo root.
		const repoRoot = path.resolve(import.meta.dir, "..");
		daemon = Bun.spawn(["bun", "--env-file=/dev/null", path.join(repoRoot, "src", "index.ts"), "up", "--port", String(PORT)], {
			cwd: STATE_DIR,
			env: {
				...process.env,
				PATH: `${path.join(repoRoot, "node_modules", ".bin")}:${process.env.PATH ?? ""}`,
				OMP_SQUAD_STATE_DIR: STATE_DIR,
				GLANCE_STATE_DIR: STATE_DIR,
				DATABASE_URL: "",
				// scratch-daemon skill safety: all autonomy OFF, Plane neutralized (existing env wins
				// over ~/.claude/secrets/plane.env, and empty string reads as unconfigured in plane.ts).
				OMP_SQUAD_AUTODISPATCH: "0",
				OMP_SQUAD_AUTODRIVE: "0",
				OMP_SQUAD_AUTOLAND: "0",
				OMP_SQUAD_AUTOSUPERVISE: "0",
				OMP_SQUAD_AUTO_SUPERVISE: "0",
				OMP_SQUAD_LAND_CONFIRM: "1",
				PLANE_API_KEY: "",
				PLANE_API_TOKEN: "",
				PLANE_WORKSPACE: "",
				PLANE_WORKSPACE_SLUG: "",
			},
			stdout: Bun.file(path.join(STATE_DIR, "daemon.log")),
			stderr: Bun.file(path.join(STATE_DIR, "daemon.log")),
		});
	}

	// (a) daemon serving: any HTTP response + token file present
	const tokenPath = path.join(STATE_DIR, "access-token");
	const ready = await waitFor("daemon http + token", 120_000, async () => {
		const res = await fetch(`${BASE}/api/auth/mode`).catch(() => undefined);
		if (res && existsSync(tokenPath)) return true;
		return undefined;
	});
	t.daemonServing = ready.at;
	const token = readFileSync(tokenPath, "utf8").trim();
	const headers = { "content-type": "application/json", Authorization: `Bearer ${token}` };

	// (b) create the console agent
	t.createStart = Date.now();
	const createRes = await fetch(`${BASE}/api/console`, { method: "POST", headers, body: JSON.stringify({ repo: REPO }) });
	if (!createRes.ok) throw new Error(`POST /api/console → ${createRes.status}: ${await createRes.text()}`);
	const { agentId } = (await createRes.json()) as { agentId: string };
	t.createReturn = Date.now();

	// (c) harness ready: status leaves "starting"
	const readyAgent = await waitFor("agent ready (status !== starting)", 120_000, async () => {
		const res = await fetch(`${BASE}/api/agents`, { headers });
		if (!res.ok) return undefined;
		const list = (await res.json()) as Array<{ id: string; status: string }>;
		const a = list.find((x) => x.id === agentId);
		return a && a.status !== "starting" ? a : undefined;
	});
	t.harnessReadyObserved = readyAgent.at;

	// current transcript high-water mark before prompting
	const preRes = await fetch(`${BASE}/api/agents/${agentId}/transcript`, { headers });
	const pre = (await preRes.json()) as Array<{ seq?: number }>;
	const sinceSeq = pre.reduce((m, e) => Math.max(m, e.seq ?? 0), 0);

	// (d) prompt → first assistant token
	t.promptStart = Date.now();
	const cmdRes = await fetch(`${BASE}/api/command`, {
		method: "POST",
		headers,
		body: JSON.stringify({ type: "prompt", id: agentId, message: PROMPT }),
	});
	if (!cmdRes.ok) throw new Error(`POST /api/command → ${cmdRes.status}: ${await cmdRes.text()}`);
	t.promptAccepted = Date.now();

	const first = await waitFor("first assistant transcript entry", 180_000, async () => {
		const res = await fetch(`${BASE}/api/agents/${agentId}/transcript?since=${sinceSeq}`, { headers });
		if (!res.ok) return undefined;
		const delta = (await res.json()) as Array<{ kind: string; text: string; ts: number; seq?: number }>;
		const a = delta.find((e) => (e.kind === "assistant" || e.kind === "thinking") && e.text.trim().length > 0);
		return a;
	});
	t.firstTokenObserved = first.at;

	// raw server-side timelines for phase reconstruction
	const transRes = await fetch(`${BASE}/api/agents/${agentId}/transitions?full=1`, { headers });
	const transitions = transRes.ok ? await transRes.json() : [];
	const fullRes = await fetch(`${BASE}/api/agents/${agentId}/transcript`, { headers });
	const transcript = fullRes.ok ? ((await fullRes.json()) as Array<{ kind: string; ts: number; seq?: number; text: string }>) : [];

	const out = {
		label: LABEL,
		boot: BOOT,
		agentId,
		phases: {
			a_daemonBootMs: BOOT ? t.daemonServing - t.bootStart : null,
			b_createRoundtripMs: t.createReturn - t.createStart,
			c_createToHarnessReadyMs: t.harnessReadyObserved - t.createReturn,
			d_promptToFirstTokenMs: t.firstTokenObserved - t.promptStart,
			totalDispatchToFirstTokenMs: t.firstTokenObserved - t.createStart,
			totalColdMs: BOOT ? t.firstTokenObserved - t.bootStart : null,
		},
		firstEntry: { kind: first.value.kind, ts: first.value.ts, seq: first.value.seq },
		wallClock: t,
		transitions,
		transcriptTimeline: transcript.map((e) => ({ kind: e.kind, ts: e.ts, seq: e.seq, chars: e.text.length })),
	};
	console.log(JSON.stringify(out, null, 2));
} finally {
	if (daemon) {
		daemon.kill();
		await daemon.exited.catch(() => {});
	}
}

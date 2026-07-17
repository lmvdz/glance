/**
 * Auto-friction capture (plans/daily-driver-w15 concern 02) — the daemon files its own gripes for
 * the three friction classes it already detects internally. Boundary-sync's held/divergence hooks
 * (and their boot-re-raise/clean-turn non-capture) are covered in tests/boundary-sync-wiring.test.ts
 * alongside the real git-write harness those need. This file covers the read-side migration
 * default, the HTTP hardening against a client-supplied `source`, the ACP-timeout hook
 * (`recordErrorTransition`), and the session-loss hook (`recordDeadPlaceholder`) including its
 * cross-restart dedup.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FrictionLog, frictionPath } from "../src/friction-log.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer } from "../src/server.ts";
import { SubagentTracker } from "../src/subagents.ts";
import type { AgentDTO, AgentStatus, FrictionEntry, PendingRequest, PersistedAgent, RpcSessionState, TransitionReason } from "../src/types.ts";
import { EventEmitter } from "node:events";
import type { AgentDriver } from "../src/agent-driver.ts";
import type { DerivedReason } from "../src/agent-lifecycle.ts";

const tmps: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function tmpDir(prefix: string): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(d);
	return d;
}

/** JsonlLog spools fire-and-forget; poll the file until the expected line count lands (mirrors
 *  friction-log.test.ts's helper — needed here to sequence two SquadManager tenures over the same
 *  friction.jsonl without a race between mgr1's async spool and mgr2's constructor-time hydrate). */
async function waitForLines(file: string, count: number, timeoutMs = 2000): Promise<string[]> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const lines = await fs
			.readFile(file, "utf8")
			.then((t) => t.split("\n").filter((l) => l.trim()))
			.catch(() => [] as string[]);
		if (lines.length >= count) return lines;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`friction.jsonl never reached ${count} line(s)`);
}

// ---------------------------------------------------------------------------
// Migration: a missing `source` reads as "human" — never a jsonl rewrite
// ---------------------------------------------------------------------------

test("FrictionLog: a pre-existing friction.jsonl row with no `source` field reads back as \"human\" via recent() and hydrateAll()", async () => {
	const dir = await tmpDir("friction-migration-");
	// Simulate a row written before this concern existed — the exact shape friction-log.ts produced
	// pre-migration (no `source` key at all, not `source: undefined`).
	const legacy: Omit<FrictionEntry, "source"> = { id: "legacy-1", ts: Date.now(), repo: "/repo", context: "cli", gripe: "old gripe, no source field" };
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(frictionPath(dir), `${JSON.stringify(legacy)}\n`);

	const log = new FrictionLog(dir);
	// recent() rehydrates its ring from the file at construction — this is the read path a fresh
	// boot takes, no rewrite of the file itself.
	const viaRecent = log.recent();
	expect(viaRecent).toHaveLength(1);
	expect(viaRecent[0].source).toBe("human");
	expect(viaRecent[0].id).toBe("legacy-1"); // untouched otherwise

	const viaHydrate = await log.hydrateAll();
	expect(viaHydrate).toHaveLength(1);
	expect(viaHydrate[0].source).toBe("human");

	// The file on disk is byte-for-byte untouched — migration is read-side only.
	const raw = await fs.readFile(frictionPath(dir), "utf8");
	expect(JSON.parse(raw.trim())).not.toHaveProperty("source");

	// A fresh human capture through the normal write path ALSO omits `source` on disk (same
	// minimal-conditional-spread convention as context/agentId) but still reads back as "human".
	log.record({ repo: "/repo", gripe: "new human gripe" });
	await waitForLines(frictionPath(dir), 2);
	const lines = (await fs.readFile(frictionPath(dir), "utf8")).split("\n").filter((l) => l.trim());
	expect(JSON.parse(lines[1]!)).not.toHaveProperty("source");
	expect(log.recent().find((e) => e.id !== "legacy-1")?.source).toBe("human");

	// An auto capture DOES write `source:"auto"` explicitly.
	log.record({ repo: "/repo", gripe: "daemon noticed something", source: "auto" });
	await waitForLines(frictionPath(dir), 3);
	const lines2 = (await fs.readFile(frictionPath(dir), "utf8")).split("\n").filter((l) => l.trim());
	expect(JSON.parse(lines2[2]!).source).toBe("auto");
});

// ---------------------------------------------------------------------------
// HTTP hardening: POST /api/friction can never make a row "auto"
// ---------------------------------------------------------------------------

async function liveServer(): Promise<{ url: string; token: string }> {
	const dir = await tmpDir("friction-hardening-srv-");
	const token = "operator-token-hardening1";
	const mgr = new SquadManager({ stateDir: dir });
	await mgr.start();
	const server = new SquadServer(mgr, { port: 0, token });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
	});
	return { url, token };
}

test('POST /api/friction: a client-supplied source:"auto" is never honored — the row always lands as human', async () => {
	const { url, token } = await liveServer();
	const res = await fetch(`${url}/api/friction`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ repo: "/r", gripe: "I am trying to fake an auto row", source: "auto", context: "cli" }),
	});
	expect(res.status).toBe(200);
	const saved = (await res.json()) as FrictionEntry;
	// The raw record() response omits `source` for a human entry (same minimal-spread convention as
	// context/agentId) — the "human" DEFAULT is a read-side thing (recent()/hydrateAll()), asserted
	// via the GET below. What matters here is it's never "auto".
	expect(saved.source).not.toBe("auto");
	expect(saved.gripe).toBe("I am trying to fake an auto row");

	const got = await fetch(`${url}/api/friction`, { headers: { authorization: `Bearer ${token}` } });
	const { entries } = (await got.json()) as { entries: FrictionEntry[] };
	expect(entries).toHaveLength(1);
	expect(entries[0].source).toBe("human");
});

// ---------------------------------------------------------------------------
// ACP-timeout hook: recordErrorTransition (bracket-access, transition-history.test.ts's pattern)
// ---------------------------------------------------------------------------

class NoopDriver extends EventEmitter implements AgentDriver {
	readonly isReady = true;
	readonly isAlive = true;
	start(): Promise<void> {
		return Promise.resolve();
	}
	stop(): Promise<void> {
		return Promise.resolve();
	}
	prompt(): Promise<void> {
		return Promise.resolve();
	}
	abort(): Promise<unknown> {
		return Promise.resolve();
	}
	getState(): Promise<RpcSessionState> {
		return Promise.reject(new Error("getState is never called in these tests"));
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

interface AgentRecordLike {
	dto: AgentDTO;
	agent: AgentDriver;
	options: PersistedAgent;
	transcript: unknown[];
	assistantBuf: string;
	thinkingBuf: string;
	streaming: boolean;
	subs: SubagentTracker;
	toolEntries: Map<string, unknown>;
}

interface LifecycleHost {
	agents: Map<string, AgentRecordLike>;
	transition: (rec: AgentRecordLike, to: AgentStatus, reason: TransitionReason, cause?: Record<string, unknown>) => void;
	setPending: (rec: AgentRecordLike, next: PendingRequest[], reason: DerivedReason, cause?: Record<string, unknown>) => void;
}

function seed(mgr: SquadManager, id: string): AgentRecordLike {
	const dto: AgentDTO = {
		id,
		name: id,
		status: "working",
		kind: "omp-operator",
		repo: "/r",
		worktree: "/r",
		branch: `squad/${id}`,
		approvalMode: "yolo",
		pending: [],
		lastActivity: 0,
		messageCount: 0,
	};
	const options: PersistedAgent = { id, name: id, repo: "/r", worktree: "/r", approvalMode: "yolo" };
	const rec: AgentRecordLike = { dto, agent: new NoopDriver(), options, transcript: [], assistantBuf: "", thinkingBuf: "", streaming: false, subs: new SubagentTracker(), toolEntries: new Map() };
	(mgr as unknown as LifecycleHost).agents.set(id, rec);
	return rec;
}

test("recordErrorTransition: an ACP prompt-timeout error transition auto-captures exactly one friction entry (source:auto, context:auto:acp-timeout)", async () => {
	const dir = await tmpDir("friction-acp-timeout-");
	const mgr = new SquadManager({ stateDir: dir });
	await mgr.start();
	cleanups.push(() => mgr.stop());
	const host = mgr as unknown as LifecycleHost;
	const rec = seed(mgr, "chat-1");

	// The driver's exact error-message shape (acp-agent-driver.ts's sendTurn silence-window reject).
	host.transition(rec, "error", "fail", { error: "acp request session/prompt timed out" });

	const entries = mgr.frictionRecent();
	expect(entries).toHaveLength(1);
	expect(entries[0]).toMatchObject({ source: "auto", context: "auto:acp-timeout", agentId: "chat-1" });
	expect(entries[0].gripe).toContain("ACP prompt timed out");
	expect(entries[0].gripe).toContain("session/prompt timed out");
});

test("recordErrorTransition: the hard-cap variant of the same driver error ALSO auto-captures", async () => {
	const dir = await tmpDir("friction-acp-hardcap-");
	const mgr = new SquadManager({ stateDir: dir });
	await mgr.start();
	cleanups.push(() => mgr.stop());
	const host = mgr as unknown as LifecycleHost;
	const rec = seed(mgr, "chat-1");

	host.transition(rec, "error", "fail", { error: "acp request session/prompt timed out (turn hard cap)" });

	expect(mgr.frictionRecent()).toHaveLength(1);
	expect(mgr.frictionRecent()[0].context).toBe("auto:acp-timeout");
});

test("recordErrorTransition: an ordinary error transition (not an ACP timeout) never auto-captures — no noise from normal failures", async () => {
	const dir = await tmpDir("friction-normal-error-");
	const mgr = new SquadManager({ stateDir: dir });
	await mgr.start();
	cleanups.push(() => mgr.stop());
	const host = mgr as unknown as LifecycleHost;
	const rec = seed(mgr, "chat-1");

	host.transition(rec, "error", "fail", { error: "some unrelated crash: ENOENT" });
	host.transition(rec, "error", "catastrophe", { error: "agent connection lost" });
	// A non-error transition must never fire the hook either.
	const rec2 = seed(mgr, "chat-2");
	host.transition(rec2, "idle", "connect-ok");

	expect(mgr.frictionRecent()).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Session-loss hook: recordDeadPlaceholder (via recordNonResumableSkips at boot)
// ---------------------------------------------------------------------------

const persistedAgent = (over: Partial<PersistedAgent> & { id: string }): PersistedAgent => ({
	name: "chat",
	repo: "/srv/r",
	worktree: "/srv/r/does-not-exist",
	approvalMode: "write",
	kind: "omp-operator",
	...over,
});

test("boot: a non-resumable persisted session that didn't survive a restart auto-captures exactly one friction entry (source:auto, context:auto:session-loss)", async () => {
	const stateDir = await tmpDir("friction-session-loss-");
	const snapshot = {
		agents: [persistedAgent({ id: "chat-dead", harness: "claude-code", repo: "/srv/lost-repo" })],
		transcripts: {},
		features: [],
	};
	await fs.writeFile(path.join(stateDir, "state.json"), JSON.stringify(snapshot));

	const mgr = new SquadManager({ stateDir } as never);
	await mgr.start();
	cleanups.push(() => mgr.stop());

	const entries = mgr.frictionRecent();
	expect(entries).toHaveLength(1);
	expect(entries[0]).toMatchObject({ source: "auto", context: "auto:session-loss", agentId: "chat-dead", repo: "/srv/lost-repo" });
	expect(entries[0].gripe).toContain("session lost");
	expect(entries[0].gripe).toContain("did not survive a daemon restart");
});

test("boot: a RESUMABLE persisted session (no harness ⇒ omp) never auto-captures session-loss friction", async () => {
	const stateDir = await tmpDir("friction-resumable-");
	const snapshot = { agents: [persistedAgent({ id: "omp-alive", name: "worker" })], transcripts: {}, features: [] };
	await fs.writeFile(path.join(stateDir, "state.json"), JSON.stringify(snapshot));

	const mgr = new SquadManager({ stateDir } as never);
	await mgr.start();
	cleanups.push(() => mgr.stop());

	expect(mgr.frictionRecent()).toHaveLength(0);
});

test("boot: session-loss friction survives across a restart — a second daemon tenure over the SAME still-persisted record adds zero new entries (dedup keyed on the stable placeholder id)", async () => {
	const stateDir = await tmpDir("friction-session-loss-dedup-");
	const snapshot = {
		agents: [persistedAgent({ id: "chat-dead", harness: "claude-code", repo: "/srv/lost-repo" })],
		transcripts: {},
		features: [],
	};
	await fs.writeFile(path.join(stateDir, "state.json"), JSON.stringify(snapshot));

	// Tenure 1: records the placeholder + the one auto-friction entry.
	const mgr1 = new SquadManager({ stateDir } as never);
	await mgr1.start();
	expect(mgr1.frictionRecent()).toHaveLength(1);
	await waitForLines(frictionPath(stateDir), 1); // flush before the next tenure's constructor-time hydrate
	await mgr1.stop();

	// Tenure 2: SAME state.json still names "chat-dead" (persistNow never ran to drop it — the
	// pathological back-to-back-restart case the concern doc calls out by name: "placeholder id").
	// recordNonResumableSkips runs again at this boot; the durable dedup check must suppress a
	// second write for the exact same placeholder id.
	const mgr2 = new SquadManager({ stateDir } as never);
	await mgr2.start();
	cleanups.push(() => mgr2.stop());

	const entries = mgr2.frictionRecent();
	expect(entries).toHaveLength(1); // rehydrated from disk — NOT two
	expect(entries[0].agentId).toBe("chat-dead");
});

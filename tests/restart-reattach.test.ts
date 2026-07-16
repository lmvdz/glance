/**
 * Restart re-attach — honest casual-session survival across a daemon restart
 * (plans/daily-onramp/04-restart-reattach.md).
 *
 * Covers the concern's Verify bullets without a live model:
 *   1. a `here`-class persisted agent on a non-resumable harness leaves a DEAD PLACEHOLDER after a
 *      simulated restart (never a silent 404 indistinguishable from "id never existed"), its
 *      transcript stays readable, and a resumable-harness record is untouched by the sweep;
 *   2. fail-closed: a corrupt persisted transcript still yields an honest placeholder that SAYS the
 *      context was unrecoverable — never a throw out of boot, never a fabricated "resumed" state;
 *   3. the client half: sessionFate's three honest outcomes, HereSession's dead-detection on a
 *      roster miss, and rebind's context fold into the operator's OWN first prompt (never auto-sent);
 *   4. the orphaned-adapter reap: identity-verified by argv fingerprint against /proc, refusing
 *      recycled pids and unverifiable argvs — the one path here that sends signals, so it's the one
 *      path that must fail CLOSED on the kill side (any doubt ⇒ no signal).
 *
 * The live half (real daemon bounce under a real claude-code session) runs in the scratch-daemon
 * choreography — green fakes never count as the live proof.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { distinctiveToken, planReap, type ProcEntry, reapAcpOrphanChain, readProcTable } from "../src/acp-orphan-reaper.ts";
import { CONSOLE_SYSTEM_PROMPT } from "../src/console-prompt.ts";
import { HereClient, HereSession } from "../src/here.ts";
import { buildDeadPlaceholder, composePriorContext, PRIOR_CONTEXT_MAX_CHARS, PRIOR_CONTEXT_MAX_ENTRIES, reattachMarker } from "../src/reattach-context.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer } from "../src/server.ts";
import { SubagentTracker } from "../src/subagents.ts";
import type { AgentDTO, PersistedAgent, TranscriptEntry } from "../src/types.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

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

const persisted = (over: Partial<PersistedAgent> & { id: string }): PersistedAgent => ({
	name: "chat",
	repo: "/srv/r",
	worktree: "/srv/r/does-not-exist",
	approvalMode: "write",
	kind: "omp-operator",
	...over,
});

const entry = (seq: number, kind: TranscriptEntry["kind"], text: string, over: Partial<TranscriptEntry> = {}): TranscriptEntry => ({ seq, kind, text, status: "ok", at: seq, ...over });

// ── 1. the pure half: placeholder / context / marker (reattach-context.ts) ──────────────────────

test("buildDeadPlaceholder keeps a readable persisted transcript and names the non-resumable harness", () => {
	const p = persisted({ id: "chat-1", harness: "claude-code" });
	const ph = buildDeadPlaceholder(p, [entry(1, "user", "hello"), entry(2, "assistant", "hi")], 42);
	expect(ph.id).toBe("chat-1");
	expect(ph.at).toBe(42);
	expect(ph.transcript.map((e) => e.text)).toEqual(["hello", "hi"]);
	expect(ph.deadReason).toContain('harness "claude-code" is not resumable');
	expect(ph.deadReason).not.toContain("unreadable"); // a clean transcript never claims corruption
});

test("fail-closed: a CORRUPT persisted transcript degrades to an honest empty tail, never a throw", () => {
	const ph = buildDeadPlaceholder(persisted({ id: "chat-2", harness: "claude-code" }), "not-an-array");
	expect(ph.transcript).toEqual([]);
	expect(ph.deadReason).toContain("transcript was unreadable");
	// Partially corrupt: readable entries survive, and the reason admits the gap.
	const mixed = buildDeadPlaceholder(persisted({ id: "chat-3", harness: "claude-code" }), [entry(1, "user", "kept"), 7, null, { seq: 2 }]);
	expect(mixed.transcript.map((e) => e.text)).toEqual(["kept"]);
	expect(mixed.deadReason).toContain("may be incomplete");
});

test("composePriorContext folds only user/assistant speech, prefers displayText, and is undefined on nothing", () => {
	expect(composePriorContext([])).toBeUndefined();
	expect(composePriorContext([entry(1, "tool", "grep"), entry(2, "thinking", "hmm")])).toBeUndefined();
	const ctx = composePriorContext([
		entry(1, "user", "CTX-AUGMENTED giant blob", { displayText: "what I typed" }),
		entry(2, "tool", "grep"),
		entry(3, "assistant", "an answer"),
	]);
	expect(ctx).toBeDefined();
	expect(ctx).toContain("user: what I typed"); // displayText wins over the audit copy
	expect(ctx).not.toContain("CTX-AUGMENTED");
	expect(ctx).toContain("assistant: an answer");
	expect(ctx).not.toContain("grep"); // tool chatter is noise at this altitude
	expect(ctx).toContain("Prior session context");
});

test("composePriorContext caps from the TAIL — the most recent turns win the budget", () => {
	const many = Array.from({ length: PRIOR_CONTEXT_MAX_ENTRIES + 10 }, (_, i) => entry(i + 1, "user", `turn-${i + 1}`));
	const ctx = composePriorContext(many) ?? "";
	expect(ctx).not.toContain("turn-1\n"); // oldest dropped
	expect(ctx).toContain(`turn-${PRIOR_CONTEXT_MAX_ENTRIES + 10}`); // newest kept
	// Char budget: two huge entries — only the most recent survives whole.
	const big = "x".repeat(PRIOR_CONTEXT_MAX_CHARS - 100);
	const ctx2 = composePriorContext([entry(1, "user", `OLD ${big}`), entry(2, "user", `NEW ${big}`)]) ?? "";
	expect(ctx2).toContain("user: NEW");
	expect(ctx2).not.toContain("user: OLD");
});

test("reattachMarker is explicit about whether prior context made it across", () => {
	expect(reattachMarker("chat-1", "claude-code", true)).toContain("continuing with your prior context");
	expect(reattachMarker("chat-1", "claude-code", false)).toContain("no prior context could be recovered");
	expect(reattachMarker("chat-1", "claude-code", false)).toContain("chat-1");
});

// ── 2. the daemon half: boot sweep + placeholder reads + re-attach stitch ───────────────────────

/** Seed a live console-shaped record the way here.test.ts does — the re-attach successor. */
function seedConsoleAgent(mgr: InstanceType<typeof SquadManager>, id: string, repo: string): void {
	const dto: AgentDTO = { id, name: "chat", status: "idle", kind: "omp-operator", repo, worktree: `${repo}/wt`, approvalMode: "write", pending: [], lastActivity: 1, messageCount: 0 };
	const options: PersistedAgent = { id, name: "chat", repo, worktree: `${repo}/wt`, approvalMode: "write", kind: "omp-operator", harness: "claude-code", appendSystemPrompt: CONSOLE_SYSTEM_PROMPT };
	const agent = { stop: async () => {}, pid: undefined };
	(mgr as unknown as { agents: Map<string, unknown> }).agents.set(id, { dto, agent, options, transcript: [], assistantBuf: "", thinkingBuf: "", streaming: false, subs: new SubagentTracker(), toolEntries: new Map() });
}

interface PlaceholderHost {
	deadPlaceholder(id: string): { deadReason: string; at: number; transcript: TranscriptEntry[] } | undefined;
	deadPlaceholders: Map<string, { at: number }>;
}

test("simulated restart: a non-resumable here-session leaves a dead placeholder; resumable + tombstoned records don't; the HTTP reads stay honest", async () => {
	const stateDir = await tmpDir("reattach-boot-");
	// The prior daemon's state: one claude-code chat session (dead — ACP never survives), one
	// resumable-harness record (worktree gone ⇒ not adopted, but NOT this concern's placeholder), one
	// tombstoned chat (an explicit rm is a choice, not a death-by-restart), one with a corrupt transcript.
	const snapshot = {
		agents: [
			persisted({ id: "chat-dead", harness: "claude-code", appendSystemPrompt: CONSOLE_SYSTEM_PROMPT }),
			persisted({ id: "omp-alive", name: "worker" }), // no harness ⇒ omp ⇒ resumable
			persisted({ id: "chat-gone", harness: "claude-code" }),
			persisted({ id: "chat-corrupt", harness: "claude-code" }),
		],
		transcripts: {
			"chat-dead": [entry(1, "user", "what does squad-manager.ts do?"), entry(2, "assistant", "It owns the roster.")],
			"chat-corrupt": "garbage-not-an-array",
		},
		features: [],
	};
	await fs.writeFile(path.join(stateDir, "state.json"), JSON.stringify(snapshot));
	await fs.writeFile(path.join(stateDir, "removed-agents.json"), JSON.stringify(["chat-gone"]));

	const mgr = new SquadManager({ stateDir } as never);
	await mgr.start();
	const srv = new SquadServer(mgr, { port: 0 });
	const url = srv.start();
	cleanups.push(async () => {
		srv.stop();
		await mgr.stop();
	});

	// The skipped non-resumable session answers truthfully — never a bare miss.
	const dead = await fetch(`${url}/api/agents/chat-dead`);
	expect(dead.status).toBe(200);
	const deadBody = (await dead.json()) as { dead: boolean; deadReason: string; transcriptEntries: number };
	expect(deadBody.dead).toBe(true);
	expect(deadBody.deadReason).toContain("did not survive a daemon restart");
	expect(deadBody.transcriptEntries).toBe(2);
	// …and its transcript is still readable (the re-attach context source).
	const tr = (await (await fetch(`${url}/api/agents/chat-dead/transcript`)).json()) as TranscriptEntry[];
	expect(tr.map((e) => e.text)).toEqual(["what does squad-manager.ts do?", "It owns the roster."]);

	// Fail-closed: the corrupt-transcript session still gets an HONEST placeholder, not a silent miss.
	const corrupt = (await (await fetch(`${url}/api/agents/chat-corrupt`)).json()) as { dead: boolean; deadReason: string; transcriptEntries: number };
	expect(corrupt.dead).toBe(true);
	expect(corrupt.deadReason).toContain("transcript was unreadable");
	expect(corrupt.transcriptEntries).toBe(0);

	// A resumable-harness record is NOT placeholdered — the existing restore paths own it.
	const host = mgr as unknown as PlaceholderHost;
	expect(host.deadPlaceholder("omp-alive")).toBeUndefined();
	// A tombstoned id has no story left; an unknown id never existed — both are clean 404s.
	expect((await fetch(`${url}/api/agents/chat-gone`)).status).toBe(404);
	expect((await fetch(`${url}/api/agents/never-existed`)).status).toBe(404);

	// The bounded window: a lapsed placeholder reads as a clean miss (checked on read, no timer).
	const ph = host.deadPlaceholders.get("chat-dead");
	expect(ph).toBeDefined();
	if (ph) ph.at = Date.now() - 25 * 60 * 60 * 1000;
	expect((await fetch(`${url}/api/agents/chat-dead`)).status).toBe(404);
});

test("reattachDeadSession stitches the successor: visible system marker + prior-context tail RETURNED, never auto-sent", async () => {
	const stateDir = await tmpDir("reattach-stitch-");
	const snapshot = {
		agents: [persisted({ id: "chat-old", harness: "claude-code", appendSystemPrompt: CONSOLE_SYSTEM_PROMPT })],
		transcripts: { "chat-old": [entry(1, "user", "remember the plan"), entry(2, "assistant", "noted")] },
		features: [],
	};
	await fs.writeFile(path.join(stateDir, "state.json"), JSON.stringify(snapshot));
	const mgr = new SquadManager({ stateDir } as never);
	await mgr.start();
	cleanups.push(() => mgr.stop());

	seedConsoleAgent(mgr, "chat-new", "/srv/r");
	const out = mgr.reattachDeadSession("chat-new", "chat-old");
	expect(out).toBeDefined();
	expect(out?.priorContext).toContain("user: remember the plan");
	expect(out?.priorContext).toContain("assistant: noted");
	// The seam is VISIBLE in the successor's transcript (CLI + webapp both render system entries).
	const marker = mgr.getTranscript("chat-new").find((e) => e.kind === "system");
	expect(marker?.text).toContain("session restarted");
	expect(marker?.text).toContain("continuing with your prior context");

	// Lapsed/never-existed predecessor ⇒ honest "no prior context", not a fabricated resume.
	seedConsoleAgent(mgr, "chat-new2", "/srv/r");
	const out2 = mgr.reattachDeadSession("chat-new2", "no-such-id");
	expect(out2?.priorContext).toBeUndefined();
	expect(mgr.getTranscript("chat-new2").find((e) => e.kind === "system")?.text).toContain("no prior context could be recovered");

	// Unknown successor id ⇒ undefined (the route then simply returns no priorContext).
	expect(mgr.reattachDeadSession("nope", "chat-old")).toBeUndefined();
});

test("an operator prompt persists the transcript durably — a daemon KILL right after never loses the newest turn", async () => {
	const stateDir = await tmpDir("reattach-durable-");
	const mgr = new SquadManager({ stateDir } as never);
	await mgr.start();
	cleanups.push(() => mgr.stop());
	// A live console-shaped record with a ready fake driver — applyCommand's prompt path runs whole.
	const dto: AgentDTO = { id: "chat-live", name: "chat", status: "idle", kind: "omp-operator", repo: "/srv/r", worktree: "/srv/r/wt", approvalMode: "write", pending: [], lastActivity: 1, messageCount: 0 };
	const options: PersistedAgent = { id: "chat-live", name: "chat", repo: "/srv/r", worktree: "/srv/r/wt", approvalMode: "write", kind: "omp-operator", harness: "claude-code" };
	const agent = { isAlive: true, isReady: true, stop: async () => {}, prompt: async () => {}, pid: undefined };
	(mgr as unknown as { agents: Map<string, unknown> }).agents.set("chat-live", { dto, agent, options, transcript: [], assistantBuf: "", thinkingBuf: "", streaming: false, subs: new SubagentTracker(), toolEntries: new Map() });

	await mgr.applyCommand({ type: "prompt", id: "chat-live", message: "the words a kill must not eat", displayText: "typed text" });
	// The write chain is deduped/queued — give it a beat, then read what a KILLED daemon would leave.
	const deadline = Date.now() + 2000;
	let persisted: { transcripts?: Record<string, TranscriptEntry[]> } = {};
	while (Date.now() < deadline) {
		try {
			persisted = JSON.parse(await fs.readFile(path.join(stateDir, "state.json"), "utf8")) as typeof persisted;
			if (persisted.transcripts?.["chat-live"]?.length) break;
		} catch {
			/* not written yet */
		}
		await new Promise((r) => setTimeout(r, 25));
	}
	const tr = persisted.transcripts?.["chat-live"] ?? [];
	expect(tr.map((e) => e.text)).toContain("the words a kill must not eat");
	expect(tr.find((e) => e.kind === "user")?.displayText).toBe("typed text"); // the fold's bare-text copy survives too
});

// ── 3. the client half: sessionFate + dead-detection + context fold ─────────────────────────────

interface FakeCall {
	path: string;
	body?: unknown;
}

/** A fake daemon with the single-agent fate route the re-attach path reads. */
function fakeDaemon(state: { transcript: TranscriptEntry[]; agent?: AgentDTO; fate?: { dead: true; deadReason?: string } | 404 | AgentDTO; failPrompts?: number }): { client: HereClient; calls: FakeCall[] } {
	const calls: FakeCall[] = [];
	const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ path: url.pathname, body });
		if (url.pathname === "/api/command") {
			if (state.failPrompts && state.failPrompts > 0 && (body as { type?: string })?.type === "prompt") {
				state.failPrompts--;
				return new Response("boom", { status: 500 });
			}
			return Response.json({ ok: true });
		}
		if (url.pathname.endsWith("/transcript")) {
			const since = Number(url.searchParams.get("since") ?? "-1");
			return Response.json(state.transcript.filter((e) => (e.seq ?? 0) > since));
		}
		if (url.pathname === "/api/agents") return Response.json(state.agent ? [state.agent] : []);
		const single = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
		if (single) {
			if (state.fate === 404 || state.fate === undefined) return new Response("no such agent", { status: 404 });
			return Response.json(state.fate);
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
	return { client: new HereClient("http://fake", () => ({}), fakeFetch), calls };
}

const agentDto = (over: Partial<AgentDTO> = {}): AgentDTO => ({
	id: "chat-1",
	name: "chat",
	status: "idle",
	kind: "omp-operator",
	repo: "/srv/r",
	worktree: "/srv/r/wt",
	approvalMode: "write",
	pending: [],
	lastActivity: 1,
	messageCount: 0,
	...over,
});

test("sessionFate: live / dead-with-reason / missing are three distinguishable answers", async () => {
	const live = fakeDaemon({ transcript: [], fate: agentDto() });
	expect(await live.client.sessionFate("chat-1")).toBe("live");
	const dead = fakeDaemon({ transcript: [], fate: { dead: true, deadReason: "did not survive a daemon restart" } });
	expect(await dead.client.sessionFate("chat-1")).toEqual({ dead: true, deadReason: "did not survive a daemon restart" });
	const missing = fakeDaemon({ transcript: [], fate: 404 });
	expect(await missing.client.sessionFate("chat-1")).toBe("missing");
});

test("a roster miss with a dead placeholder triggers onDead — and lines typed while dead QUEUE for the successor", async () => {
	const { client } = fakeDaemon({ transcript: [], agent: undefined, fate: { dead: true, deadReason: "did not survive a daemon restart" } });
	const lines: string[] = [];
	const deaths: Array<{ id: string; reason?: string }> = [];
	const session = new HereSession(client, (l) => lines.push(l), (id, reason) => deaths.push({ id, reason }));
	session.attach("chat-1");

	await session.poll();
	expect(deaths).toEqual([{ id: "chat-1", reason: "did not survive a daemon restart" }]);
	expect(session.status).toBe("dead");
	expect(lines.some((l) => l.includes("removed on the daemon side"))).toBe(false); // the dead path, not the removed path

	session.submit("typed while re-attaching");
	expect(session.queuedCount).toBe(1); // queued, not lost, not sent to a dead id
});

test("a roster miss with a LAPSED placeholder still reads as death when the client saw the disconnect", async () => {
	const { client } = fakeDaemon({ transcript: [], agent: undefined, fate: 404 });
	const deaths: string[] = [];
	const session = new HereSession(client, () => {}, (id) => deaths.push(id));
	session.attach("chat-1");
	session.noteDisconnect(); // the REPL's poll tick failed to reach the daemon before this
	await session.poll();
	expect(deaths).toEqual(["chat-1"]);
	expect(session.status).toBe("dead");
});

test("a roster miss with NO disconnect and no placeholder is the pre-04 'removed' message — an rm is not a restart", async () => {
	const { client } = fakeDaemon({ transcript: [], agent: undefined, fate: 404 });
	const lines: string[] = [];
	const deaths: string[] = [];
	const session = new HereSession(client, (l) => lines.push(l), (id) => deaths.push(id));
	session.attach("chat-1");
	// One confirmed 404 is no longer terminal (review finding 2: a transient wobble must not kill a
	// live session) — the streak requires a SECOND consecutive definitive miss before 'gone'.
	await session.poll();
	expect(session.status).not.toBe("gone");
	await session.poll();
	expect(deaths).toEqual([]);
	expect(session.status).toBe("gone");
	expect(lines.some((l) => l.includes("removed on the daemon side"))).toBe(true);
});

test("rebind folds the recovered context into the FIRST prompt only, keeps the bare text as displayText, and resets the delta cursor", async () => {
	const state = { transcript: [entry(9, "assistant", "old session line", { status: "ok" as const })], agent: agentDto() };
	const { client, calls } = fakeDaemon(state);
	const lines: string[] = [];
	const session = new HereSession(client, (l) => lines.push(l));
	session.attach("chat-old");
	await session.poll(); // cursor advances past seq 9

	session.submit("queued during the re-attach"); // status stays ready here; the queue path is covered above —
	// what matters is the fold: rebind must attach the context to the first send after it.
	session.rebind("chat-new", "--- Prior session context ---\nuser: earlier");
	session.submit("second message");
	await new Promise((r) => setTimeout(r, 10));

	const prompts = calls.filter((c) => c.path === "/api/command").map((c) => c.body as { id: string; message: string; displayText?: string });
	expect(prompts[0]?.id).toBe("chat-old"); // the pre-rebind submit went to the old id (still ready then)
	expect(prompts[1]?.id).toBe("chat-new");
	expect(prompts[1]?.message).toContain("Prior session context");
	expect(prompts[1]?.message).toContain("second message");
	expect(prompts[1]?.displayText).toBe("second message"); // viewers show what was typed
	// The NEW daemon's seq counter restarts below the old floor — reset means its entries still print.
	state.transcript = [entry(1, "system", "⟲ session restarted — …", { status: "ok" as const })];
	await session.poll();
	expect(lines.some((l) => l.includes("session restarted"))).toBe(true);
});

test("a failed send re-holds the context — it rides the NEXT attempt instead of vanishing", async () => {
	const state = { transcript: [], agent: agentDto(), failPrompts: 1 };
	const { client, calls } = fakeDaemon(state);
	const session = new HereSession(client, () => {});
	session.rebind("chat-new", "CTX");
	session.submit("first try"); // 500s — the context must survive
	await new Promise((r) => setTimeout(r, 10));
	session.submit("second try");
	await new Promise((r) => setTimeout(r, 10));
	const prompts = calls.filter((c) => c.path === "/api/command").map((c) => c.body as { message: string });
	expect(prompts[0]?.message).toContain("CTX");
	expect(prompts[1]?.message).toContain("CTX"); // re-held after the failure
	expect(prompts[1]?.message).toContain("second try");
});

// ── 4. the orphaned-adapter reap (fail-closed on the KILL side) ──────────────────────────────────

test("distinctiveToken picks the last non-flag argv element, refusing short/flag-only argvs", () => {
	expect(distinctiveToken(["npx", "-y", "@zed-industries/claude-code-acp"])).toBe("@zed-industries/claude-code-acp");
	expect(distinctiveToken(["auggie", "--acp"])).toBe("auggie");
	expect(distinctiveToken(["sh", "-c"])).toBeUndefined(); // nothing distinctive ⇒ caller must refuse
	expect(distinctiveToken([])).toBeUndefined();
});

test("planReap: verified chain kills descendants first; gone/recycled/unverifiable pids are skipped with a reason", () => {
	const cmd = ["npx", "-y", "@zed-industries/claude-code-acp"];
	const table: ProcEntry[] = [
		{ pid: 100, ppid: 1, cmdline: "npx -y @zed-industries/claude-code-acp" },
		{ pid: 101, ppid: 100, cmdline: "node claude-code-acp" },
		{ pid: 102, ppid: 101, cmdline: "node worker" },
		{ pid: 999, ppid: 1, cmdline: "unrelated" },
	];
	expect(planReap(table, 100, cmd)).toEqual({ kill: [102, 101, 100] }); // deepest first, root last
	expect(planReap(table, 500, cmd).kill).toEqual([]); // already gone — nothing to do
	expect(planReap(table, 500, cmd).skip).toContain("already gone");
	expect(planReap(table, 999, cmd).kill).toEqual([]); // pid recycled by an unrelated process
	expect(planReap(table, 999, cmd).skip).toContain("refusing to kill");
	expect(planReap(table, 100, ["sh", "-c"]).skip).toContain("no distinctive token");
});

test("live reap: a real orphan matching its persisted argv is SIGTERMed; a mismatched fingerprint is refused", async () => {
	// The "orphan": a process whose /proc cmdline contains its persisted argv's distinctive token.
	const orphan = Bun.spawn(["bash", "-c", "sleep 300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	cleanups.push(() => {
		try {
			orphan.kill();
		} catch {
			/* already dead */
		}
	});
	const table = await readProcTable();
	if (!table) return; // non-Linux: the executor honestly no-ops (nothing further to assert here)
	expect(table.some((e) => e.pid === orphan.pid)).toBe(true);

	// Mismatched fingerprint (the pid now "belongs" to something else) ⇒ refused, process untouched.
	const logs: string[] = [];
	const refused = await reapAcpOrphanChain(orphan.pid, ["npx", "-y", "@zed-industries/claude-code-acp"], (l) => logs.push(l), 50);
	expect(refused).toEqual([]);
	expect(logs.some((l) => l.includes("refusing to kill"))).toBe(true);
	expect(orphan.exitCode).toBeNull(); // still alive — the refusal was real

	// Matching fingerprint ⇒ SIGTERM lands and the chain dies.
	const termed = await reapAcpOrphanChain(orphan.pid, ["bash", "-c", "sleep 300"], () => {}, 50);
	expect(termed).toContain(orphan.pid);
	await orphan.exited;
	expect(orphan.exitCode === null || orphan.exitCode !== 0 || orphan.signalCode !== null).toBe(true);
});

test("boot end-to-end: the dead-session sweep reaps a persisted adapter pid whose identity still matches", async () => {
	const orphan = Bun.spawn(["bash", "-c", "sleep 300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	cleanups.push(() => {
		try {
			orphan.kill();
		} catch {
			/* already dead */
		}
	});
	const stateDir = await tmpDir("reattach-reap-");
	const snapshot = {
		agents: [persisted({ id: "chat-orphaned", harness: "claude-code", acpPid: orphan.pid, acpCmd: ["bash", "-c", "sleep 300"] })],
		transcripts: {},
		features: [],
	};
	await fs.writeFile(path.join(stateDir, "state.json"), JSON.stringify(snapshot));
	const mgr = new SquadManager({ stateDir } as never);
	await mgr.start();
	cleanups.push(() => mgr.stop());
	// The reap is fire-and-forget off the boot path — poll briefly for the SIGTERM to land.
	const deadline = Date.now() + 3000;
	while (orphan.exitCode === null && orphan.signalCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
	expect(orphan.exitCode !== null || orphan.signalCode !== null).toBe(true);
	// …and the placeholder is there regardless of the reap (honesty never depends on the kill).
	expect((mgr as unknown as PlaceholderHost).deadPlaceholder("chat-orphaned")?.deadReason).toContain("did not survive a daemon restart");
});

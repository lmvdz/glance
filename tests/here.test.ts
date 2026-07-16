/**
 * `glance here` — the terminal-attach on-ramp (plans/daily-onramp/02-glance-here-terminal.md).
 *
 * Covers the three seams the concern names, without a live model:
 *   1. ephemeral project registration — session-scoped registry writes that undo on release, stay
 *      durable after promote, never demote a project the operator registered themselves, and fire
 *      from the daemon's own removal path;
 *   2. verb dispatch + fail-closed CLI edges (a real `bun src/index.ts here` spawn);
 *   3. client-mode REPL logic — prompt queueing until attach, pending-answer routing, and the
 *      mutate-in-place streaming renderer over `?since=` delta polls.
 * Plus the spawn-env guarantee the claude-code verified flip leans on: CLAUDECODE never reaches a
 * spawned harness child (the adapter's nested-session refusal, reproduced live 2026-07-16, kills
 * session/new with it present).
 *
 * The live half of the concern's Verify (real daemon + real claude login + parity acceptance) runs
 * in the scratch-daemon choreography, not here — green fakes never count as the live proof.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CONSOLE_SYSTEM_PROMPT } from "../src/console-prompt.ts";
import { HereClient, HereSession, TranscriptRenderer } from "../src/here.ts";
import { scrubbedSpawnEnv } from "../src/spawn-env.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer } from "../src/server.ts";
import { SubagentTracker } from "../src/subagents.ts";
import type { AgentDTO, PersistedAgent, TranscriptEntry } from "../src/types.ts";

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

async function gitRepo(prefix: string): Promise<string> {
	const repo = await tmpDir(prefix);
	const run = async (...a: string[]): Promise<void> => {
		const p = Bun.spawn(["git", ...a], { cwd: repo, stdout: "ignore", stderr: "ignore" });
		await p.exited;
	};
	await run("init", "-q", "-b", "main");
	await run("config", "user.email", "t@t");
	await run("config", "user.name", "t");
	await fs.writeFile(path.join(repo, "a.txt"), "a\n");
	await run("add", "-A");
	await run("commit", "-qm", "base");
	return repo;
}

// ── 1. ephemeral project registration ───────────────────────────────────────────────────────────

test("registerEphemeralProject registers durably + marks the repo session-scoped; release undoes it", async () => {
	const stateDir = await tmpDir("here-eph-");
	const repo = await gitRepo("here-eph-repo-");
	const mgr = new SquadManager({ stateDir } as never);

	const reg = await mgr.registerEphemeralProject(repo);
	expect(reg.ok).toBe(true);
	if (reg.ok) {
		expect(reg.added).toBe(true);
		expect(reg.ephemeral).toBe(true);
	}
	expect(mgr.isEphemeralProject(repo)).toBe(true);
	expect(mgr.projects().map((p) => p.repo)).toEqual([repo]); // visible like any registered project

	const released = mgr.releaseEphemeralProject(repo);
	expect(released).toMatchObject({ ok: true, released: true });
	expect(mgr.isEphemeralProject(repo)).toBe(false);
	expect(mgr.projects()).toEqual([]); // pre-session state restored
});

test("a repo the operator registered DURABLY never becomes ephemeral — session end must not demote it", async () => {
	const stateDir = await tmpDir("here-eph-durable-");
	const repo = await gitRepo("here-eph-durable-repo-");
	const mgr = new SquadManager({ stateDir } as never);

	await mgr.registerProject(repo); // the operator's own registration, before any session
	const reg = await mgr.registerEphemeralProject(repo);
	expect(reg.ok && reg.ephemeral).toBe(false); // idempotent add ⇒ NOT session-scoped
	expect(mgr.isEphemeralProject(repo)).toBe(false);

	const released = mgr.releaseEphemeralProject(repo);
	expect(released).toMatchObject({ ok: true, released: false }); // no-op, honestly reported
	expect(mgr.projects().map((p) => p.repo)).toEqual([repo]); // still registered
});

test("releaseEphemeralProject is an idempotent no-op for repos that were never session-scoped", async () => {
	const stateDir = await tmpDir("here-eph-noop-");
	const mgr = new SquadManager({ stateDir } as never);
	expect(mgr.releaseEphemeralProject("/srv/never-seen")).toMatchObject({ ok: true, released: false });
});

test("ephemeral registration fails closed on a non-git directory — never silently in-place", async () => {
	const stateDir = await tmpDir("here-eph-nongit-");
	const notGit = await tmpDir("here-eph-nongit-dir-");
	const mgr = new SquadManager({ stateDir } as never);
	const reg = await mgr.registerEphemeralProject(notGit);
	expect(reg.ok).toBe(false);
	if (!reg.ok) expect(reg.reason).toContain("not a git repository");
	expect(mgr.isEphemeralProject(notGit)).toBe(false);
});

/** Seed a console-shaped agent record the way project-registry.test.ts seeds roster rows. */
function seedConsoleAgent(mgr: InstanceType<typeof SquadManager>, id: string, repo: string): void {
	const dto: AgentDTO = { id, name: "chat", status: "idle", kind: "omp-operator", repo, worktree: `${repo}/wt`, approvalMode: "write", pending: [], lastActivity: 1, messageCount: 0 };
	const options: PersistedAgent = { id, name: "chat", repo, worktree: `${repo}/wt`, approvalMode: "write", kind: "omp-operator", appendSystemPrompt: CONSOLE_SYSTEM_PROMPT };
	const agent = { stop: async () => {}, pid: undefined };
	(mgr as unknown as { agents: Map<string, unknown> }).agents.set(id, { dto, agent, options, transcript: [], assistantBuf: "", thinkingBuf: "", streaming: false, subs: new SubagentTracker(), toolEntries: new Map() });
}

test("promote clears the ephemeral marker — 'keep it' makes the registration durable", async () => {
	const stateDir = await tmpDir("here-eph-promote-");
	const repo = await gitRepo("here-eph-promote-repo-");
	const mgr = new SquadManager({ stateDir } as never);
	await mgr.registerEphemeralProject(repo);
	seedConsoleAgent(mgr, "chat-1", repo);

	const promoted = await mgr.promote("chat-1", { task: "build the thing" });
	expect(promoted.ok).toBe(true);
	expect(mgr.isEphemeralProject(repo)).toBe(false);
	// …and the later session-end release is now a no-op: the project SURVIVES.
	expect(mgr.releaseEphemeralProject(repo)).toMatchObject({ released: false });
	expect(mgr.projects().map((p) => p.repo)).toEqual([repo]);
});

test("an explicit durable registration PROMOTES an ephemeral repo — 'add project' makes it stick past /exit", async () => {
	const stateDir = await tmpDir("here-eph-promote-durable-");
	const repo = await gitRepo("here-eph-promote-durable-repo-");
	const mgr = new SquadManager({ stateDir } as never);

	await mgr.registerEphemeralProject(repo);
	expect(mgr.isEphemeralProject(repo)).toBe(true);

	// The webapp "add project" flow: POST /api/projects → registerProject with the promote flag. The
	// idempotent add returns added:false, but the marker must be cleared so the session-scoped
	// registration becomes durable.
	const promoted = await mgr.registerProject(repo, { promoteEphemeral: true });
	expect(promoted.ok).toBe(true);
	if (promoted.ok) expect(promoted.added).toBe(false); // already registered — this is the promote case
	expect(mgr.isEphemeralProject(repo)).toBe(false);

	// …and the later session-end release is now a no-op: the row the operator asked to keep SURVIVES.
	expect(mgr.releaseEphemeralProject(repo)).toMatchObject({ released: false });
	expect(mgr.projects().map((p) => p.repo)).toEqual([repo]);
});

test("registerProject WITHOUT the promote flag never demotes a live session's ephemeral marker", async () => {
	const stateDir = await tmpDir("here-eph-nopromote-");
	const repo = await gitRepo("here-eph-nopromote-repo-");
	const mgr = new SquadManager({ stateDir } as never);

	await mgr.registerEphemeralProject(repo);
	// A second `glance here` session on the same repo delegates through registerProject with no opts —
	// it must NOT silently promote the still-live session's registration to permanent.
	await mgr.registerProject(repo);
	expect(mgr.isEphemeralProject(repo)).toBe(true);
	expect(mgr.releaseEphemeralProject(repo)).toMatchObject({ released: true });
	expect(mgr.projects()).toEqual([]);
});

test("removing the LAST agent on an ephemeral repo releases the registration (daemon-side session end)", async () => {
	const stateDir = await tmpDir("here-eph-remove-");
	const repo = await gitRepo("here-eph-remove-repo-");
	const mgr = new SquadManager({ stateDir } as never);
	await mgr.registerEphemeralProject(repo);
	seedConsoleAgent(mgr, "chat-a", repo);
	seedConsoleAgent(mgr, "chat-b", repo);

	await mgr.applyCommand({ type: "remove", id: "chat-a" });
	expect(mgr.isEphemeralProject(repo)).toBe(true); // a sibling still lives there

	await mgr.applyCommand({ type: "remove", id: "chat-b" });
	expect(mgr.isEphemeralProject(repo)).toBe(false); // last one out restores the registry
	expect(mgr.projects()).toEqual([]);
});

// The restart-leak trio: the registry write is DURABLE, so the undo marker must be durable too —
// an in-memory-only marker meant a daemon restart mid-session silently promoted an ephemeral
// registration to permanent (blind-review finding, fail-open).

test("daemon restart mid-session does NOT leak an ephemeral registration to permanent — boot reaps it", async () => {
	const stateDir = await tmpDir("here-eph-restart-");
	const repo = await gitRepo("here-eph-restart-repo-");
	const mgr1 = new SquadManager({ stateDir } as never);
	await mgr1.registerEphemeralProject(repo);
	expect(mgr1.projects().map((p) => p.repo)).toEqual([repo]);
	// No release — the daemon "dies" mid-session (mgr1 is simply dropped, marker only on disk now).

	const mgr2 = new SquadManager({ stateDir } as never);
	cleanups.push(() => mgr2.stop());
	expect(mgr2.isEphemeralProject(repo)).toBe(true); // the marker survived the restart
	await mgr2.start(); // session did NOT survive ⇒ boot reconciliation reaps the registration
	expect(mgr2.isEphemeralProject(repo)).toBe(false);
	expect(mgr2.projects()).toEqual([]); // pre-session state restored — not silently permanent
});

test("a session that SURVIVES the restart keeps its marker — ordinary session end still restores the registry", async () => {
	const stateDir = await tmpDir("here-eph-survive-");
	const repo = await gitRepo("here-eph-survive-repo-");
	const mgr1 = new SquadManager({ stateDir } as never);
	await mgr1.registerEphemeralProject(repo);

	const mgr2 = new SquadManager({ stateDir } as never);
	cleanups.push(() => mgr2.stop());
	seedConsoleAgent(mgr2, "chat-1", repo); // the restored session (concern 04's reattach shape)
	await mgr2.start();
	expect(mgr2.isEphemeralProject(repo)).toBe(true); // NOT reaped — its session is alive
	expect(mgr2.projects().map((p) => p.repo)).toEqual([repo]);

	await mgr2.applyCommand({ type: "remove", id: "chat-1" }); // ordinary session end, post-restart
	expect(mgr2.isEphemeralProject(repo)).toBe(false);
	expect(mgr2.projects()).toEqual([]);
});

test("promote's durability survives a restart — the cleared marker is persisted, not in-memory", async () => {
	const stateDir = await tmpDir("here-eph-promote-durable-");
	const repo = await gitRepo("here-eph-promote-durable-repo-");
	const mgr1 = new SquadManager({ stateDir } as never);
	await mgr1.registerEphemeralProject(repo);
	seedConsoleAgent(mgr1, "chat-1", repo);
	const promoted = await mgr1.promote("chat-1", { task: "keep it" });
	expect(promoted.ok).toBe(true);

	// A fresh manager on the same stateDir must see NO marker (else its boot reap would un-register
	// a repo the operator explicitly kept). Constructor-loaded — no start() needed for the check.
	const mgr2 = new SquadManager({ stateDir } as never);
	expect(mgr2.isEphemeralProject(repo)).toBe(false);
	expect(mgr2.projects().map((p) => p.repo)).toEqual([repo]); // promoted ⇒ survives restarts
});

// ── the HTTP seam (fail-closed create + release route), no agent spawned ────────────────────────

test("POST /api/console ephemeral:true refuses a non-git repo with the reason; /api/console/release round-trips", async () => {
	const stateDir = await tmpDir("here-api-");
	const notGit = await tmpDir("here-api-nongit-");
	const repo = await gitRepo("here-api-repo-");
	const mgr = new SquadManager({ stateDir } as never);
	await mgr.start();
	const srv = new SquadServer(mgr, { port: 0 });
	const url = srv.start();
	cleanups.push(async () => {
		srv.stop();
		await mgr.stop();
	});

	const refused = await fetch(`${url}/api/console`, { method: "POST", body: JSON.stringify({ repo: notGit, ephemeral: true }) });
	expect(refused.status).toBe(400);
	expect(await refused.text()).toContain("not a git repository");
	expect(mgr.isEphemeralProject(notGit)).toBe(false);

	// Release is idempotent over the wire too.
	await mgr.registerEphemeralProject(repo);
	const rel = await fetch(`${url}/api/console/release`, { method: "POST", body: JSON.stringify({ repo }) });
	expect(rel.status).toBe(200);
	expect(await rel.json()).toMatchObject({ ok: true, released: true });
	const again = await fetch(`${url}/api/console/release`, { method: "POST", body: JSON.stringify({ repo }) });
	expect(await again.json()).toMatchObject({ ok: true, released: false });
});

// ── 2. verb dispatch (the real CLI, spawned) ─────────────────────────────────────────────────────

test("`glance here` is dispatched from main() and refuses a non-TTY politely", async () => {
	const proc = Bun.spawn(["bun", path.join(import.meta.dir, "..", "src", "index.ts"), "here"], {
		stdin: "ignore", // not a TTY — the REPL must refuse, not hang
		stdout: "pipe",
		stderr: "pipe",
	});
	const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	expect(code).toBe(1);
	expect(err).toContain("interactive");
	expect(err).toContain("glance ask"); // points at the right tool instead of a dead end
});

test("`glance here --help` prints verb-scoped help and exits 0 without touching the daemon", async () => {
	const proc = Bun.spawn(["bun", path.join(import.meta.dir, "..", "src", "index.ts"), "here", "--help"], {
		stdin: "ignore", // no TTY, no daemon — help must print and leave, never fall through to a session
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	expect(code).toBe(0);
	expect(out).toContain("glance here");
	expect(out).toContain("--harness");
	expect(out).toContain("/stop");
	expect(err).not.toContain("interactive"); // did NOT fall through to the non-TTY refusal
});

// ── 3. client-mode REPL logic ────────────────────────────────────────────────────────────────────

interface FakeCall {
	path: string;
	body?: unknown;
}

/** A fake daemon: canned transcript/roster, recorded commands — the REPL never notices. */
function fakeDaemon(state: { transcript: TranscriptEntry[]; agent?: AgentDTO }): { client: HereClient; calls: FakeCall[] } {
	const calls: FakeCall[] = [];
	const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ path: url.pathname, body });
		if (url.pathname === "/api/command") return Response.json({ ok: true });
		if (url.pathname.endsWith("/transcript")) {
			const since = Number(url.searchParams.get("since") ?? "-1");
			return Response.json(state.transcript.filter((e) => (e.seq ?? 0) > since));
		}
		if (url.pathname === "/api/agents") return Response.json(state.agent ? [state.agent] : []);
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

test("prompts typed before the session is ready are queued and flushed on attach (prewarm P1)", async () => {
	const { client, calls } = fakeDaemon({ transcript: [], agent: agentDto() });
	const lines: string[] = [];
	const session = new HereSession(client, (l) => lines.push(l));

	session.submit("first, typed during spawn");
	session.submit("second");
	expect(session.busy).toBe(true); // queued input counts as an in-flight turn
	expect(calls.filter((c) => c.path === "/api/command")).toHaveLength(0); // nothing sent yet

	session.attach("chat-1");
	await new Promise((r) => setTimeout(r, 10));
	const sent = calls.filter((c) => c.path === "/api/command").map((c) => c.body as { type: string; id: string; message: string });
	expect(sent).toEqual([
		{ type: "prompt", id: "chat-1", message: "first, typed during spawn" },
		{ type: "prompt", id: "chat-1", message: "second" },
	]);
	expect(lines.some((l) => l.includes("queued"))).toBe(true); // the operator was told, not left guessing
});

test("a pending permission request routes the next submit as an ANSWER, mapped like the TUI", async () => {
	const pending = { id: "req-1", source: "ui" as const, kind: "confirm", title: "Run tests?", createdAt: 1 };
	const { client, calls } = fakeDaemon({ transcript: [], agent: agentDto({ status: "input", pending: [pending] }) });
	const lines: string[] = [];
	const session = new HereSession(client, (l) => lines.push(l));
	session.attach("chat-1");

	await session.poll();
	expect(lines.some((l) => l.includes("needs you") && l.includes("Run tests?"))).toBe(true);
	await session.poll();
	expect(lines.filter((l) => l.includes("needs you"))).toHaveLength(1); // shown once, not every poll

	session.submit("y");
	await new Promise((r) => setTimeout(r, 10));
	const answer = calls.filter((c) => c.path === "/api/command").map((c) => c.body as Record<string, unknown>);
	expect(answer).toEqual([{ type: "answer", id: "chat-1", requestId: "req-1", value: "yes" }]);
	expect(lines.some((l) => l.includes("approved") && l.includes("Run tests?"))).toBe(true); // told how the line was read
});

test("a non-matching line over a pending confirm is sent as a MESSAGE, never silently coerced to 'no'", async () => {
	const pending = { id: "req-2", source: "ui" as const, kind: "confirm", title: "Run tests?", createdAt: 1 };
	const { client, calls } = fakeDaemon({ transcript: [], agent: agentDto({ status: "input", pending: [pending] }) });
	const lines: string[] = [];
	const session = new HereSession(client, (l) => lines.push(l));
	session.attach("chat-1");
	await session.poll();

	session.submit("wait, what does that command do?");
	await new Promise((r) => setTimeout(r, 10));
	const cmds = calls.filter((c) => c.path === "/api/command").map((c) => c.body as Record<string, unknown>);
	// The follow-up went out as a prompt — the request was NOT answered "no", and the message was NOT dropped.
	expect(cmds).toEqual([{ type: "prompt", id: "chat-1", message: "wait, what does that command do?" }]);
	expect(lines.some((l) => l.includes("still needs you"))).toBe(true); // request kept visible
});

test("a select answer only matches an offered option; a stray line is sent as a message instead", async () => {
	const pending = { id: "req-3", source: "ui" as const, kind: "select", title: "Which base?", options: ["main", "develop"], createdAt: 1 };
	const { client, calls } = fakeDaemon({ transcript: [], agent: agentDto({ status: "input", pending: [pending] }) });
	const lines: string[] = [];
	const session = new HereSession(client, (l) => lines.push(l));
	session.attach("chat-1");
	await session.poll();

	session.submit("MAIN"); // case-insensitive match on an offered option
	await new Promise((r) => setTimeout(r, 10));
	expect(calls.filter((c) => c.path === "/api/command").map((c) => c.body)).toEqual([{ type: "answer", id: "chat-1", requestId: "req-3", value: "main" }]);
	expect(lines.some((l) => l.includes('answered "main"'))).toBe(true);
});

test("a vanished agent is reported honestly, once", async () => {
	const state: { transcript: TranscriptEntry[]; agent?: AgentDTO } = { transcript: [], agent: agentDto() };
	const { client } = fakeDaemon(state);
	const lines: string[] = [];
	const session = new HereSession(client, (l) => lines.push(l));
	session.attach("chat-1");
	await session.poll();

	state.agent = undefined; // reaped server-side
	await session.poll();
	expect(session.status).toBe("gone");
	expect(lines.filter((l) => l.includes("removed on the daemon side"))).toHaveLength(1);
	await session.poll(); // further polls are inert, no repeat
	expect(lines.filter((l) => l.includes("removed on the daemon side"))).toHaveLength(1);
});

// ── the streaming renderer (mutate-in-place entries over a ?since= poll) ─────────────────────────

const entry = (seq: number, kind: TranscriptEntry["kind"], text: string, status?: TranscriptEntry["status"], tool?: TranscriptEntry["tool"]): TranscriptEntry => ({ seq, kind, text, ts: 1, status, tool });

test("renderer streams an assistant entry line-by-line and never reprints across polls", () => {
	const r = new TranscriptRenderer();
	// Poll 1: running entry, one complete line + a partial tail.
	let out = r.take([entry(5, "assistant", "hello world\npartial", "running")]);
	expect(out).toEqual(["", "hello world"]); // blank separator + the complete line; tail held back
	expect(r.since).toBe(4); // cursor stays BELOW the running entry so it is re-fetched
	// Poll 2: same seq, grown + finalized.
	out = r.take([entry(5, "assistant", "hello world\npartial line done\nbye", "ok")]);
	expect(out).toEqual(["partial line done", "bye"]);
	expect(r.since).toBe(5); // finalized ⇒ cursor advances past it
	// Poll 3: delta returns nothing new; nothing reprints.
	expect(r.take([])).toEqual([]);
});

test("renderer skips user echoes, marks tools/thinking once, and dims system lines", () => {
	const r = new TranscriptRenderer();
	const out = r.take([
		entry(1, "user", "what I typed", "ok"),
		entry(2, "thinking", "…private…", "ok"),
		entry(3, "tool", "", "ok", { name: "read_file" }),
		entry(4, "system", "context attached", "ok"),
	]);
	expect(out.some((l) => l.includes("what I typed"))).toBe(false);
	expect(out.some((l) => l.includes("thinking"))).toBe(true);
	expect(out.some((l) => l.includes("read_file"))).toBe(true);
	expect(out.some((l) => l.includes("…private…"))).toBe(false); // marker, never the content
	expect(out.some((l) => l.includes("context attached"))).toBe(true);
	expect(r.since).toBe(4);
});

test("renderer handles manager-global seq GAPS and a running tool alongside later entries", () => {
	const r = new TranscriptRenderer();
	// seq 10 tool still running, seq 17 assistant already final — cursor must hold below 10.
	let out = r.take([entry(10, "tool", "", "running", { name: "bash" }), entry(17, "assistant", "done already", "ok")]);
	expect(out.some((l) => l.includes("bash"))).toBe(true);
	expect(out.some((l) => l.includes("done already"))).toBe(true);
	expect(r.since).toBe(9);
	// Tool finalizes; the refetched assistant entry must NOT print twice.
	out = r.take([entry(10, "tool", "", "ok", { name: "bash" }), entry(17, "assistant", "done already", "ok")]);
	expect(out.filter((l) => l.includes("done already"))).toHaveLength(0);
	expect(r.since).toBe(17);
});

test("renderer restarts cleanly if a mutated entry's prefix was rewritten (redaction)", () => {
	const r = new TranscriptRenderer();
	r.take([entry(3, "assistant", "long unredacted line\n", "running")]);
	const out = r.take([entry(3, "assistant", "short\n", "ok")]); // rewritten shorter — printed > text.length
	expect(out).toEqual(["short"]); // starts over instead of slicing garbage
});

// ── the spawn-env guarantee the verified flip leans on ───────────────────────────────────────────

test("CLAUDECODE never reaches a spawned harness child — the nested-session refusal stays impossible", () => {
	const env = scrubbedSpawnEnv({ CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", PATH: "/usr/bin", HOME: "/home/u" });
	expect(env.CLAUDECODE).toBeUndefined();
	expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
	expect(env.PATH).toBe("/usr/bin"); // the keep-list still lets the child run
	expect(env.HOME).toBe("/home/u"); // …and find the operator's ~/.claude login
});

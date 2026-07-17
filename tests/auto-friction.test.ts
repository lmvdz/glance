/**
 * Auto-friction capture (daily-driver-w15 concern 02) — the daemon records REAL machine-detected
 * friction into the SAME ledger `glance grr` writes, stamped `source:"auto"` + a machine-readable
 * subtype (in `context` as `auto:<subtype>`), so the weekly drain sees daemon-felt friction beside
 * human gripes. Covered here:
 *   - a boundary-sync HELD event fires an `auto:boundary-sync-held` row (driven through the REAL
 *     git-write path, same discipline as boundary-sync-wiring.test.ts — no mocked git);
 *   - a CLEAN apply does NOT fire (normal operation is never captured);
 *   - an ACP error transition on a HERE-CLASS session fires `auto:here-session-error`; a plain fleet
 *     unit (no realTreePath) does not;
 *   - a here-session lost to a restart fires `auto:here-session-lost`; a fleet unit does not;
 *   - the dedupe window collapses a recurring condition to one row, and distinct scopes stay separate.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { frictionSource } from "../src/friction-log.ts";
import type { AgentDTO, FrictionEntry, PersistedAgent, TransitionEntry } from "../src/types.ts";

const { SquadManager } = await import("../src/squad-manager.ts");
const { SubagentTracker } = await import("../src/subagents.ts");

/** Exposes the private seams the frame loop / boot paths drive — same bracket-access discipline as
 *  tests/boundary-sync-wiring.test.ts. */
class TestManager extends SquadManager {
	turnStart(id: string): void {
		this["boundaryTurnStart"](this.agents.get(id) as never);
	}
	turnEnd(id: string): void {
		this["boundaryTurnEnd"](this.agents.get(id) as never);
	}
	async settle(): Promise<void> {
		const chains = this["boundarySyncChains"] as Map<string, Promise<void>>;
		await Promise.all([...chains.values()]);
	}
	rec(id: string): { dto: AgentDTO } {
		return this.agents.get(id) as never;
	}
	/** The exact hook recordTransition() calls for every recorded transition (concern 02's ACP-error
	 *  capture lives inside it) — fed a realistic error-class entry so the here-class branch fires. */
	fireErrorTransition(id: string, reason: "fail" | "catastrophe" | "exit-error", error?: string): void {
		const entry: TransitionEntry = { agentId: id, from: "idle", to: "error", reason, at: Date.now(), cause: error ? { error } : undefined, seq: `seq-${Math.random()}` };
		this["recordErrorTransition"](this.agents.get(id) as never, entry);
	}
	/** The boot path that mints a dead-session placeholder (concern 02's here-session-lost capture
	 *  lives inside it). */
	recordDead(p: Partial<PersistedAgent> & { id: string }): void {
		const persisted: PersistedAgent = { id: p.id, name: p.name ?? p.id, repo: p.repo ?? "/r", worktree: p.worktree ?? "/w", branch: "b", approvalMode: "yolo", harness: "claude-code-acp", ...p };
		this["recordDeadPlaceholder"](persisted, []);
	}
}

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function tmpDir(prefix: string): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(d);
	return d;
}

async function git(cwd: string, ...a: string[]): Promise<void> {
	const p = Bun.spawn(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
	if (code !== 0) throw new Error(`git ${a.join(" ")} failed (${code}): ${stderr}`);
}

async function initRepo(): Promise<string> {
	const repo = await tmpDir("af-real-");
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, "a.txt"), "one\ntwo\nthree\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	return repo;
}

async function addWorktree(repo: string): Promise<string> {
	const parent = await tmpDir("af-wt-");
	const worktree = path.join(parent, "wt");
	await git(repo, "worktree", "add", "-q", "-b", "squad/af-test", worktree, "HEAD");
	return worktree;
}

function seed(mgr: TestManager, id: string, over: Partial<PersistedAgent>): void {
	const dto: AgentDTO = {
		id,
		name: id,
		status: "idle",
		kind: "omp-operator",
		repo: over.repo ?? "/r",
		worktree: over.worktree ?? "/w",
		branch: over.branch ?? "b",
		approvalMode: "yolo",
		pending: [],
		lastActivity: 0,
		messageCount: 0,
	};
	const options: PersistedAgent = { id, name: id, repo: dto.repo, worktree: dto.worktree, branch: dto.branch, approvalMode: "yolo", ...over };
	mgr.agents.set(id, { dto, agent: undefined as never, options, transcript: [], assistantBuf: "", thinkingBuf: "", streaming: false, subs: new SubagentTracker(), toolEntries: new Map() } as never);
}

async function makeManager(): Promise<TestManager> {
	return new TestManager({ stateDir: await tmpDir("af-state-") });
}

/** The auto-captured friction rows in the ledger (newest-LAST, ring order). */
const autoRows = (mgr: TestManager): FrictionEntry[] => mgr.frictionRecent().filter((e) => frictionSource(e) === "auto");

// ── boundary-sync HELD ⇒ auto:boundary-sync-held; a CLEAN apply captures nothing ────────────────────

test("a HELD boundary sync auto-captures friction into the same ledger (source:auto, context auto:boundary-sync-held); the real tree is untouched", async () => {
	const repo = await initRepo();
	const wt = await addWorktree(repo);
	const mgr = await makeManager();
	seed(mgr, "chat-1", { repo, worktree: wt, realTreePath: repo });

	// Operator moves the real tree mid-turn ⇒ the turn's patch is HELD, never applied.
	mgr.turnStart("chat-1");
	await mgr.settle();
	await fs.appendFile(path.join(wt, "a.txt"), "turn1\n");
	await fs.writeFile(path.join(repo, "operator.txt"), "concurrent\n");
	mgr.turnEnd("chat-1");
	await mgr.settle();

	expect(await fs.readFile(path.join(repo, "a.txt"), "utf8")).not.toContain("turn1"); // held, untouched
	const rows = autoRows(mgr);
	expect(rows).toHaveLength(1);
	expect(rows[0]!.context).toBe("auto:boundary-sync-held");
	expect(rows[0]!.repo).toBe(repo);
	expect(rows[0]!.agentId).toBe("chat-1");
	expect(rows[0]!.gripe).toContain("boundary sync held");
});

test("a CLEAN apply captures NO friction — normal operation is never ledgered", async () => {
	const repo = await initRepo();
	const wt = await addWorktree(repo);
	const mgr = await makeManager();
	seed(mgr, "chat-1", { repo, worktree: wt, realTreePath: repo });

	mgr.turnStart("chat-1");
	await mgr.settle();
	await fs.appendFile(path.join(wt, "a.txt"), "agent line\n");
	mgr.turnEnd("chat-1");
	await mgr.settle();

	expect(await fs.readFile(path.join(repo, "a.txt"), "utf8")).toContain("agent line"); // applied cleanly
	expect(autoRows(mgr)).toHaveLength(0);
	expect(mgr.frictionRecent()).toHaveLength(0);
});

test("repeated HELD turns on one session collapse to ONE auto-friction row within the dedupe window", async () => {
	const repo = await initRepo();
	const wt = await addWorktree(repo);
	const mgr = await makeManager();
	seed(mgr, "chat-1", { repo, worktree: wt, realTreePath: repo });

	// Turn 1 holds (operator moved the tree); turn 2 also holds (the backlog blocks auto-apply).
	mgr.turnStart("chat-1");
	await mgr.settle();
	await fs.appendFile(path.join(wt, "a.txt"), "turn1\n");
	await fs.writeFile(path.join(repo, "operator.txt"), "concurrent\n");
	mgr.turnEnd("chat-1");
	await mgr.settle();
	mgr.turnStart("chat-1");
	await mgr.settle();
	await fs.appendFile(path.join(wt, "a.txt"), "turn2\n");
	mgr.turnEnd("chat-1");
	await mgr.settle();

	// Two held turns, but the recurring condition records once — the ledger is not flooded.
	expect(autoRows(mgr)).toHaveLength(1);
});

// ── ACP error transition on a HERE-CLASS session ⇒ auto:here-session-error ───────────────────────────

test("an error transition on a HERE-CLASS session auto-captures friction; a plain fleet unit does not", async () => {
	const mgr = await makeManager();
	seed(mgr, "chat-1", { repo: "/repo", worktree: "/w", realTreePath: "/repo" }); // here-class
	seed(mgr, "unit-1", { repo: "/repo", worktree: "/w" }); // plain fleet unit, no realTreePath

	mgr.fireErrorTransition("unit-1", "fail", "gate blew up");
	expect(autoRows(mgr)).toHaveLength(0); // fleet-unit errors are ordinary factory operation

	mgr.fireErrorTransition("chat-1", "fail", "acp turn timed out");
	const rows = autoRows(mgr);
	expect(rows).toHaveLength(1);
	expect(rows[0]!.context).toBe("auto:here-session-error");
	expect(rows[0]!.repo).toBe("/repo");
	expect(rows[0]!.agentId).toBe("chat-1");
	expect(rows[0]!.gripe).toContain("here-session error (fail)");
	expect(rows[0]!.gripe).toContain("acp turn timed out"); // the (already-redacted) cause is folded in
});

test("a flapping here-session's repeated error transitions collapse to one row; a DIFFERENT session records its own", async () => {
	const mgr = await makeManager();
	seed(mgr, "chat-1", { repo: "/repo", worktree: "/w", realTreePath: "/repo" });
	seed(mgr, "chat-2", { repo: "/other", worktree: "/w2", realTreePath: "/other" });

	mgr.fireErrorTransition("chat-1", "fail", "boom 1");
	mgr.fireErrorTransition("chat-1", "catastrophe", "boom 2");
	mgr.fireErrorTransition("chat-1", "exit-error", "boom 3");
	expect(autoRows(mgr).filter((e) => e.agentId === "chat-1")).toHaveLength(1); // deduped per session

	mgr.fireErrorTransition("chat-2", "fail", "different session");
	expect(autoRows(mgr).filter((e) => e.agentId === "chat-2")).toHaveLength(1); // distinct scope, own row
	expect(autoRows(mgr)).toHaveLength(2);
});

// ── here-session lost to a daemon restart ⇒ auto:here-session-lost ──────────────────────────────────

test("a HERE-CLASS session lost to a restart auto-captures friction; a lost fleet unit does not", async () => {
	const mgr = await makeManager();

	// A plain fleet unit dying on restart is non-resumable BY DESIGN — never friction.
	mgr.recordDead({ id: "unit-1", name: "fleet-unit", repo: "/repo" });
	expect(autoRows(mgr)).toHaveLength(0);

	// A casual `here` session (realTreePath set) that didn't survive is real friction.
	mgr.recordDead({ id: "chat-1", name: "my chat", repo: "/repo", realTreePath: "/repo" });
	const rows = autoRows(mgr);
	expect(rows).toHaveLength(1);
	expect(rows[0]!.context).toBe("auto:here-session-lost");
	expect(rows[0]!.repo).toBe("/repo");
	expect(rows[0]!.agentId).toBe("chat-1");
	expect(rows[0]!.gripe).toContain("lost to a daemon restart");
});

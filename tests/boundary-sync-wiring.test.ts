/**
 * Boundary sync (daily-onramp 03) — the SQUAD-MANAGER wiring layer, one level up from
 * tests/boundary-sync.test.ts's module seams: the real `boundaryTurnStart`/`boundaryTurnEnd`
 * methods the frame loop calls at `agent_start`/`agent_end`, the per-agent serialization chain,
 * the `here`-class gating (realTreePath marker; plain fleet units must never sync), the
 * boundary-sync attention row, `applyHeldSync`, and boot-time `reattachHeldSyncs`.
 *
 * Same discipline as the module tests: REAL git repos, no mocked git — this is a git-write path
 * against the operator's checkout.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDTO, PersistedAgent } from "../src/types.ts";

const { SquadManager } = await import("../src/squad-manager.ts");
const { SubagentTracker } = await import("../src/subagents.ts");

/** Exposes the protected/private seams the `agent_start`/`agent_end` frame cases call. */
class TestManager extends SquadManager {
	turnStart(id: string): void {
		// bracket access: the frame loop calls this private seam; tests reach it the same way answers.test.ts does
		this["boundaryTurnStart"](this.agents.get(id) as never);
	}
	turnEnd(id: string): void {
		// bracket access: the frame loop calls this private seam; tests reach it the same way answers.test.ts does
		this["boundaryTurnEnd"](this.agents.get(id) as never);
	}
	/** Settle every serialized boundary-sync chain (what the daemon awaits implicitly). Chains are
	 *  keyed by real directory on the MANAGER (not per record) since the realDir-serialization fix,
	 *  so draining them all is the test-side equivalent of the old per-agent await. */
	async settle(_id?: string): Promise<void> {
		const chains = this["boundarySyncChains"] as Map<string, Promise<void>>;
		await Promise.all([...chains.values()]);
	}
	rec(id: string): { dto: AgentDTO; boundarySyncTurn?: number; boundarySyncEndTree?: string } {
		return this.agents.get(id) as never;
	}
	/** Enqueue onto the agent's real-directory serialization chain (the private seam every
	 *  capture/sync/apply/discard rides). */
	enqueue(id: string, fn: () => Promise<void>): Promise<void> {
		const rec = this.agents.get(id) as never;
		const realDir = this["boundarySyncTarget"](rec) as string;
		return this["queueBoundarySync"](rec, realDir, fn);
	}
	reattach(): Promise<void> {
		// bracket access: the frame loop calls this private seam; tests reach it the same way answers.test.ts does
		return this["reattachHeldSyncs"]();
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

async function git(cwd: string, ...a: string[]): Promise<string> {
	const p = Bun.spawn(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	if (code !== 0) throw new Error(`git ${a.join(" ")} failed (${code}): ${stderr}`);
	return stdout;
}

async function initRepo(): Promise<string> {
	const repo = await tmpDir("bsw-real-");
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
	const parent = await tmpDir("bsw-wt-");
	const worktree = path.join(parent, "wt");
	await git(repo, "worktree", "add", "-q", "-b", "squad/bsw-test", worktree, "HEAD");
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
	return new TestManager({ stateDir: await tmpDir("bsw-state-") });
}

const syncRows = (dto: AgentDTO) => (dto.attentionEvents ?? []).filter((e) => e.source === "boundary-sync");

test("here-class turn: stable checkout ⇒ the edit lands in the real tree, no attention row", async () => {
	const repo = await initRepo();
	const wt = await addWorktree(repo);
	const mgr = await makeManager();
	seed(mgr, "chat-1", { repo, worktree: wt, realTreePath: repo });

	mgr.turnStart("chat-1");
	await mgr.settle("chat-1");
	await fs.appendFile(path.join(wt, "a.txt"), "agent line\n");
	mgr.turnEnd("chat-1");
	await mgr.settle("chat-1");

	expect(await fs.readFile(path.join(repo, "a.txt"), "utf8")).toContain("agent line");
	expect(syncRows(mgr.rec("chat-1").dto)).toHaveLength(0);
	expect(mgr.rec("chat-1").boundarySyncTurn).toBe(1);
	expect(mgr.rec("chat-1").boundarySyncEndTree).toBeTruthy(); // reused as turn 2's baseline
});

test("here-class turn: mid-turn operator edit ⇒ held + ONE boundary-sync attention row; explicit apply clears it", async () => {
	const repo = await initRepo();
	const wt = await addWorktree(repo);
	const mgr = await makeManager();
	seed(mgr, "chat-1", { repo, worktree: wt, realTreePath: repo });

	// Turn 1: operator moves the real tree mid-turn.
	mgr.turnStart("chat-1");
	await mgr.settle("chat-1");
	await fs.appendFile(path.join(wt, "a.txt"), "turn1\n");
	await fs.writeFile(path.join(repo, "operator.txt"), "concurrent\n");
	mgr.turnEnd("chat-1");
	await mgr.settle("chat-1");

	expect(await fs.readFile(path.join(repo, "a.txt"), "utf8")).not.toContain("turn1"); // untouched
	let rows = syncRows(mgr.rec("chat-1").dto);
	expect(rows).toHaveLength(1);
	expect(rows[0].summary).toContain("sync held");

	// Turn 2: real tree is stable, but the backlog blocks auto-apply — row refreshed, still one.
	mgr.turnStart("chat-1");
	await mgr.settle("chat-1");
	await fs.appendFile(path.join(wt, "a.txt"), "turn2\n");
	mgr.turnEnd("chat-1");
	await mgr.settle("chat-1");
	expect(await fs.readFile(path.join(repo, "a.txt"), "utf8")).not.toContain("turn1");
	rows = syncRows(mgr.rec("chat-1").dto);
	expect(rows).toHaveLength(1); // one row per agent, freshest state — never a stack
	expect(rows[0].detail).toContain("2 turns");

	// The operator clicks Apply: both turns replay in order, the row clears.
	const r = await mgr.applyHeldSync("chat-1");
	expect(r).toEqual({ ok: true, applied: 2, remaining: 0 });
	const a = await fs.readFile(path.join(repo, "a.txt"), "utf8");
	expect(a).toContain("turn1");
	expect(a).toContain("turn2");
	expect(syncRows(mgr.rec("chat-1").dto)).toHaveLength(0);
});

test("plain fleet unit (no realTreePath): the hooks are inert no-ops", async () => {
	const repo = await initRepo();
	const wt = await addWorktree(repo);
	const mgr = await makeManager();
	seed(mgr, "unit-1", { repo, worktree: wt }); // no realTreePath — never syncs

	mgr.turnStart("unit-1");
	await mgr.settle("unit-1");
	await fs.appendFile(path.join(wt, "a.txt"), "fleet work\n");
	mgr.turnEnd("unit-1");
	await mgr.settle("unit-1");

	expect(await fs.readFile(path.join(repo, "a.txt"), "utf8")).not.toContain("fleet work");
	expect(mgr.rec("unit-1").boundarySyncTurn).toBeUndefined(); // no turn was ever counted
	expect(syncRows(mgr.rec("unit-1").dto)).toHaveLength(0);
	expect(await mgr.applyHeldSync("unit-1")).toMatchObject({ ok: false, reason: expect.stringContaining("no boundary sync") });
});

test("self-alias guard: realTreePath === worktree ⇒ inert (never re-applies onto the same tree)", async () => {
	const repo = await initRepo();
	const mgr = await makeManager();
	seed(mgr, "chat-1", { repo, worktree: repo, realTreePath: repo });

	mgr.turnStart("chat-1");
	await mgr.settle("chat-1");
	await fs.appendFile(path.join(repo, "a.txt"), "in-place edit\n");
	mgr.turnEnd("chat-1");
	await mgr.settle("chat-1");

	expect(mgr.rec("chat-1").boundarySyncTurn).toBeUndefined();
	expect(syncRows(mgr.rec("chat-1").dto)).toHaveLength(0); // no spurious "held" noise
});

test("fail-closed at the wiring layer: an unfingerprint-able checkout holds + raises, never applies", async () => {
	const repo = await initRepo();
	const wt = await addWorktree(repo);
	const notARepo = await tmpDir("bsw-notrepo-"); // the "real dir" cannot be fingerprinted
	const mgr = await makeManager();
	seed(mgr, "chat-1", { repo, worktree: wt, realTreePath: notARepo });

	mgr.turnStart("chat-1");
	await mgr.settle("chat-1");
	await fs.appendFile(path.join(wt, "a.txt"), "agent line\n");
	mgr.turnEnd("chat-1");
	await mgr.settle("chat-1");

	expect(await fs.readdir(notARepo)).toEqual([]); // nothing ever written to the target
	const rows = syncRows(mgr.rec("chat-1").dto);
	expect(rows).toHaveLength(1);
	expect(rows[0].summary).toContain("sync held");
});

test("two here-sessions on ONE checkout share a serialization chain: work is strictly sequential across sessions", async () => {
	const repo = await initRepo();
	const wt1 = await addWorktree(repo);
	const wt2 = await tmpDir("bsw-wt2-parent-").then(async (p) => {
		const w = path.join(p, "wt");
		await git(repo, "worktree", "add", "-q", "-b", "squad/bsw-test-2", w, "HEAD");
		return w;
	});
	const mgr = await makeManager();
	seed(mgr, "chat-1", { repo, worktree: wt1, realTreePath: repo });
	seed(mgr, "chat-2", { repo, worktree: wt2, realTreePath: repo });

	// Session 1's queued work stalls on a gate; session 2's must NOT start until it finishes —
	// per-record chains would happily run them concurrently (the round-8 finding: both fingerprint,
	// both `git apply` into the same checkout at machine speed).
	const order: string[] = [];
	let release!: () => void;
	const gate = new Promise<void>((res) => { release = res; });
	const p1 = mgr.enqueue("chat-1", async () => { order.push("s1-start"); await gate; order.push("s1-end"); });
	const p2 = mgr.enqueue("chat-2", async () => { order.push("s2-start"); });
	await Bun.sleep(20); // give a concurrent s2 every chance to start while s1 is parked
	expect(order).toEqual(["s1-start"]);
	release();
	await Promise.all([p1, p2]);
	expect(order).toEqual(["s1-start", "s1-end", "s2-start"]);

	// Different checkouts stay independent: a third session on ANOTHER repo never queues behind this one.
	const repo2 = await initRepo();
	const wt3 = await addWorktree(repo2);
	seed(mgr, "chat-3", { repo: repo2, worktree: wt3, realTreePath: repo2 });
	let ran = false;
	let release2!: () => void;
	const gate2 = new Promise<void>((res) => { release2 = res; });
	const pBlocked = mgr.enqueue("chat-1", async () => { await gate2; });
	await mgr.enqueue("chat-3", async () => { ran = true; });
	expect(ran).toBe(true); // did not wait for repo 1's parked chain
	release2();
	await pBlocked;
});

test("discard unwedges a held backlog: row clears, and the next stable turn auto-applies again", async () => {
	const repo = await initRepo();
	const wt = await addWorktree(repo);
	const mgr = await makeManager();
	seed(mgr, "chat-1", { repo, worktree: wt, realTreePath: repo });

	// Turn 1 holds (operator moved the checkout), then the operator fixes a.txt BY HAND — the held
	// patch can now never apply cleanly: the exact wedge that used to brick auto-sync forever.
	mgr.turnStart("chat-1");
	await mgr.settle();
	await fs.appendFile(path.join(wt, "a.txt"), "turn1\n");
	await fs.writeFile(path.join(repo, "operator.txt"), "concurrent\n");
	mgr.turnEnd("chat-1");
	await mgr.settle();
	await fs.writeFile(path.join(repo, "a.txt"), "one\ntwo\nthree\nturn1 applied by hand\n");
	expect((await mgr.applyHeldSync("chat-1")).ok).toBe(false); // wedged for real
	expect(syncRows(mgr.rec("chat-1").dto)).toHaveLength(1);

	const r = await mgr.discardHeldSync("chat-1");
	expect(r).toEqual({ ok: true, discarded: 1, remaining: 0 });
	expect(syncRows(mgr.rec("chat-1").dto)).toHaveLength(0); // row resolved
	expect(await fs.readFile(path.join(repo, "a.txt"), "utf8")).toContain("applied by hand"); // tree untouched

	// Auto-sync is un-bricked: the next stable turn applies without any click.
	mgr.turnStart("chat-1");
	await mgr.settle();
	await fs.writeFile(path.join(wt, "c.txt"), "turn2\n");
	mgr.turnEnd("chat-1");
	await mgr.settle();
	expect(await fs.readFile(path.join(repo, "c.txt"), "utf8")).toBe("turn2\n");
});

test("uncapturable turn: row is tagged (no 'held' claim), and resolving holds never dismisses it", async () => {
	const repo = await initRepo();
	const notAWorktree = await tmpDir("bsw-notwt-"); // worktree snapshot will fail — nothing to hold
	const mgr = await makeManager();
	seed(mgr, "chat-1", { repo, worktree: notAWorktree, realTreePath: repo });

	mgr.turnStart("chat-1");
	await mgr.settle();
	await fs.writeFile(path.join(notAWorktree, "x.txt"), "edit\n");
	mgr.turnEnd("chat-1");
	await mgr.settle();

	const rows = syncRows(mgr.rec("chat-1").dto);
	expect(rows).toHaveLength(1);
	expect(rows[0].sync).toBe("uncapturable");
	expect(rows[0].summary).not.toContain("held"); // nothing IS held — the copy must not claim it
	expect(rows[0].detail).toContain("nothing is held");

	// An Apply reaching the server anyway (stale client) reports the empty backlog honestly and
	// must NOT clear the warning: that turn's edits are still worktree-only.
	expect(await mgr.applyHeldSync("chat-1")).toEqual({ ok: true, applied: 0, remaining: 0 });
	expect(syncRows(mgr.rec("chat-1").dto)).toHaveLength(1);
	expect(await mgr.discardHeldSync("chat-1")).toEqual({ ok: true, discarded: 0, remaining: 0 });
	expect(syncRows(mgr.rec("chat-1").dto)).toHaveLength(1);
});

test("uncapturable turn later COVERED by a spanning patch: the next stable turn syncs the missed edits and clears the warning", async () => {
	const repo = await initRepo();
	const wt = await addWorktree(repo);
	const mgr = await makeManager();
	seed(mgr, "chat-1", { repo, worktree: wt, realTreePath: repo });

	// Turn 1: normal, applied — establishes the prior end tree the coverage logic keys off.
	mgr.turnStart("chat-1");
	await mgr.settle();
	await fs.appendFile(path.join(wt, "a.txt"), "turn1\n");
	mgr.turnEnd("chat-1");
	await mgr.settle();
	expect(await fs.readFile(path.join(repo, "a.txt"), "utf8")).toContain("turn1");

	// Turn 2: the worktree becomes un-snapshottable at turn end (its .git link vanishes) —
	// uncapturable, edits worktree-only, warning raised, endTree deliberately NOT advanced.
	mgr.turnStart("chat-1");
	await mgr.settle();
	await fs.appendFile(path.join(wt, "a.txt"), "turn2\n");
	await fs.rename(path.join(wt, ".git"), path.join(wt, ".git-hidden"));
	mgr.turnEnd("chat-1");
	await mgr.settle();
	expect(await fs.readFile(path.join(repo, "a.txt"), "utf8")).not.toContain("turn2");
	let rows = syncRows(mgr.rec("chat-1").dto);
	expect(rows).toHaveLength(1);
	expect(rows[0].sync).toBe("uncapturable");

	// Turn 3: worktree healthy again, checkout stable. Because turn 2 never advanced the end tree,
	// turn 3's patch spans BOTH turns — applying it delivers turn 2's edits, so the warning clears.
	await fs.rename(path.join(wt, ".git-hidden"), path.join(wt, ".git"));
	mgr.turnStart("chat-1");
	await mgr.settle();
	await fs.appendFile(path.join(wt, "a.txt"), "turn3\n");
	mgr.turnEnd("chat-1");
	await mgr.settle();
	const a = await fs.readFile(path.join(repo, "a.txt"), "utf8");
	expect(a).toContain("turn2"); // the "lost" turn arrived via the spanning patch
	expect(a).toContain("turn3");
	expect(syncRows(mgr.rec("chat-1").dto)).toHaveLength(0); // warning resolved, honestly
});

test("held and uncapturable rows COEXIST — one never erases the other's affordance", async () => {
	const repo = await initRepo();
	const wt = await addWorktree(repo);
	const mgr = await makeManager();
	seed(mgr, "chat-1", { repo, worktree: wt, realTreePath: repo });

	// Turn 1 (first turn, live baseline): held via a concurrent operator edit.
	mgr.turnStart("chat-1");
	await mgr.settle();
	await fs.appendFile(path.join(wt, "a.txt"), "turn1\n");
	await fs.writeFile(path.join(repo, "operator.txt"), "concurrent\n");
	mgr.turnEnd("chat-1");
	await mgr.settle();
	expect(syncRows(mgr.rec("chat-1").dto).map((e) => e.sync)).toEqual(["held"]);

	// Turn 2: uncapturable (worktree un-snapshottable). The held row must survive — hiding it
	// would hide the only Apply/Discard affordance for a REAL backlog.
	mgr.turnStart("chat-1");
	await mgr.settle();
	await fs.rename(path.join(wt, ".git"), path.join(wt, ".git-hidden"));
	mgr.turnEnd("chat-1");
	await mgr.settle();
	await fs.rename(path.join(wt, ".git-hidden"), path.join(wt, ".git"));
	const kinds = syncRows(mgr.rec("chat-1").dto)
		.map((e) => e.sync)
		.sort();
	expect(kinds).toEqual(["held", "uncapturable"]);

	// Applying the backlog clears ONLY the held row; the uncapturable warning still stands (that
	// turn's edits were never captured into any patch — turn 2 holds nothing).
	const r = await mgr.applyHeldSync("chat-1");
	expect(r.ok).toBe(true);
	expect(syncRows(mgr.rec("chat-1").dto).map((e) => e.sync)).toEqual(["uncapturable"]);
});

test("boot: reattachHeldSyncs re-raises the row for a restored session and only warns for a vanished agent", async () => {
	const repo = await initRepo();
	const wt = await addWorktree(repo);
	const stateDir = await tmpDir("bsw-state-");

	// Daemon tenure 1: a turn holds, then the daemon "dies" (attention rows are in-memory only).
	const mgr1 = new TestManager({ stateDir });
	seed(mgr1, "chat-1", { repo, worktree: wt, realTreePath: repo });
	mgr1.turnStart("chat-1");
	await mgr1.settle("chat-1");
	await fs.appendFile(path.join(wt, "a.txt"), "turn1\n");
	await fs.writeFile(path.join(repo, "operator.txt"), "concurrent\n");
	mgr1.turnEnd("chat-1");
	await mgr1.settle("chat-1");
	expect(syncRows(mgr1.rec("chat-1").dto)).toHaveLength(1);

	// Daemon tenure 2, same state dir: the restored session gets its row back without any new turn.
	const mgr2 = new TestManager({ stateDir });
	seed(mgr2, "chat-1", { repo, worktree: wt, realTreePath: repo });
	await mgr2.reattach();
	const rows = syncRows(mgr2.rec("chat-1").dto);
	expect(rows).toHaveLength(1);
	expect(rows[0].summary).toContain("before the daemon restart");

	// Tenure 3: the agent is gone — reattach must not throw, and must not invent rows elsewhere.
	const mgr3 = new TestManager({ stateDir });
	await mgr3.reattach(); // logs a warning; holds stay durable on disk
});

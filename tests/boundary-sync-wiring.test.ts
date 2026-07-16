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
	/** Direct read of the durable held-patch store — bracket access, same seam discipline as above. */
	heldFor(id: string): Promise<{ turn: number; reason: string }[]> {
		return (this["boundarySyncHeld"] as { listHeld(id: string): Promise<{ turn: number; reason: string }[]> }).listHeld(id);
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

// ── C2: reattach re-keys a predecessor's held syncs onto the new session's id ───────────────────────

test("C2: boot orphan is discoverable (repo-scoped, patch files named); a restart reattach with a matching realDir re-keys it onto the new id and Apply works there", async () => {
	const repo = await initRepo();
	const wt = await addWorktree(repo);
	const stateDir = await tmpDir("bsw-state-");

	// Tenure 1: "chat-old" holds a turn, then the daemon dies (never reattached this tenure).
	const mgr1 = new TestManager({ stateDir });
	seed(mgr1, "chat-old", { repo, worktree: wt, realTreePath: repo });
	mgr1.turnStart("chat-old");
	await mgr1.settle("chat-old");
	await fs.appendFile(path.join(wt, "a.txt"), "turn1\n");
	await fs.writeFile(path.join(repo, "operator.txt"), "concurrent\n"); // force a hold
	mgr1.turnEnd("chat-old");
	await mgr1.settle("chat-old");
	expect(syncRows(mgr1.rec("chat-old").dto)).toHaveLength(1);

	// Tenure 2: a fresh manager, "chat-old" is NOT re-seeded (it's genuinely gone — no live owner).
	// Boot must surface this as a repo-scoped, queryable orphan — never just a log line.
	const mgr2 = new TestManager({ stateDir });
	await mgr2.reattach();
	const orphans = await mgr2.orphanedBoundarySyncs();
	expect(orphans).toHaveLength(1);
	expect(orphans[0]!.agentId).toBe("chat-old");
	expect(orphans[0]!.realDir).toBe(repo);
	expect(orphans[0]!.count).toBe(1);
	expect(orphans[0]!.patchFiles).toHaveLength(1);
	expect(await fs.readFile(orphans[0]!.patchFiles[0]!, "utf8")).toContain("turn1"); // really on disk

	// The operator runs `glance here` again on the SAME checkout — POST /api/console mints "chat-new"
	// with realTreePath === repo, then reattachOf: "chat-old" fires the re-key.
	seed(mgr2, "chat-new", { repo, worktree: wt, realTreePath: repo });
	const out = await mgr2.reattachDeadSession("chat-new", "chat-old");
	expect(out).toBeDefined();
	const rows = syncRows(mgr2.rec("chat-new").dto);
	expect(rows).toHaveLength(1);
	expect(rows[0]!.sync).toBe("held");
	expect(rows[0]!.summary).toContain("recovered from your previous session");

	// The orphan list is now empty — the hold has a live owner again.
	expect(await mgr2.orphanedBoundarySyncs()).toHaveLength(0);

	// Apply works on the NEW id: the re-keyed patch lands in the real checkout.
	const applied = await mgr2.applyHeldSync("chat-new");
	expect(applied).toMatchObject({ ok: true, applied: 1, remaining: 0 });
	expect(await fs.readFile(path.join(repo, "a.txt"), "utf8")).toContain("turn1");
	expect(syncRows(mgr2.rec("chat-new").dto)).toHaveLength(0);
});

test("C2: reattach does NOT re-key when the new session's realDir does not match the hold's recorded realDir", async () => {
	const repo = await initRepo();
	const otherRepo = await initRepo();
	const wt = await addWorktree(repo);
	const stateDir = await tmpDir("bsw-state-");

	const mgr1 = new TestManager({ stateDir });
	seed(mgr1, "chat-old", { repo, worktree: wt, realTreePath: repo });
	mgr1.turnStart("chat-old");
	await mgr1.settle("chat-old");
	await fs.appendFile(path.join(wt, "a.txt"), "turn1\n");
	await fs.writeFile(path.join(repo, "operator.txt"), "concurrent\n");
	mgr1.turnEnd("chat-old");
	await mgr1.settle("chat-old");

	// A DIFFERENT checkout reattaches naming "chat-old" as its lineage — explicit lineage alone,
	// without a matching tree, must never hand over holds for a different checkout.
	const mgr2 = new TestManager({ stateDir });
	seed(mgr2, "chat-new", { repo: otherRepo, worktree: wt, realTreePath: otherRepo });
	await mgr2.reattachDeadSession("chat-new", "chat-old");
	expect(syncRows(mgr2.rec("chat-new").dto)).toHaveLength(0); // nothing recovered onto the wrong tree
	const orphans = await mgr2.orphanedBoundarySyncs();
	expect(orphans).toHaveLength(1); // still orphaned under the old id, still recoverable later
	expect(orphans[0]!.agentId).toBe("chat-old");
});

// ── S5: promote() clears realTreePath — a fleet unit never carries it ───────────────────────────────

test("S5: promote() clears realTreePath so the unit's next turn does not boundary-sync into the operator's real checkout", async () => {
	const { CONSOLE_SYSTEM_PROMPT } = await import("../src/console-prompt.ts");
	const repo = await initRepo();
	const wt = await addWorktree(repo);
	const mgr = await makeManager();
	seed(mgr, "chat-1", { repo, worktree: wt, realTreePath: repo, kind: "omp-operator", appendSystemPrompt: CONSOLE_SYSTEM_PROMPT });
	mgr.rec("chat-1").dto.name = "chat"; // promote()'s identity check reads dto.name, which seed() pins to the agent id

	const result = await mgr.promote("chat-1", {});
	expect(result.ok).toBe(true);

	// A turn AFTER promote must be inert — no attention row, no write, exactly like a plain fleet unit.
	mgr.turnStart("chat-1");
	await mgr.settle("chat-1");
	await fs.appendFile(path.join(wt, "a.txt"), "post-promote work\n");
	mgr.turnEnd("chat-1");
	await mgr.settle("chat-1");

	expect(await fs.readFile(path.join(repo, "a.txt"), "utf8")).not.toContain("post-promote work");
	expect(mgr.rec("chat-1").boundarySyncTurn).toBeUndefined(); // the hook never even engaged
	expect(syncRows(mgr.rec("chat-1").dto)).toHaveLength(0);
});

// ── S6: a ledger bookkeeping failure must never cost the turn's patch ───────────────────────────────

test("S6: ledger-append failure raises attention naming the saved patch file — never 'nothing is held'", async () => {
	const repo = await initRepo();
	const wt = await addWorktree(repo);
	const stateDir = await tmpDir("bsw-state-");
	// Pre-occupy the held-sync ledger's path with a DIRECTORY before any turn ever runs — the patch
	// body (a sibling `<id>.patch` file) still writes fine; only the ledger append can ever fail here.
	await fs.mkdir(path.join(stateDir, "boundary-sync", "held.jsonl"), { recursive: true });
	const mgr = new TestManager({ stateDir });
	seed(mgr, "chat-1", { repo, worktree: wt, realTreePath: repo });

	mgr.turnStart("chat-1");
	await mgr.settle("chat-1");
	await fs.appendFile(path.join(wt, "a.txt"), "turn1\n");
	await fs.writeFile(path.join(repo, "operator.txt"), "concurrent\n"); // force a hold decision
	mgr.turnEnd("chat-1");
	await mgr.settle("chat-1");

	const rows = syncRows(mgr.rec("chat-1").dto);
	expect(rows).toHaveLength(1);
	expect(rows[0]!.sync).toBe("held");
	expect(rows[0]!.summary).toContain("saved but not yet tracked");
	// The attention detail NAMES an actual, existing patch file — never a dead end.
	const m = rows[0]!.detail?.match(/safe at (\S+\.patch)/);
	expect(m).toBeTruthy();
	const patchFile = m![1]!;
	const body = await fs.readFile(patchFile, "utf8");
	expect(body).toContain("diff --git");
	expect(body).toContain("turn1");
	// Fail-closed direction still holds: the real tree was never touched.
	expect(await fs.readFile(path.join(repo, "a.txt"), "utf8")).not.toContain("turn1");
});

// ── M1: the turn number must be stamped INSIDE the per-checkout chain, not before it ────────────────

test("M1: a fast next-turn-start racing a still-queued end-sync closure must not mislabel the held record's turn number", async () => {
	const repo = await initRepo();
	const wt = await addWorktree(repo);
	const mgr = await makeManager();
	seed(mgr, "chat-1", { repo, worktree: wt, realTreePath: repo });

	// Pre-seed a backlog entry so ANY turn holds unconditionally (step 2, ordering) regardless of the
	// real tree's fingerprint — removes fingerprint timing from the picture entirely; only the turn
	// NUMBER stamped on the resulting hold is under test here.
	await (mgr as unknown as { boundarySyncHeld: { hold(e: unknown): Promise<unknown> } }).boundarySyncHeld.hold({
		agentId: "chat-1",
		turn: 0,
		realDir: repo,
		reason: "pre-existing",
		patch: "x",
	});

	// Block the per-checkout chain so NOTHING queued after this point actually executes yet — this is
	// what lets the "fast next turn" call land while turn 1's own end-sync closure is still queued,
	// exactly the shape a backlogged chain (e.g. another `here` session sharing this checkout) creates.
	let release!: () => void;
	const gate = new Promise<void>((res) => {
		release = res;
	});
	const blocker = mgr.enqueue("chat-1", async () => {
		await gate;
	});

	mgr.turnStart("chat-1"); // turn 1 begins — its closure is queued behind the blocker, not yet run
	await new Promise((r) => setTimeout(r, 20)); // let the off-chain `earlyTree` worktree snapshot settle
	await fs.appendFile(path.join(wt, "a.txt"), "turn1 edit\n"); // the turn's own (only) edit
	mgr.turnEnd("chat-1"); // turn 1 ends — its closure is ALSO queued behind the blocker

	// The fast next turn: called WHILE turn 1's end-sync closure is still sitting in the queue. Pre-M1
	// the turn-number increment ran synchronously right here (before the chain), stamping 2 onto the
	// counter before turn 1's own end-sync closure ever got a chance to read it as 1.
	mgr.turnStart("chat-1");

	release();
	await blocker;
	await mgr.settle("chat-1");

	const held = await mgr.heldFor("chat-1");
	// The pre-seeded entry (turn 0) plus turn 1's own backlog-forced hold.
	const turn1Hold = held.find((h) => h.reason.includes("already held"));
	expect(turn1Hold).toBeDefined();
	expect(turn1Hold?.turn).toBe(1); // never 2 — the race must not have won
});

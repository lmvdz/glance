/**
 * Teaching-content producers, wired end-to-end (comprehension lane concern 05): the model-delta path
 * of `squad_record_decision` and the new `squad_record_symptom` host tool, both driven through the
 * real `onHostTool` dispatch with a real git repo standing in for the unit's worktree — not a
 * reimplementation of the validation, which `decision-evidence.test.ts` / `symptoms.test.ts` already
 * cover in isolation. This file proves the WIRING: the manager actually calls `runFilesTouched` /
 * `statWhereToLookEntry` against the live repo, and actually persists on success.
 */
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { listSymptoms, readSymptom } from "../src/symptoms.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SubagentTracker } from "../src/subagents.ts";
import type { AgentDTO, PersistedAgent, PersistedFeature, TranscriptEntry } from "../src/types.ts";

const cleanups: Array<() => Promise<void>> = [];
const savedFlag = process.env.OMP_SQUAD_DECISION_CAPTURE;

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	if (savedFlag === undefined) delete process.env.OMP_SQUAD_DECISION_CAPTURE;
	else process.env.OMP_SQUAD_DECISION_CAPTURE = savedFlag;
});

const tmpDir = async (prefix: string): Promise<string> => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	return dir;
};

async function git(cwd: string, ...a: string[]): Promise<string> {
	const p = Bun.spawn(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
	const [out, , code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	if (code !== 0) throw new Error(`git ${a.join(" ")} failed in ${cwd}`);
	return out.trim();
}

/**
 * A real git repo standing in for a unit's worktree, with no `branch`/distinct `worktree` on the DTO —
 * `runFilesTouched` then takes its `path.resolve(worktree) === path.resolve(repo)` shortcut and calls
 * `changedFiles(worktree)` directly (a plain `git status --porcelain`), so no land-mode/base-ref
 * resolution is needed for this test.
 *
 * `rel`'s directory is committed as tracked FIRST (a `.gitkeep` placeholder), before `rel` itself is
 * written untracked — `git status --porcelain` collapses an entirely-new, entirely-untracked directory
 * to a single `?? dir/` entry rather than listing files inside it individually, which would make an
 * untracked file inside a brand-new directory invisible to `changedFiles` under its own name.
 */
async function repoWithFile(prefix: string, rel: string, body: string): Promise<string> {
	const repo = await tmpDir(prefix);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	const dir = path.dirname(path.join(repo, rel));
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, ".gitkeep"), "");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-qm", "base");
	await fs.writeFile(path.join(repo, rel), body);
	return repo;
}

interface TestDriver {
	prompt(message: string): Promise<void>;
	abort(): Promise<void>;
	stop(): Promise<void>;
	detach?(): void;
	respondHostTool(callId: string, text: string, isError?: boolean): void;
}

interface TestRecord {
	dto: AgentDTO;
	agent: TestDriver;
	options: PersistedAgent;
	transcript: TranscriptEntry[];
	assistantBuf: string;
	streaming: boolean;
	subs: SubagentTracker;
}

interface HostToolHarness {
	onHostTool(rec: TestRecord, call: { id: string; toolName: string; arguments: unknown }): void;
}

function dto(id: string, over: Partial<AgentDTO> = {}): AgentDTO {
	return {
		id,
		name: id,
		status: "idle",
		kind: "omp-operator",
		repo: "/repo",
		worktree: `/wt/${id}`,
		approvalMode: "write",
		pending: [],
		lastActivity: 0,
		messageCount: 0,
		...over,
	};
}

function record(agent: AgentDTO, replies: Array<{ callId: string; text: string; isError?: boolean }> = []): TestRecord {
	return {
		dto: agent,
		agent: {
			async prompt() {},
			async abort() {},
			async stop() {},
			detach() {},
			respondHostTool(callId, text, isError) {
				replies.push({ callId, text, isError });
			},
		},
		options: { id: agent.id, name: agent.name, repo: agent.repo, worktree: agent.worktree, approvalMode: agent.approvalMode },
		transcript: [],
		assistantBuf: "",
		streaming: false,
		subs: new SubagentTracker(),
	};
}

function addRecord(mgr: SquadManager, rec: TestRecord): void {
	(mgr.agents as unknown as Map<string, TestRecord>).set(rec.dto.id, rec);
}

async function callTool(rec: TestRecord, mgr: SquadManager, callId: string, toolName: string, args: unknown, replies: Array<{ callId: string; text: string; isError?: boolean }>): Promise<void> {
	const done = Promise.withResolvers<void>();
	rec.agent.respondHostTool = (id, text, isError) => {
		replies.push({ callId: id, text, isError });
		done.resolve();
	};
	(mgr as unknown as HostToolHarness).onHostTool(rec, { id: callId, toolName, arguments: args });
	await done.promise;
}

// ── squad_record_decision, source:"model-delta" ────────────────────────────────────────────────

test("a valid model-delta decision is accepted when its evidence cites a file the real worktree actually touched", async () => {
	process.env.OMP_SQUAD_DECISION_CAPTURE = "1";
	const repo = await repoWithFile("teach-delta-ok-", "src/dispatch.ts", "// untracked change\n");
	const stateDir = await tmpDir("teach-delta-ok-state-");
	const mgr = new SquadManager({ stateDir } as never);
	(mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore.set(
		"f",
		{ id: "f", repo, title: "feat-f", archived: false, decisions: [] } as unknown as PersistedFeature,
	);
	const replies: Array<{ callId: string; text: string; isError?: boolean }> = [];
	const rec = record(dto("a", { featureId: "f", repo, worktree: repo }), replies);
	addRecord(mgr, rec);

	await callTool(rec, mgr, "c1", "squad_record_decision", {
		text: "Dispatch used to serialize spawns one at a time; it now fans out concurrently up to the scheduler cap.",
		source: "model-delta",
		evidence: ["src/dispatch.ts"],
	}, replies);

	expect(replies.at(-1)?.isError).toBeUndefined();
	expect(replies.at(-1)?.text).toContain("model-delta recorded");
	const featureStore = (mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore;
	const decisions = featureStore.get("f")?.decisions ?? [];
	expect(decisions.length).toBe(1);
	expect(decisions[0]).toMatchObject({ source: "model-delta", evidence: ["src/dispatch.ts"] });
});

test("a model-delta whose evidence points outside the real worktree's changed files is rejected, naming the rule, and nothing is written", async () => {
	process.env.OMP_SQUAD_DECISION_CAPTURE = "1";
	const repo = await repoWithFile("teach-delta-bad-", "src/dispatch.ts", "// untracked change\n");
	const stateDir = await tmpDir("teach-delta-bad-state-");
	const mgr = new SquadManager({ stateDir } as never);
	(mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore.set(
		"f",
		{ id: "f", repo, title: "feat-f", archived: false, decisions: [] } as unknown as PersistedFeature,
	);
	const replies: Array<{ callId: string; text: string; isError?: boolean }> = [];
	const rec = record(dto("a", { featureId: "f", repo, worktree: repo }), replies);
	addRecord(mgr, rec);

	await callTool(rec, mgr, "c1", "squad_record_decision", {
		text: "Dispatch used to serialize spawns one at a time; it now fans out concurrently up to the cap.",
		source: "model-delta",
		evidence: ["src/never-touched.ts"],
	}, replies);

	expect(replies.at(-1)?.isError).toBe(true);
	expect(replies.at(-1)?.text).toContain("model-delta-evidence-anchor");
	expect(replies.at(-1)?.text).toContain("never-touched.ts");
	const featureStore = (mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore;
	expect((featureStore.get("f")?.decisions ?? []).length).toBe(0);
});

test("a model-delta with no evidence at all is rejected before touching the feature store", async () => {
	process.env.OMP_SQUAD_DECISION_CAPTURE = "1";
	const repo = await repoWithFile("teach-delta-anchorless-", "src/dispatch.ts", "// untracked change\n");
	const stateDir = await tmpDir("teach-delta-anchorless-state-");
	const mgr = new SquadManager({ stateDir } as never);
	(mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore.set(
		"f",
		{ id: "f", repo, title: "feat-f", archived: false, decisions: [] } as unknown as PersistedFeature,
	);
	const replies: Array<{ callId: string; text: string; isError?: boolean }> = [];
	const rec = record(dto("a", { featureId: "f", repo, worktree: repo }), replies);
	addRecord(mgr, rec);

	await callTool(rec, mgr, "c1", "squad_record_decision", {
		text: "Dispatch used to serialize spawns one at a time; it now fans out concurrently up to the cap.",
		source: "model-delta",
	}, replies);

	expect(replies.at(-1)?.isError).toBe(true);
	expect(replies.at(-1)?.text).toContain("model-delta-requires-evidence");
	const featureStore = (mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore;
	expect((featureStore.get("f")?.decisions ?? []).length).toBe(0);
});

test("a routine (non-model-delta) decision is unaffected by the evidence floor", async () => {
	process.env.OMP_SQUAD_DECISION_CAPTURE = "1";
	const stateDir = await tmpDir("teach-routine-state-");
	const mgr = new SquadManager({ stateDir } as never);
	(mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore.set(
		"f",
		{ id: "f", repo: "/repo", title: "feat-f", archived: false, decisions: [] } as unknown as PersistedFeature,
	);
	const replies: Array<{ callId: string; text: string; isError?: boolean }> = [];
	const rec = record(dto("a", { featureId: "f" }), replies);
	addRecord(mgr, rec);

	await callTool(rec, mgr, "c1", "squad_record_decision", { text: "Use RRF over a second ranker" }, replies);

	expect(replies.at(-1)?.isError).toBeUndefined();
	const featureStore = (mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore;
	expect(featureStore.get("f")?.decisions?.[0]).toMatchObject({ source: "agent" });
});

// ── squad_record_symptom ────────────────────────────────────────────────────────────────────────

test("a valid symptom (real existing file + real 2-deep dir + a glance command) is accepted and persisted", async () => {
	process.env.OMP_SQUAD_DECISION_CAPTURE = "1";
	const repo = await tmpDir("teach-symptom-ok-");
	await fs.mkdir(path.join(repo, "src", "lib"), { recursive: true });
	await fs.writeFile(path.join(repo, "src", "dispatch.ts"), "// stub\n");
	const stateDir = await tmpDir("teach-symptom-ok-state-");
	const mgr = new SquadManager({ stateDir } as never);
	const replies: Array<{ callId: string; text: string; isError?: boolean }> = [];
	const rec = record(dto("a", { repo, worktree: repo }), replies);
	addRecord(mgr, rec);

	await callTool(rec, mgr, "c1", "squad_record_symptom", {
		symptom: "daemon healthy but dispatch stalled",
		whereToLook: ["src/dispatch.ts", "src/lib", "glance doctor"],
	}, replies);

	expect(replies.at(-1)?.isError).toBeUndefined();
	expect(replies.at(-1)?.text).toContain("symptom recorded");
	const all = await listSymptoms(stateDir);
	expect(all.length).toBe(1);
	expect(all[0]?.symptom).toBe("daemon healthy but dispatch stalled");
	expect(all[0]?.whereToLook).toEqual(["src/dispatch.ts", "src/lib", "glance doctor"]);
	expect(all[0]?.repo).toBe(repo);
	expect(all[0]?.fixedBy.agentId).toBe("a");
	const byId = await readSymptom(stateDir, all[0]!.id);
	expect(byId?.symptom).toBe("daemon healthy but dispatch stalled");
});

test("a bare top-level directory in whereToLook is rejected, naming the rule, and nothing is written", async () => {
	process.env.OMP_SQUAD_DECISION_CAPTURE = "1";
	const repo = await tmpDir("teach-symptom-bare-");
	await fs.mkdir(path.join(repo, "src"), { recursive: true });
	const stateDir = await tmpDir("teach-symptom-bare-state-");
	const mgr = new SquadManager({ stateDir } as never);
	const replies: Array<{ callId: string; text: string; isError?: boolean }> = [];
	const rec = record(dto("a", { repo, worktree: repo }), replies);
	addRecord(mgr, rec);

	await callTool(rec, mgr, "c1", "squad_record_symptom", {
		symptom: "daemon healthy but dispatch stalled",
		whereToLook: ["src/"],
	}, replies);

	expect(replies.at(-1)?.isError).toBe(true);
	expect(replies.at(-1)?.text).toContain("symptom-where-to-look-bare-dir");
	const all = await listSymptoms(stateDir);
	expect(all.length).toBe(0);
});

test("a whereToLook entry pointing at a nonexistent path is rejected", async () => {
	process.env.OMP_SQUAD_DECISION_CAPTURE = "1";
	const repo = await tmpDir("teach-symptom-missing-");
	const stateDir = await tmpDir("teach-symptom-missing-state-");
	const mgr = new SquadManager({ stateDir } as never);
	const replies: Array<{ callId: string; text: string; isError?: boolean }> = [];
	const rec = record(dto("a", { repo, worktree: repo }), replies);
	addRecord(mgr, rec);

	await callTool(rec, mgr, "c1", "squad_record_symptom", {
		symptom: "daemon healthy but dispatch stalled",
		whereToLook: ["src/does-not-exist.ts"],
	}, replies);

	expect(replies.at(-1)?.isError).toBe(true);
	expect(replies.at(-1)?.text).toContain("symptom-where-to-look-missing");
});

test("a symptom under the text floor is rejected", async () => {
	process.env.OMP_SQUAD_DECISION_CAPTURE = "1";
	const repo = await tmpDir("teach-symptom-short-");
	const stateDir = await tmpDir("teach-symptom-short-state-");
	const mgr = new SquadManager({ stateDir } as never);
	const replies: Array<{ callId: string; text: string; isError?: boolean }> = [];
	const rec = record(dto("a", { repo, worktree: repo }), replies);
	addRecord(mgr, rec);

	await callTool(rec, mgr, "c1", "squad_record_symptom", { symptom: "too short", whereToLook: ["glance doctor"] }, replies);

	expect(replies.at(-1)?.isError).toBe(true);
	expect(replies.at(-1)?.text).toContain("symptom-text-too-short");
});

test("squad_record_symptom is flag-gated the same as squad_record_decision — disabled by default", async () => {
	delete process.env.OMP_SQUAD_DECISION_CAPTURE;
	const repo = await tmpDir("teach-symptom-flag-");
	const stateDir = await tmpDir("teach-symptom-flag-state-");
	const mgr = new SquadManager({ stateDir } as never);
	const replies: Array<{ callId: string; text: string; isError?: boolean }> = [];
	const rec = record(dto("a", { repo, worktree: repo }), replies);
	addRecord(mgr, rec);

	await callTool(rec, mgr, "c1", "squad_record_symptom", { symptom: "daemon healthy but dispatch stalled", whereToLook: ["glance doctor"] }, replies);

	expect(replies.at(-1)?.isError).toBe(true);
	expect(replies.at(-1)?.text).toContain("disabled");
	const all = await listSymptoms(stateDir);
	expect(all.length).toBe(0);
});

test("whereToLook stats against the unit's WORKTREE — a file the run itself created (not yet in the origin repo) passes the floor", async () => {
	process.env.OMP_SQUAD_DECISION_CAPTURE = "1";
	const repo = await tmpDir("teach-symptom-origin-");
	const worktree = await tmpDir("teach-symptom-wt-");
	await fs.mkdir(path.join(worktree, "src", "dispatch"), { recursive: true });
	await fs.writeFile(path.join(worktree, "src", "dispatch", "lease-guard.ts"), "// created by this run\n");
	const stateDir = await tmpDir("teach-symptom-wt-state-");
	const mgr = new SquadManager({ stateDir } as never);
	const replies: Array<{ callId: string; text: string; isError?: boolean }> = [];
	const rec = record(dto("a", { repo, worktree }), replies);
	addRecord(mgr, rec);

	await callTool(rec, mgr, "c1", "squad_record_symptom", {
		symptom: "daemon healthy but dispatch stalled",
		whereToLook: ["src/dispatch/lease-guard.ts"],
	}, replies);

	expect(replies.at(-1)?.isError).toBeUndefined();
	expect((await listSymptoms(stateDir)).length).toBe(1);
});

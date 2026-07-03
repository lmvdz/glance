/**
 * Feature derivation — land-status readiness, plan-dir scan, buildFeatures.
 * Real git repos in temp dirs (gpgsign off for headless).
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendConcernDecision, appendDecisionLine, buildFeatures, featureLandStatus, featureReadiness, listPlanDirs, parsePlanConcerns, validatePlanConcerns } from "../src/features.ts";
import type { AgentDTO, FeatureDTO, FeatureWorktreeStatus } from "../src/types.ts";

const tmps: string[] = [];
afterEach(async () => {
	for (const t of tmps) await fs.rm(t, { recursive: true, force: true }).catch(() => {});
	tmps.length = 0;
});

async function git(repo: string, ...a: string[]): Promise<void> {
	await Bun.spawn(["git", "-C", repo, ...a], { stdout: "ignore", stderr: "ignore" }).exited;
}

async function baseRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "feat-"));
	tmps.push(repo);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "t@t");
	await git(repo, "config", "user.name", "t");
	await git(repo, "config", "commit.gpgsign", "false");
	await fs.writeFile(path.join(repo, "base.txt"), "base\n");
	await git(repo, "add", ".");
	await git(repo, "commit", "-qm", "base");
	return repo;
}

function agent(over: Partial<AgentDTO> & { id: string; worktree: string }): AgentDTO {
	return { name: over.id, status: "idle", kind: "omp-operator", repo: "", approvalMode: "yolo", pending: [], lastActivity: 0, messageCount: 0, ...over };
}

function readinessOf(worktrees: FeatureWorktreeStatus[], over: Partial<Pick<FeatureDTO, "stage" | "blocked">> = {}) {
	return featureReadiness({ stage: over.stage ?? "review", blocked: over.blocked ?? false, worktrees });
}

function worktree(readiness: FeatureWorktreeStatus["readiness"], proof?: FeatureWorktreeStatus["proof"]): FeatureWorktreeStatus {
	return { branch: "feat", worktree: "/tmp/feat", changedFiles: 0, ahead: readiness === "ahead" ? 1 : 0, behind: readiness === "diverged" ? 1 : 0, readiness, proof };
}

test("featureReadiness distinguishes missing, failed, stale, fresh, and blocking states", () => {
	expect(readinessOf([]).state).toBe("no-candidate");
	expect(readinessOf([worktree("ahead", { state: "none", artifacts: 0 })])).toMatchObject({ ready: false, state: "needs-proof", blockers: ["needs-proof"] });
	expect(readinessOf([worktree("ahead", { state: "failed", artifacts: 0 })])).toMatchObject({ ready: false, state: "proof-failed", blockers: ["proof-failed"] });
	expect(readinessOf([worktree("ahead", { state: "stale", artifacts: 0 })])).toMatchObject({ ready: false, state: "proof-stale", blockers: ["proof-stale"] });
	expect(readinessOf([worktree("ahead", { state: "fresh", artifacts: 0 })])).toMatchObject({ ready: true, state: "ready", blockers: [] });
	expect(readinessOf([worktree("uncommitted", { state: "fresh", artifacts: 0 })])).toMatchObject({ ready: false, state: "uncommitted", blockers: ["uncommitted"] });
	expect(readinessOf([worktree("diverged", { state: "fresh", artifacts: 0 })])).toMatchObject({ ready: false, state: "diverged", blockers: ["diverged"] });
	expect(readinessOf([worktree("ahead", { state: "fresh", artifacts: 0 })], { blocked: true })).toMatchObject({ ready: false, state: "blocked-input", blockers: ["blocked-input"] });
});

test("featureLandStatus: no-branch when worktree === repo", async () => {
	const repo = await baseRepo();
	const [s] = await featureLandStatus([{ worktree: repo, repo }]);
	expect(s.readiness).toBe("no-branch");
});

test("featureLandStatus: ahead branch is 'ahead'; dirty worktree is 'uncommitted'", async () => {
	const repo = await baseRepo();
	await git(repo, "checkout", "-q", "-b", "feat");
	await fs.writeFile(path.join(repo, "a.txt"), "a\n");
	await git(repo, "add", ".");
	await git(repo, "commit", "-qm", "feat-1");
	await git(repo, "checkout", "-q", "main");
	const wt = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "wt-")), "feat");
	tmps.push(path.dirname(wt));
	await git(repo, "worktree", "add", "-q", wt, "feat");

	const [clean] = await featureLandStatus([{ branch: "feat", worktree: wt, repo }]);
	expect(clean.readiness).toBe("ahead");
	expect(clean.ahead).toBe(1);
	expect(clean.behind).toBe(0);

	await fs.writeFile(path.join(wt, "b.txt"), "dirty\n");
	const [dirty] = await featureLandStatus([{ branch: "feat", worktree: wt, repo }]);
	expect(dirty.readiness).toBe("uncommitted");
	expect(dirty.changedFiles).toBeGreaterThan(0);
});

test("featureLandStatus: branch that conflicts with advanced main is 'diverged'", async () => {
	const repo = await baseRepo();
	await git(repo, "checkout", "-q", "-b", "div");
	await fs.writeFile(path.join(repo, "f.txt"), "X\n");
	await git(repo, "add", ".");
	await git(repo, "commit", "-qm", "div-x");
	await git(repo, "checkout", "-q", "main");
	await fs.writeFile(path.join(repo, "f.txt"), "Y\n");
	await git(repo, "add", ".");
	await git(repo, "commit", "-qm", "main-y");
	const wt = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "wt-")), "div");
	tmps.push(path.dirname(wt));
	await git(repo, "worktree", "add", "-q", wt, "div");

	const [s] = await featureLandStatus([{ branch: "div", worktree: wt, repo }]);
	expect(s.ahead).toBe(1);
	expect(s.behind).toBe(1);
	expect(s.readiness).toBe("diverged");
});

test("featureLandStatus: a git error on a nonexistent branch reports 'diverged', never silently 'clean' (#11)", async () => {
	// A branch name that does not exist in git causes `rev-list` to fail with a non-zero exit
	// code. Before the fix, aheadBehind() returned { ahead: 0, behind: 0 } on any error, so a
	// branch with a bad/unknown ref appeared as "clean" (nothing to land, nothing diverged) —
	// masking the real problem. After the fix the error is surfaced as "diverged" so the operator
	// sees a branch that needs attention rather than one that has already been cleanly merged.
	const repo = await baseRepo();
	// Use a worktree path distinct from repo so the "worktree===repo → no-branch" short-circuit
	// doesn't fire, then supply a branch name that does not exist so git rev-list fails.
	const wt = await fs.mkdtemp(path.join(os.tmpdir(), "feat-err-"));
	tmps.push(wt);
	const [s] = await featureLandStatus([{ branch: "nonexistent-branch-xyz", worktree: wt, repo }]);
	// Must NOT report "clean" (which would mean "nothing to do / already merged")
	expect(s.readiness).not.toBe("clean");
	// Must surface as "diverged" — the "needs attention" sentinel for git errors
	expect(s.readiness).toBe("diverged");
});

test("listPlanDirs finds plan dirs and their PLANE pointers", async () => {
	const repo = await baseRepo();
	await fs.mkdir(path.join(repo, "plans", "auth"), { recursive: true });
	await fs.writeFile(path.join(repo, "plans", "auth", "01-login.md"), "# Login\nPLANE: ACME-12\nsome text\n");
	await fs.writeFile(path.join(repo, "plans", "auth", "02-tokens.md"), "PLANE: ACME-13\n");
	await fs.writeFile(path.join(repo, "plans", "auth", "00-overview.md"), "# Auth plan\n");
	await fs.mkdir(path.join(repo, "plans", "billing-flow"), { recursive: true });
	await fs.writeFile(path.join(repo, "plans", "billing-flow", "00-overview.md"), "# Overview\n");
	await fs.mkdir(path.join(repo, "plans", "empty"), { recursive: true }); // no markdown → skipped

	const dirs = await listPlanDirs(repo);
	expect(dirs.map((d) => d.dir)).toEqual(["plans/auth", "plans/billing-flow"]);
	expect(dirs[0].issueIds.sort()).toEqual(["ACME-12", "ACME-13"]);
	expect(dirs[0].title).toBe("Auth plan");
	expect(dirs[1].title).toBe("Billing Flow");
	expect(dirs[0].createdAt).toBeGreaterThan(0);
	expect(dirs[0].updatedAt).toBeGreaterThan(0);
});

test("buildFeatures: plan dir → planned/issues-created feature; agent → in-flight feature", async () => {
	const repo = await baseRepo();
	// agent on an ahead branch (committed, unmerged) → review (needs land)
	await git(repo, "checkout", "-q", "-b", "work");
	await fs.writeFile(path.join(repo, "c.txt"), "c\n");
	await git(repo, "add", ".");
	await git(repo, "commit", "-qm", "work-1");
	await git(repo, "checkout", "-q", "main");
	const wt = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "wt-")), "work");
	tmps.push(path.dirname(wt));
	await git(repo, "worktree", "add", "-q", wt, "work");
	// plan dir on disk in the main checkout (buildFeatures scans the filesystem)
	await fs.mkdir(path.join(repo, "plans", "auth"), { recursive: true });
	await fs.writeFile(path.join(repo, "plans", "auth", "01.md"), "PLANE: ACME-1\n");

	const feats = await buildFeatures(repo, [agent({ id: "a1", worktree: wt, branch: "work", repo, status: "idle" })]);
	const plan = feats.find((f) => f.id.startsWith("plan:"));
	const ag = feats.find((f) => f.id === "agent:a1");
	expect(plan?.stage).toBe("issues-created"); // has a PLANE pointer
	expect(plan?.issueIdentifiers).toEqual(["ACME-1"]);
	expect(ag?.stage).toBe("review"); // ahead commit, not merged → needs land
	expect(ag?.agentIds).toEqual(["a1"]);
	expect(ag?.worktrees[0].readiness).toBe("ahead");
});

test("buildFeatures derives task context from plan docs", async () => {
	const repo = await baseRepo();
	await fs.mkdir(path.join(repo, "plans", "context"), { recursive: true });
	await fs.writeFile(path.join(repo, "plans", "context", "01-api.md"), [
		"# API work",
		"STATUS: todo",
		"PLANE: ACME-7",
		"## Acceptance Criteria",
		"- Handles empty input",
		"## Prerequisites",
		"- Decide auth mode",
		"## Decisions",
		"- Use boring REST",
		"",
	].join("\n"));

	const [feature] = await buildFeatures(repo, [], []);
	expect(feature.acceptanceCriteria?.map((item) => item.text)).toContain("Handles empty input");
	expect(feature.decisions?.map((item) => item.text)).toContain("Use boring REST");
	expect(feature.relationships?.[0]?.targetId).toBe("ACME-7");
	expect(feature.contextBundle?.criteria).toBe("API work: Handles empty input");
	expect(feature.contextBundle?.prerequisites).toBe("API work: Decide auth mode");
	expect(feature.contextBundle?.decisions).toBe("Use boring REST");
});

test("buildFeatures merges persisted relationships with Plane issue relationships", async () => {
	const repo = await baseRepo();
	const [feature] = await buildFeatures(repo, [], [{
		id: "f1",
		title: "Persisted",
		repo,
		plane: { issueIdentifiers: ["ACME-7", "ACME-8"] },
		relationships: [{ id: "DOC-1", targetId: "DOC-1", targetTitle: "Design doc", type: "related" }],
		createdAt: 0,
		updatedAt: 0,
	}]);

	expect(feature.relationships?.map((item) => item.targetId)).toEqual(["DOC-1", "ACME-7", "ACME-8"]);
});

test("buildFeatures derives Plane issue relationships when persisted relationships are empty", async () => {
	const repo = await baseRepo();
	const [feature] = await buildFeatures(repo, [], [{
		id: "f1",
		title: "Persisted",
		repo,
		plane: { issueIdentifiers: ["ACME-7"] },
		relationships: [],
		createdAt: 0,
		updatedAt: 0,
	}]);

	expect(feature.relationships?.map((item) => item.targetId)).toEqual(["ACME-7"]);
});

test("buildFeatures does not turn verify commands into acceptance criteria", async () => {
	const repo = await baseRepo();
	await fs.mkdir(path.join(repo, "plans", "verify-is-not-criteria"), { recursive: true });
	await fs.writeFile(path.join(repo, "plans", "verify-is-not-criteria", "01-api.md"), [
		"# API work",
		"STATUS: open",
		"## Acceptance Criteria",
		"- Operators see a human-readable success condition",
		"## Verify",
		"- `bun test tests/features.test.ts`",
		"",
	].join("\n"));

	const [feature] = await buildFeatures(repo, [], []);
	const criteria = feature.acceptanceCriteria?.map((item) => item.text) ?? [];
	expect(criteria).toContain("Operators see a human-readable success condition");
	expect(criteria).not.toContain("`bun test tests/features.test.ts`");
	expect(feature.contextBundle?.criteria).toBe("API work: Operators see a human-readable success condition");
});

// ── visual-plan concern 09/11: Open-Questions answers append to the concern Decisions log ──

test("appendDecisionLine creates a Decisions section when absent", () => {
	const out = appendDecisionLine("# Concern\nSTATUS: open\n", "Q: Strategy? — A: JWT");
	expect(out).toContain("## Decisions");
	expect(out).toContain("- Q: Strategy? — A: JWT");
});

test("appendDecisionLine appends into an existing Decisions section and is idempotent", () => {
	const base = "# Concern\nSTATUS: open\n\n## Decisions\n\n- First decision\n";
	const once = appendDecisionLine(base, "Q: Strategy? — A: JWT");
	expect(once).toContain("- First decision");
	expect(once).toContain("- Q: Strategy? — A: JWT");
	const twice = appendDecisionLine(once, "Q: Strategy? — A: JWT");
	expect(twice).toBe(once); // same bullet not duplicated
	expect(twice.match(/- Q: Strategy\? — A: JWT/g)?.length).toBe(1);
});

test("appendDecisionLine recognizes 'Decision Log' heading variant", () => {
	const dl = appendDecisionLine("# C\nSTATUS: open\n\n## Decision Log\n\n- a\n", "b");
	expect(dl).toContain("## Decision Log");
	expect(dl).not.toContain("## Decisions"); // appended into the existing section, no new one
	expect(dl).toContain("- b");
});

test("appendConcernDecision round-trips through parsePlanConcerns as a decision", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "dec-"));
	tmps.push(repo);
	await fs.mkdir(path.join(repo, "plans", "x"), { recursive: true });
	await fs.writeFile(path.join(repo, "plans", "x", "01-c.md"), "# C\nSTATUS: open\n\n## Approach\n\ndo it\n");
	const updated = await appendConcernDecision(repo, "plans/x/01-c.md", "Q: Gate? — A: warn-only");
	expect(updated?.decisions).toContain("Q: Gate? — A: warn-only");
	const reparsed = (await parsePlanConcerns(repo, "plans/x")).find((c) => c.file === "01-c.md");
	expect(reparsed?.decisions).toContain("Q: Gate? — A: warn-only"); // persisted to disk
});

test("validatePlanConcerns flags a dependency cycle and a dangling dep (shared with the UI core)", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "val-"));
	tmps.push(repo);
	const dir = path.join(repo, "plans", "bad");
	await fs.mkdir(dir, { recursive: true });
	// 01 ⇄ 02 is a cycle; 03 depends on a concern (99) that does not exist.
	await fs.writeFile(path.join(dir, "00-overview.md"), "# Overview\n\n## Dependency graph\n\n| Concern | BLOCKED_BY |\n| --- | --- |\n| 01 | 02 |\n| 02 | 01 |\n| 03 | 99 |\n");
	await fs.writeFile(path.join(dir, "01-a.md"), "# A\nSTATUS: open\n");
	await fs.writeFile(path.join(dir, "02-b.md"), "# B\nSTATUS: open\n");
	await fs.writeFile(path.join(dir, "03-c.md"), "# C\nSTATUS: open\n");
	const issues = await validatePlanConcerns(repo, "plans/bad");
	expect(issues.some((i) => i.kind === "cycle")).toBe(true);
	expect(issues.some((i) => i.kind === "unresolved" && i.refs.includes(99))).toBe(true);
});

test("validatePlanConcerns is clean for a well-formed plan", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "val-"));
	tmps.push(repo);
	const dir = path.join(repo, "plans", "ok");
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, "00-overview.md"), "# Overview\n\n## Dependency graph\n\n| Concern | BLOCKED_BY |\n| --- | --- |\n| 01 | none |\n| 02 | 01 |\n");
	await fs.writeFile(path.join(dir, "01-a.md"), "# A\nSTATUS: open\n");
	await fs.writeFile(path.join(dir, "02-b.md"), "# B\nSTATUS: open\n");
	expect(await validatePlanConcerns(repo, "plans/ok")).toEqual([]);
});

test("appendConcernDecision returns null for a non-concern file", async () => {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "dec-"));
	tmps.push(repo);
	await fs.mkdir(path.join(repo, "plans", "x"), { recursive: true });
	await fs.writeFile(path.join(repo, "plans", "x", "00-overview.md"), "# Overview\n");
	expect(await appendConcernDecision(repo, "plans/x/00-overview.md", "noop")).toBeNull();
});

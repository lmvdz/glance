import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileStore } from "../src/dal/store.ts";
import type { OpenPlanVoteInput } from "../src/plan-votes.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer } from "../src/server.ts";
import type { PlanVoteRound, SquadEvent } from "../src/types.ts";

/** manager.openPlanVote returns PlanVoteRound | { conflict } (409 seam) — every open in these tests
 *  is the first for its feature, so narrow to the round or fail loudly. */
async function openRound(manager: SquadManager, input: OpenPlanVoteInput, actor?: string): Promise<PlanVoteRound> {
	const r = await manager.openPlanVote(input, actor);
	if ("conflict" in r) throw new Error("unexpected open-round conflict in test setup");
	return r;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function authed(init: RequestInit = {}): RequestInit {
	return { ...init, headers: { "content-type": "application/json", authorization: "Bearer admin", ...init.headers } };
}

async function fixture() {
	const state = await fs.mkdtemp(path.join(os.tmpdir(), "plan-vote-state-"));
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "plan-vote-repo-"));
	await fs.mkdir(path.join(repo, "plans", "ctx"), { recursive: true });
	await fs.writeFile(path.join(repo, "plans", "ctx", "01-spec.md"), "# Spec\n\nSome content.\n");
	const manager = new SquadManager({ stateDir: state, store: new FileStore(state) });
	const server = new SquadServer(manager, { port: 0, token: "admin" });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await manager.stop();
		await fs.rm(state, { recursive: true, force: true });
		await fs.rm(repo, { recursive: true, force: true });
	});
	return { url, repo, manager };
}

const PLAN_PATH = "plans/ctx/01-spec.md";

async function createFeature(url: string, repo: string): Promise<{ id: string }> {
	return fetch(`${url}/api/features/from-plan`, authed({ method: "POST", body: JSON.stringify({ repo, title: "Vote feature", planDir: "plans/ctx" }) })).then((res) => res.json());
}

/** Add + resolve one plan-annotation comment on PLAN_PATH — the minimal way to open the review
 *  gate (reviewGateOpen / planVoteGateOpen both require ≥1 resolved, doc-anchored comment). */
async function openReviewGate(url: string, repo: string, featureId: string): Promise<void> {
	const comment = await fetch(`${url}/api/features/${encodeURIComponent(featureId)}/annotations?repo=${encodeURIComponent(repo)}`, authed({ method: "POST", body: JSON.stringify({ planPath: PLAN_PATH, lineStart: 1, body: "looks good" }) })).then((res) => res.json());
	await fetch(`${url}/api/features/${encodeURIComponent(featureId)}/annotations/${encodeURIComponent(comment.id)}/resolve?repo=${encodeURIComponent(repo)}`, authed({ method: "POST" }));
}

async function createCandidate(url: string, repo: string, featureId: string, summary = "tighten the plan"): Promise<{ id: string }> {
	return fetch(`${url}/api/features/${encodeURIComponent(featureId)}/plan-candidates?repo=${encodeURIComponent(repo)}`, authed({ method: "POST", body: JSON.stringify({ planPath: PLAN_PATH, summary }) })).then((res) => res.json());
}

// ── file-mode identity gap: the DEFAULT-seeded assignee (operatorId, e.g. "local") vs the
// bearer-token role actor every file-mode request carries (`web:admin`) — never explicitly
// re-assigned via setAssignees, exactly the state a fresh feature is in the moment it's created ───

test("file mode: the operator's own bearer actor can call a vote on a feature's DEFAULT-seeded assignee (no explicit setAssignees)", async () => {
	const { url, repo, manager } = await fixture();
	const feature = await createFeature(url, repo);
	// Never called manager.setAssignees — this IS the default seed (feature-assignees.ts: [operatorId]).
	expect(await manager.featureAssignees(feature.id, repo)).toEqual([manager.operatorId]);
	await openReviewGate(url, repo, feature.id);
	await createCandidate(url, repo, feature.id);

	const res = await fetch(`${url}/api/features/${encodeURIComponent(feature.id)}/plan-vote/call?repo=${encodeURIComponent(repo)}`, authed({ method: "POST", body: "{}" }));
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(body.round.state).toBe("voting");
});

test("file mode: the operator's own bearer actor can cast on a round whose snapshot assignees is the DEFAULT operator id", async () => {
	const { url, repo, manager } = await fixture();
	const feature = await createFeature(url, repo);
	await openReviewGate(url, repo, feature.id);
	await createCandidate(url, repo, feature.id);

	const called = await fetch(`${url}/api/features/${encodeURIComponent(feature.id)}/plan-vote/call?repo=${encodeURIComponent(repo)}`, authed({ method: "POST", body: "{}" })).then((res) => res.json());
	expect(called.round.assignees).toEqual([manager.operatorId]);

	const cast = await fetch(`${url}/api/features/${encodeURIComponent(feature.id)}/plan-vote/cast?repo=${encodeURIComponent(repo)}`, authed({ method: "POST", body: JSON.stringify({ roundId: called.round.id, choice: "approve" }) }));
	expect(cast.status).toBe(200);
	const body = await cast.json();
	expect(body.round.state).toBe("passed"); // A=1 (solo operator) auto-passes
	expect(body.quorum.reason).toContain("sole assignee auto-pass");
});

test("file mode: a non-operator assignee (written directly through the manager, bypassing the PUT restriction) still 403s a bearer actor — no blanket admin bypass", async () => {
	const { url, repo, manager } = await fixture();
	const feature = await createFeature(url, repo);
	await manager.setAssignees(feature.id, ["someone-else"], repo); // never the operator
	await openReviewGate(url, repo, feature.id);
	await createCandidate(url, repo, feature.id);

	const res = await fetch(`${url}/api/features/${encodeURIComponent(feature.id)}/plan-vote/call?repo=${encodeURIComponent(repo)}`, authed({ method: "POST", body: "{}" }));
	expect(res.status).toBe(403);
});

// ── call: guards ───────────────────────────────────────────────────────────────────────────────

test("call: 403 when the caller isn't one of the feature's assignees", async () => {
	const { url, repo, manager } = await fixture();
	const feature = await createFeature(url, repo);
	await manager.setAssignees(feature.id, ["someone-else"], repo);
	await openReviewGate(url, repo, feature.id);
	await createCandidate(url, repo, feature.id);

	const res = await fetch(`${url}/api/features/${encodeURIComponent(feature.id)}/plan-vote/call?repo=${encodeURIComponent(repo)}`, authed({ method: "POST", body: "{}" }));
	expect(res.status).toBe(403);
});

test("call: 400 when there's no candidate to vote on", async () => {
	const { url, repo, manager } = await fixture();
	const feature = await createFeature(url, repo);
	await manager.setAssignees(feature.id, ["web:admin"], repo);
	await openReviewGate(url, repo, feature.id);

	const res = await fetch(`${url}/api/features/${encodeURIComponent(feature.id)}/plan-vote/call?repo=${encodeURIComponent(repo)}`, authed({ method: "POST", body: "{}" }));
	expect(res.status).toBe(400);
	expect(await res.text()).toContain("no head candidate");
});

test("call: 400 when review comments are unresolved (the gate)", async () => {
	const { url, repo, manager } = await fixture();
	const feature = await createFeature(url, repo);
	await manager.setAssignees(feature.id, ["web:admin"], repo);
	await createCandidate(url, repo, feature.id);
	// One unresolved plan-annotation comment — never resolved.
	await fetch(`${url}/api/features/${encodeURIComponent(feature.id)}/annotations?repo=${encodeURIComponent(repo)}`, authed({ method: "POST", body: JSON.stringify({ planPath: PLAN_PATH, lineStart: 1, body: "needs a fix" }) }));

	const res = await fetch(`${url}/api/features/${encodeURIComponent(feature.id)}/plan-vote/call?repo=${encodeURIComponent(repo)}`, authed({ method: "POST", body: "{}" }));
	expect(res.status).toBe(400);
	expect(await res.text()).toContain("unresolved");
});

test("A=0 is structurally unreachable through the live FeatureDTO — buildFeatures always defaults an emptied assignee list back to [operator] (feature-assignees.ts's own guarantee), so the call endpoint's `assignees.length === 0` guard is defense-in-depth for a state the DTO layer never actually produces", async () => {
	const { manager, repo } = await fixture();
	const pf = manager.createFeature({ title: "Cleared", repo });
	await manager.setAssignees(pf.id, [], repo); // an admin explicitly clears the roster…
	const got = (await manager.features(repo)).find((f) => f.id === pf.id);
	expect(got?.assignees).not.toEqual([]); // …but the read path never surfaces A=0
	expect(got?.assignees.length).toBeGreaterThan(0);
});

test("call: 409 when a round is already open for this feature", async () => {
	const { url, repo, manager } = await fixture();
	const feature = await createFeature(url, repo);
	await manager.setAssignees(feature.id, ["web:admin"], repo);
	await openReviewGate(url, repo, feature.id);
	await createCandidate(url, repo, feature.id);

	const first = await fetch(`${url}/api/features/${encodeURIComponent(feature.id)}/plan-vote/call?repo=${encodeURIComponent(repo)}`, authed({ method: "POST", body: "{}" }));
	expect(first.status).toBe(200);
	const second = await fetch(`${url}/api/features/${encodeURIComponent(feature.id)}/plan-vote/call?repo=${encodeURIComponent(repo)}`, authed({ method: "POST", body: "{}" }));
	expect(second.status).toBe(409);
});

// ── the end-to-end A=1 (solo assignee) happy path, entirely over real HTTP ──────────────────────

test("call → cast: A=1 auto-passes, is audited, and leaves the candidate for the (unbuilt) commit-on-pass seam", async () => {
	const { url, repo, manager } = await fixture();
	const events: SquadEvent[] = [];
	manager.on("event", (e) => events.push(e as SquadEvent));

	const feature = await createFeature(url, repo);
	await manager.setAssignees(feature.id, ["web:admin"], repo);
	await openReviewGate(url, repo, feature.id);
	const candidate = await createCandidate(url, repo, feature.id, "adopt the reviewed revision");

	const called = await fetch(`${url}/api/features/${encodeURIComponent(feature.id)}/plan-vote/call?repo=${encodeURIComponent(repo)}`, authed({ method: "POST", body: "{}" })).then((res) => res.json());
	expect(called.round.state).toBe("voting");
	expect(called.round.candidateId).toBe(candidate.id);
	expect(called.round.assignees).toEqual(["web:admin"]);
	expect(called.quorum).toMatchObject({ assignees: 1, approvals: 0, decided: false, passed: false });

	// GET before casting: the round is surfaced as the current one.
	const getBefore = await fetch(`${url}/api/features/${encodeURIComponent(feature.id)}/plan-vote?repo=${encodeURIComponent(repo)}`, authed()).then((res) => res.json());
	expect(getBefore.round.id).toBe(called.round.id);
	expect(getBefore.round.state).toBe("voting");

	const cast = await fetch(`${url}/api/features/${encodeURIComponent(feature.id)}/plan-vote/cast?repo=${encodeURIComponent(repo)}`, authed({ method: "POST", body: JSON.stringify({ roundId: called.round.id, choice: "approve" }) })).then((res) => res.json());
	expect(cast.round.state).toBe("passed");
	expect(cast.quorum).toMatchObject({ assignees: 1, approvals: 1, decided: true, passed: true });
	expect(cast.quorum.reason).toContain("sole assignee auto-pass");

	// GET after: reflects the passed round.
	const getAfter = await fetch(`${url}/api/features/${encodeURIComponent(feature.id)}/plan-vote?repo=${encodeURIComponent(repo)}`, authed()).then((res) => res.json());
	expect(getAfter.round.state).toBe("passed");

	// Commit-on-pass (onVotePassed) DOES run now — but `repo` here is a plain temp dir, not a real git
	// repo, so there's no producer branch/tip to resolve at call time (revisionSha comes back "") and
	// it fails closed rather than landing anything: the candidate stays "candidate" for a human to
	// notice. See tests/plan-vote-commit.test.ts for the real-git commit-lands-cleanly money-shot.
	const candidates = await fetch(`${url}/api/features/${encodeURIComponent(feature.id)}/plan-candidates?repo=${encodeURIComponent(repo)}`, authed()).then((res) => res.json());
	expect(candidates.find((c: { id: string }) => c.id === candidate.id)?.state).toBe("candidate");

	// Audited: call, cast, and the passed-decision all left an audit trail.
	const actions = events.filter((e) => e.type === "audit").map((e) => (e as { entry: { action: string } }).entry.action);
	expect(actions).toContain("plan-vote.call");
	expect(actions).toContain("plan-vote.cast");
	expect(actions).toContain("plan-vote.passed");
});

// ── cast: guards ───────────────────────────────────────────────────────────────────────────────

test("cast: 403 when the caller isn't one of the round's assignees", async () => {
	const { url, repo, manager } = await fixture();
	const feature = await createFeature(url, repo);
	await manager.setAssignees(feature.id, ["someone-else"], repo);
	const candidate = await manager.addPlanRevisionCandidate({ repo, featureId: feature.id, planPath: PLAN_PATH, summary: "x" });
	const round = await openRound(manager, { featureId: feature.id, repo, planPath: PLAN_PATH, candidateId: candidate.id, baseSha: "", revisionSha: "", assignees: ["someone-else"], openedBy: "someone-else" });

	const res = await fetch(`${url}/api/features/${encodeURIComponent(feature.id)}/plan-vote/cast?repo=${encodeURIComponent(repo)}`, authed({ method: "POST", body: JSON.stringify({ roundId: round.id, choice: "approve" }) }));
	expect(res.status).toBe(403);
});

test("cast: 400 on an invalid choice", async () => {
	const { url, repo, manager } = await fixture();
	const feature = await createFeature(url, repo);
	await manager.setAssignees(feature.id, ["web:admin"], repo);
	const candidate = await manager.addPlanRevisionCandidate({ repo, featureId: feature.id, planPath: PLAN_PATH, summary: "x" });
	const round = await openRound(manager, { featureId: feature.id, repo, planPath: PLAN_PATH, candidateId: candidate.id, baseSha: "", revisionSha: "", assignees: ["web:admin"], openedBy: "web:admin" });

	const res = await fetch(`${url}/api/features/${encodeURIComponent(feature.id)}/plan-vote/cast?repo=${encodeURIComponent(repo)}`, authed({ method: "POST", body: JSON.stringify({ roundId: round.id, choice: "maybe" }) }));
	expect(res.status).toBe(400);
});

test("cast: 404 on a round from a different feature", async () => {
	const { url, repo, manager } = await fixture();
	const feature = await createFeature(url, repo);
	await manager.setAssignees(feature.id, ["web:admin"], repo);
	const other = await manager.addPlanRevisionCandidate({ repo, featureId: "other-feature", planPath: PLAN_PATH, summary: "x" });
	const round = await openRound(manager, { featureId: "other-feature", repo, planPath: PLAN_PATH, candidateId: other.id, baseSha: "", revisionSha: "", assignees: ["web:admin"], openedBy: "web:admin" });

	const res = await fetch(`${url}/api/features/${encodeURIComponent(feature.id)}/plan-vote/cast?repo=${encodeURIComponent(repo)}`, authed({ method: "POST", body: JSON.stringify({ roundId: round.id, choice: "approve" }) }));
	expect(res.status).toBe(404);
});

// ── multi-assignee quorum, driven at the manager layer (HTTP identity is fixed to one role per
// token in this deployment, so a genuine 3-distinct-voter scenario is exercised the same way
// feature-assignees.test.ts and plan-annotations-api.test.ts's second test drive multi-actor
// scenarios: through the manager directly, with an explicit actor id per call) ──────────────────

test("2 of 3 approve → PASSED, decided EARLY (before the 3rd casts); commit-on-pass runs but can't land this fixture's fake revision", async () => {
	const { manager, repo } = await fixture();
	const pf = manager.createFeature({ title: "Multi-voter", repo });
	await manager.setAssignees(pf.id, ["db:u1", "db:u2", "db:u3"], repo);
	const candidate = await manager.addPlanRevisionCandidate({ repo, featureId: pf.id, planPath: PLAN_PATH, summary: "multi-voter change" });
	// `fixture()`'s repo is a plain temp dir, not a git repo, so its real `planDocHeadRevision` is "" —
	// baseSha must match that (not a fake non-empty literal) or V4's base-SHA guard (onVotePassed,
	// squad-manager.ts) would misfire "superseded" against a doc that never actually moved.
	const round = await openRound(manager, { featureId: pf.id, repo, planPath: PLAN_PATH, candidateId: candidate.id, baseSha: "", revisionSha: "sha2", assignees: ["db:u1", "db:u2", "db:u3"], openedBy: "db:u1" });

	const r1 = await manager.castPlanVote(pf.id, round.id, "db:u1", "approve", "db:u1");
	expect(r1.round.state).toBe("voting"); // 1/3 — not yet decided
	const r2 = await manager.castPlanVote(pf.id, round.id, "db:u2", "approve", "db:u2");
	expect(r2.round.state).toBe("passed"); // 2/3 > 1.5 — decided WITHOUT the 3rd vote
	expect(r2.quorum).toMatchObject({ approvals: 2, pending: 1, decided: true, passed: true });

	// Commit-on-pass DID run (this unit's job now) — but "sha2" isn't a real commit in a real repo, so
	// it fails closed rather than landing anything: the candidate is left as "candidate" for a human to
	// notice, never silently accepted. See tests/plan-vote-commit.test.ts for the real-git money-shot.
	const closed = (await manager.listPlanVoteRounds({ repo, featureId: pf.id })).find((r) => r.id === round.id);
	expect(closed?.commitOutcome).toBe("failed");
	const candidates = await manager.listPlanRevisionCandidates({ repo, featureId: pf.id });
	expect(candidates.find((c) => c.id === candidate.id)?.state).toBe("candidate");
});

test("2 of 3 reject → candidate transitions to rejected, plan tree untouched", async () => {
	const { manager, repo } = await fixture();
	const pf = manager.createFeature({ title: "Multi-voter reject", repo });
	await manager.setAssignees(pf.id, ["db:u1", "db:u2", "db:u3"], repo);
	const candidate = await manager.addPlanRevisionCandidate({ repo, featureId: pf.id, planPath: PLAN_PATH, summary: "a change nobody wants" });
	const round = await openRound(manager, { featureId: pf.id, repo, planPath: PLAN_PATH, candidateId: candidate.id, baseSha: "sha1", revisionSha: "sha2", assignees: ["db:u1", "db:u2", "db:u3"], openedBy: "db:u1" });

	await manager.castPlanVote(pf.id, round.id, "db:u1", "reject", "db:u1");
	const r2 = await manager.castPlanVote(pf.id, round.id, "db:u2", "reject", "db:u2");
	expect(r2.round.state).toBe("rejected"); // best case for the 3rd is 1/3 — can never pass
	expect(r2.quorum).toMatchObject({ approvals: 0, rejects: 2, pending: 1, decided: true, passed: false });

	const candidates = await manager.listPlanRevisionCandidates({ repo, featureId: pf.id });
	const got = candidates.find((c) => c.id === candidate.id);
	expect(got?.state).toBe("rejected");
	expect(got?.reason).toContain("plan vote failed");
});

test("re-casting the same actor doesn't double-count (idempotent, no double-vote)", async () => {
	const { manager, repo } = await fixture();
	const pf = manager.createFeature({ title: "No double vote", repo });
	await manager.setAssignees(pf.id, ["db:u1", "db:u2", "db:u3"], repo);
	const candidate = await manager.addPlanRevisionCandidate({ repo, featureId: pf.id, planPath: PLAN_PATH, summary: "x" });
	const round = await openRound(manager, { featureId: pf.id, repo, planPath: PLAN_PATH, candidateId: candidate.id, baseSha: "", revisionSha: "", assignees: ["db:u1", "db:u2", "db:u3"], openedBy: "db:u1" });

	await manager.castPlanVote(pf.id, round.id, "db:u1", "approve", "db:u1");
	await manager.castPlanVote(pf.id, round.id, "db:u1", "approve", "db:u1"); // same actor, casts again
	const { round: got, quorum } = await manager.castPlanVote(pf.id, round.id, "db:u1", "reject", "db:u1"); // flips their own vote
	expect(quorum.approvals).toBe(0);
	expect(quorum.rejects).toBe(1);
	expect(got.state).toBe("voting"); // still just one real voter's worth of signal
});

test("casting on an already-closed round throws (server surfaces it as 409)", async () => {
	const { manager, repo } = await fixture();
	const pf = manager.createFeature({ title: "A1", repo });
	await manager.setAssignees(pf.id, ["local"], repo);
	const candidate = await manager.addPlanRevisionCandidate({ repo, featureId: pf.id, planPath: PLAN_PATH, summary: "x" });
	const round = await openRound(manager, { featureId: pf.id, repo, planPath: PLAN_PATH, candidateId: candidate.id, baseSha: "", revisionSha: "", assignees: ["local"], openedBy: "local" });
	await manager.castPlanVote(pf.id, round.id, "local", "approve", "local"); // auto-passes, closes

	await expect(manager.castPlanVote(pf.id, round.id, "local", "approve", "local")).rejects.toThrow(/already/);
});

// ── review findings: concurrency + snapshot-authz (HIGH 1, HIGH 2, MEDIUM 3) ────────────────────

test("HIGH 1: two concurrent DECIDING casts fire onVotePassed EXACTLY ONCE (per-feature lock serializes)", async () => {
	const { manager, repo } = await fixture();
	// Spy on the private side-effect: count how many times a round actually transitions to passed by
	// counting the durable "plan-vote.passed" audit (recordAudit emits an "audit" event synchronously).
	let passedFires = 0;
	manager.on("event", (e) => {
		const ev = e as { type: string; entry?: { action: string } };
		if (ev.type === "audit" && ev.entry?.action === "plan-vote.passed") passedFires++;
	});

	const pf = manager.createFeature({ title: "Race", repo });
	await manager.setAssignees(pf.id, ["db:u1", "db:u2", "db:u3"], repo);
	const candidate = await manager.addPlanRevisionCandidate({ repo, featureId: pf.id, planPath: PLAN_PATH, summary: "raced change" });
	const round = await openRound(manager, { featureId: pf.id, repo, planPath: PLAN_PATH, candidateId: candidate.id, baseSha: "sha1", revisionSha: "sha2", assignees: ["db:u1", "db:u2", "db:u3"], openedBy: "db:u1" });

	// u1 approves (1/3, undecided). Then u2 AND u3 approve simultaneously — each, read in isolation,
	// would be the deciding 2nd vote. Without the lock BOTH would observe "voting", both close, both
	// fire onVotePassed → double-commit. With the lock, exactly one closes; the other throws "already".
	await manager.castPlanVote(pf.id, round.id, "db:u1", "approve", "db:u1");
	const results = await Promise.allSettled([
		manager.castPlanVote(pf.id, round.id, "db:u2", "approve", "db:u2"),
		manager.castPlanVote(pf.id, round.id, "db:u3", "approve", "db:u3"),
	]);

	// Give the fire-and-forget recordAudit emits a tick to flush.
	await new Promise((r) => setTimeout(r, 0));
	expect(passedFires).toBe(1); // the money assertion: onVotePassed's decision fired exactly once

	const fulfilled = results.filter((r) => r.status === "fulfilled");
	const rejected = results.filter((r) => r.status === "rejected");
	expect(fulfilled).toHaveLength(1); // one deciding cast won
	expect(rejected).toHaveLength(1); // the other saw the closed round and threw
	if (fulfilled[0]?.status === "fulfilled") expect(fulfilled[0].value.round.state).toBe("passed");

	// And the durable log holds exactly one passed round, in state "passed".
	const [stored] = await manager.listPlanVoteRounds({ repo, featureId: pf.id });
	expect(stored?.state).toBe("passed");
});

test("HIGH 2: editing assignees mid-round doesn't change who may cast — the round's SNAPSHOT roster governs, not the live list", async () => {
	const { url, repo, manager } = await fixture();
	const feature = await createFeature(url, repo);
	// Round opens with web:admin on the snapshot roster (the token identity that will cast over HTTP).
	await manager.setAssignees(feature.id, ["web:admin", "db:u2", "db:u3"], repo);
	const candidate = await manager.addPlanRevisionCandidate({ repo, featureId: feature.id, planPath: PLAN_PATH, summary: "x" });
	const round = await openRound(manager, { featureId: feature.id, repo, planPath: PLAN_PATH, candidateId: candidate.id, baseSha: "", revisionSha: "", assignees: ["web:admin", "db:u2", "db:u3"], openedBy: "web:admin" });

	// Now the live roster is edited to EXCLUDE web:admin and add a stranger — the mutable list changes,
	// the round's frozen snapshot does not.
	await manager.setAssignees(feature.id, ["db:u4"], repo);

	// web:admin (on the snapshot, off the live list) may STILL cast — authz is against round.assignees.
	const ok = await fetch(`${url}/api/features/${encodeURIComponent(feature.id)}/plan-vote/cast?repo=${encodeURIComponent(repo)}`, authed({ method: "POST", body: JSON.stringify({ roundId: round.id, choice: "approve" }) }));
	expect(ok.status).toBe(200);

	// The quorum denominator is still the 3-person snapshot (1 approval of 3 is not yet decided) —
	// proving the snapshot governs the tally too, not the now-1-person live list.
	const body = await ok.json();
	expect(body.quorum).toMatchObject({ assignees: 3, approvals: 1, decided: false });

	// And db:u4 (added to the LIVE list AFTER the round opened) is NOT on the snapshot roster the
	// server authorizes casts against — so `round.assignees.includes("db:u4")` is false and the cast
	// handler 403s them, exactly the check that prevents a non-quorum voter from stranding the round.
	const current = (await manager.listPlanVoteRounds({ repo, featureId: feature.id }))[0]!;
	expect(current.assignees).toEqual(["web:admin", "db:u2", "db:u3"]);
	expect(current.assignees).not.toContain("db:u4");
});

test("MEDIUM 3: two concurrent CALLS open exactly one round (atomic check-and-open under the lock)", async () => {
	const { manager, repo } = await fixture();
	const pf = manager.createFeature({ title: "Double call", repo });
	await manager.setAssignees(pf.id, ["db:u1", "db:u2"], repo);
	const candidate = await manager.addPlanRevisionCandidate({ repo, featureId: pf.id, planPath: PLAN_PATH, summary: "x" });
	const input: OpenPlanVoteInput = { featureId: pf.id, repo, planPath: PLAN_PATH, candidateId: candidate.id, baseSha: "", revisionSha: "", assignees: ["db:u1", "db:u2"], openedBy: "db:u1" };

	// Two simultaneous opens (a double-click / two callers). Exactly one wins; the other gets conflict.
	const [a, b] = await Promise.all([manager.openPlanVote(input, "db:u1"), manager.openPlanVote(input, "db:u1")]);
	const conflicts = [a, b].filter((r) => "conflict" in r);
	const opened = [a, b].filter((r) => !("conflict" in r));
	expect(opened).toHaveLength(1);
	expect(conflicts).toHaveLength(1);

	// Exactly one round persisted, and it's the open one.
	const rounds = await manager.listPlanVoteRounds({ repo, featureId: pf.id });
	expect(rounds).toHaveLength(1);
	expect(rounds[0]?.state).toBe("voting");
});

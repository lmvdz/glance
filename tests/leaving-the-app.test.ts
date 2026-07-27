import { expect, test } from "bun:test";
import { RECOVERY_DELAY_MS, gateHealth, notificationText, readGateEvaluation, shouldLeaveTheApp, type GateEvaluation } from "../src/leaving-the-app.ts";

const T = 1_000_000_000;
function evaluation(over: Partial<GateEvaluation> = {}): GateEvaluation {
	return {
		id: "g1", nodeId: "n1", createdAt: T,
		question: "Should 3.2 retry against the new endpoint, or wait for you?",
		noRuleSettles: true, blocksMovingWork: true, answerableInOneSentence: true,
		blastRadius: "44 units are unaffected and still running.",
		eligibleAt: T - RECOVERY_DELAY_MS - 1,
		...over,
	};
}

test("all three conditions must hold — two out of three does not leave", () => {
	expect(shouldLeaveTheApp(evaluation(), T).send).toBe(true);
	for (const [field, name] of [["noRuleSettles", "a rule already settles this"], ["blocksMovingWork", "nothing is waiting on it"], ["answerableInOneSentence", "it needs more than one sentence to answer"]] as const) {
		const decision = shouldLeaveTheApp(evaluation({ [field]: false }), T);
		expect(decision.send).toBe(false);
		expect(decision.failed).toContain(name);
		// The refusal says which conditions held, so the gate can be argued with.
		expect(decision.because).toContain("All three conditions have to hold at once");
	}
});

test("the delay is enforced here, not trusted to a caller's timer", () => {
	// Many things that look blocking at minute zero are gone by minute nine. Sending immediately
	// optimises for the system's confidence rather than the person's evening.
	const early = shouldLeaveTheApp(evaluation({ eligibleAt: T - 60_000 }), T);
	expect(early.send).toBe(false);
	expect(early.because).toContain("8 more minutes");
	expect(early.because).toContain("gone by minute nine");
	expect(shouldLeaveTheApp(evaluation({ eligibleAt: T - RECOVERY_DELAY_MS }), T).send).toBe(true);
});

test("a reason that goes away during the wait cancels the send, and that is named as success", () => {
	const decision = shouldLeaveTheApp(evaluation({ cancelledAt: T, cancelledBecause: "the retry succeeded on its own" }), T);
	expect(decision.send).toBe(false);
	expect(decision.because).toContain("the retry succeeded on its own");
	expect(decision.because).toContain("the delay doing its job");
});

test("an already-sent evaluation never sends twice", () => {
	const decision = shouldLeaveTheApp(evaluation({ sentAt: T - 1 }), T);
	expect(decision.send).toBe(false);
	expect(decision.because).toContain("the same interruption twice");
});

test("the notification states what is NOT affected", () => {
	// Every interruption answers the anxious question before it is asked.
	expect(notificationText(evaluation())).toContain("44 units are unaffected");
	expect(shouldLeaveTheApp(evaluation(), T).because).toContain("44 units are unaffected");
});

test("gate health counts unreviewed sends rather than reading them as fine", () => {
	// A gate whose sends are never reviewed has no evidence it is calibrated, and no evidence of a
	// problem is not evidence of no problem.
	const sent = [evaluation({ id: "a", sentAt: T }), evaluation({ id: "b", sentAt: T })];
	const health = gateHealth(sent, [{ evaluationId: "a", reviewedAt: T, worthIt: true, because: "it was" }]);
	expect(health.sent).toBe(2);
	expect(health.reviewed).toBe(1);
	expect(health.sentence).toContain("1 of them has not been reviewed");
	expect(health.sentence).toContain("no evidence either way");
});

test("zero interruptions is reported as an achievement, with what the delay absorbed", () => {
	expect(gateHealth([], []).sentence).toContain("Nobody has been interrupted");
	const withCancels = gateHealth([evaluation({ cancelledAt: T })], []);
	expect(withCancels.sentence).toContain("sorted itself out during the wait");
});

test("a half-written evaluation is not an evaluation", () => {
	// The only thing between a person's evening and a notification is this record decoding.
	const { blastRadius: _b, ...noBlast } = evaluation();
	expect(readGateEvaluation(noBlast)).toBeUndefined();
	expect(readGateEvaluation({ ...evaluation(), noRuleSettles: "yes" })).toBeUndefined();
	const full = evaluation({ sentAt: T, cancelledAt: T, cancelledBecause: "x" });
	expect(readGateEvaluation(full)).toEqual(full);
});

test("the manager refuses to interrupt anyone on a record it cannot read", async () => {
  // Enforced at the seam, for the same reason the delegation boundary and the cost-disclosure rule
  // are: a gate every notification site must remember to consult is one that someone will skip, and
  // the failure is invisible — an evening is interrupted and nothing records that it should not have
  // been.
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { SquadManager } = await import("../src/squad-manager.ts");
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "leaving-"));
  const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), "leaving-wt-"));
  const mgr = new SquadManager({ stateDir, worktreeBase });
  await mgr.start();

  const good = mgr.mayLeaveTheApp(evaluation(), T);
  expect(good.send).toBe(true);
  expect(good.text).toContain("44 units are unaffected");

  for (const bad of [{}, null, undefined, { ...evaluation(), noRuleSettles: "yes" }, (({ blastRadius: _b, ...rest }) => rest)(evaluation())]) {
    const decision = mgr.mayLeaveTheApp(bad, T);
    expect(decision.send).toBe(false);
    expect(decision.because).toContain("did not decode");
  }

  expect(mgr.recoveryDelayMs).toBe(RECOVERY_DELAY_MS);
  await mgr.stop();
  for (const dir of [stateDir, worktreeBase]) await fs.rm(dir, { recursive: true, force: true });
});

test("interruptState reports the gate as UNWIRED, because it is", async () => {
  // `mayLeaveTheApp` is called by this test file and by nothing in production. No needs-you consults
  // it; the only thing that leaves the app is the weekly brief. Reporting `sent: 0` without saying so
  // is the worst kind of true — a reader takes it as a gate that considered and declined, when it is
  // a gate nothing asks.
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { SquadManager } = await import("../src/squad-manager.ts");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "interrupt-state-"));
  const mgr = new SquadManager({ stateDir: dir, worktreeBase: dir });
  const state = mgr.interruptState();
  expect(state.wired).toBe(false);
  expect(state.recoveryDelayMs).toBe(RECOVERY_DELAY_MS);
  // Whatever it claims leaves must not include anything about work waiting on a person.
  expect(state.leaves.some((what) => /needs you|waiting/i.test(what))).toBe(false);
  await fs.rm(dir, { recursive: true, force: true });
});

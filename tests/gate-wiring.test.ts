import { expect, test } from "bun:test";
import { answerableInOneSentence, blastRadius, blocksMovingWork, buildEvaluation, noRuleSettles } from "../src/gate-wiring.ts";
import { RECOVERY_DELAY_MS, shouldLeaveTheApp } from "../src/leaving-the-app.ts";
import type { AgentDTO, PendingRequest } from "../src/types.ts";

const T = 1_000_000_000;
const req = (over: Partial<PendingRequest> = {}): PendingRequest =>
	({ id: "gate_1", source: "ui", kind: "confirm", title: "Approve plan", createdAt: T, ...over }) as PendingRequest;
const agent = (over: Partial<AgentDTO> = {}): AgentDTO => ({ id: "u1", name: "wren", status: "input", ...over }) as AgentDTO;

test("condition 1: a rule that already settles this class means the person already decided", () => {
	expect(noRuleSettles(req(), [])).toBe(true);
	expect(noRuleSettles(req({ kind: "confirm" }), [{ sentence: "auto-approve confirms", settles: ["confirm"] }])).toBe(false);
	// Matching is on the RECORDED classes, never on the sentence prose — pattern-matching English to
	// decide whether to wake somebody is the guess this gate exists to refuse.
	expect(noRuleSettles(req({ kind: "confirm" }), [{ sentence: "you can confirm anything about plans", settles: [] }])).toBe(true);
});

test("condition 2: only a unit stopped ON this question counts as blocked by it", () => {
	expect(blocksMovingWork(agent({ status: "input" }))).toBe(true);
	// Already stopped for another reason — this question is not what is holding it up.
	expect(blocksMovingWork(agent({ status: "stopped" }))).toBe(false);
	expect(blocksMovingWork(agent({ status: "working" }))).toBe(false);
});

test("condition 3: an unknown kind answers NO, because not knowing is not permission", () => {
	expect(answerableInOneSentence(req({ kind: "confirm" }))).toBe(true);
	expect(answerableInOneSentence(req({ kind: "select", options: ["a", "b"] }))).toBe(true);
	// Needs a screen: an appointment, not a notification.
	expect(answerableInOneSentence(req({ kind: "input" }))).toBe(false);
	expect(answerableInOneSentence(req({ kind: "editor" }))).toBe(false);
	expect(answerableInOneSentence(req({ kind: "select", options: ["a", "b", "c", "d", "e"] }))).toBe(false);
	expect(answerableInOneSentence(req({ kind: "something-new" }))).toBe(false);
});

test("the blast radius says what is still fine, which is half the point of being interrupted", () => {
	const fleet = [agent({ id: "u1" }), agent({ id: "u2", status: "working" }), agent({ id: "u3", status: "working" })];
	expect(blastRadius(fleet, "u1")).toContain("2 other units are still running and unaffected");
	expect(blastRadius([agent({ id: "u1" })], "u1")).toContain("Nothing else is running");
	expect(blastRadius([agent({ id: "u1" }), agent({ id: "u2", status: "idle" })], "u1")).toContain("not the only thing stopped");
});

test("an evaluation is stable per question, so a restart cannot create a second one", () => {
	const build = () => buildEvaluation({ request: req(), agent: agent(), fleet: [agent()], rules: [], nodeId: "n1", now: T });
	expect(build().id).toBe(build().id);
	expect(build().id).toBe("u1:gate_1");
});

test("the mandatory wait starts now, so a question that arrives during a restart cannot skip it", () => {
	// createdAt is old; eligibleAt is not. Otherwise a daemon coming back up would immediately fire
	// everything that had been waiting, which is the opposite of what the delay is for.
	const built = buildEvaluation({ request: req({ createdAt: T - 60 * 60_000 }), agent: agent(), fleet: [agent()], rules: [], nodeId: "n1", now: T });
	expect(built.eligibleAt).toBe(T);
	expect(shouldLeaveTheApp({ ...built }, T).send).toBe(false);
	expect(shouldLeaveTheApp({ ...built }, T + RECOVERY_DELAY_MS).send).toBe(true);
});

test("all three conditions and the wait must hold before anything leaves", () => {
	const base = buildEvaluation({ request: req(), agent: agent(), fleet: [agent()], rules: [], nodeId: "n1", now: T });
	const late = T + RECOVERY_DELAY_MS;
	expect(shouldLeaveTheApp(base, late).send).toBe(true);
	expect(shouldLeaveTheApp({ ...base, noRuleSettles: false }, late).send).toBe(false);
	expect(shouldLeaveTheApp({ ...base, blocksMovingWork: false }, late).send).toBe(false);
	expect(shouldLeaveTheApp({ ...base, answerableInOneSentence: false }, late).send).toBe(false);
});

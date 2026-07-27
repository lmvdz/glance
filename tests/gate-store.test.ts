import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GateStore } from "../src/gate-store.ts";
import { RECOVERY_DELAY_MS, gateHealth, type GateEvaluation } from "../src/leaving-the-app.ts";

const tmps: string[] = [];
afterAll(async () => { for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {}); });

const T = 1_000_000_000;
async function store(): Promise<GateStore> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-store-"));
	tmps.push(dir);
	return new GateStore(path.join(dir, "interrupt-gate.jsonl"));
}
const ev = (over: Partial<GateEvaluation> = {}): GateEvaluation => ({
	id: "u1:gate_1", nodeId: "u1", createdAt: T, question: "wren needs you: Approve plan",
	noRuleSettles: true, blocksMovingWork: true, answerableInOneSentence: true,
	blastRadius: "3 other units are still running and unaffected.", eligibleAt: T, ...over,
});

test("declining is recorded too — a gate that only records sends cannot be audited for what it suppressed", async () => {
	const s = await store();
	s.put(ev({ id: "a", blocksMovingWork: false }));
	s.put(ev({ id: "b" }));
	expect(s.evaluations().map((e) => e.id).sort()).toEqual(["a", "b"]);
});

test("a resolved question is never re-opened, so a restart cannot interrupt twice about one thing", async () => {
	const s = await store();
	s.put(ev());
	s.markSent("u1:gate_1", T + RECOVERY_DELAY_MS);
	// Exactly what a restart does: the unit still has the pending, so the tick re-evaluates it.
	expect(s.put(ev())).toBe(false);
	expect(s.get("u1:gate_1")?.sentAt).toBe(T + RECOVERY_DELAY_MS);
});

test("re-evaluating an OUTSTANDING question keeps its original wait, so the delay cannot be restarted", async () => {
	const s = await store();
	s.put(ev({ eligibleAt: T }));
	// A later pass — a minute on, or after a daemon bounce — must not push the deadline out.
	s.put(ev({ eligibleAt: T + 5 * 60_000 }));
	expect(s.get("u1:gate_1")?.eligibleAt).toBe(T);
});

test("a cancelled question stays cancelled, and reads as the delay working", async () => {
	const s = await store();
	s.put(ev());
	s.markCancelled("u1:gate_1", T + 60_000, "it was answered before anyone was interrupted");
	s.markSent("u1:gate_1", T + RECOVERY_DELAY_MS); // must not resurrect it
	expect(s.get("u1:gate_1")?.sentAt).toBeUndefined();
	expect(gateHealth(s.evaluations(), s.reviews()).cancelledByDelay).toBe(1);
});

test("only sends can be reviewed, and a reviewed send stops being asked about", async () => {
	const s = await store();
	s.put(ev({ id: "sent" }));
	s.put(ev({ id: "quiet" }));
	s.markSent("sent", T);
	expect(s.awaitingReview().map((e) => e.id)).toEqual(["sent"]);
	s.review({ evaluationId: "sent", reviewedAt: T + 1, worthIt: true, because: "it was" });
	expect(s.awaitingReview()).toEqual([]);
	expect(gateHealth(s.evaluations(), s.reviews()).worthIt).toBe(1);
});

test("the record survives a restart — the wait is meaningless if a bounce forgets it", async () => {
	// The nine-minute delay only means something if it is measured across a daemon restart. Both
	// failure modes have happened to this room's own cards: firing everything that was waiting, and
	// forgetting anything was waiting at all.
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-durable-"));
	tmps.push(dir);
	const file = path.join(dir, "interrupt-gate.jsonl");

	const before = new GateStore(file);
	before.put(ev({ id: "u1:gate_1" }));
	before.markSent("u1:gate_1", T + RECOVERY_DELAY_MS);
	before.review({ evaluationId: "u1:gate_1", reviewedAt: T + 1, worthIt: false, because: "it sorted itself out anyway" });
	// Let the fire-and-forget spool reach disk before reading it back.
	await Bun.sleep(80);

	const after = new GateStore(file);
	expect(after.get("u1:gate_1")?.sentAt).toBe(T + RECOVERY_DELAY_MS);
	expect(after.reviews()).toHaveLength(1);
	expect(after.reviews()[0]?.worthIt).toBe(false);
	// And it still refuses to re-open it, which is the property that matters across a restart.
	expect(after.put(ev({ id: "u1:gate_1" }))).toBe(false);
});

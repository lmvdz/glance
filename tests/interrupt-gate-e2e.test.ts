import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GateStore } from "../src/gate-store.ts";
import { buildEvaluation } from "../src/gate-wiring.ts";
import { RECOVERY_DELAY_MS, gateHealth, notificationText, shouldLeaveTheApp } from "../src/leaving-the-app.ts";
import type { AgentDTO, PendingRequest } from "../src/types.ts";

const tmps: string[] = [];
afterAll(async () => { for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {}); });

const T = 1_000_000_000;
const req = (over: Partial<PendingRequest> = {}): PendingRequest =>
  ({ id: "gate_1", source: "ui", kind: "confirm", title: "Approve plan", gateClass: true, createdAt: T, ...over }) as PendingRequest;
const agent = (over: Partial<AgentDTO> = {}): AgentDTO => ({ id: "u1", name: "wren", status: "input", ...over }) as AgentDTO;

async function store(): Promise<GateStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-e2e-"));
  tmps.push(dir);
  return new GateStore(path.join(dir, "interrupt-gate.jsonl"));
}

test("the whole loop: stopped unit → recorded → waits → sends → reviewed", async () => {
  const s = await store();
  const fleet = [agent(), agent({ id: "u2", status: "working" })];
  const evaluation = buildEvaluation({ request: req(), agent: agent(), fleet, rules: [], nodeId: "u1", now: T });
  s.put(evaluation);

  // Minute zero: all three conditions hold and it STILL does not send.
  expect(shouldLeaveTheApp(s.get(evaluation.id)!, T).send).toBe(false);
  // Minute nine: now it does.
  const late = T + RECOVERY_DELAY_MS;
  expect(shouldLeaveTheApp(s.get(evaluation.id)!, late).send).toBe(true);

  // What actually reaches the person carries the blast radius, not just the demand.
  const text = notificationText(s.get(evaluation.id)!);
  expect(text).toContain("Approve plan");
  expect(text).toContain("still running and unaffected");

  s.markSent(evaluation.id, late);
  expect(s.awaitingReview().map((e) => e.id)).toEqual([evaluation.id]);
  s.review({ evaluationId: evaluation.id, reviewedAt: late + 60_000, worthIt: true, because: "it was" });

  const health = gateHealth(s.evaluations(), s.reviews());
  expect(health.sent).toBe(1);
  expect(health.reviewed).toBe(1);
  expect(health.worthIt).toBe(1);
});

test("the delay is the product: a question answered during the wait never leaves", async () => {
  const s = await store();
  const evaluation = buildEvaluation({ request: req(), agent: agent(), fleet: [agent()], rules: [], nodeId: "u1", now: T });
  s.put(evaluation);
  // Answered at minute four — before the gate would have sent anything.
  s.markCancelled(evaluation.id, T + 4 * 60_000, "it was answered before anyone was interrupted");

  const late = T + RECOVERY_DELAY_MS;
  expect(shouldLeaveTheApp(s.get(evaluation.id)!, late).send).toBe(false);
  const health = gateHealth(s.evaluations(), s.reviews());
  expect(health.sent).toBe(0);
  expect(health.cancelledByDelay).toBe(1);
  // And it says so as the delay working, not as an absence.
  expect(health.sentence).toContain("sorted");
});

test("a rule that settles it means the person is never told", async () => {
  const s = await store();
  const evaluation = buildEvaluation({
    request: req(), agent: agent(), fleet: [agent()],
    rules: [{ sentence: "you can approve plans without me", settles: ["confirm"] }],
    nodeId: "u1", now: T,
  });
  s.put(evaluation);
  const decision = shouldLeaveTheApp(s.get(evaluation.id)!, T + RECOVERY_DELAY_MS);
  expect(decision.send).toBe(false);
  expect(decision.because).toContain("a rule already settles this");
  // Recorded anyway — the suppressions are the half nobody audits.
  expect(s.evaluations()).toHaveLength(1);
});

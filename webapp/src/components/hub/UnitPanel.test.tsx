import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentDTO } from "../../lib/dto";
import { UnitPanel, thisUnitSentence, unitChecks } from "./UnitPanel";

const T = 1_000_000_000;
const agent = (over: Partial<AgentDTO> = {}): AgentDTO => ({
  id: "wren-1", name: "Wren", status: "working", repo: "/src/billing-service", branch: "squad/retry-budget",
  startedAt: T - 2 * 3_600_000 - 8 * 60_000, pending: [], subagents: [], transitions: [], reports: [], attentionEvents: [],
  ...over,
} as AgentDTO);

test("stale verification is NOT reported as a pass", () => {
  // Evidence that was green against a different main is evidence about a different repository. The
  // whole point of showing checks is that a person can trust the green ones.
  const stale = unitChecks(agent({ verificationState: "stale" })).find((check) => check.name === "verification");
  expect(stale!.state).not.toBe("pass");
  expect(stale!.detail).toContain("older main");
  expect(unitChecks(agent({ verificationState: "fresh" })).find((c) => c.name === "verification")!.state).toBe("pass");
});

test("a check that never ran says so rather than rendering as quiet approval", () => {
  const none = unitChecks(agent({})).find((check) => check.name === "verification");
  expect(none!.detail).toBe("has not run");
  expect(none!.state).toBe("unknown");
});

test("the unit sentence says what it is missing, not what state it is in", () => {
  const waiting = thisUnitSentence(agent({ pending: [{ id: "gate_1", source: "ui", kind: "confirm", title: "?", createdAt: T }] }), T);
  expect(waiting).toContain("2h 8m");
  expect(waiting).toContain("the only thing missing is your answer");

  const healthy = thisUnitSentence(agent({}), T);
  expect(healthy).toContain("Nothing is waiting on you for this");

  const broken = thisUnitSentence(agent({ status: "error", error: "TypeError" }), T);
  expect(broken).toContain("stopped in a way it did not choose");
  expect(broken).toContain("TypeError");
});

test("the product-change pane admits when nobody has written the sentence", () => {
  // Inventing one from a branch name would be the machine putting words in someone's mouth about what
  // their change does.
  const html = renderToStaticMarkup(<UnitPanel agent={agent({})} now={T} />);
  expect(html).toContain("WHAT CHANGES IN THE PRODUCT");
  expect(html).toContain("the diff exists, the sentence does not");
});

test("the panel names the three questions, not the machinery", () => {
  const html = renderToStaticMarkup(<UnitPanel agent={agent({})} now={T} />);
  expect(html).toContain("THIS UNIT");
  expect(html).toContain("WHAT THE CHECKS SAY");
  expect(html).toContain("WHAT CHANGES IN THE PRODUCT");
  // The old workbench headings named the machinery instead.
  expect(html).not.toContain("LAND");
  expect(html).not.toContain("RUN");
});

test("a blocked land says what is blocking it, not just 'no'", () => {
  const blocked = unitChecks(agent({ blockedReason: "the gate has not run on this commit" })).find((c) => c.name === "ready to land");
  expect(blocked!.detail).toBe("the gate has not run on this commit");
  expect(blocked!.state).toBe("fail");
});

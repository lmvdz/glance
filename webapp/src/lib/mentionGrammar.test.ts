import { expect, test } from "bun:test";
import type { AgentDTO } from "./dto";
import { buildMentionSections, resolveMentionRoute, serializeMention, type MentionTarget } from "./mentionGrammar";
import type { Task } from "../types";

const agent = (id: string, name: string, status: AgentDTO["status"]): AgentDTO => ({ id, name, status } as AgentDTO);
const task = (id: string, title: string): Task => ({ id, title, status: "todo" } as Task);

test("buildMentionSections: one @ trigger produces sectioned agents and issues", () => {
  const sections = buildMentionSections([agent("a1", "Builder", "idle")], [task("T-1", "Fix login")], "");
  expect(sections.map((section) => [section.id, section.label, section.items.map((item) => item.label)])).toEqual([
    ["agents", "Agents", ["Builder"]],
    ["issues", "Issues", ["Fix login"]],
  ]);
});

test("serializeMention: uses R3 markdown-link format with resolver axis in the URL", () => {
  const target: MentionTarget = { kind: "agent", id: "agent 1", label: "Builder" };
  expect(serializeMention(target)).toBe("[@Builder](omp://agent/agent%201)");
});

test("resolveMentionRoute: idle and input agents route to direct steer", () => {
  const idle = agent("a1", "Builder", "idle");
  const input = agent("a2", "Reviewer", "input");
  expect(resolveMentionRoute(`${serializeMention({ kind: "agent", id: idle.id, label: idle.name })} ship it`, [idle])).toMatchObject({ kind: "steer", text: "ship it", target: { id: "a1" } });
  expect(resolveMentionRoute(`${serializeMention({ kind: "agent", id: input.id, label: input.name })} answer this`, [input])).toMatchObject({ kind: "steer", text: "answer this", target: { id: "a2" } });
});

test("resolveMentionRoute: working agents require confirmation instead of raw mid-turn injection", () => {
  const working = agent("a1", "Builder", "working");
  expect(resolveMentionRoute(`${serializeMention({ kind: "agent", id: working.id, label: working.name })} change direction`, [working])).toMatchObject({ kind: "confirm", text: "change direction", target: { id: "a1" } });
});

test("resolveMentionRoute: non-resident and reserved capability mentions route to spawn proposal", () => {
  expect(resolveMentionRoute("@vendor-capability build the adapter", [])).toMatchObject({ kind: "spawn", text: "build the adapter", target: { kind: "capability", id: "vendor-capability" } });
  expect(resolveMentionRoute("[@Ghost](omp://agent/missing) investigate", [])).toMatchObject({ kind: "spawn", text: "investigate", target: { kind: "agent", id: "missing" } });
});

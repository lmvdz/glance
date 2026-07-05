/**
 * Agent authorization scope — scopeFor decides which agents an agent-origin actor may address
 * (the message allowlist) and see (the context-fabric data scope). A pure roster walk, so it's
 * driven directly with crafted hierarchies. No manager, no processes.
 */

import { expect, test } from "bun:test";
import { agentActor, scopeFor } from "../src/agent-scope.ts";
import type { AgentDTO } from "../src/types.ts";

const A = (id: string, parentId?: string, featureId?: string): AgentDTO =>
	({ id, parentId, featureId, name: id, repo: "/r", status: "working" }) as AgentDTO;

// Tree:  P → { alpha, bravo, charlie };  charlie → delta.
const tree = [A("P"), A("alpha", "P"), A("bravo", "P"), A("charlie", "P"), A("delta", "charlie")];

test("a human/operator actor sees the whole roster", () => {
	const scope = scopeFor({ id: "op", origin: "operator" } as never, tree);
	expect(scope.size).toBe(tree.length);
});

test("scopeFor: a child sees itself and its ancestors — NOT its siblings or cousins", () => {
	const alpha = scopeFor(agentActor("alpha"), tree);
	expect([...alpha].sort()).toEqual(["P", "alpha"]);
	expect(alpha.has("bravo")).toBe(false); // sibling — the leak this test guards
	expect(alpha.has("charlie")).toBe(false); // sibling
	expect(alpha.has("delta")).toBe(false); // cousin (charlie's child)
});

test("scopeFor: a deeper node sees its full ancestor chain but no uncle branches", () => {
	const delta = scopeFor(agentActor("delta"), tree);
	expect([...delta].sort()).toEqual(["P", "charlie", "delta"]);
	expect(delta.has("alpha")).toBe(false); // uncle
	expect(delta.has("bravo")).toBe(false); // uncle
});

test("scopeFor: a parent still sees its entire descendant subtree", () => {
	const p = scopeFor(agentActor("P"), tree);
	expect([...p].sort()).toEqual(["P", "alpha", "bravo", "charlie", "delta"]);
});

test("scopeFor: agents in the same feature see each other regardless of hierarchy", () => {
	const feat = [A("x", undefined, "F"), A("y", undefined, "F"), A("z")];
	const x = scopeFor(agentActor("x"), feat);
	expect(x.has("y")).toBe(true); // same feature squad
	expect(x.has("z")).toBe(false); // no feature — out of scope
});

test("scopeFor: an actor not in the roster gets an empty scope", () => {
	expect(scopeFor(agentActor("ghost"), tree).size).toBe(0);
});

/**
 * Does the context we assembled actually REACH the agent?
 *
 * The harness registry has always DECLARED this per harness (`capabilities.contextInjection`), and
 * nothing consulted it. So the harness scorecard credited a unit with `hasInstructions` whenever a
 * primer was BUILT — even for an ACP unit, whose driver has no system-prompt slot and (by default)
 * throws the primer away. The scorecard was measuring our intent, not the agent's reality. Same defect
 * class as `primer-empty`, the metric that lived inside the branch it was meant to measure.
 *
 * `contextReachesAgent` is the predicate that makes the claim honest, and `primer-undelivered` is the
 * metric that watches it from outside.
 */

import { expect, test } from "bun:test";
import { contextReachesAgent } from "../src/harness-registry.ts";

const NO_ACP_CONTEXT = {} as NodeJS.ProcessEnv;
const ACP_CONTEXT = { OMP_SQUAD_ACP_CONTEXT: "prompt" } as NodeJS.ProcessEnv;

test("omp has a native --append-system-prompt channel", () => {
	expect(contextReachesAgent({ harness: "omp" }, NO_ACP_CONTEXT)).toBe(true);
});

test("an ACP unit runs UNSCOPED by default — the primer never arrives", () => {
	expect(contextReachesAgent({ harness: "auggie" }, NO_ACP_CONTEXT)).toBe(false);
});

test("…and does receive it when the operator opts into first-turn injection", () => {
	expect(contextReachesAgent({ harness: "auggie" }, ACP_CONTEXT)).toBe(true);
});

/** Every ACP harness inherits the honest answer for free — the point of asking the registry rather than
 *  hardcoding a list of names, so a harness added tomorrow (grok, on its own branch) is covered too. */
test("every acp-protocol harness answers the same way, without being enumerated here", () => {
	for (const harness of ["opencode", "codex", "claude-code", "gemini"]) {
		expect(contextReachesAgent({ harness }, NO_ACP_CONTEXT)).toBe(false);
		expect(contextReachesAgent({ harness }, ACP_CONTEXT)).toBe(true);
	}
});

/** The legacy `runtime: "acp"` alias resolves through the same choke point as `harness`. */
test("a persisted legacy runtime alias is not a back door", () => {
	expect(contextReachesAgent({ runtime: "acp" }, NO_ACP_CONTEXT)).toBe(false);
});

/** A workflow's context reaches its inner omp RpcAgent; a sandboxed unit's reaches the omp child inside
 *  the container (`--append-system-prompt` on the in-container argv). Both native, whatever the record's
 *  outer harness field happens to say. */
test("workflow and sandbox units deliver through their inner omp child", () => {
	expect(contextReachesAgent({ workflow: { nodes: [] }, harness: "auggie" }, NO_ACP_CONTEXT)).toBe(true);
	expect(contextReachesAgent({ sandbox: { image: "oven/bun:1" }, harness: "auggie" }, NO_ACP_CONTEXT)).toBe(true);
});

/** `resolveHarness` throws for an unknown name (create() will too). Until then, never CLAIM delivery. */
test("an unknown harness never claims delivery", () => {
	expect(contextReachesAgent({ harness: "not-a-real-harness" }, ACP_CONTEXT)).toBe(false);
});

/** The sandbox driver silently dropped it: `create()` never passed `appendSystemPrompt` through, so a
 *  sandboxed unit ran with an empty system prompt while the scorecard reported instructions. This is the
 *  builder production uses. */
test("the sandboxed omp child is launched with --append-system-prompt as one argv element", async () => {
	const { defaultAgentCommand } = await import("../src/sandbox-agent-driver.ts");

	const cmd = defaultAgentCommand({ workdir: "/work", appendSystemPrompt: "PRIMER\nline two" });
	const at = cmd.indexOf("--append-system-prompt");
	expect(at).toBeGreaterThan(0);
	expect(cmd[at + 1]).toBe("PRIMER\nline two"); // never interpolated into a shell string

	expect(defaultAgentCommand({ workdir: "/work" })).not.toContain("--append-system-prompt");
});

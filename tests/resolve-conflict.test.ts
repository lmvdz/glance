/**
 * The bundled resolve-conflict workflow is load-bearing for the integration layer,
 * so prove the graph stays valid and keeps its safety invariants: the merge and
 * verify steps are goal-gated (a textually-clean-but-broken merge can't land), the
 * fix-up loop is bounded (it can't spin forever), and the only edge to `commit`
 * fires on success. A broken edit to the .fabro fails here, not at land time.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { parseWorkflow } from "../src/workflow/dot.ts";

const src = readFileSync(new URL("../workflows/resolve-conflict/workflow.fabro", import.meta.url), "utf8");

test("resolve-conflict parses into a valid graph with the right node kinds", () => {
	const wf = parseWorkflow(src);
	expect(wf.name).toBe("ResolveConflict");
	expect(wf.nodes.get(wf.start)?.kind).toBe("start");
	expect(wf.nodes.get(wf.exit)?.kind).toBe("exit");
	expect(wf.nodes.get("merge")?.kind).toBe("command");
	expect(wf.nodes.get("resolve")?.kind).toBe("agent");
	expect(wf.nodes.get("verify")?.kind).toBe("command");
	expect(wf.nodes.get("fixup")?.kind).toBe("agent");
	expect(wf.nodes.get("commit")?.kind).toBe("command");
});

test("merge + verify are goal-gated and the fix-up loop is bounded", () => {
	const wf = parseWorkflow(src);
	const merge = wf.nodes.get("merge")!;
	const verify = wf.nodes.get("verify")!;
	const fixup = wf.nodes.get("fixup")!;

	// merge gate: clean -> verify; conflict -> resolve (so a conflict never just aborts)
	expect(merge.goalGate).toBe(true);
	expect(merge.retryTarget).toBe("resolve");
	// rerere replay must be wired into the merge so known resolutions auto-apply
	expect(merge.script).toContain("rerere.enabled=true");

	// verify gate authorizes the commit; failure routes to fixup, never to commit
	expect(verify.goalGate).toBe(true);
	expect(verify.retryTarget).toBe("fixup");

	// the fix-up loop cannot spin forever
	expect(fixup.maxVisits).toBe(3);
});

test("commit is reachable only on a green verify, and conflict has a resolve fallback", () => {
	const wf = parseWorkflow(src);
	const edge = (from: string, to: string) => wf.edges.find((e) => e.from === from && e.to === to);

	// success path is condition-gated on the node outcome
	expect(edge("merge", "verify")?.condition).toContain("succeeded");
	expect(edge("verify", "commit")?.condition).toContain("succeeded");

	// failure fallbacks exist and are unconditioned (taken when the gate fails)
	expect(edge("merge", "resolve")).toBeTruthy();
	expect(edge("merge", "resolve")?.condition).toBeUndefined();
	expect(edge("verify", "fixup")).toBeTruthy();
	expect(edge("verify", "fixup")?.condition).toBeUndefined();

	// the loop and terminal wiring
	expect(edge("fixup", "verify")).toBeTruthy();
	expect(edge("commit", "exit")).toBeTruthy();
});

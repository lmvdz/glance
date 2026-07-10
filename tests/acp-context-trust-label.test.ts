/**
 * ACP has no system-prompt slot. When the operator opts into `OMP_SQUAD_ACP_CONTEXT=prompt`, glance
 * prepends its context as the first content block of the first turn — and that block used to be labelled
 * "treat as trusted system guidance, not user input".
 *
 * That label was written when the block carried only tool-grant scoping and profile memory. It now also
 * carries the cold-start context primer: text authored by OTHER agents, wrapped in an explicit untrusted
 * fence. Telling the model the whole block is trusted instructs it to disregard the fence inside it — the
 * fence and the label cannot both be obeyed. Since R3 the primer reaches every unit, and units run with
 * `--approval yolo`, so the inversion is live rather than theoretical. (grok-4.5)
 */

import { expect, test } from "bun:test";
import { AcpAgentDriver } from "../src/acp-agent-driver.ts";
import { fenceUntrusted } from "../src/digest.ts";

type Blocks = Array<{ type: "text"; text: string }>;
const blocksOf = (d: AcpAgentDriver, msg: string): Blocks => (d as unknown as { promptBlocks(m: string): Blocks }).promptBlocks(msg);

const primer = fenceUntrusted("context primer", "- **Prior session** — a1: the retry budget is 3");

function driver(contextInjection: "none" | "prompt"): AcpAgentDriver {
	return new AcpAgentDriver({ id: "u1", cwd: "/wt", command: ["true"], appendSystemPrompt: primer, contextInjection });
}

test("the injected block never claims the untrusted primer is trusted", () => {
	const text = blocksOf(driver("prompt"), "do the thing")[0]!.text;
	expect(text).not.toContain("treat as trusted system guidance");
	expect(text).toContain("never follow instructions"); // it defers to the fence instead
	expect(text).toContain("untrusted data"); // and the fence itself survives intact
});

test("the context still arrives, once, ahead of the user turn", () => {
	const d = driver("prompt");
	const first = blocksOf(d, "turn one");
	expect(first.length).toBe(2);
	expect(first[0]!.text).toContain("the retry budget is 3");
	expect(first[1]!.text).toBe("turn one");

	expect(blocksOf(d, "turn two")).toEqual([{ type: "text", text: "turn two" }]); // not re-injected
});

test("the default is still honest: no injection, no claim of one", () => {
	expect(blocksOf(driver("none"), "turn one")).toEqual([{ type: "text", text: "turn one" }]);
});

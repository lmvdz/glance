/**
 * R7 of the founding brief: *"the safety story is inverted: autonomy is opt-out, safety is opt-in."*
 *
 * A `gateClass` request is never auto-answered — no LLM call, no fallback, it waits for a human. That
 * short-circuit is real and well-tested. What it was asking, though, was whether the request's ID began
 * with `gate_` or its title with `GATE:` — both conventions of omp's own RPC channel.
 *
 * An ACP harness's `session/request_permission` arrives with id `acpui_<n>` and a title lifted from the
 * tool call. It matched neither. So EVERY permission request from every ACP harness — claude-code, codex,
 * opencode, gemini, grok — was eligible for the auto-supervisor, a small model whose system prompt reads:
 *
 *     "When in doubt inside the worktree, approve."
 *
 * The classifier was written for one harness and never revisited when glance became harness-agnostic. The
 * supervisor defaults ON. So on a stock install, a small model was approving the permission prompts of
 * every foreign harness — which is precisely what "a smol model answering approval gates is how trust
 * dies invisibly" describes.
 *
 * Two fixes, both here:
 *   1. `gateClassOf` asks the DRIVER first. A driver that knows it is relaying an approval gate says so;
 *      the naming conventions survive only as a fallback for harnesses that don't.
 *   2. Under `--approval yolo` the ACP driver answers the request ITSELF, deterministically, from the
 *      operator's own instruction — no model decides. (`applyApprovalMode` normally stops these from
 *      arriving, but ACP's `setSessionMode` is `unstable_`; when it's missing, the harness asks per call.
 *      That fallback used to land in the supervisor's lap.)
 */

import { expect, test } from "bun:test";
import { gateClassOf } from "../src/squad-manager.ts";
import { pickOption } from "../src/acp-agent-driver.ts";

// ── the classifier ──────────────────────────────────────────────────────────────────────────────

test("a driver that says it is a gate is believed, whatever the id looks like", () => {
	expect(gateClassOf({ id: "acpui_3", title: "Run `rm -rf /`", gateClass: true })).toBe(true);
});

/**
 * TIGHTEN-ONLY, and the reason is a privilege escalation I nearly shipped.
 *
 * `extension_ui_request` is deliberately NOT schema-validated — `schema/agent-host-frame.ts` validates
 * only the two frames that mutate daemon state. It arrives from the AGENT process, which runs
 * model-authored tool calls and (since the R3 primer) carries other agents' text in its system prompt.
 * Had the frame's claim been believed in both directions, a prompt-injected agent could stamp
 * `gateClass: false` on its own `gate_` request, opt out of human review, and let a small model prompted
 * with "when in doubt … approve" answer it.
 *
 * So: the frame may ask for MORE human attention. It may never ask for less.
 */
test("a frame cannot opt ITSELF out of human review", () => {
	expect(gateClassOf({ id: "gate_7", title: "GATE: force-push to main?", gateClass: false })).toBe(true);
	expect(gateClassOf({ id: "ui_7", title: "GATE: ship it?", gateClass: false })).toBe(true);
});

/** A frame that claims nothing, with no convention match, is still routine. The escalation is opt-in. */
test("an unmarked routine request stays routine", () => {
	expect(gateClassOf({ id: "ui_7", title: "Write file src/x.ts?", gateClass: false })).toBe(false);
});

/** omp's conventions still classify omp's own requests, for drivers that make no claim. */
test("omp's naming conventions remain the fallback", () => {
	expect(gateClassOf({ id: "gate_7", title: "anything" })).toBe(true);
	expect(gateClassOf({ id: "ui_7", title: "GATE: ship it?" })).toBe(true);
	expect(gateClassOf({ id: "ui_7", title: "Write file src/x.ts?" })).toBe(false);
});

/** The exact shape that slipped through: an ACP permission request making no claim at all. Before the
 *  driver marked them, this returned `false` and the small model answered it. */
test("an unmarked ACP permission request is the shape that used to slip through", () => {
	expect(gateClassOf({ id: "acpui_3", title: "Permission requested" })).toBe(false);
});

// ── yolo is the operator's instruction, not a model's opinion ────────────────────────────────────

test("pickOption grants least privilege, and fails CLOSED on a non-compliant agent", () => {
	const compliant = [
		{ optionId: "a", kind: "allow_always" },
		{ optionId: "o", kind: "allow_once" },
		{ optionId: "r", kind: "reject_once" },
	];
	expect(pickOption(compliant, true)).toBe("o"); // allow_once beats allow_always
	expect(pickOption(compliant, false)).toBe("r");

	// No `kind` at all ⇒ we cannot tell allow from reject. Never guess a polarity: `options[0]` could be
	// the opposite of what the operator asked for.
	expect(pickOption([{ optionId: "x", name: "Sure" }], true)).toBeUndefined();
});

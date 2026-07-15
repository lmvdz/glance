/**
 * SingleAgentExecutor.runCommand's steer-body path (noisegate-compaction concern 03): an oversized
 * command-node output no longer blind head-cuts at `MAX_CONTEXT_OUTPUT` — it goes through
 * `reduceOutput` (output-reduce.ts, concern 01) at `STEER_BODY_BUDGET` (3800), so a `(fail)`/summary
 * line living at the TAIL of a huge dump survives instead of being sliced away, and the result stays
 * bounded well under checkpoint-log's `MAX_FIELD_BYTES` (4096, concern 04) even with the offload
 * pointer appended.
 *
 * Identity safety (red-team RT2-1): `reduceOutput` durably offloads the full original via
 * `writeGateLog` on EVERY reduction and mints a fresh ts+nonce pointer path each time — so two
 * `runCommand` calls fed the byte-identical oversized failing output twice produce two DIFFERENT raw
 * strings (different pointer line), even though the underlying failure never changed. This is
 * exactly what `identityNormalize` (also exercised directly by executor-reflection.test.ts and
 * verify-escalate.test.ts) exists to collapse back to equality for the no-progress / refutation
 * detectors.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setGateLogRoot } from "../src/gate-logs.ts";
import { GateSemaphore } from "../src/gate-semaphore.ts";
import { identityNormalize } from "../src/output-reduce.ts";
import { SingleAgentExecutor } from "../src/workflow/executor.ts";
import type { RunContext, WorkflowNode } from "../src/workflow/types.ts";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {});
});

async function tmp(): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "output-reduce-steer-"));
	tmps.push(dir);
	return dir;
}

/** Real captured bun-test SHAPE (plain mode: `(fail)`, not the ANSI `✗`), padded with plenty of inert
 *  filler so the whole thing is well past both `STEER_BODY_BUDGET` (3800) and the old 4000-byte
 *  head-cut, with the failure line and pass/fail summary living at the very END — exactly where a
 *  naive `slice(0, N)` head-cut would have thrown them away. */
const TAIL_FAILURE_LINE = "(fail) fixture suite > the tail case regressed";
function syntheticBunFailure(): string {
	const filler = Array.from({ length: 150 }, (_, i) => `  log line ${i}: nothing to see here, just noise padding out this suite run`).join("\n");
	return [
		"bun test v1.3.14 (0d9b296a)",
		"",
		filler,
		"",
		`${TAIL_FAILURE_LINE} [3.21ms]`,
		"      at <anonymous> (/tmp/fixture.test.ts:88:12)",
		"",
		" 4 pass",
		" 1 fail",
		"Ran 5 tests across 1 file. [45.00ms]",
	].join("\n");
}

const node: WorkflowNode = { id: "verify", kind: "command", label: "Verify", script: "bun test", attrs: {} };

function exec(cwd: string, execCommand: (script: string, cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>): SingleAgentExecutor {
	return new SingleAgentExecutor({
		cwd,
		acquireAgent: () => Promise.reject(new Error("not used")),
		emit: () => {},
		gate: () => Promise.resolve(""),
		execCommand,
		gateSemaphore: new GateSemaphore(1), // private instance — never contends with the process-wide singleton
		reflection: { stateDir: "/unused", repo: "/repo", agentId: "a1" },
	});
}

describe("runCommand steer body: signal-preserving reduce + identity safety", () => {
	test("a >5000-char failing output keeps its TAIL failure line, stays <= 4096 chars, and carries an offload pointer", async () => {
		const dir = await tmp();
		setGateLogRoot(dir);
		const cwd = await tmp();
		const raw = syntheticBunFailure();
		expect(raw.length).toBeGreaterThan(5000); // sanity: the fixture is actually oversized

		const e = exec(cwd, async () => ({ code: 1, stdout: raw, stderr: "" }));
		const ctx: RunContext = { goal: "g", vars: {} };
		const res = await e.runCommand(node, ctx);

		expect(res.outcome).toBe("failed");
		expect(res.text).toContain(TAIL_FAILURE_LINE); // the tail signal survived reduction
		expect(res.text.length).toBeLessThanOrEqual(4096); // checkpoint-log's MAX_FIELD_BYTES headroom
		expect(res.text).toMatch(/\[\d+ bytes omitted — full: .*\]/); // offload pointer present
	});

	test("running the SAME oversized failing output through runCommand TWICE: raw texts differ (fresh offload nonce), but identityNormalize collapses them to equal — while a genuinely different failure stays different", async () => {
		const dir = await tmp();
		setGateLogRoot(dir);
		const cwd = await tmp();
		const raw = syntheticBunFailure();

		const e = exec(cwd, async () => ({ code: 1, stdout: raw, stderr: "" }));
		const ctx: RunContext = { goal: "g", vars: {} };

		const first = await e.runCommand(node, ctx);
		const second = await e.runCommand(node, ctx);

		// Both are within budget and both preserved the tail failure line.
		for (const r of [first, second]) {
			expect(r.text).toContain(TAIL_FAILURE_LINE);
			expect(r.text.length).toBeLessThanOrEqual(4096);
		}

		// The raw strings differ — writeGateLog mints a fresh ts+nonce offload path on every call, even
		// for byte-identical input, so the pointer line alone makes the two outputs byte-different.
		expect(first.text).not.toBe(second.text);

		// But normalized (pointer/ANSI/timing-stripped), they compare EQUAL — this is the exact property
		// noProgressRoute (engine.ts) and reflectionNote's hashOutput (executor.ts) depend on to detect
		// "the same failure reproduced again" despite the differing offload nonce (red-team RT2-1).
		expect(identityNormalize(first.text)).toBe(identityNormalize(second.text));

		// Negative control: a GENUINELY different failure must NOT collapse to the same normalized text.
		const differentRaw = syntheticBunFailure().replace(TAIL_FAILURE_LINE, "(fail) fixture suite > an entirely unrelated case broke");
		const e2 = exec(cwd, async () => ({ code: 1, stdout: differentRaw, stderr: "" }));
		const third = await e2.runCommand(node, { goal: "g", vars: {} });
		expect(identityNormalize(third.text)).not.toBe(identityNormalize(first.text));
	});
});

/**
 * Digest module — buildDigest carries deterministic facts verbatim (goal, touched
 * files, where-we-left-off), writeDigest/readDigest round-trip on disk, a missing
 * digest reads as "", and fenceUntrusted wraps injected memory in untrusted markers.
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RunReceipt, TranscriptEntry } from "../src/types.ts";
import { buildDigest, fenceUntrusted, readDigest, writeDigest } from "../src/digest.ts";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

const transcript: TranscriptEntry[] = [
	{ kind: "user", text: "Build a cold-start resume digest for agents.", ts: 1 },
	{ kind: "assistant", text: "I added src/digest.ts and wired it into the manager.", ts: 2 },
	{ kind: "tool", text: "ran tests", ts: 3 },
	{ kind: "assistant", text: "All done. Left off after wiring restart surfacing.", ts: 4 },
];

const receipt = (runId: string, filesTouched: string[]): RunReceipt => ({
	agentId: "a1",
	name: "n",
	repo: "r",
	runId,
	startedAt: 1,
	status: "stopped",
	toolCalls: 0,
	toolTally: {},
	filesTouched,
});

const receipts: RunReceipt[] = [
	receipt("run1", ["src/digest.ts", "src/squad-manager.ts"]),
	receipt("run2", ["src/digest.ts", "tests/digest.test.ts"]),
];

test("buildDigest carries the goal + left-off verbatim and dedups touched files", () => {
	const md = buildDigest({ transcript, receipts });
	expect(md).toContain("Build a cold-start resume digest for agents.");
	expect(md).toContain("- src/squad-manager.ts");
	expect(md).toContain("Left off after wiring restart surfacing.");
	// union dedups src/digest.ts (in both receipts) to a single bullet.
	expect(md.split("- src/digest.ts\n").length - 1).toBe(1);
});

test("writeDigest then readDigest round-trips", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "digest-"));
	tmps.push(dir);
	const md = buildDigest({ transcript, receipts });
	await writeDigest(dir, "a1", md);
	expect(await readDigest(dir, "a1")).toBe(md);
});

test("readDigest returns empty string for a missing agent", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "digest-"));
	tmps.push(dir);
	expect(await readDigest(dir, "nope")).toBe("");
});

test("fenceUntrusted wraps body in begin/end untrusted markers", () => {
	const fenced = fenceUntrusted("resume digest", "injected body");
	expect(fenced).toContain("===== BEGIN resume digest (untrusted data) =====");
	expect(fenced).toContain("===== END resume digest =====");
	expect(fenced).toContain("injected body");
});

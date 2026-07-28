/**
 * Orphaned-run digest reconstruction (C3 / E_orphan — plans/research-long-horizon-agent-memory,
 * VALIDATION C3, HARNESS-SPEC G02's digest-level half). finalizeRun covers every exit inside a
 * living daemon; the one orphan window left is the DAEMON dying mid-run — the interrupted run
 * wrote no receipt and no digest, and cold-adopt used to surface the PREVIOUS run's digest (stale)
 * or nothing. Now: persisted-transcript activity newer than the last finalized receipt is the
 * machine-checkable unfinalized-tail detector, and the digest is rebuilt from the persisted
 * exhaust at adopt time, MARKED reconstructed — evidence, not self-report.
 */
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readDigest, writeDigest } from "../src/digest.ts";
import { appendReceipt } from "../src/receipts.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { PersistedAgent, RunReceipt, TranscriptEntry } from "../src/types.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tmpDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanups.push(async () => fs.rm(dir, { recursive: true, force: true }));
	return dir;
}

type Harness = { surfaceResumeDigest: (newId: string, p: PersistedAgent, t?: TranscriptEntry[]) => Promise<void> };

function fakeRec(id: string) {
	return {
		dto: { id, name: id, status: "idle", repo: "/r", worktree: "/w", approvalMode: "write", pending: [], lastActivity: 0 },
		agent: { async prompt() {}, async abort() {}, async stop() {}, respondHostTool() {} },
		options: { id, name: id, repo: "/r", worktree: "/w", approvalMode: "write" },
		transcript: [] as Array<{ kind: string; text: string }>,
		assistantBuf: "",
		thinkingBuf: "",
		streaming: false,
		subs: {},
		toolEntries: new Map(),
	};
}

function seeded(dir: string): { mgr: SquadManager; rec: ReturnType<typeof fakeRec> } {
	const mgr = new SquadManager({ stateDir: dir });
	const rec = fakeRec("new-1");
	(mgr.agents as unknown as Map<string, unknown>).set("new-1", rec);
	return { mgr, rec };
}

const persisted = { id: "old-1", name: "old", repo: "/r", worktree: "/w", approvalMode: "write" } as unknown as PersistedAgent;

const orphanTranscript: TranscriptEntry[] = [
	{ kind: "user", text: "Rotate the frobnicator lock before the deploy window closes.", ts: 4000 },
	{ kind: "assistant", text: "Rotated the frobnicator lock and updated src/frob/lock.ts to the new epoch.", ts: 5000 },
] as TranscriptEntry[];

test("an unfinalized tail (transcript newer than any receipt) is reconstructed and MARKED — not surfaced stale", async () => {
	const dir = await tmpDir("orphan-a-");
	const { mgr, rec } = seeded(dir);
	// A digest from a PREVIOUS finalized run sits on disk — the stale thing the old code surfaced.
	await writeDigest(dir, "old-1", "## Goal\nAncient prior-run digest that predates the orphaned work.");

	await (mgr as unknown as Harness).surfaceResumeDigest("new-1", persisted, orphanTranscript);

	const surfaced = rec.transcript.at(-1)?.text ?? "";
	expect(surfaced).toContain("RECONSTRUCTED post-mortem");
	expect(surfaced).toContain("frobnicator"); // the interrupted run's content, not the ancient digest
	expect(surfaced).not.toContain("Ancient prior-run digest");
	// The rebuilt digest is durable under the OLD id (the exhaust's key), banner included.
	const onDisk = await readDigest(dir, "old-1");
	expect(onDisk).toContain("RECONSTRUCTED post-mortem");
});

test("a cleanly finalized run (receipt newer than the transcript tail) is NOT relabeled reconstructed", async () => {
	const dir = await tmpDir("orphan-b-");
	const { mgr, rec } = seeded(dir);
	await writeDigest(dir, "old-1", "## Goal\nProperly finalized digest from the last run.");
	const receipt: RunReceipt = { agentId: "old-1", name: "old", repo: "/r", runId: "r1", startedAt: 1000, endedAt: 9000, status: "idle", toolCalls: 1, toolTally: {}, filesTouched: [] };
	await appendReceipt(dir, receipt);

	await (mgr as unknown as Harness).surfaceResumeDigest("new-1", persisted, orphanTranscript); // tail ts 5000 < receipt endedAt 9000

	const surfaced = rec.transcript.at(-1)?.text ?? "";
	expect(surfaced).toContain("Properly finalized digest");
	expect(surfaced).not.toContain("RECONSTRUCTED"); // relabeling a clean run as post-mortem would be its own lie
});

test("reconstruction is regenerated, never appended: a second adopt produces the identical digest, one banner", async () => {
	const dir = await tmpDir("orphan-c-");
	const { mgr } = seeded(dir);
	await (mgr as unknown as Harness).surfaceResumeDigest("new-1", persisted, orphanTranscript);
	const first = await readDigest(dir, "old-1");
	await (mgr as unknown as Harness).surfaceResumeDigest("new-1", persisted, orphanTranscript);
	const second = await readDigest(dir, "old-1");
	expect(second).toBe(first);
	expect(second.split("RECONSTRUCTED").length - 1).toBe(1);
});

test("no transcript and no digest ⇒ nothing surfaced (the empty case stays empty)", async () => {
	const dir = await tmpDir("orphan-d-");
	const { mgr, rec } = seeded(dir);
	await (mgr as unknown as Harness).surfaceResumeDigest("new-1", persisted, []);
	expect(rec.transcript).toHaveLength(0);
});

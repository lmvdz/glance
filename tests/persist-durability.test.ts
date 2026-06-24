/**
 * Durability across an UNCLEAN stop (OMPSQ-76 / concern 03, validates concern 01's fsync).
 *
 * The whole Archil case rests on one property: a host crash keeps *committed* work. A clean
 * unmount flushes, so a clean mount→remount cycle is a FALSE GREEN — it passes precisely
 * because it never exercises the no-fsync window. So this test crashes the writer with NO
 * clean shutdown (SIGKILL — no manager.stop, no flush hook), then asserts survival.
 *
 * Two checks:
 *  1. Crash-survival: a writer subprocess commits a real state.json (via writeFileDurable) +
 *     transcripts.json + a fsynced receipts NDJSON line, prints COMMITTED, then loops. The
 *     parent SIGKILLs it and asserts the committed files parse, are uncorrupted, the receipt
 *     tail is a whole record (never corrupt mid-record), and no stray `.tmp` is taken as truth.
 *  2. fsync-on-commit spy: proves the durability barrier (fsync) is actually on the durable
 *     commit path and absent from a plain writeFile.
 *
 * ponytail: on a normal local FS the OS page cache survives a process SIGKILL (only a real
 * power cut / kernel crash drops it), so a non-fsync writer's bytes also survive here — local
 * loss is unobservable without real hardware. So the negative control is the fsync-on-commit
 * spy (check 2), and TRUE crash-loss observation lives in scripts/durability-archil.ts (the
 * live external-dep leg: kill -9 + remount on a real Archil mount).
 */

import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeFileDurable } from "../src/dal/store.ts";
import type { RunReceipt } from "../src/types.ts";

const STORE_ABS = path.resolve(import.meta.dir, "../src/dal/store.ts");
const RECEIPTS_ABS = path.resolve(import.meta.dir, "../src/receipts.ts");

/** Writer subprocess source: commits the fileset, prints COMMITTED, then loops (no clean stop). */
function writerSource(): string {
	return `
import { writeFileDurable } from ${JSON.stringify(STORE_ABS)};
import { appendReceipt } from ${JSON.stringify(RECEIPTS_ABS)};
import * as fs from "node:fs/promises";
import * as path from "node:path";

const dir = process.argv[2];
const mode = process.argv[3] ?? "durable";
const transcripts = { a1: [{ kind: "system", text: "committed-work", ts: 1 }] };
const state = { agents: [{ id: "a1", name: "a1", repo: "/r", worktree: dir, approvalMode: "write" }], transcripts, features: [] };
const receipt = { agentId: "a1", name: "a1", repo: "/r", runId: "run-1", startedAt: 1, status: "idle", toolCalls: 1, toolTally: { bash: 1 }, filesTouched: [] };
const stateFile = path.join(dir, "state.json");
const transcriptsFile = path.join(dir, "transcripts.json");

if (mode === "durable") {
	await writeFileDurable(stateFile, JSON.stringify({ version: 1, ...state }, null, 2));
	await writeFileDurable(transcriptsFile, JSON.stringify(transcripts));
	await appendReceipt(dir, receipt);
} else {
	await fs.writeFile(stateFile, JSON.stringify({ version: 1, ...state }, null, 2));
	await fs.writeFile(transcriptsFile, JSON.stringify(transcripts));
	await fs.mkdir(path.join(dir, "receipts"), { recursive: true });
	await fs.appendFile(path.join(dir, "receipts", "a1.jsonl"), JSON.stringify(receipt) + "\\n");
}

process.stdout.write("COMMITTED\\n");
// Unclean stop: block forever on stdin (no timer) until the parent SIGKILLs us.
// No flush hook, no graceful shutdown — the point is to crash mid-life.
process.stdin.resume();
`;
}

/** Resolve once `needle` is seen on the stream, or reject on timeout / stream end. */
async function waitForLine(stream: ReadableStream<Uint8Array>, needle: string, timeoutMs: number): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	// We await the real signal (the stream chunk carrying `needle`); this timer is only a
	// fail-fast guard so a hung writer subprocess errors instead of hanging the whole suite.
	// A real OS subprocess's stdout cannot be driven by fake timers, hence a wall-clock guard.
	const timer = setTimeout(() => reject(new Error(`timeout waiting for "${needle}"`)), timeoutMs);
	(async () => {
		const dec = new TextDecoder();
		let buf = "";
		for await (const chunk of stream) {
			buf += dec.decode(chunk);
			if (buf.includes(needle)) {
				clearTimeout(timer);
				resolve();
				return;
			}
		}
		clearTimeout(timer);
		reject(new Error(`stream ended before "${needle}"`));
	})();
	return promise;
}

test("committed state survives SIGKILL of the writer with no clean shutdown", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "persist-durability-"));
	try {
		const writer = path.join(dir, "writer.ts");
		await fs.writeFile(writer, writerSource());

		const p = Bun.spawn(["bun", writer, dir, "durable"], { stdout: "pipe", stderr: "pipe" });
		await waitForLine(p.stdout, "COMMITTED", 20_000);

		// UNCLEAN stop: kill the writer mid-loop. No manager.stop(), no flush hook.
		expect(p.pid).toBeGreaterThan(0);
		process.kill(p.pid, "SIGKILL");
		await p.exited;

		// state.json: parses and contains the committed agent.
		const state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
		expect(state.version).toBe(1);
		expect(state.agents).toHaveLength(1);
		expect(state.agents[0].id).toBe("a1");
		expect(state.transcripts.a1[0].text).toBe("committed-work");

		// transcripts.json: parses and is uncorrupted.
		const transcripts = JSON.parse(await fs.readFile(path.join(dir, "transcripts.json"), "utf8"));
		expect(transcripts.a1[0].text).toBe("committed-work");

		// Receipts tail: a WHOLE record, never corrupt mid-record (committed line ends in newline).
		const raw = await fs.readFile(path.join(dir, "receipts", "a1.jsonl"), "utf8");
		expect(raw.endsWith("\n")).toBe(true);
		const lines = raw.split("\n").filter((l) => l.trim());
		expect(lines).toHaveLength(1);
		const receipt = JSON.parse(lines[0]) as RunReceipt;
		expect(receipt.agentId).toBe("a1");
		expect(receipt.runId).toBe("run-1");

		// No stray `.tmp` masquerading as truth — the durable rename consumed it before COMMITTED.
		const entries = await fs.readdir(dir);
		expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
	} finally {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
});

test("writeFileDurable puts fsync on the commit path; plain writeFile does not", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "persist-durability-spy-"));
	try {
		// Spy on the FileHandle's sync (fsync) via its prototype.
		const probe = await fs.open(path.join(dir, ".probe"), "w");
		const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
		const realSync = proto.sync;
		let syncs = 0;
		proto.sync = async function patched(this: unknown) {
			syncs++;
			return realSync.call(this);
		};
		await probe.close(); // counts as no sync (we only patched, close != sync)
		syncs = 0;

		try {
			// Durable commit must fsync at least once (the file's bytes).
			await writeFileDurable(path.join(dir, "durable.json"), JSON.stringify({ ok: true }));
			expect(syncs).toBeGreaterThanOrEqual(1);

			// Plain writeFile never reaches the durability barrier.
			syncs = 0;
			await fs.writeFile(path.join(dir, "plain.json"), JSON.stringify({ ok: true }));
			expect(syncs).toBe(0);
		} finally {
			proto.sync = realSync;
		}

		// And the durable write is exact + leaves no `.tmp`.
		expect(await fs.readFile(path.join(dir, "durable.json"), "utf8")).toBe(JSON.stringify({ ok: true }));
		expect((await fs.readdir(dir)).some((e) => e.endsWith(".tmp"))).toBe(false);
	} finally {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
});

test("writeFileDurable leaves no partial target and no stray .tmp on a write error", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "persist-durability-err-"));
	try {
		// A directory where the target file should be → open("w") on the path fails (EISDIR),
		// exercising the throw + best-effort tmp cleanup.
		const target = path.join(dir, "isdir");
		await fs.mkdir(target);
		// The .tmp would be `${target}.tmp`; force the write to throw by making JSON.stringify fine
		// but the rename land on a directory. Simpler: target itself is a dir → rename(tmp, dir-as-file)
		// fails. Assert the helper throws and cleans the tmp.
		await expect(writeFileDurable(target, "x")).rejects.toBeDefined();
		expect(await fs.exists(`${target}.tmp`)).toBe(false);
	} finally {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
});

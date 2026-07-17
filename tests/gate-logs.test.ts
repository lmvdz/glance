/**
 * Lossless gate-log offload (plans/eap-borrows/ concern 03, "validator half"). Small inputs pass
 * through untouched (no file, no cost); oversized diffs get diffstat + whole-hunk packing (never a
 * bisected hunk); oversized logs get head+tail; a write failure degrades to a plain truncate and
 * NEVER throws (a throw here would fail-close a land); the sweep removes only stale files.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { LocalStorageBackend, setStorageBackend, type StorageBackend } from "../src/dal/storage.ts";
import { budgetedExcerpt, setGateLogRoot, sweepGateLogs, writeGateLog } from "../src/gate-logs.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "gate-logs-"));
	setGateLogRoot(dir);
});
afterEach(() => {
	setStorageBackend(new LocalStorageBackend());
	setGateLogRoot(path.join(tmpdir(), "gate-logs-unset")); // avoid a stale root leaking into other suites
	rmSync(dir, { recursive: true, force: true });
});

// ── budgetedExcerpt: small input ────────────────────────────────────────────────────────────────

test("small input passes through untouched with no file written", async () => {
	const backend = new CountingBackend(new LocalStorageBackend());
	setStorageBackend(backend);
	const s = "a short diff\nwith a couple lines\n";
	const result = await budgetedExcerpt(s, 1000, { kind: "diff", agentId: "agent-1" });
	expect(result.text).toBe(s);
	expect(result.path).toBeUndefined();
	expect(backend.writes).toBe(0);
});

test("input exactly at budget also passes through untouched", async () => {
	const s = "x".repeat(50);
	const result = await budgetedExcerpt(s, 50, { kind: "log", agentId: "agent-1" });
	expect(result.text).toBe(s);
	expect(result.path).toBeUndefined();
});

// ── budgetedExcerpt: oversized diff ─────────────────────────────────────────────────────────────

function fileDiff(name: string, hunkLines: number): string {
	const hunk = [`@@ -1,${hunkLines} +1,${hunkLines} @@`, ...Array.from({ length: hunkLines }, (_, i) => `+added line ${i} in ${name}`)].join("\n");
	return [`diff --git a/${name} b/${name}`, "index 000..111 100644", `--- a/${name}`, `+++ b/${name}`, hunk].join("\n");
}

test("oversized diff excerpt: diffstat header + only whole hunks, never a bisected hunk", async () => {
	const small = fileDiff("small.ts", 3); // fits comfortably
	const big = fileDiff("big.ts", 500); // does not fit in the remaining budget at all
	const diff = `${small}\n${big}`;
	const budget = small.length + 200; // room for the diffstat header + the whole small file, not the big one
	const result = await budgetedExcerpt(diff, budget, { kind: "diff", agentId: "agent-2" });
	expect(result.text.startsWith("diffstat: 2 files changed")).toBe(true);
	expect(result.text).toContain(small);
	// The big file's hunk marker never appears half-formed: either the WHOLE hunk (all "+added line"
	// entries) is present, or the file is entirely absent from the excerpt.
	const bigHunkLines = big.split("\n").filter((l) => l.startsWith("+added line"));
	const presentBigLines = bigHunkLines.filter((l) => result.text.includes(l));
	expect(presentBigLines.length === 0 || presentBigLines.length === bigHunkLines.length).toBe(true);
	// Pointer line to the full untruncated content.
	expect(result.text).toMatch(/\[\d+ bytes omitted — full: .+\]$/);
	expect(result.path).toBeDefined();
	// The full original diff is durably readable back from the pointer.
	const full = await new LocalStorageBackend().readText(result.path!);
	expect(full).toBe(diff);
});

test("oversized log excerpt: head + tail, conclusion (tail) survives", async () => {
	const s = `${"HEAD-".repeat(200)}\nCONCLUSION: all tests passed\n`;
	const result = await budgetedExcerpt(s, 120, { kind: "log", agentId: "agent-3" });
	expect(result.text).toContain("CONCLUSION: all tests passed");
	expect(result.text.startsWith("HEAD-")).toBe(true);
	expect(result.path).toBeDefined();
});

test("no agentId ⇒ still persists, under an 'unknown' bucket", async () => {
	const s = "x".repeat(500);
	const result = await budgetedExcerpt(s, 10, { kind: "log" });
	expect(result.path).toBeDefined();
	expect(result.path).toContain(`${path.sep}unknown${path.sep}`);
});

// ── budgetedExcerpt: write failure never throws ─────────────────────────────────────────────────

class FailingBackend implements StorageBackend {
	readonly name = "failing";
	async writeDurable(): Promise<void> {
		throw new Error("disk full");
	}
	writeDurableSync(): void {
		throw new Error("disk full");
	}
	async appendDurable(): Promise<void> {
		throw new Error("disk full");
	}
	async readText(): Promise<string | undefined> {
		return undefined;
	}
	readTextSync(): string | undefined {
		return undefined;
	}
	async readdir(): Promise<string[]> {
		return [];
	}
	async remove(): Promise<void> {}
	async mkdir(): Promise<void> {}
	exists(): boolean {
		return false;
	}
}

class CountingBackend implements StorageBackend {
	readonly name = "counting";
	writes = 0;
	constructor(private inner: StorageBackend) {}
	async writeDurable(file: string, data: string, opts?: { mode?: number }): Promise<void> {
		this.writes++;
		await this.inner.writeDurable(file, data, opts);
	}
	writeDurableSync(file: string, data: string, opts?: { mode?: number }): void {
		this.writes++;
		this.inner.writeDurableSync(file, data, opts);
	}
	async appendDurable(file: string, data: string): Promise<void> {
		await this.inner.appendDurable(file, data);
	}
	async readText(file: string): Promise<string | undefined> {
		return this.inner.readText(file);
	}
	readTextSync(file: string): string | undefined {
		return this.inner.readTextSync(file);
	}
	async readdir(dir: string): Promise<string[]> {
		return this.inner.readdir(dir);
	}
	async remove(target: string): Promise<void> {
		await this.inner.remove(target);
	}
	async mkdir(dir: string): Promise<void> {
		await this.inner.mkdir(dir);
	}
	exists(file: string): boolean {
		return this.inner.exists(file);
	}
}

test("write-failure path degrades to a plain truncate and never throws", async () => {
	setStorageBackend(new FailingBackend());
	const s = "x".repeat(500);
	const result = await budgetedExcerpt(s, 50, { kind: "diff", agentId: "agent-4" });
	expect(result.text).toBe(`${s.slice(0, 50)}…`);
	expect(result.path).toBeUndefined();
	expect(result.text).not.toContain("bytes omitted"); // no pointer — there is no file to point to
});

test("writeGateLog itself rejects (never called directly without a guard) on a failing backend", async () => {
	setStorageBackend(new FailingBackend());
	await expect(writeGateLog("agent-5", "diff", "content")).rejects.toThrow();
});

// ── writeGateLog / budgetedExcerpt: persistence-boundary redaction (noisegate-compaction concern 02) ─

test("offload content containing a secret-shaped value: the on-disk file is redacted, the excerpt text is unaffected", async () => {
	const secret = `sk-${"a".repeat(20)}`;
	const s = `${"line filler ".repeat(20)}\ncredential: ${secret}\n${"more filler ".repeat(20)}`;
	const result = await budgetedExcerpt(s, 40, { kind: "log", agentId: "agent-secret" });
	// The excerpt handed to the judge is built from the UNREDACTED input by design (persistence-
	// boundary-only redaction — see DESIGN.md "Redaction") — it may or may not contain the secret
	// depending on where head/tail land, but it is NOT itself redacted, and the pointer is still there.
	expect(result.text).toMatch(/\[\d+ bytes omitted — full: .+\]$/);
	expect(result.path).toBeDefined();
	// The durably persisted file, however, IS redacted.
	const onDisk = await new LocalStorageBackend().readText(result.path!);
	expect(onDisk).not.toContain(secret);
	expect(onDisk).toContain("[REDACTED]");
});

test("offload content with legit `authorization`-adjacent code: the on-disk file is byte-identical (hardened pattern doesn't fire)", async () => {
	const line = "const authorization = req.headers.authorization;";
	const s = `${line}\n${"filler line for budget padding ".repeat(20)}`;
	const result = await budgetedExcerpt(s, 40, { kind: "log", agentId: "agent-legit" });
	expect(result.path).toBeDefined();
	const onDisk = await new LocalStorageBackend().readText(result.path!);
	expect(onDisk).toBe(s); // redact(s) === s for this content — nothing should change on disk
});

test("writeGateLog persists redacted content but reports the ORIGINAL byte length", async () => {
	const secret = `sk-${"b".repeat(20)}`;
	const content = `before ${secret} after`;
	const result = await writeGateLog("agent-bytes", "log", content);
	expect(result.bytes).toBe(Buffer.byteLength(content, "utf8")); // original length, not the redacted (shorter) length
	const onDisk = await new LocalStorageBackend().readText(result.path);
	expect(onDisk).not.toContain(secret);
	expect(onDisk!.length).toBeLessThan(content.length); // redaction actually shrank what hit disk
});

// ── writeGateLog: unique path per write ─────────────────────────────────────────────────────────

test("writeGateLog gives every write its own unique path, even for the same agent+kind+content", async () => {
	const a = await writeGateLog("agent-6", "diff", "same content");
	const b = await writeGateLog("agent-6", "diff", "same content");
	expect(a.path).not.toBe(b.path);
	const backend = new LocalStorageBackend();
	expect(await backend.readText(a.path)).toBe("same content");
	expect(await backend.readText(b.path)).toBe("same content");
});

// ── sweepGateLogs ────────────────────────────────────────────────────────────────────────────────

test("sweep removes only stale files, keeps fresh ones, prunes now-empty agent dirs", async () => {
	const backend = new LocalStorageBackend();
	const now = Date.now();
	const staleFile = path.join(dir, "gate-logs", "agent-a", `${now - 20 * 24 * 60 * 60 * 1000}-deadbeef-diff.log`);
	const freshFile = path.join(dir, "gate-logs", "agent-a", `${now - 1 * 24 * 60 * 60 * 1000}-cafebabe-diff.log`);
	const staleOnlyDirFile = path.join(dir, "gate-logs", "agent-b", `${now - 30 * 24 * 60 * 60 * 1000}-abad1dea-log.log`);
	await backend.writeDurable(staleFile, "stale");
	await backend.writeDurable(freshFile, "fresh");
	await backend.writeDurable(staleOnlyDirFile, "stale too");

	const removed = await sweepGateLogs(14 * 24 * 60 * 60 * 1000);
	expect(removed).toBe(2);
	expect(backend.exists(staleFile)).toBe(false);
	expect(backend.exists(freshFile)).toBe(true);
	expect(backend.exists(staleOnlyDirFile)).toBe(false);
	// agent-b's dir had only the stale file — it should be pruned entirely.
	expect(await backend.readdir(path.join(dir, "gate-logs", "agent-b"))).toEqual([]);
	// agent-a's dir still holds the fresh file.
	expect(await backend.readdir(path.join(dir, "gate-logs", "agent-a"))).toContain(path.basename(freshFile));
});

test("sweep on an empty/missing root is a no-op", async () => {
	setGateLogRoot(path.join(dir, "never-created"));
	expect(await sweepGateLogs()).toBe(0);
});

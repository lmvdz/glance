/**
 * Concern 02 — ArtifactSnapshotStore: immutability across source mutation/removal, symlink-escape
 * rejection, content hash + revision, and visible copy failures.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactSnapshotStore, resolveWithinSessionRoot } from "../src/voice-call-artifacts.ts";

let dir: string;
let sessionRoot: string;
beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "voice-artifacts-state-"));
	sessionRoot = mkdtempSync(path.join(os.tmpdir(), "voice-artifacts-session-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	rmSync(sessionRoot, { recursive: true, force: true });
});

describe("resolveWithinSessionRoot", () => {
	test("a plain file beneath the root resolves", async () => {
		writeFileSync(path.join(sessionRoot, "a.md"), "hi");
		const result = await resolveWithinSessionRoot(sessionRoot, "a.md");
		expect(result.ok).toBe(true);
	});

	test("a relative escape (../../etc/passwd) is rejected", async () => {
		const result = await resolveWithinSessionRoot(sessionRoot, "../../../../etc/passwd");
		expect(result.ok).toBe(false);
	});

	test("a symlink escaping the root is rejected as symlink-escape", async () => {
		const outside = mkdtempSync(path.join(os.tmpdir(), "voice-artifacts-outside-"));
		const secret = path.join(outside, "secret.md");
		writeFileSync(secret, "top secret");
		const link = path.join(sessionRoot, "innocuous.md");
		symlinkSync(secret, link);
		const result = await resolveWithinSessionRoot(sessionRoot, "innocuous.md");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("symlink-escape");
		rmSync(outside, { recursive: true, force: true });
	});

	test("a non-existent path is reported as enoent, distinct from a symlink escape", async () => {
		const result = await resolveWithinSessionRoot(sessionRoot, "nope.md");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("enoent");
	});

	test("a symlink that stays WITHIN the root resolves normally (not an escape)", async () => {
		const real = path.join(sessionRoot, "real.md");
		writeFileSync(real, "content");
		const link = path.join(sessionRoot, "link.md");
		symlinkSync(real, link);
		const result = await resolveWithinSessionRoot(sessionRoot, "link.md");
		expect(result.ok).toBe(true);
	});
});

describe("ArtifactSnapshotStore.snapshotReady", () => {
	test("copies an immutable snapshot and records content hash + revision 1", async () => {
		writeFileSync(path.join(sessionRoot, "report.md"), "# hello");
		const store = new ArtifactSnapshotStore(dir);
		const record = await store.snapshotReady({ channelId: "room-1", callId: "call-1", sessionRoot, sourcePath: "report.md" });
		expect(record.status).toBe("ready");
		expect(record.contentHash).toBeTruthy();
		expect(record.revision).toBe(1);
		expect(record.snapshotPath).toBeTruthy();
		const copied = await fs.readFile(record.snapshotPath!, "utf8");
		expect(copied).toBe("# hello");
	});

	test("the snapshot survives source mutation", async () => {
		const src = path.join(sessionRoot, "report.md");
		writeFileSync(src, "version 1");
		const store = new ArtifactSnapshotStore(dir);
		const record = await store.snapshotReady({ channelId: "room-1", callId: "call-1", sessionRoot, sourcePath: "report.md" });
		writeFileSync(src, "version 2 — mutated after the snapshot");
		const copied = await fs.readFile(record.snapshotPath!, "utf8");
		expect(copied).toBe("version 1");
	});

	test("the snapshot survives source removal (worktree cleanup)", async () => {
		const src = path.join(sessionRoot, "report.md");
		writeFileSync(src, "durable content");
		const store = new ArtifactSnapshotStore(dir);
		const record = await store.snapshotReady({ channelId: "room-1", callId: "call-1", sessionRoot, sourcePath: "report.md" });
		await fs.rm(src);
		const copied = await fs.readFile(record.snapshotPath!, "utf8");
		expect(copied).toBe("durable content");
	});

	test("a symlink-escaping artifact path is rejected, never copied", async () => {
		const outside = mkdtempSync(path.join(os.tmpdir(), "voice-artifacts-outside2-"));
		writeFileSync(path.join(outside, "secret.md"), "nope");
		symlinkSync(path.join(outside, "secret.md"), path.join(sessionRoot, "link.md"));
		const store = new ArtifactSnapshotStore(dir);
		const record = await store.snapshotReady({ channelId: "room-1", callId: "call-1", sessionRoot, sourcePath: "link.md" });
		expect(record.status).toBe("failed");
		expect(record.error).toContain("symlink-escape");
		rmSync(outside, { recursive: true, force: true });
	});

	test("a genuinely new revision of the same logical path increments revision and hash", async () => {
		const src = path.join(sessionRoot, "report.md");
		writeFileSync(src, "v1");
		const store = new ArtifactSnapshotStore(dir);
		const first = await store.snapshotReady({ channelId: "room-1", callId: "call-1", sessionRoot, sourcePath: "report.md" });
		writeFileSync(src, "v2 — different bytes");
		const second = await store.snapshotReady({ channelId: "room-1", callId: "call-1", sessionRoot, sourcePath: "report.md" });
		expect(second.revision).toBe(2);
		expect(second.contentHash).not.toBe(first.contentHash);
		// The FIRST snapshot's bytes are untouched — immutability across revisions, not just mutation.
		const firstBytes = await fs.readFile(first.snapshotPath!, "utf8");
		expect(firstBytes).toBe("v1");
	});

	test("a byte-identical re-announce does not bump the revision", async () => {
		writeFileSync(path.join(sessionRoot, "report.md"), "stable");
		const store = new ArtifactSnapshotStore(dir);
		const first = await store.snapshotReady({ channelId: "room-1", callId: "call-1", sessionRoot, sourcePath: "report.md" });
		const second = await store.snapshotReady({ channelId: "room-1", callId: "call-1", sessionRoot, sourcePath: "report.md" });
		expect(second.revision).toBe(first.revision);
		expect(second.contentHash).toBe(first.contentHash);
	});

	test("copy failure (a directory, not a file) is a visible failed record, never a thrown error", async () => {
		mkdirSync(path.join(sessionRoot, "adir"));
		const store = new ArtifactSnapshotStore(dir);
		const record = await store.snapshotReady({ channelId: "room-1", callId: "call-1", sessionRoot, sourcePath: "adir" });
		expect(record.status).toBe("failed");
		expect(record.error).toBeTruthy();
	});

	test("registry entries persist and rehydrate from a fresh store instance", async () => {
		writeFileSync(path.join(sessionRoot, "report.md"), "content");
		const store = new ArtifactSnapshotStore(dir);
		await store.snapshotReady({ channelId: "room-1", callId: "call-1", sessionRoot, sourcePath: "report.md" });
		const rehydrated = new ArtifactSnapshotStore(dir);
		const list = rehydrated.list("room-1");
		expect(list.length).toBe(1);
		expect(list[0]!.status).toBe("ready");
	});
});

describe("recordFailed / markPendingIncomplete", () => {
	test("a journal-reported failed artifact is recorded verbatim", () => {
		const store = new ArtifactSnapshotStore(dir);
		const record = store.recordFailed({ channelId: "room-1", callId: "call-1", sessionRoot, sourcePath: "x.md" }, "journal reported artifact status: failed");
		expect(record.status).toBe("failed");
		expect(store.list("room-1")).toHaveLength(1);
	});

	test("an unfinished artifact can be marked incomplete", () => {
		const store = new ArtifactSnapshotStore(dir);
		const record = store.markPendingIncomplete("room-1", "call-1", "x.md", "call ended before readiness confirmed");
		expect(record.status).toBe("incomplete");
	});
});

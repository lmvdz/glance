/**
 * Pluggable storage backend (plans/archive/archil-mt-pilot/ "OrgStorage" payoff, no Archil) — the seam
 * under omp-squad's durable state. Proves (a) LocalStorageBackend round-trips durably, (b) the whole
 * persistence surface (writeFileDurable + appendReceipt + proof) routes through the ACTIVE backend, so
 * a swap redirects it with zero call-site changes, and (c) the Archil stub loud-fails.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ArchilStorageBackend, backendFromEnv, getStorageBackend, LocalStorageBackend, setStorageBackend, type StorageBackend } from "../src/dal/storage.ts";
import { writeFileDurable } from "../src/dal/store.ts";
import { appendReceipt } from "../src/receipts.ts";
import { runProof, proofFor } from "../src/proof.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "storage-")); });
afterEach(() => { setStorageBackend(new LocalStorageBackend()); rmSync(dir, { recursive: true, force: true }); });

test("LocalStorageBackend round-trips write/read/append/readdir/remove/exists", async () => {
	const b = new LocalStorageBackend();
	const f = path.join(dir, "a", "b.json");
	await b.writeDurable(f, '{"x":1}');
	expect(await b.readText(f)).toBe('{"x":1}');
	expect(b.readTextSync(f)).toBe('{"x":1}');
	expect(b.exists(f)).toBe(true);
	expect(await b.readText(path.join(dir, "missing"))).toBeUndefined();
	await b.appendDurable(f, "\nmore");
	expect(await b.readText(f)).toBe('{"x":1}\nmore');
	expect(await b.readdir(path.join(dir, "a"))).toContain("b.json");
	expect(await b.readdir(path.join(dir, "nope"))).toEqual([]); // missing dir → []
	await b.remove(path.join(dir, "a"));
	expect(b.exists(f)).toBe(false);
});

/** An in-memory backend — the whole point is that swapping THIS captures every durable write. */
class MemBackend implements StorageBackend {
	readonly name = "mem";
	files = new Map<string, string>();
	writes = 0;
	appends = 0;
	async writeDurable(file: string, data: string) { this.writes++; this.files.set(file, data); }
	writeDurableSync(file: string, data: string) { this.writes++; this.files.set(file, data); }
	async appendDurable(file: string, data: string) { this.appends++; this.files.set(file, (this.files.get(file) ?? "") + data); }
	async readText(file: string) { return this.files.get(file); }
	readTextSync(file: string) { return this.files.get(file); }
	async readdir() { return []; }
	async remove(target: string) { this.files.delete(target); }
	async mkdir() {}
	exists(file: string) { return this.files.has(file); }
}

test("writeFileDurable routes through the active backend (settings/policy/FileStore ride this)", async () => {
	const mem = new MemBackend();
	setStorageBackend(mem);
	const f = path.join(dir, "state.json");
	await writeFileDurable(f, "hello");
	expect(mem.writes).toBe(1);
	expect(mem.files.get(f)).toBe("hello");
	expect(getStorageBackend()).toBe(mem);
});

test("appendReceipt routes through the active backend", async () => {
	const mem = new MemBackend();
	setStorageBackend(mem);
	await appendReceipt(dir, { agentId: "a1", runId: "r1" } as never);
	expect(mem.appends).toBe(1);
	expect([...mem.files.keys()][0]).toContain(path.join("receipts", "a1.jsonl"));
});

test("proof persistence routes through the active backend (runProof write, proofFor read)", async () => {
	const mem = new MemBackend();
	setStorageBackend(mem);
	// runProof on a non-repo worktree yields a FAILED proof but still PERSISTS it via the backend.
	const proof = await runProof({ repo: dir, worktree: path.join(dir, "wt"), command: "true" });
	expect(mem.writes).toBeGreaterThanOrEqual(1);
	expect(proof.ok).toBe(false); // missing worktree → failed, but recorded
	// proofFor reads back through the SAME backend
	const back = await proofFor(dir, path.join(dir, "wt"));
	expect(back?.commandHash).toBe(proof.commandHash);
});

test("ArchilStorageBackend loud-fails until provisioned; backendFromEnv selects it", async () => {
	const archil = new ArchilStorageBackend();
	expect(archil.name).toBe("archil");
	await expect(archil.writeDurable("/x", "y")).rejects.toThrow(/not provisioned/i);
	expect(() => archil.exists("/x")).toThrow(/not provisioned/i);
	expect(backendFromEnv({ OMP_SQUAD_STORAGE_BACKEND: "archil" } as never).name).toBe("archil");
	expect(backendFromEnv({} as never).name).toBe("local");
});

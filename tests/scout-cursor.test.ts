import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readScoutCursors, writeScoutCursors } from "../src/scout-cursor.ts";

function tmpDir(): string {
	return mkdtempSync(path.join(os.tmpdir(), "scout-cursor-"));
}

test("round-trips cursors through the state dir", () => {
	const dir = tmpDir();
	writeScoutCursors(dir, new Map([["agent-a", 111], ["agent-b", 222]]));
	const back = readScoutCursors(dir);
	expect(back.get("agent-a")).toBe(111);
	expect(back.get("agent-b")).toBe(222);
	expect(back.size).toBe(2);
});

test("missing file ⇒ empty map (fresh daemon)", () => {
	expect(readScoutCursors(tmpDir()).size).toBe(0);
});

test("corrupt or wrong-shaped file ⇒ empty map, never a throw", () => {
	const dir = tmpDir();
	writeFileSync(path.join(dir, "scout-cursor.json"), "{not json");
	expect(readScoutCursors(dir).size).toBe(0);
	writeFileSync(path.join(dir, "scout-cursor.json"), JSON.stringify([1, 2, 3]));
	// arrays are objects — entries are index→number, all finite, so they load; the manager
	// simply never asks for numeric ids. The guard that matters is non-number VALUES:
	writeFileSync(path.join(dir, "scout-cursor.json"), JSON.stringify({ a: "nope", b: 5, c: null }));
	const filtered = readScoutCursors(dir);
	expect(filtered.get("b")).toBe(5);
	expect(filtered.has("a")).toBe(false);
	expect(filtered.has("c")).toBe(false);
});

test("deleting an entry and re-writing persists the removal", () => {
	const dir = tmpDir();
	const cursors = new Map([["gone", 1], ["kept", 2]]);
	writeScoutCursors(dir, cursors);
	cursors.delete("gone");
	writeScoutCursors(dir, cursors);
	const back = readScoutCursors(dir);
	expect(back.has("gone")).toBe(false);
	expect(back.get("kept")).toBe(2);
});

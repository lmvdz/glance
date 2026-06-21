/**
 * Raw omp session discovery — the classifier is pure and deterministic, so it's
 * the part worth pinning. Assert-based, no framework fixtures.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { discoverExternalSessions, isRawOmpSession } from "../src/sessions.ts";

test("isRawOmpSession accepts plain omp sessions", () => {
	assert.equal(isRawOmpSession(["bun", "/home/u/.bun/bin/omp"]), true);
	assert.equal(isRawOmpSession(["bun", "/home/u/.bun/bin/omp", "--model", "opus"]), true);
	// the bare entrypoint name, however it's launched
	assert.equal(isRawOmpSession(["omp"]), true);
	assert.equal(isRawOmpSession(["omp", "--model", "opus"]), true);
});

test("isRawOmpSession rejects squad's omp --mode rpc children", () => {
	assert.equal(isRawOmpSession(["bun", "/x/omp", "--mode", "rpc", "-e", "/x/lease-hook.ts"]), false);
});

test("isRawOmpSession rejects the omp-squad daemon/CLI", () => {
	assert.equal(isRawOmpSession(["bun", "/x/omp-squad", "up", "--no-tui"]), false);
});

test("isRawOmpSession rejects agent hosts", () => {
	assert.equal(isRawOmpSession(["bun", "/x/agent-host-main.ts", "--id", "x"]), false);
});

test("isRawOmpSession rejects the squad daemon launched from source", () => {
	assert.equal(isRawOmpSession(["bun", "src/index.ts", "up"]), false);
});

test("isRawOmpSession rejects argv with no omp entrypoint token", () => {
	assert.equal(isRawOmpSession([]), false);
	assert.equal(isRawOmpSession(["bun", "/x/something.ts"]), false);
	// a token merely containing "omp" is not the entrypoint
	assert.equal(isRawOmpSession(["bun", "/x/compose.ts"]), false);
});

test("discoverExternalSessions resolves to an array and never throws", async () => {
	const sessions = await discoverExternalSessions();
	assert.ok(Array.isArray(sessions));
	for (const s of sessions) {
		assert.equal(typeof s.pid, "number");
		assert.equal(typeof s.repo, "string");
		assert.equal(typeof s.cwd, "string");
		assert.equal(typeof s.startedAt, "number");
		assert.notEqual(s.pid, process.pid); // never reports the current process
	}
});

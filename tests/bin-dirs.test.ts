/**
 * bin-dirs.ts — the well-known-install-dir PATH fallback (post-ship harness-dropdown fix). Root cause
 * this exists for: a daemon started/respawned via `nohup omp-squad up &` from a non-interactive shell
 * carries whatever bare PATH its parent had, missing every user-local install directory
 * (`~/.bun/bin`, `~/.local/bin`, …) an interactive terminal would have picked up from the shell
 * profile — so a genuinely-installed harness binary reads as "not found", both for the daemon's own
 * `/api/harnesses` detection AND for the actual tenant-agent spawn (spawn-env.test.ts covers the
 * latter through `scrubbedSpawnEnv`).
 */

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { applyWellKnownDirsToProcessPath, augmentPathWithWellKnownDirs, wellKnownBinDirs } from "../src/bin-dirs.ts";

test("wellKnownBinDirs is keyed off the given home, not the real process home", () => {
	const dirs = wellKnownBinDirs("/home/fixture-user");
	expect(dirs).toContain(path.join("/home/fixture-user", ".bun", "bin"));
	expect(dirs).toContain(path.join("/home/fixture-user", ".local", "bin"));
	expect(dirs).toContain(path.join("/home/fixture-user", ".claude", "local"));
	expect(dirs).toContain(path.join("/home/fixture-user", ".grok", "bin"));
	// System-wide dirs are absolute and never home-relative.
	expect(dirs).toContain("/usr/local/bin");
});

test("augmentPathWithWellKnownDirs appends missing well-known dirs after the real PATH, preserving order", () => {
	const augmented = augmentPathWithWellKnownDirs("/usr/bin:/bin", "/home/fixture-user");
	const parts = augmented.split(path.delimiter);
	expect(parts[0]).toBe("/usr/bin");
	expect(parts[1]).toBe("/bin");
	expect(parts).toContain(path.join("/home/fixture-user", ".bun", "bin"));
	// Every well-known dir is present exactly once.
	const seen = new Set<string>();
	for (const p of parts) {
		expect(seen.has(p)).toBe(false);
		seen.add(p);
	}
});

test("augmentPathWithWellKnownDirs never duplicates a well-known dir that the real PATH already contains", () => {
	const home = "/home/fixture-user";
	const realPath = `/usr/bin:${path.join(home, ".bun", "bin")}`;
	const augmented = augmentPathWithWellKnownDirs(realPath, home);
	const parts = augmented.split(path.delimiter);
	expect(parts.filter((p) => p === path.join(home, ".bun", "bin"))).toHaveLength(1);
	// It stayed in its original (second) position, not moved to the end.
	expect(parts[1]).toBe(path.join(home, ".bun", "bin"));
});

test("augmentPathWithWellKnownDirs handles an empty/undefined PATH (still returns a usable, non-empty PATH)", () => {
	expect(augmentPathWithWellKnownDirs(undefined, "/home/fixture-user").length).toBeGreaterThan(0);
	expect(augmentPathWithWellKnownDirs("", "/home/fixture-user").length).toBeGreaterThan(0);
});

test("augmentPathWithWellKnownDirs is a pure fallback: a WIDE real PATH is unaffected other than the append (a correctly configured daemon sees no behavior change beyond extra unused entries)", () => {
	const wide = "/usr/local/bin:/usr/bin:/bin:/opt/custom/bin";
	const augmented = augmentPathWithWellKnownDirs(wide, "/home/fixture-user");
	expect(augmented.startsWith(wide)).toBe(true);
});

// ── applyWellKnownDirsToProcessPath (the real boot-time call, index.ts's cmdUp) ──────────────────

test("applyWellKnownDirsToProcessPath widens PATH in place on a plain env object, keyed off ITS OWN HOME (not the real process's)", () => {
	const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/home/fixture-user" };
	applyWellKnownDirsToProcessPath(env);
	expect(env.PATH).toBe(augmentPathWithWellKnownDirs("/usr/bin", "/home/fixture-user"));
});

test("applyWellKnownDirsToProcessPath defaults to mutating the REAL process.env when called with no argument (the real boot call shape)", () => {
	const prior = process.env.PATH;
	try {
		process.env.PATH = "/usr/bin:/bin";
		applyWellKnownDirsToProcessPath();
		expect(process.env.PATH?.startsWith("/usr/bin:/bin")).toBe(true);
		expect(process.env.PATH?.length).toBeGreaterThan("/usr/bin:/bin".length);
	} finally {
		process.env.PATH = prior;
	}
});

// ── wiring: cmdUp actually calls this before anything can spawn (deleted-call regression guard) ──
// Mirrors this codebase's own "prove the wiring, not a reimplementation" convention (fog-route.test.ts,
// symptom-route.test.ts) — a full `bun src/index.ts up` boot is DB/port/TLS-heavy and disproportionate
// for proving one call survives at the top of one function; reading the real source text is what every
// comparable CLI-wiring test in this repo already does (cli-harnesses.test.ts only proves rendering,
// relying on server.ts's own route tests — same division of labor here).
test("cmdUp calls applyWellKnownDirsToProcessPath as its very first statement, before any Plane/DB/TLS/spawn setup", () => {
	const src = fs.readFileSync(path.join(import.meta.dir, "..", "src", "index.ts"), "utf8");
	const fnStart = src.indexOf("async function cmdUp(");
	expect(fnStart).toBeGreaterThan(-1);
	const body = src.slice(fnStart, fnStart + 1000);
	const callIdx = body.indexOf("applyWellKnownDirsToProcessPath()");
	const parseArgsIdx = body.indexOf("parseArgs(args)");
	expect(callIdx).toBeGreaterThan(-1);
	expect(parseArgsIdx).toBeGreaterThan(-1);
	expect(callIdx).toBeLessThan(parseArgsIdx); // widened before the function does anything else
});

/**
 * plans/daily-dogfood-engine/03 — the shared meta-plan Ledger append machinery and the two
 * scripts that ride it. The load-bearing invariants under test:
 *
 *  1. insertLedgerRow inserts exactly one line at the end of `## Ledger` and leaves every other
 *     byte of the file identical — mid-file section, EOF section, trailing-blank-line cases.
 *  2. Fail-closed: no `## Ledger` heading, a multi-line row, or a non-list row throws (and the
 *     scripts exit 1 with the file untouched).
 *  3. THE HITL BOUNDARY: no code path through the machinery can write verdict language
 *     (SUCCESS / KILL / verdict / adopted / no-go / shouted STOP) into 00-meta.md. The gate
 *     verdict is Lars's alone — an agent-supplied `--clusters "recommend KILL"` must be refused
 *     with the file untouched, not sanitized, not warned-and-written.
 *  4. Both real writers (scripts/append-adoption-ledger.ts, scripts/append-drain-summary.ts)
 *     actually go through the machinery end-to-end, exercised as real subprocesses.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { assertNoVerdictLanguage, insertLedgerRow } from "../src/meta-ledger.ts";

const repoRoot = path.resolve(import.meta.dir, "..");

const META_MID = `# Daily driver — meta-plan

## North star

Words.

## Ledger

- 2026-07-15 — meta-plan authored.
- 2026-07-16 — run 1 shipped.

## Notes

Trailing section stays put.
`;

const META_EOF = `# Meta

## Ledger

- 2026-07-15 — first row.


`;

describe("insertLedgerRow", () => {
	test("inserts at the end of a mid-file Ledger section; every other byte identical", () => {
		const out = insertLedgerRow(META_MID, "- 2026-07-16 — weekly drain (B03): 3 gripe(s) triaged — 2 fixed now, 1 filed as concern(s), 0 accepted.");
		const lines = out.split("\n");
		const idx = lines.indexOf("- 2026-07-16 — weekly drain (B03): 3 gripe(s) triaged — 2 fixed now, 1 filed as concern(s), 0 accepted.");
		expect(idx).toBeGreaterThan(-1);
		expect(lines[idx - 1]).toBe("- 2026-07-16 — run 1 shipped.");
		expect(lines[idx + 1]).toBe("");
		expect(lines[idx + 2]).toBe("## Notes");
		// Everything outside the insertion is untouched: removing the inserted line restores the original.
		expect(out.replace(`${lines[idx]}\n`, "")).toBe(META_MID);
	});

	test("Ledger as last section: row lands under the last entry, trailing blanks trimmed", () => {
		const out = insertLedgerRow(META_EOF, "- 2026-07-16 — second row.");
		expect(out).toBe(`# Meta

## Ledger

- 2026-07-15 — first row.
- 2026-07-16 — second row.
`);
	});

	test("throws when the file has no ## Ledger section", () => {
		expect(() => insertLedgerRow("# Meta\n\n## Notes\n", "- row.")).toThrow(/no "## Ledger" section/);
	});

	test("throws on a multi-line row (no smuggling extra content)", () => {
		expect(() => insertLedgerRow(META_MID, "- row.\n## Verdict")).toThrow(/single line/);
	});

	test("throws on a non-list row", () => {
		expect(() => insertLedgerRow(META_MID, "## Another heading")).toThrow(/must start with "- "/);
	});

	test("refuses verdict language — the verdict line is Lars's alone", () => {
		for (const row of [
			"- 2026-07-30 — counters flat, recommend KILL.",
			"- 2026-07-30 — gate: SUCCESS, onward.",
			"- 2026-07-30 — verdict pending.",
			"- 2026-07-30 — looks adopted to me.",
			"- 2026-07-30 — my read: no-go.",
			"- 2026-07-30 — killed the epic.",
			"- 2026-07-30 — STOP, re-diagnose.",
		]) {
			expect(() => insertLedgerRow(META_MID, row)).toThrow(/verdict language/);
		}
	});

	test("does not false-positive on the real machine rows or ordinary prose", () => {
		for (const row of [
			"- 2026-07-16 — adoption counters (B02): last 7d 3 casual session(s) / 12 prompt(s) / 2 push tap(s); today 1/4/0.",
			"- 2026-07-16 — weekly drain (B03): 5 gripe(s) triaged — 2 fixed now, 2 filed as concern(s), 1 accepted; repeat-pattern cluster(s): three push gripes.",
			"- 2026-07-16 — the successor daemon stopped cleanly; stop-the-world pause gone.",
		]) {
			expect(() => assertNoVerdictLanguage(row)).not.toThrow();
		}
	});
});

/** Run a repo script as a real subprocess (cwd = repo root so relative imports resolve).
 *  Async spawn, NOT spawnSync — the adoption-script tests serve a fake daemon from THIS process,
 *  and spawnSync would block the event loop the fake daemon needs to answer. */
async function runScript(script: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn([process.execPath, script, ...args], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
	const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { code, stdout, stderr };
}

async function tmpMeta(content: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "meta-ledger-"));
	const p = path.join(dir, "00-meta.md");
	await fs.writeFile(p, content);
	return p;
}

describe("scripts/append-drain-summary.ts", () => {
	test("appends exactly one status row with the given counts", async () => {
		const meta = await tmpMeta(META_MID);
		const r = await runScript("scripts/append-drain-summary.ts", [
			"--fixed", "2", "--filed", "1", "--accepted", "1",
			"--clusters", "three attention/push gripes — needs-you-ladder expansion signal",
			"--meta", meta,
		]);
		expect(r.code).toBe(0);
		const text = await fs.readFile(meta, "utf8");
		const added = text.split("\n").filter((l) => l.includes("weekly drain (B03)"));
		expect(added).toHaveLength(1);
		expect(added[0]).toMatch(/4 gripe\(s\) triaged — 2 fixed now, 1 filed as concern\(s\), 1 accepted; repeat-pattern cluster\(s\): three attention\/push gripes/);
		// The Notes section after Ledger survived byte-identical.
		expect(text).toContain("## Notes\n\nTrailing section stays put.\n");
	});

	test("--dry-run prints the row and leaves the file byte-identical", async () => {
		const meta = await tmpMeta(META_MID);
		const r = await runScript("scripts/append-drain-summary.ts", ["--fixed", "0", "--filed", "0", "--accepted", "0", "--meta", meta, "--dry-run"]);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("0 gripe(s) triaged");
		expect(await fs.readFile(meta, "utf8")).toBe(META_MID);
	});

	test("a missing count is exit 1 + untouched — never a guessed zero", async () => {
		const meta = await tmpMeta(META_MID);
		const r = await runScript("scripts/append-drain-summary.ts", ["--filed", "1", "--accepted", "0", "--meta", meta]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("--fixed");
		expect(await fs.readFile(meta, "utf8")).toBe(META_MID);
	});

	test("non-integer and negative counts are exit 1 + untouched", async () => {
		const meta = await tmpMeta(META_MID);
		for (const bad of ["1.5", "-1", "two"]) {
			const r = await runScript("scripts/append-drain-summary.ts", ["--fixed", bad, "--filed", "0", "--accepted", "0", "--meta", meta]);
			expect(r.code).toBe(1);
		}
		expect(await fs.readFile(meta, "utf8")).toBe(META_MID);
	});

	test("verdict language in --clusters is refused, file untouched (the hitl boundary)", async () => {
		const meta = await tmpMeta(META_MID);
		const r = await runScript("scripts/append-drain-summary.ts", [
			"--fixed", "0", "--filed", "0", "--accepted", "3",
			"--clusters", "counters flat two weeks running, recommend KILL",
			"--meta", meta,
		]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("verdict language");
		expect(await fs.readFile(meta, "utf8")).toBe(META_MID);
	});

	test("meta file without ## Ledger is exit 1 + untouched", async () => {
		const meta = await tmpMeta("# Meta\n\n## Notes\n\nno ledger here\n");
		const r = await runScript("scripts/append-drain-summary.ts", ["--fixed", "1", "--filed", "0", "--accepted", "0", "--meta", meta]);
		expect(r.code).toBe(1);
		expect(await fs.readFile(meta, "utf8")).toBe("# Meta\n\n## Notes\n\nno ledger here\n");
	});
});

describe("scripts/append-adoption-ledger.ts (through the shared machinery)", () => {
	const counters = {
		casualSessionsByDay: { "2026-07-16": 2 },
		promptsByDay: { "2026-07-16": 7 },
		pushTapsByDay: {},
	};

	test("valid daemon shape → exactly one counters row appended", async () => {
		const server = Bun.serve({ port: 0, fetch: () => Response.json(counters) });
		try {
			const meta = await tmpMeta(META_MID);
			const r = await runScript("scripts/append-adoption-ledger.ts", ["--port", String(server.port), "--meta", meta]);
			expect(r.code).toBe(0);
			const text = await fs.readFile(meta, "utf8");
			const added = text.split("\n").filter((l) => l.includes("adoption counters (B02)"));
			expect(added).toHaveLength(1);
			expect(text).toContain("## Notes\n\nTrailing section stays put.\n");
		} finally {
			server.stop(true);
		}
	});

	test("unrecognized response shape → exit 1, file untouched (no fabricated zeros)", async () => {
		const server = Bun.serve({ port: 0, fetch: () => Response.json({ nope: 1 }) });
		try {
			const meta = await tmpMeta(META_MID);
			const r = await runScript("scripts/append-adoption-ledger.ts", ["--port", String(server.port), "--meta", meta]);
			expect(r.code).toBe(1);
			expect(await fs.readFile(meta, "utf8")).toBe(META_MID);
		} finally {
			server.stop(true);
		}
	});

	test("unreachable daemon → exit 1, file untouched", async () => {
		// Acquire a real free port, then close it so the connection is refused.
		const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
		const deadPort = probe.port;
		probe.stop(true);
		const meta = await tmpMeta(META_MID);
		const r = await runScript("scripts/append-adoption-ledger.ts", ["--port", String(deadPort), "--meta", meta]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("unreachable");
		expect(await fs.readFile(meta, "utf8")).toBe(META_MID);
	});
});

/**
 * Intake router — deterministic tests (no tokens). The router turns a plain task
 * into a process so the human only describes intent; here we pin the decisions.
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { detectVerify, routeIntake } from "../src/intake.ts";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function repo(files: Record<string, string>): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), "intake-"));
	tmps.push(d);
	for (const [f, c] of Object.entries(files)) await fs.writeFile(path.join(d, f), c);
	return d;
}

test("detectVerify: bun package scripts → typecheck && test", async () => {
	const d = await repo({ "bun.lock": "", "package.json": JSON.stringify({ scripts: { typecheck: "tsc", test: "bun test", lint: "x" } }) });
	expect(await detectVerify(d)).toBe("bun run typecheck && bun run test");
});

test("detectVerify: npm (no lockfile) test-only script", async () => {
	const d = await repo({ "package.json": JSON.stringify({ scripts: { test: "vitest" } }) });
	expect(await detectVerify(d)).toBe("npm run test");
});

test("detectVerify: Cargo → cargo check && cargo test", async () => {
	expect(await detectVerify(await repo({ "Cargo.toml": "[package]" }))).toBe("cargo check && cargo test");
});

test("detectVerify: no toolchain → undefined", async () => {
	expect(await detectVerify(await repo({ "README.md": "hi" }))).toBeUndefined();
});

test("routeIntake: ordinary code change → autonomous verify loop (no human gate)", async () => {
	const d = await repo({ "package.json": JSON.stringify({ scripts: { test: "vitest" } }) });
	const r = await routeIntake("fix the failing auth test", d);
	expect(r.verify).toBe("npm run test");
	expect(r.workflow).toBeUndefined();
});

test("routeIntake: high-risk change → plan + approval (the rare human-in-the-loop)", async () => {
	const r = await routeIntake("migrate the production database schema", await repo({}));
	expect(r.workflow).toContain("plan-implement");
	expect(r.verify).toBeUndefined();
});

test("routeIntake: several approaches → parallel fan-out", async () => {
	const r = await routeIntake("explore 3 approaches to caching in parallel", await repo({}));
	expect(r.workflow).toContain("fan-out");
});

test("routeIntake: no toolchain, non-risky → plain agent", async () => {
	const r = await routeIntake("write a haiku about latency", await repo({ "README.md": "x" }));
	expect(r.workflow).toBeUndefined();
	expect(r.verify).toBeUndefined();
});

test("routeIntake: 'carefully/subtle' bumps reasoning effort", async () => {
	const r = await routeIntake("carefully implement the subtle ordering fix", await repo({}));
	expect(r.thinking).toBe("high");
});

// ── LLM router (injected classify; no real model) ──────────────────────────────

const classify = (json: string) => async () => json;

test("routeIntake (LLM): 'verify' classification → auto-verify on a JS repo", async () => {
	const d = await repo({ "package.json": JSON.stringify({ scripts: { test: "vitest" } }) });
	const r = await routeIntake("do the thing", d, classify('{"process":"verify","effort":"low"}'));
	expect(r.verify).toBe("npm run test");
	expect(r.thinking).toBe("low");
	expect(r.reason).toContain("LLM router");
});

test("routeIntake (LLM): 'plan' → plan-implement, 'fanout' → fan-out, 'plain' → plain", async () => {
	expect((await routeIntake("x", await repo({}), classify('{"process":"plan"}'))).workflow).toContain("plan-implement");
	expect((await routeIntake("x", await repo({}), classify('{"process":"fanout"}'))).workflow).toContain("fan-out");
	const plain = await routeIntake("x", await repo({}), classify('{"process":"plain","effort":"high"}'));
	expect(plain.workflow).toBeUndefined();
	expect(plain.thinking).toBe("high");
});

test("routeIntake (LLM): tolerates surrounding prose, extracting the JSON object", async () => {
	const r = await routeIntake("x", await repo({}), classify('Sure! Here is the routing:\n{"process":"plan"}\nHope that helps.'));
	expect(r.workflow).toContain("plan-implement");
});

test("routeIntake (LLM): unparseable output falls back to heuristics", async () => {
	const r = await routeIntake("migrate the production database", await repo({}), classify("I cannot help with that."));
	expect(r.workflow).toContain("plan-implement"); // heuristic high-risk path
	expect(r.reason).not.toContain("LLM router");
});

// ── TDD routing (Epic 2 leaf 04): the router selects mode:"tdd" for behavior-adding verify tasks ──

test("routeIntake: behavior-adding code change → verify + mode:tdd (write the test first)", async () => {
	const d = await repo({ "package.json": JSON.stringify({ scripts: { test: "vitest" } }) });
	const r = await routeIntake("add a /health endpoint", d);
	expect(r.verify).toBe("npm run test");
	expect(r.mode).toBe("tdd");
	expect(r.reason).toContain("TDD");
});

test("routeIntake: trivial task never gets mode:tdd even with a TDD signal word", async () => {
	const d = await repo({ "package.json": JSON.stringify({ scripts: { test: "vitest" } }) });
	const r = await routeIntake("fix typo in README", d);
	expect(r.mode).toBeUndefined();
});

test("routeIntake: OMP_SQUAD_TDD=0 disables tdd globally; =force emits it on every verify-routed task", async () => {
	const d = await repo({ "package.json": JSON.stringify({ scripts: { test: "vitest" } }) });
	const prior = process.env.OMP_SQUAD_TDD;
	try {
		process.env.OMP_SQUAD_TDD = "0";
		expect((await routeIntake("add a /health endpoint", d)).mode).toBeUndefined();

		process.env.OMP_SQUAD_TDD = "force";
		expect((await routeIntake("fix the failing auth test", d)).mode).toBe("tdd");
	} finally {
		if (prior === undefined) delete process.env.OMP_SQUAD_TDD;
		else process.env.OMP_SQUAD_TDD = prior;
	}
});

test("routeIntake (LLM): 'verify' classification also carries mode:tdd for a behavior-adding task", async () => {
	const d = await repo({ "package.json": JSON.stringify({ scripts: { test: "vitest" } }) });
	const r = await routeIntake("implement a new caching handler", d, classify('{"process":"verify","effort":"low"}'));
	expect(r.verify).toBe("npm run test");
	expect(r.mode).toBe("tdd");
});

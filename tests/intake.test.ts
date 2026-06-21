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

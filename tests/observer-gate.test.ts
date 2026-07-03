/**
 * Observer regression gate (runMainGate) honors detectVerify(repo) instead of a hardcoded
 * "bun run check && bun test" (OMPSQ-136). Three behaviors pinned:
 *   - no detectable verify command ⇒ ok:true (don't file a false `regression:` against a non-bun repo)
 *   - the detected command passing ⇒ ok:true
 *   - the detected command failing ⇒ ok:false (it actually ran the repo's own gate)
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SquadManager } from "../src/squad-manager.ts";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

/** Exposes the protected runMainGate seam for direct exercise. */
class GateManager extends SquadManager {
	gate(repo: string): Promise<{ ok: boolean; firstFailure?: string; skipped?: boolean }> {
		return this.runMainGate(repo);
	}
}

async function repo(files: Record<string, string>): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), "obsgate-"));
	tmps.push(d);
	for (const [f, c] of Object.entries(files)) await fs.writeFile(path.join(d, f), c);
	return d;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function git(args: string[], cwd: string): Promise<void> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
	const err = await new Response(proc.stderr).text();
	const code = await proc.exited;
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err}`);
}

async function gitRepo(files: Record<string, string>): Promise<string> {
	const r = await repo(files);
	await git(["init"], r);
	await git(["add", "."], r);
	await git(["-c", "user.email=agent@example.invalid", "-c", "user.name=Agent", "commit", "-m", "init"], r);
	return r;
}

async function readCount(file: string): Promise<number> {
	try {
		return (await fs.readFile(file, "utf8")).length;
	} catch (e) {
		if ((e as { code?: string }).code === "ENOENT") return 0;
		throw e;
	}
}

async function manager(): Promise<GateManager> {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "obsgate-state-"));
	tmps.push(stateDir);
	return new GateManager({ stateDir });
}

test("no detectable verify command ⇒ ok:true (no false regression on a non-bun repo)", async () => {
	const mgr = await manager();
	const r = await repo({ "README.md": "hi" });
	expect(await mgr.gate(r)).toEqual({ ok: true });
});

test("detected command passing ⇒ ok:true", async () => {
	const mgr = await manager();
	const r = await repo({ "bun.lock": "", "package.json": JSON.stringify({ scripts: { check: "true", test: "true" } }) });
	expect(await mgr.gate(r)).toEqual({ ok: true });
});

test("detected command failing ⇒ ok:false (it ran the repo's own gate)", async () => {
	const mgr = await manager();
	const r = await repo({ "bun.lock": "", "package.json": JSON.stringify({ scripts: { check: "false", test: "true" } }) });
	const g = await mgr.gate(r);
	expect(g.ok).toBe(false);
});
test("unchanged working-tree fingerprint skips cached green gate until every tenth tick", async () => {
	const mgr = await manager();
	const countFile = path.join(os.tmpdir(), `obsgate-count-${Date.now()}-${Math.random()}`);
	tmps.push(countFile);
	const r = await gitRepo({
		"bun.lock": "",
		"package.json": JSON.stringify({ scripts: { check: `printf x >> ${shellQuote(countFile)}` } }),
	});
	expect(await mgr.gate(r)).toEqual({ ok: true });
	expect(await mgr.gate(r)).toEqual({ ok: true, skipped: true });
	expect(await readCount(countFile)).toBe(1);

	for (let i = 0; i < 7; i++) expect((await mgr.gate(r)).skipped).toBe(true);
	expect(await mgr.gate(r)).toEqual({ ok: true });
	expect(await readCount(countFile)).toBe(2);
});

test("tracked working-tree edit invalidates the cached gate result", async () => {
	const mgr = await manager();
	const countFile = path.join(os.tmpdir(), `obsgate-count-${Date.now()}-${Math.random()}`);
	tmps.push(countFile);
	const r = await gitRepo({
		"bun.lock": "",
		"tracked.txt": "one\n",
		"package.json": JSON.stringify({ scripts: { check: `printf x >> ${shellQuote(countFile)}` } }),
	});
	expect(await mgr.gate(r)).toEqual({ ok: true });
	await fs.writeFile(path.join(r, "tracked.txt"), "two\n");
	expect(await mgr.gate(r)).toEqual({ ok: true });
	expect(await readCount(countFile)).toBe(2);
});

test("dirty uncommitted failing change still goes red instead of reusing HEAD-era cache", async () => {
	const mgr = await manager();
	const r = await gitRepo({
		"bun.lock": "",
		"verify.sh": "test ! -f FAIL\n",
		"package.json": JSON.stringify({ scripts: { check: "sh verify.sh" } }),
	});
	expect(await mgr.gate(r)).toEqual({ ok: true });
	await fs.writeFile(path.join(r, "FAIL"), "dirty\n");
	const g = await mgr.gate(r);
	expect(g.skipped).toBeUndefined();
	expect(g.ok).toBe(false);
});

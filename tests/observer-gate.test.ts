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
	gate(repo: string): Promise<{ ok: boolean; firstFailure?: string }> {
		return this.runMainGate(repo);
	}
}

async function repo(files: Record<string, string>): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), "obsgate-"));
	tmps.push(d);
	for (const [f, c] of Object.entries(files)) await fs.writeFile(path.join(d, f), c);
	return d;
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

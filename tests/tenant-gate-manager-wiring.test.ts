import { afterAll, expect, test, describe } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SquadManager } from "../src/squad-manager.ts";
import { openTenantGateRegistry } from "../src/tenant-gate-registry.ts";
import type { TenantGateManifest } from "../src/tenant-gates.ts";

/**
 * The MANAGER-side wiring of glance#393: the per-org registry actually reaching the three places R2
 * #384 named as daemon-global or fail-open — the Observer's main gate, the reviewer ledger path, and
 * the gate cache key. Each test here is the "was the value USED?" half; the contract's own semantics
 * live in tests/tenant-gate-manifest.test.ts.
 */

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

class WiringManager extends SquadManager {
	gate(repo: string): Promise<{ ok: boolean; firstFailure?: string; skipped?: boolean; unrunnable?: boolean }> {
		return this.runMainGate(repo);
	}
	ledgerFor(repo: string): string | undefined {
		return this.reviewerLedgerPathFor(repo);
	}
	contractFor(repo: string): { manifest?: TenantGateManifest; error?: string } {
		return this.tenantManifest(repo);
	}
}

async function tmp(prefix: string): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(d);
	return d;
}

async function managerWith(record: unknown, repo: string): Promise<WiringManager> {
	const stateDir = await tmp("tenant-wire-state-");
	if (record !== undefined) await fs.writeFile(path.join(stateDir, "tenant-gates.json"), JSON.stringify({ [repo]: record }));
	return new WiringManager({ stateDir });
}

function gateManifest(repo: string, extra: Partial<TenantGateManifest> = {}): unknown {
	return { version: 1, repo, gates: [{ name: "suite", command: "true", timeoutMs: 5000, expects: { exit: 0, parser: "raw" } }], ...extra };
}

describe("the registry is per-org and read through", () => {
	test("two managers on different state dirs disagree about the same repo — the end of daemon-global policy", async () => {
		const repo = await tmp("tenant-wire-repo-");
		const registered = await managerWith(gateManifest(repo), repo);
		const unregistered = await managerWith(undefined, repo);
		expect(registered.contractFor(repo).manifest).toBeDefined();
		expect(unregistered.contractFor(repo).manifest).toBeUndefined();
	});

	test("a registration written AFTER construction is seen — a stale cache here would be a fail-open", async () => {
		const repo = await tmp("tenant-wire-repo-");
		const stateDir = await tmp("tenant-wire-state-");
		const m = new WiringManager({ stateDir });
		expect(m.contractFor(repo).manifest).toBeUndefined();
		openTenantGateRegistry(stateDir).register(JSON.parse(JSON.stringify(gateManifest(repo))) as TenantGateManifest);
		expect(m.contractFor(repo).manifest).toBeDefined();
	});
});

describe("the reviewer ledger stops being pinned to glance's own tree", () => {
	test("a registered manifest's reviewerLedgerPath is what the land receipt would cite", async () => {
		const repo = await tmp("tenant-wire-repo-");
		const m = await managerWith(gateManifest(repo, { reviewerLedgerPath: "/tenant/two/reviewer-ledger.jsonl" } as Partial<TenantGateManifest>), repo);
		expect(m.ledgerFor(repo)).toBe("/tenant/two/reviewer-ledger.jsonl");
	});

	test("an un-registered repo still resolves to the default (undefined) — the fleet is unchanged", async () => {
		const repo = await tmp("tenant-wire-repo-");
		const m = await managerWith(undefined, repo);
		expect(m.ledgerFor(repo)).toBeUndefined();
	});

	test("the test-only DI override still beats the manifest — a contract must not shadow the fixture seam", async () => {
		const repo = await tmp("tenant-wire-repo-");
		const stateDir = await tmp("tenant-wire-state-");
		await fs.writeFile(path.join(stateDir, "tenant-gates.json"), JSON.stringify({ [repo]: gateManifest(repo, { reviewerLedgerPath: "/from/manifest" } as Partial<TenantGateManifest>) }));
		class Overridden extends WiringManager {
			protected reviewerLedgerPathOverride(): string | undefined {
				return "/from/override";
			}
		}
		expect(new Overridden({ stateDir }).ledgerFor(repo)).toBe("/from/override");
	});
});

describe("the Observer's main gate under a contract", () => {
	test("a registered repo whose contract passes reports a real green", async () => {
		const repo = await tmp("tenant-wire-repo-");
		await Bun.spawn(["git", "init", "-q"], { cwd: repo, stdout: "ignore", stderr: "ignore" }).exited;
		// The env is NOT touched here: tests/setup.ts already pins OMP_SQUAD_GATE_SANDBOX=host as the
		// suite's hermetic baseline, and a local set/delete pair would clobber that global for every file
		// that runs after this one (bun runs the suite in one process — the LANE_POLICY leak shape).
		// `sandboxStrict: false` in the contract is what makes this row independent of docker.
		const m = await managerWith(gateManifest(repo, { policy: { sandboxStrict: false } } as Partial<TenantGateManifest>), repo);
		const r = await m.gate(repo);
		expect(r.ok).toBe(true);
		expect(r.skipped).toBeUndefined();
	}, 60_000);

	test("a registered repo with an UNREADABLE record refuses — it never falls back to detection", async () => {
		const repo = await tmp("tenant-wire-repo-");
		await Bun.spawn(["git", "init", "-q"], { cwd: repo, stdout: "ignore", stderr: "ignore" }).exited;
		// A repo with NO package.json: under detection this is the `{ ok: true, skipped: true }` fail-open
		// (R2 #384 #5) — green forever to every `.ok`-only reader. Registered-but-broken must not be that.
		const m = await managerWith({ version: 1, repo, gates: [] }, repo);
		const r = await m.gate(repo);
		expect(r.ok).toBe(false);
		expect(r.unrunnable).toBe(true);
		expect(r.firstFailure).toContain("command-unregistered");
	}, 60_000);

	test("the un-registered no-toolchain repo keeps its historical skipped-green — the fleet is not broken", async () => {
		const repo = await tmp("tenant-wire-repo-");
		await Bun.spawn(["git", "init", "-q"], { cwd: repo, stdout: "ignore", stderr: "ignore" }).exited;
		const m = await managerWith(undefined, repo);
		const r = await m.gate(repo);
		expect(r).toMatchObject({ ok: true, skipped: true });
	}, 60_000);

	test("C-2: a corrupt registry FILE makes the observer gate refuse for EVERY repo, not fall to skipped-green", async () => {
		const repo = await tmp("tenant-wire-repo-");
		await Bun.spawn(["git", "init", "-q"], { cwd: repo, stdout: "ignore", stderr: "ignore" }).exited;
		const stateDir = await tmp("tenant-wire-state-");
		await fs.writeFile(path.join(stateDir, "tenant-gates.json"), "{ corrupt");
		const m = new WiringManager({ stateDir });
		// `contractFor` surfaces the file-level error; the observer gate refuses (unrunnable), never the
		// `{ ok:true, skipped:true }` fall-through a whole-file catch used to produce.
		expect(m.contractFor(repo).error).toBeDefined();
		const r = await m.gate(repo);
		expect(r.ok).toBe(false);
		expect(r.unrunnable).toBe(true);
	}, 60_000);
});

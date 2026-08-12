import { afterAll, beforeAll, expect, test, describe } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { openTenantGateRegistry, readTenantManifestInput, TENANT_MANIFEST_INPUT_PATH } from "../src/tenant-gate-registry.ts";
import { manifestCommand, manifestHash, manifestStrict } from "../src/tenant-gates.ts";
import { runProof, setProofRoot } from "../src/proof.ts";
import { resolveStateDir } from "../src/state-dir.ts";

/**
 * GLANCE AS TENANT ZERO (glance#393, acceptance test).
 *
 * Two halves, and both are load-bearing:
 *   1. glance's own gates, expressed in the same contract a foreign tenant would use, imported from
 *      `.glance/gates.json` and REGISTERED into a per-org record. The rail must not special-case its
 *      home repo once the contract exists.
 *   2. A real end-to-end run through the manifest path — a genuine `bun test` executed against a
 *      genuine temp repo, its count parsed by the declared parser and landing in the proof receipt.
 *      Stubbing that would prove the plumbing and not the parsing, and the parsing is the fail-open.
 */

const REPO_ROOT = path.join(import.meta.dir, "..");

describe("glance's own gate contract", () => {
	test(`${TENANT_MANIFEST_INPUT_PATH} decodes as a TenantGateManifest`, async () => {
		const input = await readTenantManifestInput(REPO_ROOT);
		expect(input).toBeDefined();
		if (!input || !("manifest" in input)) throw new Error(`glance's own manifest must decode: ${input && "error" in input ? input.error : "absent"}`);
		const m = input.manifest;
		// The three gates the destination names: check, root suite with an expected count, webapp suite.
		expect(m.gates.map((g) => g.name)).toEqual(["check", "root-suite", "webapp-suite"]);
		expect(manifestCommand(m)).toContain("bun run check");
		// The counts are the point. A `check` gate legitimately asserts nothing but its exit code; the
		// two suites must both carry a floor, or tenant zero would be exempt from the rule it enforces.
		expect(m.gates[0]!.expects.parser).toBe("raw");
		expect(m.gates[1]!.expects.minTests).toBeGreaterThan(0);
		expect(m.gates[2]!.expects.minTests).toBeGreaterThan(0);
		// Tenant zero runs its own gates hermetically — it does not opt out of the policy it ships.
		expect(manifestStrict(m)).toBe(true);
		// The repo field is forced to the caller's root, so an imported file cannot claim another checkout.
		expect(m.repo).toBe(REPO_ROOT);
	});

	test("the declared floors are below the suites' real sizes (a contract nobody could pass is theatre)", async () => {
		const input = await readTenantManifestInput(REPO_ROOT);
		if (!input || !("manifest" in input)) throw new Error("unreachable");
		// Measured 2026-08-12: root 5336 tests / webapp 2002. The floors sit under those with room for
		// legitimate churn, and far above zero — which is the number the old bun-only guard could not
		// distinguish from a pass.
		expect(input.manifest.gates[1]!.expects.minTests).toBeLessThan(5336);
		expect(input.manifest.gates[2]!.expects.minTests).toBeLessThan(2002);
	});

	test("registering it is a per-org write, and the registry reads back the same contract", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tenant-zero-"));
		try {
			const input = await readTenantManifestInput(REPO_ROOT);
			if (!input || !("manifest" in input)) throw new Error("unreachable");
			const registry = openTenantGateRegistry(dir);
			expect(registry.get(REPO_ROOT)).toBeUndefined(); // unregistered until a human registers it
			expect(registry.register(input.manifest)).toBe("registered");
			const found = registry.get(REPO_ROOT);
			if (!found || !("manifest" in found)) throw new Error("must read back");
			expect(manifestHash(found.manifest)).toBe(manifestHash(input.manifest));
			expect(registry.repos()).toEqual([REPO_ROOT]);
			expect(registry.unregister(REPO_ROOT)).toBe("removed");
			expect(registry.get(REPO_ROOT)).toBeUndefined();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("a record that exists but does not decode is an ERROR, never a silent 'unregistered'", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tenant-bad-"));
		try {
			await fs.writeFile(path.join(dir, "tenant-gates.json"), JSON.stringify({ "/repo": { version: 1, repo: "/repo", gates: [] } }));
			const found = openTenantGateRegistry(dir).get("/repo");
			expect(found && "error" in found).toBe(true);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("a record filed under one repo but naming another is refused, not honoured", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tenant-mis-"));
		try {
			const gate = { name: "t", command: "bun test", timeoutMs: 1000, expects: { exit: 0, parser: "bun-test" } };
			await fs.writeFile(path.join(dir, "tenant-gates.json"), JSON.stringify({ "/repo-a": { version: 1, repo: "/repo-b", gates: [gate] } }));
			const found = openTenantGateRegistry(dir).get("/repo-a");
			expect(found && "error" in found && found.error).toContain("another repo's contract");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	// C-2 (gauntlet round 1): whole-FILE corruption must fail closed for EVERY repo, not silently
	// unregister the org to detection/skipped-green.
	test("C-2: a corrupt registry FILE is a registry-unreadable error for any repo, and readError() fires", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tenant-corrupt-"));
		try {
			await fs.writeFile(path.join(dir, "tenant-gates.json"), "{ this is not json");
			const registry = openTenantGateRegistry(dir);
			expect(registry.readError()).toBeDefined();
			// A repo that was never even mentioned in the (corrupt) file still refuses — the registry
			// cannot prove it is un-gated, so it is not silently "unregistered".
			const found = registry.get("/any/repo");
			expect(found && "error" in found && found.error).toContain("unreadable");
			expect(registry.repos()).toEqual([]); // cannot enumerate a corrupt file
			// register/unregister refuse to clobber a corrupt file blind — a human must see it.
			expect(registry.register({ version: 1, repo: "/x", gates: [{ name: "t", command: "true", timeoutMs: 1, expects: { exit: 0, parser: "raw" } }] })).toBe("error");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("C-2: an ABSENT or empty registry file is honest 'unregistered', not an error", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tenant-empty-"));
		try {
			const registry = openTenantGateRegistry(dir);
			expect(registry.readError()).toBeUndefined(); // absent ⇒ nothing registered, not corrupt
			expect(registry.get("/any/repo")).toBeUndefined();
			await fs.writeFile(path.join(dir, "tenant-gates.json"), "   \n");
			expect(openTenantGateRegistry(dir).readError()).toBeUndefined(); // empty/whitespace ⇒ same
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("a real land runs through the manifest path, with counts in the receipt", () => {
	let repo = "";
	let proofDir = "";

	beforeAll(async () => {
		// The gate really executes here, so it runs on the host: the point of this test is the parser and
		// the receipt, not the sandbox (which tests/gate-runner.test.ts owns). The env is deliberately
		// NOT touched — tests/setup.ts already pins OMP_SQUAD_GATE_SANDBOX=host for the whole suite, and
		// a local set/restore pair would clobber that global for every file after this one. The contract's
		// `policy.sandboxStrict: false` is what makes the row independent of docker's presence.
		repo = await fs.mkdtemp(path.join(os.tmpdir(), "tenant-live-"));
		proofDir = await fs.mkdtemp(path.join(os.tmpdir(), "tenant-proof-"));
		setProofRoot(proofDir);
		await fs.writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "fixture", private: true }));
		await fs.writeFile(
			path.join(repo, "fixture.test.ts"),
			'import { expect, test } from "bun:test";\ntest("a", () => expect(1).toBe(1));\ntest("b", () => expect(2).toBe(2));\ntest("c", () => expect(3).toBe(3));\n',
		);
		for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture"]]) {
			const p = Bun.spawn(["git", ...args], { cwd: repo, stdout: "ignore", stderr: "ignore" });
			await p.exited;
		}
	});

	afterAll(async () => {
		// `proofRoot` is proof.ts module state shared by every test file in this process — restore the
		// resolved default rather than leaving it pointed at a temp dir that is about to be deleted.
		setProofRoot(resolveStateDir());
		await fs.rm(repo, { recursive: true, force: true });
		await fs.rm(proofDir, { recursive: true, force: true });
	});

	function fixtureContract(minTests: number) {
		return {
			version: 1 as const,
			repo,
			policy: { sandboxStrict: false },
			gates: [{ name: "suite", command: "bun test", timeoutMs: 120_000, expects: { exit: 0, parser: "bun-test" as const, minTests } }],
		};
	}

	test("green: the proof carries the contract hash and the tests it PROVED ran", async () => {
		const manifest = fixtureContract(3);
		const proof = await runProof({ repo, worktree: repo, command: manifestCommand(manifest), manifest });
		expect(proof.ok).toBe(true);
		expect(proof.manifestHash).toBe(manifestHash(manifest));
		expect(proof.refusalCode).toBeUndefined();
		expect(proof.stages?.[0]?.name).toBe("suite");
		// The number, in the receipt — not merely used to reach a verdict and then discarded.
		expect(proof.stages?.[0]?.tests).toBe(3);
	}, 120_000);

	test("MUTATION: raise the floor above the real count and the SAME green run refuses", async () => {
		const manifest = fixtureContract(99);
		const proof = await runProof({ repo, worktree: repo, command: manifestCommand(manifest), manifest });
		expect(proof.ok).toBe(false);
		expect(proof.refusalCode).toBe("count-violated");
		expect(proof.detail).toContain("REFUSED");
		// Still 3 — the run is identical; only the contract changed. That is what proves the count was
		// USED and not merely recorded.
		expect(proof.stages?.[0]?.tests).toBe(3);
		expect(proof.manifestHash).not.toBe(manifestHash(fixtureContract(3)));
	}, 120_000);

	test("MUTATION: strip the manifest and the same repo falls back to the detection path", async () => {
		// The un-registered fleet's behavior, unchanged: no contract hash, no refusal code, no counts.
		const proof = await runProof({ repo, worktree: repo, command: "bun test", stages: [{ name: "verify", command: "bun test" }] });
		expect(proof.manifestHash).toBeUndefined();
		expect(proof.refusalCode).toBeUndefined();
		expect(proof.stages?.[0]?.tests).toBeUndefined();
		expect(proof.ok).toBe(true);
	}, 120_000);
});

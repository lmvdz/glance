import { expect, test, describe } from "bun:test";
import { missingCommandRefusal, runManifestGates, type GateCommandRunner } from "../src/tenant-gate-run.ts";
import { composeFileFor, startGateServices } from "../src/tenant-services.ts";
import { decodeTenantGateManifest, type TenantGate, type TenantGateManifest } from "../src/tenant-gates.ts";

/**
 * G2 #386's rigged-red matrix, one row per test, each asserting a DISTINCT refusal code and reason.
 *
 * "It refused" is not a receipt. An operator staring at a blocked land needs to know whether to start
 * docker, fix a test, or fix the registration — so the assertions here are on the code AND on the
 * reason text, because a shared string across two causes would be the same fail-open one layer up.
 *
 * Nothing here touches docker: the exec, the compose spawn, and the docker probe are all injected,
 * which is why every row can be proven by MUTATION (kill docker, run zero tests, strip the runner)
 * rather than by structure.
 */

function contract(gates: TenantGate[], policy?: TenantGateManifest["policy"]): TenantGateManifest {
	const r = decodeTenantGateManifest({ version: 1, repo: "/repo", gates, policy });
	if (!("manifest" in r)) throw new Error(`fixture must decode: ${r.error}`);
	return r.manifest;
}

/** An exec that answers every command with the same canned run. */
function fakeExec(run: { code: number; stdout?: string; stderr?: string; degraded?: boolean }, seen?: string[]): GateCommandRunner {
	return async (command) => {
		seen?.push(command);
		return { code: run.code, stdout: run.stdout ?? "", stderr: run.stderr ?? "", sandboxed: true, degraded: run.degraded };
	};
}

const noDocker = (): boolean => false;
const hasDocker = (): boolean => true;

const testGate: TenantGate = { name: "unit", command: "pnpm test", timeoutMs: 1000, expects: { exit: 0, parser: "vitest", minTests: 12 } };

describe("R1 — the gate ran and failed", () => {
	test("non-zero exit refuses as gate-red, and names the command", async () => {
		const out = await runManifestGates({ manifest: contract([testGate]), cwd: "/wt", exec: fakeExec({ code: 1, stdout: " Tests  1 failed | 11 passed (12)\n" }), dockerProbe: hasDocker });
		expect(out.ok).toBe(false);
		expect(out.refusal?.code).toBe("gate-red");
		expect(out.refusal?.reason).toContain("pnpm test");
	});
});

describe("R2 — count violated (the Vitest --passWithNoTests killer)", () => {
	test("exit 0 having run ZERO tests under a minTests contract refuses as zero-tests", async () => {
		const out = await runManifestGates({
			manifest: contract([testGate]),
			cwd: "/wt",
			exec: fakeExec({ code: 0, stdout: "\n No test files found, exiting with code 0\n" }),
			dockerProbe: hasDocker,
		});
		expect(out.ok).toBe(false);
		expect(out.refusal?.code).toBe("zero-tests");
		expect(out.refusal?.reason).toContain("ZERO tests");
		// The count that WAS proven rides into the receipt, not just the verdict.
		expect(out.results[0]?.tests).toBe(0);
	});

	test("exit 0 with a SHORT run refuses as count-violated — a different reason from zero", async () => {
		const out = await runManifestGates({ manifest: contract([testGate]), cwd: "/wt", exec: fakeExec({ code: 0, stdout: " Tests  4 passed (4)\n" }), dockerProbe: hasDocker });
		expect(out.refusal?.code).toBe("count-violated");
		expect(out.refusal?.reason).toContain("executed 4 tests");
		expect(out.refusal?.reason).not.toBe((await runManifestGates({ manifest: contract([testGate]), cwd: "/wt", exec: fakeExec({ code: 0, stdout: "No test files found" }), dockerProbe: hasDocker })).refusal?.reason);
	});

	test("the same run under a contract that demands nothing PASSES — the count is doing the work", async () => {
		const lax = contract([{ ...testGate, expects: { exit: 0, parser: "vitest" } }]);
		const out = await runManifestGates({ manifest: lax, cwd: "/wt", exec: fakeExec({ code: 0, stdout: "No test files found" }), dockerProbe: hasDocker });
		expect(out.ok).toBe(true);
	});
});

describe("R3 — required service absent", () => {
	const withService: TenantGate = {
		...testGate,
		requires: { services: [{ name: "db", image: "postgres:16", healthcheckCommand: "pg_isready -U postgres", ports: ["55432:5432"], env: { POSTGRES_PASSWORD: "x" } }] },
	};

	test("docker down under a service-requiring gate REFUSES — it never falls back to the host", async () => {
		const seen: string[] = [];
		const out = await runManifestGates({ manifest: contract([withService]), cwd: "/wt", exec: fakeExec({ code: 0, stdout: " Tests  99 passed (99)\n" }, seen), dockerProbe: noDocker });
		expect(out.ok).toBe(false);
		expect(out.refusal?.code).toBe("service-unavailable");
		expect(out.refusal?.reason).toContain("docker is unavailable");
		// The load-bearing half: the gate command was NEVER RUN on the host. A refusal that still ran
		// the suite against the daemon's own database would be the fail-open wearing a refusal's clothes.
		expect(seen).toHaveLength(0);
	});

	test("a service that never goes healthy refuses with compose's own output", async () => {
		const out = await runManifestGates({
			manifest: contract([withService]),
			cwd: "/wt",
			exec: fakeExec({ code: 0, stdout: " Tests  99 passed (99)\n" }),
			dockerProbe: hasDocker,
			serviceSpawn: async (argv) => (argv.includes("up") ? { code: 1, output: "container db is unhealthy" } : { code: 0, output: "" }),
		});
		expect(out.refusal?.code).toBe("service-unavailable");
		expect(out.refusal?.reason).toContain("unhealthy");
	});

	test("services come DOWN on the refusal path — a refusing land must not leak containers", async () => {
		const argvs: string[][] = [];
		await runManifestGates({
			manifest: contract([withService]),
			cwd: "/wt",
			exec: fakeExec({ code: 1, stdout: "" }),
			dockerProbe: hasDocker,
			serviceSpawn: async (argv) => {
				argvs.push(argv);
				return { code: 0, output: "" };
			},
		});
		expect(argvs.some((a) => a.includes("up") && a.includes("--wait"))).toBe(true);
		expect(argvs.some((a) => a.includes("down") && a.includes("-v"))).toBe(true);
	});

	test("the generated compose file carries the healthcheck, not a sleep", () => {
		const yaml = composeFileFor([{ name: "db", image: "postgres:16", healthcheckCommand: "pg_isready", healthcheckRetries: 7, healthcheckIntervalMs: 3000 }]);
		expect(yaml).toContain('"db"');
		expect(yaml).toContain("healthcheck:");
		expect(yaml).toContain('"CMD-SHELL"');
		expect(yaml).toContain("retries: 7");
		expect(yaml).toContain("interval: 3s");
	});

	test("a gate declaring no services never probes docker at all", async () => {
		let probed = false;
		const r = await startGateServices({ services: [], gateName: "unit", cwd: "/wt", timeoutMs: 1000, dockerProbe: () => ((probed = true), false) });
		expect(r.ok).toBe(true);
		expect(probed).toBe(false);
	});
});

describe("R4 — declared runner unavailable", () => {
	const browserGate: TenantGate = { name: "e2e", command: "pnpm e2e", timeoutMs: 1000, expects: { exit: 0, parser: "raw" }, requires: { runnerImage: "mcr.microsoft.com/playwright:v1.50.0" } };

	test("a runnerImage with no docker refuses as runner-unavailable — never a skip", async () => {
		const seen: string[] = [];
		const out = await runManifestGates({ manifest: contract([browserGate]), cwd: "/wt", exec: fakeExec({ code: 0 }, seen), dockerProbe: noDocker });
		expect(out.refusal?.code).toBe("runner-unavailable");
		expect(out.refusal?.reason).toContain("playwright");
		expect(seen).toHaveLength(0);
	});

	test("its reason is distinct from the service-absent one — different fix, different sentence", async () => {
		const runner = await runManifestGates({ manifest: contract([browserGate]), cwd: "/wt", exec: fakeExec({ code: 0 }), dockerProbe: noDocker });
		const service = await runManifestGates({
			manifest: contract([{ ...testGate, requires: { services: [{ name: "db", image: "postgres:16", healthcheckCommand: "pg_isready" }] } }]),
			cwd: "/wt",
			exec: fakeExec({ code: 0 }),
			dockerProbe: noDocker,
		});
		expect(runner.refusal?.code).not.toBe(service.refusal?.code);
		expect(runner.refusal?.reason).not.toBe(service.refusal?.reason);
	});
});

describe("R5 — registered, but there is no runnable command", () => {
	test("the refusal names the repo and says how to clear it", () => {
		const r = missingCommandRefusal("/repo", "registered manifest for /repo is unusable: bad JSON");
		expect(r.code).toBe("command-unregistered");
		expect(r.reason).toContain("/repo");
		// The defect being closed: `{ ok: true, skipped: true }` read as green to every `.ok`-only caller.
		expect(r.reason).toContain("refusing to report a gate as passed when none ran");
	});
});

describe("R6 — all green", () => {
	test("passes, stamps the contract hash, and carries per-gate counts", async () => {
		const m = contract([
			{ name: "typecheck", command: "pnpm typecheck", timeoutMs: 1000, expects: { exit: 0, parser: "raw" } },
			testGate,
		]);
		const out = await runManifestGates({ manifest: m, cwd: "/wt", exec: fakeExec({ code: 0, stdout: " Tests  12 passed (12)\n" }), dockerProbe: hasDocker });
		expect(out.ok).toBe(true);
		expect(out.refusal).toBeUndefined();
		expect(out.manifestHash).toHaveLength(64);
		expect(out.results.map((r) => r.name)).toEqual(["typecheck", "unit"]);
		expect(out.results[1]?.tests).toBe(12);
	});
});

describe("cross-cutting runner behavior", () => {
	test("gates fail FAST, and a skipped gate is recorded as skipped — never as passed", async () => {
		const m = contract([
			{ name: "first", command: "pnpm typecheck", timeoutMs: 1000, expects: { exit: 0, parser: "raw" } },
			{ name: "second", command: "pnpm test", timeoutMs: 1000, expects: { exit: 0, parser: "raw" } },
		]);
		const seen: string[] = [];
		const out = await runManifestGates({ manifest: m, cwd: "/wt", exec: fakeExec({ code: 2 }, seen), dockerProbe: hasDocker });
		expect(out.refusal?.code).toBe("gate-red");
		expect(seen).toEqual(["pnpm typecheck"]);
		expect(out.results[1]).toMatchObject({ name: "second", exitCode: null });
	});

	test("a degraded sandbox refuses even when the run exits 0 and claims passes", async () => {
		const out = await runManifestGates({
			manifest: contract([{ ...testGate, expects: { exit: 0, parser: "vitest", minTests: 1 } }]),
			cwd: "/wt",
			exec: fakeExec({ code: 0, stdout: " Tests  12 passed (12)\n", degraded: true }),
			dockerProbe: hasDocker,
		});
		expect(out.refusal?.code).toBe("degraded-sandbox");
	});

	test("the tenant policy is what reaches the exec — not the daemon's env", async () => {
		let captured: { policy?: { sandboxStrict?: boolean; sandboxImage?: string } } | undefined;
		const m = contract([{ ...testGate, expects: { exit: 0, parser: "raw" } }], { sandboxStrict: true, sandboxImage: "tenant/image:1" });
		await runManifestGates({
			manifest: m,
			cwd: "/wt",
			dockerProbe: hasDocker,
			exec: async (_c, _cwd, o) => {
				captured = o;
				return { code: 0, stdout: "", stderr: "", sandboxed: true };
			},
		});
		expect(captured?.policy).toMatchObject({ sandboxStrict: true, sandboxImage: "tenant/image:1" });
	});

	test("a gate requiring services declares requireSandbox, so the host fallback is unreachable", async () => {
		let captured: { requireSandbox?: string } | undefined;
		await runManifestGates({
			manifest: contract([{ ...testGate, expects: { exit: 0, parser: "raw" }, requires: { services: [{ name: "db", image: "postgres:16", healthcheckCommand: "pg_isready" }] } }]),
			cwd: "/wt",
			dockerProbe: hasDocker,
			serviceSpawn: async () => ({ code: 0, output: "" }),
			exec: async (_c, _cwd, o) => {
				captured = o;
				return { code: 0, stdout: "", stderr: "", sandboxed: true };
			},
		});
		expect(captured?.requireSandbox).toContain("requires composed services");
	});

	test("a gate's teardown runs after it, on the red path too", async () => {
		const seen: string[] = [];
		await runManifestGates({
			manifest: contract([{ ...testGate, expects: { exit: 0, parser: "raw" }, teardown: "pnpm clean" }]),
			cwd: "/wt",
			exec: fakeExec({ code: 1 }, seen),
			dockerProbe: hasDocker,
		});
		expect(seen).toEqual(["pnpm test", "pnpm clean"]);
	});
});

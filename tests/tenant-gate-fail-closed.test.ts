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

	test("H-3: a test parser requires positive evidence even with NO explicit minTests — an empty run refuses", async () => {
		// Declaring `parser: "vitest"` IS the declaration "this gate runs tests"; an empty run under it
		// is a fail-open, not a pass. Before round 2 this same lax contract passed on "No test files".
		const lax = contract([{ ...testGate, expects: { exit: 0, parser: "vitest" } }]);
		const empty = await runManifestGates({ manifest: lax, cwd: "/wt", exec: fakeExec({ code: 0, stdout: "No test files found" }), dockerProbe: hasDocker });
		expect(empty.ok).toBe(false);
		expect(empty.refusal?.code).toBe("zero-tests");
		// A run that DID execute tests passes the same lax contract — the implicit floor is 1, not N.
		const ran = await runManifestGates({ manifest: lax, cwd: "/wt", exec: fakeExec({ code: 0, stdout: " Tests  3 passed (3)\n" }), dockerProbe: hasDocker });
		expect(ran.ok).toBe(true);
	});

	test("H-3: `raw` opts OUT of positive-evidence — an exit-0 raw gate with no output passes", async () => {
		const raw = contract([{ name: "lint", command: "biome ci", timeoutMs: 1000, expects: { exit: 0, parser: "raw" } }]);
		const out = await runManifestGates({ manifest: raw, cwd: "/wt", exec: fakeExec({ code: 0, stdout: "" }), dockerProbe: hasDocker });
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

// ── Round 2 hardening (gauntlet round 1 High findings) ───────────────────────────────────────────

const serviceGate: TenantGate = {
	name: "integration",
	command: "pnpm test:integration",
	timeoutMs: 1000,
	expects: { exit: 0, parser: "raw" },
	requires: { services: [{ name: "db", image: "postgres:16", healthcheckCommand: "pg_isready -U postgres", ports: ["55432:5432"], env: { POSTGRES_PASSWORD: "x" } }] },
};

describe("THEME B (SECURITY) — the tenant gate env is a POSITIVE ALLOWLIST, not a denylist", () => {
	test("FLIP: EVERY secret shape is absent — including SECRET_CANARY the round-2 denylist missed", async () => {
		const names = ["CANARY_SECRET", "DATABASE_URL", "VENDOR_API_KEY", "SECRET_CANARY"] as const;
		const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
		for (const n of names) process.env[n] = `leak-${n}`;
		process.env.PATH ??= "/usr/bin"; // an allowlisted var the gate legitimately keeps
		try {
			let captured: Record<string, string> | undefined;
			await runManifestGates({
				manifest: contract([serviceGate]),
				cwd: "/wt",
				dockerProbe: hasDocker,
				serviceSpawn: async () => ({ code: 0, output: "" }),
				exec: async (_c, _cwd, o) => {
					captured = o.env;
					return { code: 0, stdout: "", stderr: "", sandboxed: true };
				},
			});
			expect(captured).toBeDefined();
			// codex reproduced SECRET_CANARY leaking under the suffix denylist; the positive allowlist
			// admits it nowhere. DATABASE_URL / VENDOR_API_KEY / CANARY_SECRET likewise absent.
			for (const n of names) expect(captured?.[n]).toBeUndefined();
			// The allowlist keeps operational vars and adds only the rail's service-discovery vars —
			// now service-name : container-port (reachable on the joined compose network), not 127.0.0.1.
			expect(captured?.PATH).toBeDefined();
			expect(captured?.GLANCE_SERVICE_DB_HOST).toBe("db");
			expect(captured?.GLANCE_SERVICE_DB_PORT).toBe("5432");
		} finally {
			for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
		}
	});

	test("policy.env re-admits a NAMED toolchain var across the boundary, nothing else", async () => {
		const saved = { cargo: process.env.CARGO_HOME, secret: process.env.MY_SECRET };
		process.env.CARGO_HOME = "/home/t/.cargo";
		process.env.MY_SECRET = "nope";
		try {
			let captured: Record<string, string> | undefined;
			await runManifestGates({
				manifest: contract([{ ...testGate, expects: { exit: 0, parser: "raw" } }], { env: ["CARGO_HOME"] }),
				cwd: "/wt",
				dockerProbe: hasDocker,
				exec: async (_c, _cwd, o) => { captured = o.env; return { code: 0, stdout: "", stderr: "", sandboxed: true }; },
			});
			expect(captured?.CARGO_HOME).toBe("/home/t/.cargo"); // named in policy.env → admitted
			expect(captured?.MY_SECRET).toBeUndefined(); // not named → absent
		} finally {
			if (saved.cargo === undefined) delete process.env.CARGO_HOME; else process.env.CARGO_HOME = saved.cargo;
			if (saved.secret === undefined) delete process.env.MY_SECRET; else process.env.MY_SECRET = saved.secret;
		}
	});
});

describe("H-2 — runnerImage becomes the ACTUAL sandbox image, or runner-unavailable", () => {
	const browserGate: TenantGate = { name: "e2e", command: "pnpm e2e", timeoutMs: 1000, expects: { exit: 0, parser: "raw" }, requires: { runnerImage: "mcr.microsoft.com/playwright:v1.50.0" } };

	test("a present/pullable image is PASSED to the exec as sandboxImage — the gate runs in it, not the default", async () => {
		let captured: { policy?: { sandboxImage?: string } } | undefined;
		const out = await runManifestGates({
			manifest: contract([browserGate]),
			cwd: "/wt",
			dockerProbe: hasDocker,
			ensureImage: async () => true, // present/pulled
			exec: async (_c, _cwd, o) => {
				captured = o;
				return { code: 0, stdout: "", stderr: "", sandboxed: true };
			},
		});
		expect(out.ok).toBe(true);
		expect(captured?.policy?.sandboxImage).toBe("mcr.microsoft.com/playwright:v1.50.0");
	});

	test("FLIP: an unpullable image REFUSES runner-unavailable — the gate never runs in the wrong image", async () => {
		const seen: string[] = [];
		const out = await runManifestGates({
			manifest: contract([browserGate]),
			cwd: "/wt",
			dockerProbe: hasDocker,
			ensureImage: async () => false, // absent + pull failed
			exec: fakeExec({ code: 0 }, seen),
		});
		expect(out.refusal?.code).toBe("runner-unavailable");
		expect(out.refusal?.reason).toContain("could not be pulled");
		expect(seen).toHaveLength(0);
	});
});

describe("H-4 — a missing binary is environmental/retryable, never a permanent gate-red wedge", () => {
	test("FLIP: exit 127 refuses command-unregistered (which land classifies retryable), not gate-red", async () => {
		const out = await runManifestGates({ manifest: contract([{ ...testGate, expects: { exit: 0, parser: "raw" } }]), cwd: "/wt", exec: fakeExec({ code: 127, stderr: "pnpm: command not found" }), dockerProbe: hasDocker });
		expect(out.refusal?.code).toBe("command-unregistered");
		expect(out.refusal?.code).not.toBe("gate-red");
	});

	test("a non-127 exit whose output shows an executable-resolution failure is also environmental", async () => {
		const out = await runManifestGates({ manifest: contract([{ ...testGate, expects: { exit: 0, parser: "raw" } }]), cwd: "/wt", exec: fakeExec({ code: 1, stderr: "Executable not found in $PATH: vitest" }), dockerProbe: hasDocker });
		expect(out.refusal?.code).toBe("command-unregistered");
	});
});

describe("H-5 — a failed `down` blocks the GREEN receipt (containers alive ≠ a pass)", () => {
	test("FLIP: gate passes but compose `down` fails → the pass becomes a service-unavailable refusal", async () => {
		const out = await runManifestGates({
			manifest: contract([serviceGate]),
			cwd: "/wt",
			dockerProbe: hasDocker,
			// up succeeds, down fails — containers may still be running.
			serviceSpawn: async (argv) => (argv.includes("down") ? { code: 1, output: "Error response from daemon: conflict" } : { code: 0, output: "" }),
			exec: async () => ({ code: 0, stdout: "", stderr: "", sandboxed: true }),
		});
		expect(out.ok).toBe(false);
		expect(out.refusal?.code).toBe("service-unavailable");
		expect(out.refusal?.reason).toContain("teardown did not complete");
	});

	test("a clean `down` after a green gate lands normally", async () => {
		const out = await runManifestGates({
			manifest: contract([serviceGate]),
			cwd: "/wt",
			dockerProbe: hasDocker,
			serviceSpawn: async () => ({ code: 0, output: "" }),
			exec: async () => ({ code: 0, stdout: "", stderr: "", sandboxed: true }),
		});
		expect(out.ok).toBe(true);
	});
});

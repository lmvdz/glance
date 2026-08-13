import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { landAgent } from "../src/land.ts";
import { setProofRoot, proofFor } from "../src/proof.ts";
import { resolveStateDir } from "../src/state-dir.ts";
import { dockerAvailable } from "../src/gate-runner.ts";
import { normalizeRepoPath } from "../src/project-registry.ts";
import { openTenantGateRegistry } from "../src/tenant-gate-registry.ts";
import { manifestHash, type TenantGate, type TenantGateManifest } from "../src/tenant-gates.ts";
import {
	assembleManifest,
	composeProjectPrefix,
	gateMissingCommand,
	gatePlaywrightRefused,
	gatePnpmInstall,
	gateServiceUnstartable,
	gateTypecheck,
	gateVitest,
	greenManifest,
	mintFixtureTenant,
	type FixtureControl,
	type FixtureTenant,
} from "./fixtures/fixture-tenant.ts";

/**
 * B5 #394 — the DESTINATION artifact-2 proof: a disposable foreign-stack fixture tenant, registered
 * on the glance side, driven through the REAL rail (`landAgent`), walking G2 #386's six-row rigged-red
 * matrix. R1–R5 must REFUSE with DISTINCT codes and reasons; R6 (all green) must LAND its scratch
 * branch into the fixture's own `main` with a receipt carrying the manifest hash + per-gate counts.
 *
 * This is the end-to-end complement of tests/tenant-gate-fail-closed.test.ts (which proves the runner's
 * logic in isolation with injected execs). Here nothing is injected below `landAgent`: real git repos,
 * real pnpm, real gate commands, and — for R6 — a real docker-compose Postgres. The single most
 * important property (the gauntlet brief): TRY TO MAKE A RED FIXTURE LAND. Every R1–R5 assertion pins
 * `merged === false` AND `main` still at `head0` AND no green post-merge proof — three independent
 * ways of saying the rejection actually held.
 *
 * The suite pins OMP_SQUAD_GATE_SANDBOX=host (tests/setup.ts), so the plain gates run on the host; the
 * R6 integration gate carries its own per-gate `runnerImage`, which overrides the host pin and runs it
 * sandboxed on the compose network — the production service path, exercised for real.
 */

const dockerUp = await dockerAvailable();
if (!dockerUp) {
	// LOUD: R6 is environment-limited, not green. R3 still asserts its refusal (docker-absent → the
	// docker-unavailable branch of service-unavailable), so the matrix's rejection spine is unbroken.
	console.warn(
		"\n[B5 #394] docker is UNAVAILABLE on this host — R6 (the all-green land) will be SKIPPED LOUDLY as environment-limited, NOT reported green. R3 still runs and asserts its refusal.\n",
	);
}

// M-1 (gauntlet): a RUN-UNIQUE label so every compose project this suite's gates create shares one
// `glance-gate-<RUN>-*` prefix — the teardown sweep targets exactly that prefix and never a concurrent
// suite's or a live daemon's `glance-gate-*` resources. Every fixture is minted with this label.
const RUN = `b5${Math.random().toString(36).slice(2, 10)}`;
const PROJECT_PREFIX = composeProjectPrefix(RUN);

const fixtures: FixtureTenant[] = [];
let proofDir = "";

beforeAll(async () => {
	proofDir = await fs.mkdtemp(path.join(os.tmpdir(), "b5-proof-"));
	setProofRoot(proofDir);
});

afterAll(async () => {
	setProofRoot(resolveStateDir());
	// Do NOT swallow fixture cleanup errors — collect and surface them (a cleanup that fails while the
	// suite passes is a silent leak).
	const cleanupErrors: string[] = [];
	for (const f of fixtures) {
		try {
			await f.cleanup();
		} catch (e) {
			cleanupErrors.push(String(e));
		}
	}
	await fs.rm(proofDir, { recursive: true, force: true }).catch((e) => cleanupErrors.push(String(e)));
	const leakDetail = await sweepThisRunsCompose();
	if (cleanupErrors.length) throw new Error(`[B5 #394] fixture cleanup failed (${cleanupErrors.length}): ${cleanupErrors.join("; ")}`);
	if (leakDetail) throw new Error(leakDetail);
});

/** A bounded docker call (M-1: cleanup must be bounded, never a hang). Kills the child at `timeoutMs`. */
async function dockerBounded(args: string[], timeoutMs = 30_000): Promise<{ code: number; stdout: string }> {
	try {
		const p = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
		const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
		try {
			const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
			return { code, stdout: stdout.trim() };
		} finally {
			clearTimeout(timer);
		}
	} catch (e) {
		return { code: 1, stdout: String(e) };
	}
}

/**
 * Teardown net beyond the rail's own unconditional `down` — SCOPED to THIS run's project prefix only
 * (M-1). Removes only `glance-gate-<RUN>-*` resources this suite created, checks removal exit codes,
 * and returns a non-empty detail (→ the suite FAILS) if any owned resource survives removal. Never
 * touches another suite's or a daemon's containers.
 */
async function sweepThisRunsCompose(): Promise<string | undefined> {
	if (!dockerUp) return undefined;
	const problems: string[] = [];
	for (const [kind, listArgs, rmArgs] of [
		["container", ["ps", "-aq", "--filter", `name=${PROJECT_PREFIX}`], ["rm", "-f"]],
		["network", ["network", "ls", "-q", "--filter", `name=${PROJECT_PREFIX}`], ["network", "rm"]],
	] as const) {
		const listed = await dockerBounded([...listArgs]);
		const ids = listed.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
		if (!ids.length) continue;
		console.warn(`[B5 #394] sweeping ${ids.length} owned ${kind}(s) under ${PROJECT_PREFIX}-* (the rail's own teardown should have handled these).`);
		const rm = await dockerBounded([...rmArgs, ...ids]);
		if (rm.code !== 0) problems.push(`docker ${rmArgs[0]} for ${kind}s exited ${rm.code}: ${rm.stdout.slice(0, 200)}`);
		const still = await dockerBounded([...listArgs]);
		const remaining = still.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
		if (remaining.length) problems.push(`${remaining.length} ${kind}(s) under ${PROJECT_PREFIX}-* survived removal: ${remaining.join(", ")}`);
	}
	return problems.length ? `[B5 #394] teardown left owned resources: ${problems.join("; ")}` : undefined;
}

async function headOf(repo: string): Promise<string> {
	const p = Bun.spawn(["git", "-C", repo, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
	const [s] = await Promise.all([new Response(p.stdout).text(), p.exited]);
	return s.trim();
}

/** The refusal code the land receipt embeds: `... REFUSED the land (<code>): <reason>`. */
function refusalCodeOf(detail: string): string | undefined {
	return /REFUSED the land \(([a-z-]+)\)/.exec(detail)?.[1];
}

/**
 * Mint a fixture with `control`, REGISTER its manifest into a fresh glance-side registry, resolve it
 * back through that registry (the authority round-trip), and drive the resolved manifest through the
 * REAL `landAgent`. Returns the land result plus the post-land `main` HEAD for the rollback assertion.
 */
async function driveRow(
	control: FixtureControl,
	gates: TenantGate[],
): Promise<{ fixture: FixtureTenant; manifest: TenantGateManifest; res: Awaited<ReturnType<typeof landAgent>>; mainAfter: string }> {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "b5-registry-"));
	// Build the manifest against a placeholder; re-key to the real repo after mint (repo path is minted).
	const fixture = await mintFixtureTenant({ control, label: RUN });
	fixtures.push(fixture);
	const manifest = assembleManifest(fixture.repo, gates);

	// Register glance-side, then resolve ONLY through the registry — a land is judged by the stored
	// contract, never a hand-built one. Prove the round-trip is lossless (same hash, same repo key).
	const registry = openTenantGateRegistry(stateDir);
	expect(registry.register(manifest)).toBe("registered");
	const looked = registry.get(fixture.repo);
	if (!looked || "error" in looked) throw new Error(`registry.get failed: ${looked && "error" in looked ? looked.error : "undefined"}`);
	expect(looked.manifest.repo).toBe(normalizeRepoPath(fixture.repo));
	expect(manifestHash(looked.manifest)).toBe(manifestHash(manifest));

	const res = await landAgent({
		repo: fixture.repo,
		worktree: fixture.worktree,
		branch: fixture.workBranch,
		message: "land the scratch branch",
		commitWip: false,
		verify: "",
		manifest: looked.manifest,
	});
	const mainAfter = await headOf(fixture.repo);
	await fs.rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
	return { fixture, manifest: looked.manifest, res, mainAfter };
}

/** Assert a row REFUSED to land, with a specific code, and that main never moved off head0. */
async function expectRefused(
	row: { fixture: FixtureTenant; res: Awaited<ReturnType<typeof landAgent>>; mainAfter: string },
	code: string,
	reasonIncludes: string,
): Promise<string> {
	expect(row.res.ok).toBe(false);
	expect(row.res.merged).toBe(false);
	expect(refusalCodeOf(row.res.detail)).toBe(code);
	expect(row.res.detail).toContain(reasonIncludes);
	// The load-bearing anti-"red fixture lands" assertions: main is exactly where it started, and there
	// is no green post-merge proof for a refused land.
	expect(row.mainAfter).toBe(row.fixture.head0);
	const proof = await proofFor(row.fixture.repo, row.fixture.repo);
	expect(proof?.ok).not.toBe(true);
	return row.res.detail;
}

// Collected for the cross-row distinctness assertion (each refusal reason must be its OWN sentence).
const refusalReasons: Record<string, string> = {};
const refusalCodes: Record<string, string | undefined> = {};

describe("B5 #394 — the rigged-red matrix through the real rail", () => {
	test("R1 — a gate exits non-zero → REFUSE (gate-red)", async () => {
		// The typecheck gate's script is rigged to exit 1; pnpm propagates it. A red gate is a red land.
		const row = await driveRow({ typecheck: { exit: 1 } }, [gateTypecheck]);
		const detail = await expectRefused(row, "gate-red", "typecheck");
		refusalReasons.R1 = detail;
		refusalCodes.R1 = "gate-red";
	}, 120_000);

	test("R2 — exit 0 but fewer tests than the count assertion → REFUSE (count-violated)", async () => {
		// The Vitest-shape gate runs 4 tests; the contract demands >= 12. pnpm install passes en route,
		// proving the rail runs the real gates in order and refuses only at the rigged one.
		const row = await driveRow({ vitest: { exit: 0, tests: 4 } }, [gatePnpmInstall, gateVitest(12)]);
		const detail = await expectRefused(row, "count-violated", "executed 4 tests");
		refusalReasons.R2 = detail;
		refusalCodes.R2 = "count-violated";
	}, 120_000);

	test("R3 — a required compose service cannot start → REFUSE (service-unavailable), never a host fallback", async () => {
		// PASSES whether docker is absent (probe false → 'docker is unavailable') or present (unpullable
		// service image → compose 'up --wait' fails). Either way the gate COMMAND never runs: R3_MARKER_RAN
		// (which the command would touch) must be absent — the fail-open would be running the suite against
		// the daemon host's own database.
		const row = await driveRow({}, [gateServiceUnstartable()]);
		expect(row.res.ok).toBe(false);
		expect(row.res.merged).toBe(false);
		expect(refusalCodeOf(row.res.detail)).toBe("service-unavailable");
		expect(row.mainAfter).toBe(row.fixture.head0);
		expect(await fs.exists(path.join(row.fixture.repo, "R3_MARKER_RAN"))).toBe(false);
		const proof = await proofFor(row.fixture.repo, row.fixture.repo);
		expect(proof?.ok).not.toBe(true);
		refusalReasons.R3 = row.res.detail;
		refusalCodes.R3 = "service-unavailable";
	}, 120_000);

	test("R4 — a gate declares a runner this host cannot provide → REFUSE (runner-unavailable), never a skip", async () => {
		// The Playwright/e2e gate — DECLARED-but-refused per #386's omission list. Its runnerImage is
		// unpullable, so it refuses deterministically even where docker is present; browsers are never
		// fetched and the gate never runs.
		const row = await driveRow({}, [gatePlaywrightRefused()]);
		const detail = await expectRefused(row, "runner-unavailable", "runner");
		refusalReasons.R4 = detail;
		refusalCodes.R4 = "runner-unavailable";
	}, 120_000);

	test("R5 — the declared command is missing from the repo → REFUSE (command-unregistered)", async () => {
		// The named `{ ok:true, skipped:true }` defect's end-to-end cousin: a registered gate whose command
		// does not exist must refuse, never report a pass.
		const row = await driveRow({}, [gateMissingCommand()]);
		const detail = await expectRefused(row, "command-unregistered", "not found");
		refusalReasons.R5 = detail;
		refusalCodes.R5 = "command-unregistered";
	}, 120_000);

	test("every refusal reason and code is DISTINCT — 'it failed' is not a receipt", () => {
		const reasons = Object.values(refusalReasons);
		expect(reasons.length).toBe(5); // R1..R5 all ran
		expect(new Set(reasons).size).toBe(5); // each a different sentence
		expect(new Set(Object.values(refusalCodes)).size).toBe(5); // each a different code
	});

	// C-1 (gauntlet Critical): once R6 is SELECTED to run (docker present at the declaration-time probe
	// below), a landing-rail REFUSAL is a hard FAILURE of this test — never a warn-and-return that Bun
	// records as a pass. R6 is the row whose entire job is to LAND; a refusal counted as green means the
	// proof's positive half silently did not run. The ONLY skip is the declaration-time skipIf(!dockerUp).
	// CI IMPLICATION: the proof lane MUST run on a docker-available host so this row is actually
	// exercised (an all-skipped R6 proves nothing) — a docker-absent CI must treat R6's skip as RED.
	test.skipIf(!dockerUp)(
		"R6 — all six gate classes green → LANDS into the scratch branch with a receipt (hash + per-gate counts)",
		async () => {
			const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "b5-registry-"));
			const fixture = await mintFixtureTenant({ label: RUN }); // all-green control
			fixtures.push(fixture);
			const manifest = greenManifest(fixture.repo);
			const registry = openTenantGateRegistry(stateDir);
			expect(registry.register(manifest)).toBe("registered");
			const looked = registry.get(fixture.repo);
			if (!looked || "error" in looked) throw new Error(`registry.get failed for R6`);

			const res = await landAgent({
				repo: fixture.repo,
				worktree: fixture.worktree,
				branch: fixture.workBranch,
				message: "land the green scratch branch",
				commitWip: false,
				verify: "",
				manifest: looked.manifest,
			});
			await fs.rm(stateDir, { recursive: true, force: true }).catch(() => undefined);

			// No retryable escape hatch: a refusal here (service/runner-unavailable, docker vanished, image
			// unpullable, anything) FAILS the row loudly with its detail. The land must have happened.
			if (!res.ok) throw new Error(`[B5 #394] R6 was selected to run (docker present) but the land did not happen: ${res.detail}`);
			expect(res.ok).toBe(true);
			expect(res.merged).toBe(true);
			// The receipt: verified against the tenant contract, carrying the manifest hash AND per-gate counts.
			expect(res.detail).toContain("verified against tenant contract");
			expect(res.detail).toContain(manifestHash(looked.manifest).slice(0, 12));
			// H-1 (the B4 receipt-formatter fix): assert the ACTUAL COUNTS are in the receipt, not just gate
			// names. `test=3 tests` is a REAL bun-test count (H-2), and the counts-script gates' named counts
			// now ride into the receipt (they were silently dropped before the formatter fix).
			expect(res.detail).toContain("test=3 tests"); // REAL runner count, not a printed summary
			expect(res.detail).toContain("integration=rows=3"); // real psql-against-Postgres count, in the receipt
			expect(res.detail).toContain("ci-counts=files=3/cases=12"); // counts-script named counts, in the receipt
			// The receipt lists every gate that ran, in order.
			for (const name of ["install", "typecheck", "lint", "test", "integration", "ci-counts"]) expect(res.detail).toContain(name);
			// main actually advanced — the scratch branch landed.
			expect(await headOf(fixture.repo)).not.toBe(fixture.head0);
			const proof = await proofFor(fixture.repo, fixture.repo);
			expect(proof?.ok).toBe(true);
		},
		240_000,
	);

	// C-1 GUARD (permanent regression): the positive row's assertions must OBSERVE a post-selection
	// refusal as res.ok===false — proving the escape hatch is gone. A green fixture whose manifest is
	// rigged with an unpullable runnerImage (a refusal that only surfaces AFTER docker is probed present)
	// must return a REFUSAL result, so R6's `expect(res.ok).toBe(true)` would fail on it, not pass it.
	test.skipIf(!dockerUp)(
		"C-1 flip — a post-selection refusal is observable as res.ok=false (R6 could not silently skip it)",
		async () => {
			const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "b5-registry-"));
			const fixture = await mintFixtureTenant({ label: RUN });
			fixtures.push(fixture);
			// The green six-class manifest PLUS a gate whose runnerImage is unpullable — reachable only
			// after the docker-present probe, i.e. a genuine post-selection refusal.
			const rigged = assembleManifest(fixture.repo, [
				gatePnpmInstall,
				gatePlaywrightRefused("glance-fixture-refused.invalid/post-selection:v0"),
			]);
			const registry = openTenantGateRegistry(stateDir);
			expect(registry.register(rigged)).toBe("registered");
			const looked = registry.get(fixture.repo);
			if (!looked || "error" in looked) throw new Error("registry.get failed for the C-1 flip");
			const res = await landAgent({
				repo: fixture.repo,
				worktree: fixture.worktree,
				branch: fixture.workBranch,
				message: "rigged post-selection refusal",
				commitWip: false,
				verify: "",
				manifest: looked.manifest,
			});
			await fs.rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
			// The refusal is OBSERVABLE — exactly what R6's happy-path assertions now trip on (no skip escape).
			expect(res.ok).toBe(false);
			expect(res.merged).toBe(false);
			expect(refusalCodeOf(res.detail)).toBe("runner-unavailable");
			expect(await headOf(fixture.repo)).toBe(fixture.head0);
		},
		120_000,
	);
});

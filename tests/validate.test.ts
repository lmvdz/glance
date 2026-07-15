/**
 * validate.ts's commissioning gate (concern 06, OMPSQ-160) — proves `typecheckWorker`'s tsc spawn and
 * `acceptanceWorker`'s `flue run` spawn now route through gate-runner's shipped sandbox planner
 * instead of a bare `Bun.spawn`, while their own narrower env scrubs (`baselineEnv`/`acceptanceEnv`)
 * still apply INSIDE the container as belt-and-suspenders.
 *
 * Injected via `GateOptions.exec` (validate.ts's own test seam), NOT `mock.module("../src/gate-runner.ts",
 * ...)`: gate-runner.ts is imported by land.ts/land-pr.ts/proof.ts/convergence-run.ts/squad-manager.ts and
 * their own test files exercise the REAL implementation — a process-wide module mock here would silently
 * swap their gate planner too for the rest of this `bun test` invocation (the exact hazard ahead-of-base.test.ts
 * documents for `land-mode.ts`). The injected `exec` instead calls the REAL `gateExec` with a fake
 * `dockerProbe`/`imageBuilder` (so no real docker build or container run happens) and records the plan it
 * produced — "goes through gate-runner" is proven by exercising gate-runner's actual planning code, not by
 * replacing it.
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { GateExec } from "../src/gate-runner.ts";
import { gateExec } from "../src/gate-runner.ts";
import { validateWorker } from "../src/validate.ts";
import type { CommissionSpec } from "../src/types.ts";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function makeWorkerDir(opts: { tsc?: boolean; flue?: boolean } = { tsc: true, flue: true }): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-validate-gate-"));
	tmps.push(dir);
	await fs.mkdir(path.join(dir, "node_modules", ".bin"), { recursive: true });
	if (opts.tsc !== false) {
		const bin = path.join(dir, "node_modules", ".bin", "tsc");
		await fs.writeFile(bin, "#!/bin/sh\nexit 0\n");
		await fs.chmod(bin, 0o755);
	}
	if (opts.flue !== false) {
		const bin = path.join(dir, "node_modules", ".bin", "flue");
		await fs.writeFile(bin, '#!/bin/sh\necho \'{"ok":true}\'\nexit 0\n');
		await fs.chmod(bin, 0o755);
	}
	return dir;
}

interface RecordedCall {
	command: string;
	cwd: string;
	network?: string;
	plan: GateExec;
}

/**
 * A GateOptions.exec fake that calls the REAL gateExec (real planning logic) with an injected docker
 * probe/image builder — never touches real docker — and records the resulting plan instead of
 * spawning it, so the test proves what WOULD run without paying for a container.
 */
function recordingExec(calls: RecordedCall[], dockerUp: boolean) {
	return async (command: string, cwd: string, opts: { mounts?: string[]; env?: Record<string, string>; network?: string } = {}) => {
		const plan = await gateExec(command, cwd, {
			mounts: opts.mounts,
			env: opts.env,
			network: opts.network,
			// No OMP_SQUAD_GATE_SANDBOX key here at all ⇒ gateExec's auto-mode branch runs regardless of
			// tests/setup.ts's suite-wide `OMP_SQUAD_GATE_SANDBOX=host` pin (opts.source, when given,
			// wins over process.env entirely).
			source: {} as NodeJS.ProcessEnv,
			dockerProbe: async () => dockerUp,
			imageBuilder: async () => "fake-sandbox-image:test",
		});
		calls.push({ command, cwd, network: opts.network, plan });
		return { code: 0, stdout: "", stderr: "" };
	};
}

test("typecheckWorker's tsc spawn plans through gate-runner's REAL sandbox planner when docker is available, carrying baselineEnv (not gate-runner's own gateEnv) into the container", async () => {
	const dir = await makeWorkerDir({ flue: false }); // no flue ⇒ acceptance skips, isolating the typecheck call
	const calls: RecordedCall[] = [];
	const spec: CommissionSpec = { name: "w", purpose: "p" };
	// A var that a broader pass-through-minus-secrets scrub (gate-runner's own gateEnv) would happily
	// carry through, but baselineEnv()'s fixed ENV_BASELINE allowlist has no entry for.
	const prevUnrelated = process.env.SQT_VALIDATE_UNRELATED_VAR;
	process.env.SQT_VALIDATE_UNRELATED_VAR = "should-not-reach-the-gate";
	try {
		const report = await validateWorker(dir, spec, { exec: recordingExec(calls, true) });

		expect(calls.length).toBe(1); // lint/ponytail are pure fs; acceptance skipped (no flue) ⇒ only typecheck spawns
		const [call] = calls;
		expect(call.plan.sandboxed).toBe(true);
		expect(call.plan.image).toBe("fake-sandbox-image:test");
		expect(call.command).toContain("node_modules/.bin/tsc");
		expect(call.command).toContain("--noEmit");
		// typecheck never overrides network ⇒ falls back to the gate-wide default (none) inside sandboxPlan.
		expect(call.network).toBeUndefined();
		expect(call.plan.argv).toContain("--network");
		expect(call.plan.argv[call.plan.argv.indexOf("--network") + 1]).toBe("none");
		// baselineEnv(), not gateEnv(source) — proves the narrower scrub rode along into the plan: PATH is
		// one of ENV_BASELINE's named vars, but an arbitrary unrelated var is not, even though it would
		// have survived gate-runner's own (much broader) pass-through-minus-secrets gateEnv().
		expect(call.plan.env.PATH).toBeDefined();
		expect("SQT_VALIDATE_UNRELATED_VAR" in call.plan.env).toBe(false);

		expect(report.checks.find((c) => c.name === "typecheck")?.status).toBe("pass");
		expect(report.checks.find((c) => c.name === "acceptance")?.status).toBe("skip");
	} finally {
		if (prevUnrelated === undefined) delete process.env.SQT_VALIDATE_UNRELATED_VAR;
		else process.env.SQT_VALIDATE_UNRELATED_VAR = prevUnrelated;
	}
});

test("acceptanceWorker's flue-run spawn widens network past the gate-wide none default while acceptanceEnv's deny-by-default scrub still keeps secrets out of the container flags", async () => {
	const dir = await makeWorkerDir({ tsc: false }); // no tsc ⇒ typecheck skips, isolating the acceptance call
	const calls: RecordedCall[] = [];
	const spec: CommissionSpec = { name: "w", purpose: "p", model: "anthropic/claude-x", accept: { payload: { a: 1 } } };

	const prevKey = process.env.ANTHROPIC_API_KEY;
	const prevDb = process.env.DATABASE_URL;
	process.env.ANTHROPIC_API_KEY = "sk-real-secret";
	process.env.DATABASE_URL = "postgres://daemon-secret";
	try {
		const report = await validateWorker(dir, spec, { exec: recordingExec(calls, true) });
		expect(calls.length).toBe(1);
		const [call] = calls;
		expect(call.plan.sandboxed).toBe(true);
		expect(call.command).toContain("node_modules/.bin/flue");
		expect(call.command).toContain("run");
		// Acceptance's per-call network override beats the gate-wide "none" default.
		expect(call.network).toBe("bridge");
		expect(call.plan.argv).toContain("--network");
		expect(call.plan.argv[call.plan.argv.indexOf("--network") + 1]).toBe("bridge");
		// acceptanceEnv() admits the ONE provider key the declared model implies...
		expect(call.plan.env.ANTHROPIC_API_KEY).toBe("sk-real-secret");
		// ...but DATABASE_URL (a daemon secret with no capability grant) never reaches acceptanceEnv's
		// output, so it can never appear as a container `-e` flag either — check the actual argv, not
		// just the env object, since that's what the container really sees.
		expect(call.plan.argv.some((a) => a.includes("DATABASE_URL"))).toBe(false);
		expect(report.checks.find((c) => c.name === "acceptance")?.status).toBe("pass");
		expect(report.checks.find((c) => c.name === "typecheck")?.status).toBe("skip");
	} finally {
		if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
		else process.env.ANTHROPIC_API_KEY = prevKey;
		if (prevDb === undefined) delete process.env.DATABASE_URL;
		else process.env.DATABASE_URL = prevDb;
	}
});

test("typecheckWorker degrades to a host plan when docker is unavailable — same fail-open-to-legible-host contract every other gate has, still scoped to baselineEnv", async () => {
	const dir = await makeWorkerDir({ flue: false });
	const calls: RecordedCall[] = [];
	const spec: CommissionSpec = { name: "w", purpose: "p" };
	const report = await validateWorker(dir, spec, { exec: recordingExec(calls, false) });

	expect(calls.length).toBe(1);
	const [call] = calls;
	expect(call.plan.sandboxed).toBe(false);
	expect(call.plan.argv[0]).toBe("bash");
	expect(call.plan.argv[1]).toBe("-lc");
	expect(call.plan.env.PATH).toBeDefined();
	expect(report.checks.find((c) => c.name === "typecheck")?.status).toBe("pass");
});

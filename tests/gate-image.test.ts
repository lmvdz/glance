/**
 * Gate sandbox IMAGE CONTRACT — the ompsq-432 regression test, verified against REAL docker
 * (skipped when docker is unavailable, mirroring tests/sandbox.test.ts).
 *
 * Incident: workflow verify gates run inside the hermetic gate sandbox (squad-manager routes
 * command nodes through execGatedCommand). The auto-mode default image used to be bare
 * `oven/bun:1`, which has NO git — so every full-suite verify died deterministically with
 * `error: Executable not found in $PATH: "git"` at the first test that spawns git
 * (tests/harness-scorecard.test.ts:132), while the same command passed on the host. The unit then
 * burned its whole codefix→fixup→escalate cascade on an environment defect it could never fix.
 *
 * The contract (gate-runner.ts header): the gate image must provide bash, the repo toolchain
 * (bun), AND git. `defaultGateImage()` enforces it by deriving a git-enabled image locally.
 */

import { expect, test } from "bun:test";
import { DEFAULT_SANDBOX_IMAGE, DERIVED_SANDBOX_IMAGE, SUITE_BINARIES, defaultGateImage, gateExec } from "../src/gate-runner.ts";

let hasDocker = false;
try {
	hasDocker = (await Bun.spawn(["docker", "version"], { stdout: "ignore", stderr: "ignore" }).exited) === 0;
} catch {
	hasDocker = false;
}

/** First run may `docker build` (apt-get over the network); cached runs are near-instant. */
const BUILD_TIMEOUT_MS = 300_000;

test.skipIf(!hasDocker)(
	"defaultGateImage() resolves an image where bare `git` spawns — the exact call shape the incident died on",
	async () => {
		const image = await defaultGateImage();
		expect(image).toBe(DERIVED_SANDBOX_IMAGE); // build succeeded — not the gitless-base fallback
		// The incident's failing call was Bun.spawn(["git", ...]) from test code inside the sandbox.
		// Reproduce that exact shape: spawn bare `git` (PATH resolution, no shell) inside the image.
		const proc = Bun.spawn(["docker", "run", "--rm", image, "git", "--version"], { stdout: "pipe", stderr: "pipe" });
		const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		expect(await proc.exited).toBe(0);
		expect(out).toContain("git version");
		expect(err).not.toContain("Executable not found");
	},
	BUILD_TIMEOUT_MS,
);

test.skipIf(!hasDocker)(
	"suite-critical binaries contract: every SUITE_BINARIES entry resolves in the derived image",
	async () => {
		// The empirical rule from gate-runner.ts: the image must carry every binary the repo's own
		// suite spawns. One probe run, all binaries — a missing one prints MISSING:<name> and fails.
		const image = await defaultGateImage();
		const probe = SUITE_BINARIES.map((b) => `command -v ${b} >/dev/null || { echo "MISSING:${b}"; exit 1; }`).join("\n");
		const proc = Bun.spawn(["docker", "run", "--rm", image, "bash", "-lc", probe], { stdout: "pipe", stderr: "pipe" });
		const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		expect(`${out}${err}`).not.toContain("MISSING:");
		expect(await proc.exited).toBe(0);
	},
	BUILD_TIMEOUT_MS,
);

test.skipIf(!hasDocker)(
	"jq runs in the derived image — the ompsq-434 continue-loop hook regression",
	async () => {
		// scripts/continue-loop.sh parses its stdin/oracle with jq; with jq missing its stdout was
		// EOF-empty and every verify visit died in tests/continue-loop-hook.test.ts.
		const image = await defaultGateImage();
		const proc = Bun.spawn(["docker", "run", "--rm", image, "bash", "-lc", `echo '{"decision":"block"}' | jq -r .decision`], { stdout: "pipe", stderr: "ignore" });
		const out = await new Response(proc.stdout).text();
		expect(await proc.exited).toBe(0);
		expect(out.trim()).toBe("block");
	},
	BUILD_TIMEOUT_MS,
);

test.skipIf(!hasDocker)(
	"end-to-end auto-mode plan: gateExec (no operator image) plans the git-enabled image, and the documented failure is dead",
	async () => {
		// setup.ts pins OMP_SQUAD_GATE_SANDBOX=host for suite hermeticity; build an explicit auto-mode
		// source here to exercise the REAL default path (real builder, real docker probe).
		const plan = await gateExec("git --version", "/tmp", { source: { PATH: process.env.PATH, HOME: process.env.HOME } as NodeJS.ProcessEnv });
		expect(plan.sandboxed).toBe(true);
		expect(plan.image).toBe(DERIVED_SANDBOX_IMAGE);
		expect(plan.image).not.toBe(DEFAULT_SANDBOX_IMAGE); // the bare base (no git) must never be the auto default again
	},
	BUILD_TIMEOUT_MS,
);

import { expect, test } from "bun:test";
import { DERIVED_SANDBOX_IMAGE, execGatedCommand, GateSandboxUnavailableError, gateExec, gateRunUnrunnable } from "../src/gate-runner.ts";

const HOST_SRC = { PATH: "/usr/bin", HOME: "/home/t", CI: "1", ANTHROPIC_API_KEY: "sk" } as NodeJS.ProcessEnv;

// A docker probe is injected in every test so the plan is deterministic regardless of whether the
// box running the suite actually has docker (this box does not — the fallback path is the default).
const noDocker = () => false;
const hasDocker = () => true;
// An image builder is injected wherever the auto path would otherwise really `docker build` the
// git-enabled default image (the real, docker-gated build is covered in tests/gate-image.test.ts).
const fakeBuild = async () => DERIVED_SANDBOX_IMAGE;

test("host opt-out (OMP_SQUAD_GATE_SANDBOX=host): bash -lc with the scrubbed env — pre-sandbox behavior", async () => {
	const plan = await gateExec("bun test", "/repo", { source: { ...HOST_SRC, OMP_SQUAD_GATE_SANDBOX: "host" }, dockerProbe: hasDocker });
	expect(plan.argv).toEqual(["bash", "-lc", "bun test"]);
	expect(plan.sandboxed).toBe(false);
	expect(plan.env.PATH).toBe("/usr/bin");
	expect(plan.env.ANTHROPIC_API_KEY).toBeUndefined(); // secrets scrubbed either way
});

test("explicit image: docker run with worktree+repo mounts, no network, host-only vars withheld", async () => {
	const plan = await gateExec("bun test", "/wt/x", {
		mounts: ["/repo"],
		source: { ...HOST_SRC, OMP_SQUAD_GATE_SANDBOX: "oven/bun:1", CARGO_HOME: "/home/t/.cargo" },
		dockerProbe: noDocker, // explicit image must NOT probe — the operator asked for it
	});
	const argv = plan.argv.join(" ");
	expect(plan.sandboxed).toBe(true);
	expect(plan.image).toBe("oven/bun:1");
	expect(plan.argv[0]).toBe("docker");
	expect(argv).toContain("--network none"); // no exfiltration path by default
	expect(argv).toContain("-v /wt/x:/wt/x");
	expect(argv).toContain("-v /repo:/repo"); // the worktree's gitdir lives in the main repo
	expect(argv).toContain("-w /wt/x");
	expect(argv).toContain("-e CI=1");
	expect(argv).toContain("-e CARGO_HOME=/home/t/.cargo");
	expect(argv).not.toContain("-e PATH="); // the image's own PATH must win
	expect(argv).not.toContain("ANTHROPIC_API_KEY"); // secrets never reach the container
	expect(plan.argv.slice(-4)).toEqual(["oven/bun:1", "bash", "-lc", "bun test"]);
	expect(plan.env.PATH).toBe("/usr/bin"); // the docker CLIENT still runs with host PATH
});

test("sandbox network override + duplicate mounts collapse", async () => {
	const plan = await gateExec("true", "/repo", {
		mounts: ["/repo"],
		source: { OMP_SQUAD_GATE_SANDBOX: "img", OMP_SQUAD_GATE_SANDBOX_NETWORK: "bridge" } as NodeJS.ProcessEnv,
	});
	const argv = plan.argv.join(" ");
	expect(argv).toContain("--network bridge");
	expect(argv.match(/-v \/repo:\/repo/g)?.length).toBe(1);
});

test("auto (default) + docker PRESENT: sandbox with the git-enabled derived image, no explicit env needed", async () => {
	const plan = await gateExec("bun test", "/wt/x", { mounts: ["/repo"], source: { ...HOST_SRC }, dockerProbe: hasDocker, imageBuilder: fakeBuild });
	expect(plan.sandboxed).toBe(true);
	expect(plan.image).toBe(DERIVED_SANDBOX_IMAGE); // NOT the bare base image — it has no git (ompsq-432)
	expect(plan.argv[0]).toBe("docker");
	expect(plan.argv.slice(-3)).toEqual(["bash", "-lc", "bun test"]);
});

test("auto (default) + docker PRESENT: OMP_SQUAD_GATE_SANDBOX_IMAGE is honored verbatim and never triggers the derived build", async () => {
	let built = false;
	const plan = await gateExec("bun test", "/wt/x", {
		source: { ...HOST_SRC, OMP_SQUAD_GATE_SANDBOX_IMAGE: "my/repo-toolchain:2" },
		dockerProbe: hasDocker,
		imageBuilder: async () => {
			built = true;
			return DERIVED_SANDBOX_IMAGE;
		},
	});
	expect(plan.sandboxed).toBe(true);
	expect(plan.image).toBe("my/repo-toolchain:2"); // operator contract: their image, as named
	expect(plan.argv).toContain("my/repo-toolchain:2");
	expect(built).toBe(false); // no surprise docker build behind an explicit operator choice
});

test("auto (default) + docker PRESENT: a failed derived build degrades to whatever the builder resolves (never throws)", async () => {
	// The real builder resolves the BARE base image on build failure (warn-once, legible). The plan
	// layer must treat that as an ordinary image, keeping the gate sandboxed rather than erroring out.
	const plan = await gateExec("bun test", "/wt/x", { source: { ...HOST_SRC }, dockerProbe: hasDocker, imageBuilder: async () => "oven/bun:1" });
	expect(plan.sandboxed).toBe(true);
	expect(plan.image).toBe("oven/bun:1");
	expect(plan.degraded).toBe(true); // marked so gateRunUnrunnable can refuse a failed run in the bare image
});

test("an operator-NAMED image is never marked degraded, even when it equals the bare base", async () => {
	const plan = await gateExec("bun test", "/wt/x", { source: { ...HOST_SRC, OMP_SQUAD_GATE_SANDBOX_IMAGE: "oven/bun:1" }, dockerProbe: hasDocker });
	expect(plan.image).toBe("oven/bun:1");
	expect(plan.degraded).toBeUndefined(); // the operator chose it — their contract, not a fallback
});

// ── gateRunUnrunnable — the shared unrunnable-gate classifier ───────────────────────────────────

test("gateRunUnrunnable: exit 127 is unrunnable regardless of output", () => {
	expect(gateRunUnrunnable({ code: 127, output: "" })).toContain("127");
	expect(gateRunUnrunnable({ code: 127, output: "12 pass\n1 fail" })).toContain("127"); // top-level 127 wins: the COMMAND could not run
});

test("gateRunUnrunnable: executable-not-found shapes with no test executed are unrunnable", () => {
	expect(gateRunUnrunnable({ code: 1, output: 'error: Executable not found in $PATH: "git"' })).toContain("executable");
	expect(gateRunUnrunnable({ code: 1, output: "bash: line 1: jq: command not found" })).toContain("executable");
	expect(gateRunUnrunnable({ code: 1, output: "'npm' is not recognized as an internal or external command" })).toContain("executable");
});

test("gateRunUnrunnable: a run whose output carries bun's 'N pass' marker is NEVER unrunnable — the suite demonstrably executed", () => {
	// A real red suite whose captured failure text contains "command not found" (fixtures testing
	// missing-binary handling) must be judged on its failures, not misread as an env failure.
	expect(gateRunUnrunnable({ code: 1, output: "expected 'command not found' in output\n 2071 pass\n 1 fail" })).toBeUndefined();
});

test("gateRunUnrunnable: zero tests executed on a test gate is unrunnable — only for confidently parseable shapes", () => {
	expect(gateRunUnrunnable({ code: 1, output: "The following filters did not match any test files" }, "bun run check && bun run test")).toContain("zero tests");
	expect(gateRunUnrunnable({ code: 1, output: "Ran 0 tests across 0 files." }, "bun test")).toContain("zero tests");
	// Not a test gate => the zero-tests signal never fires (a build command legitimately runs no tests).
	expect(gateRunUnrunnable({ code: 1, output: "Ran 0 tests across 0 files." }, "cargo build")).toBeUndefined();
	// No command context => conservative, no zero-tests classification.
	expect(gateRunUnrunnable({ code: 1, output: "Ran 0 tests across 0 files." })).toBeUndefined();
});

test("gateRunUnrunnable: a failed run in a DEGRADED bare-image sandbox with no test executed is unrunnable", () => {
	expect(gateRunUnrunnable({ code: 1, output: "some inscrutable failure", degraded: true })).toContain("DEGRADED");
	// ...but if tests demonstrably ran, even a degraded sandbox produced a judgeable red.
	expect(gateRunUnrunnable({ code: 1, output: " 30 pass\n 2 fail", degraded: true })).toBeUndefined();
});

test("gateRunUnrunnable: green runs and ordinary red runs are runnable", () => {
	expect(gateRunUnrunnable({ code: 0, output: "" })).toBeUndefined();
	expect(gateRunUnrunnable({ code: 1, output: "(fail) new.test.ts > introduced" }, "bun run check && bun run test")).toBeUndefined();
});

test("auto (default) + docker ABSENT: graceful host fallback, stamped sandboxed:false", async () => {
	const plan = await gateExec("bun test", "/wt/x", { source: { ...HOST_SRC }, dockerProbe: noDocker });
	expect(plan.argv).toEqual(["bash", "-lc", "bun test"]); // byte-identical to pre-sandbox host exec
	expect(plan.sandboxed).toBe(false); // the weaker-proof stamp propagates to the Proof record
	expect(plan.image).toBeUndefined();
});

test("STRICT + docker ABSENT: fails closed — refuses to run on the host", async () => {
	await expect(gateExec("bun test", "/wt/x", { source: { OMP_SQUAD_GATE_SANDBOX_STRICT: "1" } as NodeJS.ProcessEnv, dockerProbe: noDocker })).rejects.toBeInstanceOf(GateSandboxUnavailableError);
});

test("STRICT + docker PRESENT: sandboxes normally (no fail-closed)", async () => {
	const plan = await gateExec("bun test", "/wt/x", { source: { OMP_SQUAD_GATE_SANDBOX_STRICT: "1" } as NodeJS.ProcessEnv, dockerProbe: hasDocker, imageBuilder: fakeBuild });
	expect(plan.sandboxed).toBe(true);
	expect(plan.image).toBe(DERIVED_SANDBOX_IMAGE);
});

test("STRICT overrides the host opt-out: refuses rather than silently host-running", async () => {
	await expect(gateExec("true", "/repo", { source: { OMP_SQUAD_GATE_SANDBOX: "host", OMP_SQUAD_GATE_SANDBOX_STRICT: "1" } as NodeJS.ProcessEnv, dockerProbe: hasDocker })).rejects.toBeInstanceOf(GateSandboxUnavailableError);
});

test("sandbox runs as the daemon's uid:gid with a writable HOME — container writes must not land root-owned on the host", async () => {
	const plan = await gateExec("bun run build", "/wt/x", { source: { ...HOST_SRC }, dockerProbe: hasDocker, imageBuilder: fakeBuild });
	const argv = plan.argv.join(" ");
	expect(argv).toContain(`--user ${process.getuid!()}:${process.getgid!()}`);
	expect(argv).toContain("-e HOME=/tmp"); // the mapped uid has no passwd entry in the image; `/` is unwritable
});

test("OMP_SQUAD_GATE_SANDBOX_USER overrides the container user verbatim (root restores old behavior)", async () => {
	const plan = await gateExec("true", "/repo", { source: { ...HOST_SRC, OMP_SQUAD_GATE_SANDBOX_USER: "root" }, dockerProbe: hasDocker, imageBuilder: fakeBuild });
	const argv = plan.argv.join(" ");
	expect(argv).toContain("--user root");
	expect(argv).not.toContain(`--user ${process.getuid!()}`);
});

test("OMP_SQUAD_GATE_SANDBOX_DISABLE=1 forces host exec even when docker is present", async () => {
	const plan = await gateExec("true", "/repo", { source: { OMP_SQUAD_GATE_SANDBOX_DISABLE: "1" } as NodeJS.ProcessEnv, dockerProbe: hasDocker });
	expect(plan.argv).toEqual(["bash", "-lc", "true"]);
	expect(plan.sandboxed).toBe(false);
});

test("execGatedCommand runs the command with daemon secrets scrubbed from its env", async () => {
	// The workflow `verify` gate and the main regression gate both run agent-authored scripts through
	// this helper. Force host mode so the assertion is docker-independent; plant a daemon secret and
	// prove the executed child never sees it (gateEnv scrub) while still capturing its output.
	const prevSecret = process.env.PLANE_API_KEY;
	const prevMode = process.env.OMP_SQUAD_GATE_SANDBOX;
	process.env.PLANE_API_KEY = "plane-live-SECRET-must-not-leak";
	process.env.OMP_SQUAD_GATE_SANDBOX = "host";
	try {
		const res = await execGatedCommand("printenv PLANE_API_KEY || true; echo done", process.cwd());
		expect(res.code).toBe(0);
		expect(res.stdout).toContain("done"); // output is captured
		expect(res.stdout).not.toContain("SECRET"); // the daemon secret was scrubbed before exec
	} finally {
		if (prevSecret === undefined) delete process.env.PLANE_API_KEY;
		else process.env.PLANE_API_KEY = prevSecret;
		if (prevMode === undefined) delete process.env.OMP_SQUAD_GATE_SANDBOX;
		else process.env.OMP_SQUAD_GATE_SANDBOX = prevMode;
	}
});

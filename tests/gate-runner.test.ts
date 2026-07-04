import { expect, test } from "bun:test";
import { DEFAULT_SANDBOX_IMAGE, GateSandboxUnavailableError, gateExec } from "../src/gate-runner.ts";

const HOST_SRC = { PATH: "/usr/bin", HOME: "/home/t", CI: "1", ANTHROPIC_API_KEY: "sk" } as NodeJS.ProcessEnv;

// A docker probe is injected in every test so the plan is deterministic regardless of whether the
// box running the suite actually has docker (this box does not — the fallback path is the default).
const noDocker = () => false;
const hasDocker = () => true;

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

test("auto (default) + docker PRESENT: sandbox with the default image, no explicit env needed", async () => {
	const plan = await gateExec("bun test", "/wt/x", { mounts: ["/repo"], source: { ...HOST_SRC }, dockerProbe: hasDocker });
	expect(plan.sandboxed).toBe(true);
	expect(plan.image).toBe(DEFAULT_SANDBOX_IMAGE);
	expect(plan.argv[0]).toBe("docker");
	expect(plan.argv.slice(-3)).toEqual(["bash", "-lc", "bun test"]);
});

test("auto (default) + docker PRESENT: OMP_SQUAD_GATE_SANDBOX_IMAGE picks the default image", async () => {
	const plan = await gateExec("bun test", "/wt/x", { source: { ...HOST_SRC, OMP_SQUAD_GATE_SANDBOX_IMAGE: "my/repo-toolchain:2" }, dockerProbe: hasDocker });
	expect(plan.sandboxed).toBe(true);
	expect(plan.image).toBe("my/repo-toolchain:2");
	expect(plan.argv).toContain("my/repo-toolchain:2");
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
	const plan = await gateExec("bun test", "/wt/x", { source: { OMP_SQUAD_GATE_SANDBOX_STRICT: "1" } as NodeJS.ProcessEnv, dockerProbe: hasDocker });
	expect(plan.sandboxed).toBe(true);
	expect(plan.image).toBe(DEFAULT_SANDBOX_IMAGE);
});

test("STRICT overrides the host opt-out: refuses rather than silently host-running", async () => {
	await expect(gateExec("true", "/repo", { source: { OMP_SQUAD_GATE_SANDBOX: "host", OMP_SQUAD_GATE_SANDBOX_STRICT: "1" } as NodeJS.ProcessEnv, dockerProbe: hasDocker })).rejects.toBeInstanceOf(GateSandboxUnavailableError);
});

test("sandbox runs as the daemon's uid:gid with a writable HOME — container writes must not land root-owned on the host", async () => {
	const plan = await gateExec("bun run build", "/wt/x", { source: { ...HOST_SRC }, dockerProbe: hasDocker });
	const argv = plan.argv.join(" ");
	expect(argv).toContain(`--user ${process.getuid!()}:${process.getgid!()}`);
	expect(argv).toContain("-e HOME=/tmp"); // the mapped uid has no passwd entry in the image; `/` is unwritable
});

test("OMP_SQUAD_GATE_SANDBOX_USER overrides the container user verbatim (root restores old behavior)", async () => {
	const plan = await gateExec("true", "/repo", { source: { ...HOST_SRC, OMP_SQUAD_GATE_SANDBOX_USER: "root" }, dockerProbe: hasDocker });
	const argv = plan.argv.join(" ");
	expect(argv).toContain("--user root");
	expect(argv).not.toContain(`--user ${process.getuid!()}`);
});

test("OMP_SQUAD_GATE_SANDBOX_DISABLE=1 forces host exec even when docker is present", async () => {
	const plan = await gateExec("true", "/repo", { source: { OMP_SQUAD_GATE_SANDBOX_DISABLE: "1" } as NodeJS.ProcessEnv, dockerProbe: hasDocker });
	expect(plan.argv).toEqual(["bash", "-lc", "true"]);
	expect(plan.sandboxed).toBe(false);
});

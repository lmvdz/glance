import { expect, test } from "bun:test";
import { gateExec } from "../src/gate-runner.ts";

const HOST_SRC = { PATH: "/usr/bin", HOME: "/home/t", CI: "1", ANTHROPIC_API_KEY: "sk" } as NodeJS.ProcessEnv;

test("host mode (no sandbox): bash -lc with the scrubbed env — pre-sandbox behavior", () => {
	const plan = gateExec("bun test", "/repo", { source: HOST_SRC });
	expect(plan.argv).toEqual(["bash", "-lc", "bun test"]);
	expect(plan.env.PATH).toBe("/usr/bin");
	expect(plan.env.ANTHROPIC_API_KEY).toBeUndefined(); // secrets scrubbed either way
});

test("sandbox mode: docker run with worktree+repo mounts, no network, host-only vars withheld", () => {
	const plan = gateExec("bun test", "/wt/x", {
		mounts: ["/repo"],
		source: { ...HOST_SRC, OMP_SQUAD_GATE_SANDBOX: "oven/bun:1", CARGO_HOME: "/home/t/.cargo" },
	});
	const argv = plan.argv.join(" ");
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

test("sandbox network override + duplicate mounts collapse", () => {
	const plan = gateExec("true", "/repo", {
		mounts: ["/repo"],
		source: { OMP_SQUAD_GATE_SANDBOX: "img", OMP_SQUAD_GATE_SANDBOX_NETWORK: "bridge" } as NodeJS.ProcessEnv,
	});
	const argv = plan.argv.join(" ");
	expect(argv).toContain("--network bridge");
	expect(argv.match(/-v \/repo:\/repo/g)?.length).toBe(1);
});

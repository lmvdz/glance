import { expect, test } from "bun:test";
import { gateEnv } from "../src/gate-env.ts";

test("gateEnv strips daemon secrets but passes toolchain vars through", () => {
	const env = gateEnv({
		PATH: "/usr/bin",
		HOME: "/home/t",
		CARGO_HOME: "/home/t/.cargo",
		CI: "1",
		ANTHROPIC_API_KEY: "sk-secret",
		PLANE_API_KEY: "plane-secret",
		DATABASE_URL: "postgres://secret",
		AWS_SECRET_ACCESS_KEY: "aws-secret",
		AWS_SESSION_TOKEN: "aws-token",
		MY_SERVICE_PASSWORD: "hunter2",
		GITHUB_TOKEN: "gh-secret",
	});
	expect(env.PATH).toBe("/usr/bin");
	expect(env.HOME).toBe("/home/t");
	expect(env.CARGO_HOME).toBe("/home/t/.cargo");
	expect(env.CI).toBe("1");
	for (const gone of ["ANTHROPIC_API_KEY", "PLANE_API_KEY", "DATABASE_URL", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "MY_SERVICE_PASSWORD", "GITHUB_TOKEN"]) {
		expect(env[gone]).toBeUndefined();
	}
});

test("gateEnv strips every OMP_SQUAD_* var (bearer, coordinator token, flags)", () => {
	const env = gateEnv({
		PATH: "/usr/bin",
		OMP_SQUAD_COORDINATOR_TOKEN: "coord-secret",
		OMP_SQUAD_AUTOLAND: "1",
		OMP_SQUAD_GATE_ENV: "",
	});
	expect(env.PATH).toBe("/usr/bin");
	expect(Object.keys(env).some((k) => k.startsWith("OMP_SQUAD_"))).toBe(false);
});

test("OMP_SQUAD_GATE_ENV re-admits explicitly named vars for suites that need them", () => {
	const env = gateEnv({
		OMP_SQUAD_GATE_ENV: "STRIPE_TEST_API_KEY, INTEGRATION_TOKEN",
		STRIPE_TEST_API_KEY: "sk-test",
		INTEGRATION_TOKEN: "tok",
		OTHER_API_KEY: "still-secret",
	});
	expect(env.STRIPE_TEST_API_KEY).toBe("sk-test");
	expect(env.INTEGRATION_TOKEN).toBe("tok");
	expect(env.OTHER_API_KEY).toBeUndefined();
	expect(env.OMP_SQUAD_GATE_ENV).toBeUndefined(); // the knob itself is not forwarded
});

test("gateEnv skips undefined values and keeps ordinary vars", () => {
	const env = gateEnv({ FOO: "bar", EMPTY: undefined });
	expect(env.FOO).toBe("bar");
	expect("EMPTY" in env).toBe(false);
});

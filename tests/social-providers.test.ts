import { afterEach, expect, test } from "bun:test";
import { authOptions, configuredSocialProviders, signupOpen } from "../src/db/auth.ts";
import { resolveDialect } from "../src/db/index.ts";

// A throwaway in-memory dialect just so authOptions() can be constructed; these tests only read config,
// never migrate or open a connection.
function dialect() {
	return resolveDialect("sqlite::memory:").dialect;
}

const KEYS = ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "OMP_SQUAD_ALLOW_SIGNUP"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

afterEach(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

test("GitHub social provider is gated on BOTH id and secret being present", () => {
	delete process.env.GITHUB_CLIENT_ID;
	delete process.env.GITHUB_CLIENT_SECRET;
	expect(configuredSocialProviders()).toEqual([]);

	// Only one half configured ⇒ still off (no dead button).
	process.env.GITHUB_CLIENT_ID = "id-only";
	expect(configuredSocialProviders()).toEqual([]);
	delete process.env.GITHUB_CLIENT_ID;
	process.env.GITHUB_CLIENT_SECRET = "secret-only";
	expect(configuredSocialProviders()).toEqual([]);

	// Both present ⇒ advertised + wired into better-auth options.
	process.env.GITHUB_CLIENT_ID = "id";
	process.env.GITHUB_CLIENT_SECRET = "secret";
	expect(configuredSocialProviders()).toEqual(["github"]);
	const opts = authOptions({ dialect: dialect(), type: "sqlite" }) as { socialProviders?: { github?: { clientId: string; clientSecret: string } } };
	expect(opts.socialProviders?.github).toEqual({ clientId: "id", clientSecret: "secret" });
});

test("authOptions omits socialProviders entirely when GitHub is unconfigured", () => {
	delete process.env.GITHUB_CLIENT_ID;
	delete process.env.GITHUB_CLIENT_SECRET;
	const opts = authOptions({ dialect: dialect(), type: "sqlite" }) as { socialProviders?: unknown };
	expect("socialProviders" in opts).toBe(false);
});

test("signupOpen mirrors OMP_SQUAD_ALLOW_SIGNUP=1", () => {
	delete process.env.OMP_SQUAD_ALLOW_SIGNUP;
	expect(signupOpen()).toBe(false);
	process.env.OMP_SQUAD_ALLOW_SIGNUP = "0";
	expect(signupOpen()).toBe(false);
	process.env.OMP_SQUAD_ALLOW_SIGNUP = "1";
	expect(signupOpen()).toBe(true);
});

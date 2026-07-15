/**
 * spawn-env.ts — the tenant-agent env scrub, unit-tested against its pure functions plus a
 * mutation-proof, REAL-spawn check per site (no mocked env objects) so a regression that deletes
 * a call site's `env:` option — the implicit-inheritance failure mode this module exists to close —
 * actually fails a test, not just an assertion about a function's return value.
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AcpAgentDriver } from "../src/acp-agent-driver.ts";
import { FlueServiceDriver } from "../src/flue-service-driver.ts";
import { ompOneShot } from "../src/omp-call.ts";
import { hostSpawnEnv, RpcAgent } from "../src/rpc-agent.ts";
import { harnessAuthEnv, isSquadEnvCompatKey, scrubbedSpawnEnv } from "../src/spawn-env.ts";

const tmps: string[] = [];
const drivers: AcpAgentDriver[] = [];
const agents: RpcAgent[] = [];
afterAll(async () => {
	for (const d of drivers) await d.stop().catch(() => {});
	for (const a of agents) await a.stop().catch(() => {});
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

/** Set `process.env[key]` for the duration of `fn`, restoring the prior value (or absence) after —
 *  every mutation-proof test below needs a REAL secret present in process.env to prove it's scrubbed. */
async function withEnv<T>(key: string, value: string, fn: () => Promise<T>): Promise<T> {
	const prior = process.env[key];
	process.env[key] = value;
	try {
		return await fn();
	} finally {
		if (prior === undefined) delete process.env[key];
		else process.env[key] = prior;
	}
}

// ── Unit: scrubbedSpawnEnv ──────────────────────────────────────────────────────────────────────

test("scrubbedSpawnEnv strips both OMP_SQUAD_ and GLANCE_ prefix twins", () => {
	const env = scrubbedSpawnEnv({ PATH: "/usr/bin", OMP_SQUAD_COORDINATOR_TOKEN: "coord-secret", GLANCE_TLS_KEY: "tls-secret", GLANCE_AUTOLAND: "1" });
	expect(env.PATH).toBe("/usr/bin");
	expect(Object.keys(env).some((k) => k.startsWith("OMP_SQUAD_") || k.startsWith("GLANCE_"))).toBe(false);
});

test("scrubbedSpawnEnv strips DATABASE_URL", () => {
	const env = scrubbedSpawnEnv({ PATH: "/usr/bin", DATABASE_URL: "postgres://secret" });
	expect(env.DATABASE_URL).toBeUndefined();
});

test("scrubbedSpawnEnv strips the whole BETTER_AUTH_*/GITHUB_*/WORKOS_*/PLANE_* prefixes, including non-secret-shaped names under them", () => {
	const env = scrubbedSpawnEnv({
		PATH: "/usr/bin",
		BETTER_AUTH_SECRET: "auth-secret", // secret-shaped too — belt and suspenders
		BETTER_AUTH_URL: "https://example.com", // NOT secret-shaped: only the prefix denial catches this
		GITHUB_TOKEN: "gh-secret",
		GITHUB_REPOSITORY: "org/repo", // NOT secret-shaped — CI-style var a tenant agent must not see anyway
		WORKOS_API_KEY: "wk-secret",
		WORKOS_CLIENT_ID: "client-id", // NOT secret-shaped
		PLANE_API_KEY: "plane-secret",
		PLANE_WORKSPACE_SLUG: "my-workspace", // NOT secret-shaped
	});
	expect(env.PATH).toBe("/usr/bin");
	for (const gone of ["BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "GITHUB_TOKEN", "GITHUB_REPOSITORY", "WORKOS_API_KEY", "WORKOS_CLIENT_ID", "PLANE_API_KEY", "PLANE_WORKSPACE_SLUG"]) {
		expect(env[gone]).toBeUndefined();
	}
});

test("scrubbedSpawnEnv strips arbitrary secret-shaped names outside the named prefixes (*_KEY/*_SECRET/*_TOKEN/*_PASSWORD/*_CREDENTIALS)", () => {
	const env = scrubbedSpawnEnv({
		PATH: "/usr/bin",
		STRIPE_SECRET_KEY: "sk-stripe",
		SOME_SERVICE_TOKEN: "tok",
		MY_APP_PASSWORD: "hunter2",
		AWS_CREDENTIALS: "aws-creds",
		X_CREDENTIAL: "singular-variant",
	});
	for (const gone of ["STRIPE_SECRET_KEY", "SOME_SERVICE_TOKEN", "MY_APP_PASSWORD", "AWS_CREDENTIALS", "X_CREDENTIAL"]) {
		expect(env[gone]).toBeUndefined();
	}
});

test("scrubbedSpawnEnv preserves the explicit keep-list (PATH, HOME, SHELL, LANG, LC_*, TERM, TZ) and drops everything else non-secret-shaped by default", () => {
	const env = scrubbedSpawnEnv({
		PATH: "/usr/bin",
		HOME: "/home/t",
		SHELL: "/bin/bash",
		LANG: "en_US.UTF-8",
		LC_ALL: "en_US.UTF-8",
		TERM: "xterm-256color",
		TZ: "UTC",
		RANDOM_TOOLCHAIN_VAR: "not on the keep-list", // narrow keep-list ⇒ dropped, unlike gate-env's pass-through
	});
	expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/t", SHELL: "/bin/bash", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", TERM: "xterm-256color", TZ: "UTC" });
});

test("scrubbedSpawnEnv preserves a deliberately-injected harness key even though its name is secret-shaped", () => {
	const env = scrubbedSpawnEnv({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-would-be-stripped-if-not-injected" }, { ANTHROPIC_API_KEY: "sk-injected" });
	// The base env's own ANTHROPIC_API_KEY is stripped by shape; only the deliberately injected value survives.
	expect(env.ANTHROPIC_API_KEY).toBe("sk-injected");
});

test("scrubbedSpawnEnv skips undefined values in base", () => {
	const env = scrubbedSpawnEnv({ PATH: "/usr/bin", GHOST: undefined });
	expect("GHOST" in env).toBe(false);
});

// ── Unit: runtime-config keep-list additions (concern 01 round-2 audit) ──────────────────────────
// Non-secret proxy/CA/base-URL/runtime-flag vars a harness needs in a proxied/CA/ADC deployment —
// dropped silently before this fix, breaking every harness behind a corporate proxy or custom CA.

test("scrubbedSpawnEnv preserves provider base-URL overrides (proxied/self-hosted-gateway deployments)", () => {
	const env = scrubbedSpawnEnv({
		PATH: "/usr/bin",
		ANTHROPIC_BASE_URL: "https://proxy.internal/anthropic",
		OPENAI_BASE_URL: "https://proxy.internal/openai",
		OPENAI_API_BASE: "https://proxy.internal/openai-legacy",
		GEMINI_BASE_URL: "https://proxy.internal/gemini",
		GOOGLE_GENAI_BASE_URL: "https://proxy.internal/genai",
	});
	expect(env.ANTHROPIC_BASE_URL).toBe("https://proxy.internal/anthropic");
	expect(env.OPENAI_BASE_URL).toBe("https://proxy.internal/openai");
	expect(env.OPENAI_API_BASE).toBe("https://proxy.internal/openai-legacy");
	expect(env.GEMINI_BASE_URL).toBe("https://proxy.internal/gemini");
	expect(env.GOOGLE_GENAI_BASE_URL).toBe("https://proxy.internal/genai");
});

test("scrubbedSpawnEnv preserves CA/TLS vars and NODE_OPTIONS (non-secret runtime config, not credentials)", () => {
	const env = scrubbedSpawnEnv({
		PATH: "/usr/bin",
		NODE_EXTRA_CA_CERTS: "/etc/ssl/corp-ca.pem",
		SSL_CERT_FILE: "/etc/ssl/cert.pem",
		SSL_CERT_DIR: "/etc/ssl/certs",
		NODE_OPTIONS: "--max-old-space-size=8192",
	});
	expect(env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/corp-ca.pem");
	expect(env.SSL_CERT_FILE).toBe("/etc/ssl/cert.pem");
	expect(env.SSL_CERT_DIR).toBe("/etc/ssl/certs");
	expect(env.NODE_OPTIONS).toBe("--max-old-space-size=8192");
});

test("scrubbedSpawnEnv re-admits GOOGLE_APPLICATION_CREDENTIALS (a service-account file PATH, not a secret value) despite matching the *_CREDENTIALS? shape rule", () => {
	const env = scrubbedSpawnEnv({ PATH: "/usr/bin", GOOGLE_APPLICATION_CREDENTIALS: "/var/secrets/vertex-sa.json" });
	expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe("/var/secrets/vertex-sa.json");
});

test("scrubbedSpawnEnv still strips an arbitrary *_CREDENTIALS name that ISN'T the named ADC exception (the shape exception is narrow, not a loosened rule)", () => {
	const env = scrubbedSpawnEnv({ PATH: "/usr/bin", SOME_OTHER_APP_CREDENTIALS: "should-still-be-stripped" });
	expect(env.SOME_OTHER_APP_CREDENTIALS).toBeUndefined();
});

// ── Unit: new deny-by-exact-name secrets (grok audit — shapes the shape regex misses) ────────────

test("scrubbedSpawnEnv strips PGPASSWORD, MYSQL_PWD, AWS_ACCESS_KEY_ID, and DOCKER_AUTH_CONFIG — names the *_KEY/*_SECRET/*_TOKEN/*_PASSWORD/*_CREDENTIALS shape regex does not match", () => {
	const env = scrubbedSpawnEnv({
		PATH: "/usr/bin",
		PGPASSWORD: "pg-secret",
		MYSQL_PWD: "mysql-secret",
		AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
		DOCKER_AUTH_CONFIG: "eyJhdXRocyI6e319",
	});
	expect(env.PATH).toBe("/usr/bin");
	for (const gone of ["PGPASSWORD", "MYSQL_PWD", "AWS_ACCESS_KEY_ID", "DOCKER_AUTH_CONFIG"]) {
		expect(env[gone]).toBeUndefined();
	}
});

test("scrubbedSpawnEnv still strips AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN via the existing shape regex (*_KEY / *_TOKEN) — no regression alongside the new exact-name additions", () => {
	const env = scrubbedSpawnEnv({ PATH: "/usr/bin", AWS_SECRET_ACCESS_KEY: "secret", AWS_SESSION_TOKEN: "session-token" });
	expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
	expect(env.AWS_SESSION_TOKEN).toBeUndefined();
});

// ── Unit: isDaemonSecretEnvKey / isSquadEnvCompatKey (the predicates gate-env.ts now shares) ─────

test("isSquadEnvCompatKey matches both prefixes only", () => {
	expect(isSquadEnvCompatKey("OMP_SQUAD_X")).toBe(true);
	expect(isSquadEnvCompatKey("GLANCE_X")).toBe(true);
	expect(isSquadEnvCompatKey("SOMETHING_ELSE")).toBe(false);
});

test("the deny predicate (via scrubbedSpawnEnv) is true for every deny class and false for ordinary vars", () => {
	// isDaemonSecretEnvKey is not exported (dead-exports ratchet: scrubbedSpawnEnv is its only
	// production caller) — exercise the same deny classes through the public surface instead.
	for (const secret of ["OMP_SQUAD_FOO", "GLANCE_FOO", "DATABASE_URL", "GITHUB_ANYTHING", "PLANE_ANYTHING", "WORKOS_ANYTHING", "BETTER_AUTH_ANYTHING", "FOO_API_KEY", "FOO_SECRET", "FOO_TOKEN", "FOO_PASSWORD", "FOO_CREDENTIALS", "FOO_CREDENTIAL"]) {
		const env = scrubbedSpawnEnv({ PATH: "/usr/bin", [secret]: "value" });
		expect(env[secret]).toBeUndefined();
	}
	// "ordinary" vars that are neither secret-shaped nor on the narrow keep-list: dropped, but for
	// a DIFFERENT reason (not on the keep-list) — assert via the keep-listed PATH/HOME instead, which
	// prove the predicate isn't over-matching and stripping vars it shouldn't.
	const env = scrubbedSpawnEnv({ PATH: "/usr/bin", HOME: "/home/t", CARGO_HOME: "/cargo", NODE_ENV: "test" });
	expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/t" });
});

// ── Unit: harnessAuthEnv ───────────────────────────────────────────────────────────────────────

test("harnessAuthEnv with no harness/model narrows to DEFAULT_PROVIDER's own key only — never a random-shaped var, and never a DIFFERENT provider's key just because it happens to be set", () => {
	const env = harnessAuthEnv({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-a", OPENAI_API_KEY: "sk-o", RANDOM_OTHER_KEY: "not a harness credential" });
	expect(env).toEqual({ ANTHROPIC_API_KEY: "sk-a" });
});

test("harnessAuthEnv(source, 'gemini') passes through only the named LLM-provider credential vars for that vendor that are actually set — never an unrelated var", () => {
	const env = harnessAuthEnv({ PATH: "/usr/bin", GOOGLE_API_KEY: "sk-g", GEMINI_API_KEY: "sk-gg", RANDOM_OTHER_KEY: "not a harness credential" }, "gemini");
	expect(env).toEqual({ GOOGLE_API_KEY: "sk-g", GEMINI_API_KEY: "sk-gg" });
});

test("harnessAuthEnv returns empty when none of the named vars are set", () => {
	expect(harnessAuthEnv({ PATH: "/usr/bin" })).toEqual({});
});

// ── Unit: harnessAuthEnv NARROWING by harness/model — concern 01's "keep it narrow" ──────────────
// A multi-provider operator sets every credential; a spawn for harness X must not see provider Y's
// key. The pin the reviewer named directly.

const ALL_PROVIDER_ENV = {
	PATH: "/usr/bin",
	ANTHROPIC_API_KEY: "sk-anthropic",
	OPENAI_API_KEY: "sk-openai",
	GOOGLE_API_KEY: "sk-google",
	GEMINI_API_KEY: "sk-gemini",
	XAI_API_KEY: "sk-xai",
	OPENROUTER_API_KEY: "sk-openrouter",
	AUGMENT_API_KEY: "sk-augment",
};

test("harnessAuthEnv(source, 'codex') admits only OPENAI_API_KEY — not anthropic/google/xai/augment", () => {
	expect(harnessAuthEnv(ALL_PROVIDER_ENV, "codex")).toEqual({ OPENAI_API_KEY: "sk-openai" });
});

test("harnessAuthEnv(source, 'gemini') admits GOOGLE_API_KEY and GEMINI_API_KEY only", () => {
	expect(harnessAuthEnv(ALL_PROVIDER_ENV, "gemini")).toEqual({ GOOGLE_API_KEY: "sk-google", GEMINI_API_KEY: "sk-gemini" });
});

test("harnessAuthEnv(source, 'grok') admits only XAI_API_KEY", () => {
	expect(harnessAuthEnv(ALL_PROVIDER_ENV, "grok")).toEqual({ XAI_API_KEY: "sk-xai" });
});

test("harnessAuthEnv(source, 'auggie') admits only AUGMENT_API_KEY, even though auggie has no ModelLineage", () => {
	expect(harnessAuthEnv(ALL_PROVIDER_ENV, "auggie")).toEqual({ AUGMENT_API_KEY: "sk-augment" });
});

test("harnessAuthEnv(source, 'omp') with no model pin defaults to ANTHROPIC_API_KEY only (omp's own default vendor)", () => {
	expect(harnessAuthEnv(ALL_PROVIDER_ENV, "omp")).toEqual({ ANTHROPIC_API_KEY: "sk-anthropic" });
});

test("harnessAuthEnv(source, 'pi') with no model pin defaults to ANTHROPIC_API_KEY only", () => {
	expect(harnessAuthEnv(ALL_PROVIDER_ENV, "pi")).toEqual({ ANTHROPIC_API_KEY: "sk-anthropic" });
});

test("harnessAuthEnv(source, 'omp', 'openai/gpt-5') follows the PINNED MODEL's real vendor, not omp's default", () => {
	expect(harnessAuthEnv(ALL_PROVIDER_ENV, "omp", "openai/gpt-5")).toEqual({ OPENAI_API_KEY: "sk-openai" });
});

test("harnessAuthEnv(source, 'grok', 'gemini-2.5-pro') follows the pinned model over the harness's static vendor pin", () => {
	// Contrived (grok's ACP command never actually takes a cross-vendor model), but proves model wins.
	expect(harnessAuthEnv(ALL_PROVIDER_ENV, "grok", "gemini-2.5-pro")).toEqual({ GOOGLE_API_KEY: "sk-google", GEMINI_API_KEY: "sk-gemini" });
});

// Round-2 cross-lineage audit (both codex and grok): the PRE-fix behavior of the two tests below was
// "falls back to the full list (honest ignorance, not a narrowing)" — admitting every configured
// provider credential (all 7) to a spawn whose vendor we simply couldn't classify. Both foreign-lineage
// reviewers flagged that as the opposite of narrow: an opencode spawn with no pinned model, or a Flue
// worker's harnessAuthEnv() call with no harness/model at all, walked away with six credentials it
// never asked for. Fixed: unknown lineage now fails closed to DEFAULT_PROVIDER (anthropic) alone —
// ONE key, matching the same honest-default answer omp/pi already used, extended to every
// unclassifiable case instead of being the one narrow exception among several broad ones.

test("harnessAuthEnv(source, 'opencode') — a genuinely multi-vendor harness with no model pin — fails closed to DEFAULT_PROVIDER (anthropic) alone, not the full list", () => {
	expect(harnessAuthEnv(ALL_PROVIDER_ENV, "opencode")).toEqual({ ANTHROPIC_API_KEY: "sk-anthropic" });
});

test("harnessAuthEnv with an unknown harness name and no model fails closed to DEFAULT_PROVIDER (anthropic) alone, not the full list", () => {
	expect(harnessAuthEnv(ALL_PROVIDER_ENV, "some-future-harness")).toEqual({ ANTHROPIC_API_KEY: "sk-anthropic" });
});

test("harnessAuthEnv() with NO harness and NO model at all (the Flue-worker call shape, flue-service-driver.ts) fails closed to DEFAULT_PROVIDER (anthropic) alone, not the full list", () => {
	expect(harnessAuthEnv(ALL_PROVIDER_ENV)).toEqual({ ANTHROPIC_API_KEY: "sk-anthropic" });
});

test("harnessAuthEnv for a known-vendor ACP harness (gemini) returns exactly its ONE vendor's key set, never the other providers' keys", () => {
	const env = harnessAuthEnv(ALL_PROVIDER_ENV, "gemini");
	expect(env).toEqual({ GOOGLE_API_KEY: "sk-google", GEMINI_API_KEY: "sk-gemini" });
	for (const leaked of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY", "AUGMENT_API_KEY"]) {
		expect(env[leaked]).toBeUndefined();
	}
});

// ── Mutation proof: real spawns at all four sites, each with a real DATABASE_URL in process.env ──

test("mutation proof (flue-service-driver.ts): the fourth tenant-agent spawn — a flue worker — never sees DATABASE_URL, even though it prefers the worker repo's OWN node_modules/.bin/flue", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-spawn-env-flue-"));
	tmps.push(dir);
	const dumpPath = path.join(dir, "env.json");
	const script = path.join(dir, "fake-flue-envdump.ts");
	await fs.writeFile(script, `require("fs").writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify(process.env));\nconsole.log(JSON.stringify({ ok: true }));\n`);

	await withEnv("DATABASE_URL", "postgres://mutation-proof-flue", async () => {
		const driver = new FlueServiceDriver({ dir, workflow: "w", target: "node", buildInvocation: () => ({ bin: "bun", args: [script] }) });
		await driver.start();
		await driver.prompt("{}");
		await driver.stop();
	});

	const dumped = JSON.parse(await fs.readFile(dumpPath, "utf8")) as Record<string, string>;
	expect(dumped.DATABASE_URL).toBeUndefined();
	expect(dumped.PATH).toBeDefined(); // sanity: the worker still got a usable env
});

test("mutation proof (omp-call.ts): a real one-shot child spawned via ompOneShot never sees DATABASE_URL", async () => {
	await withEnv("DATABASE_URL", "postgres://mutation-proof-omp-call", async () => {
		const { out, code } = await ompOneShot([], { bin: "env" });
		expect(code).toBe(0);
		expect(out).not.toContain("DATABASE_URL");
		expect(out).toContain("PATH="); // sanity: the child still got a usable env, not an empty one
	});
});

/** A fake `omp --mode rpc` child: dumps its own env to `dumpPath` before doing anything else, emits
 *  the ready frame agent-host.ts waits on, then answers get_state so RpcAgent.start() can complete. */
function fakeOmpEnvDump(dumpPath: string): string {
	return `#!/usr/bin/env bun
require("fs").writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify(process.env));
console.log(JSON.stringify({ type: "ready" }));
const decoder = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
	buf += decoder.decode(chunk, { stream: true });
	let nl;
	while ((nl = buf.indexOf("\\n")) >= 0) {
		const line = buf.slice(0, nl).trim();
		buf = buf.slice(nl + 1);
		if (!line) continue;
		let f; try { f = JSON.parse(line); } catch { continue; }
		if (f.type === "get_state") console.log(JSON.stringify({ type: "response", id: f.id, success: true, command: "get_state", data: {} }));
	}
}
`;
}

test("mutation proof (agent-host.ts): the real omp child agent-host spawns never sees DATABASE_URL", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-spawn-env-host-"));
	tmps.push(dir);
	const binPath = path.join(dir, "fake-omp-envdump.ts");
	const dumpPath = path.join(dir, "env.json");
	await fs.writeFile(binPath, fakeOmpEnvDump(dumpPath));
	await fs.chmod(binPath, 0o755);
	const socket = path.join(dir, "agent.sock");

	await withEnv("DATABASE_URL", "postgres://mutation-proof-agent-host", async () => {
		const agent = new RpcAgent({ id: `spawn-env-host-${Date.now().toString(36)}`, cwd: dir, bin: binPath, socket, approvalMode: "yolo", thinking: "minimal" });
		agents.push(agent);
		await agent.start(20_000);
		await agent.stop();
		const dumped = JSON.parse(await fs.readFile(dumpPath, "utf8")) as Record<string, string>;
		expect(dumped.DATABASE_URL).toBeUndefined();
		expect(dumped.PATH).toBeDefined(); // sanity: the child still got a usable env
	});
});

// ── Unit + smoke: hostSpawnEnv (rpc-agent.ts) — the OUTER `bun agent-host-main.ts` spawn's own env ──
//
// Round-2 cross-lineage audit (both codex and grok, independently, CRITICAL): `RpcAgent.spawnHost`
// passed `{ ...process.env }` verbatim to the detached agent-host process — the daemon's FULL env,
// `DATABASE_URL`/`BETTER_AUTH_SECRET`/the voice boot secret (`OMP_SQUAD_SECRETS_KEY`/
// `GLANCE_SECRETS_KEY`) included. A same-uid tenant process can read that straight back out of
// `/proc/<host-pid>/environ` — the kernel's immutable snapshot of a process's environ at exec time —
// even after secrets.ts deletes the key from the DAEMON's own `process.env` at boot: deleting a
// runtime `process.env` entry can never retroactively edit an already-exec'd process's kernel environ.
// Fixed: `spawnHost` now routes through `hostSpawnEnv`, the SAME `scrubbedSpawnEnv` the inner tenant
// omp/pi child already uses, narrowed to exactly what `agent-host-main.ts`'s transitive imports read
// from `process.env` (state-dir.ts's `GLANCE_STATE_DIR`/`OMP_SQUAD_STATE_DIR`, and the ONE provider
// credential the inner child's own `harnessAuthEnv` call will need) — see rpc-agent.ts's doc on
// `hostSpawnEnv` for the full grep-verified inventory.

test("hostSpawnEnv strips DATABASE_URL, BETTER_AUTH_SECRET, and the voice master key (both OMP_SQUAD_SECRETS_KEY and its GLANCE_ twin) from the outer agent-host-main.ts spawn", () => {
	const env = hostSpawnEnv({
		PATH: "/usr/bin",
		DATABASE_URL: "postgres://daemon-secret",
		BETTER_AUTH_SECRET: "auth-secret",
		OMP_SQUAD_SECRETS_KEY: "voice-master-key-legacy",
		GLANCE_SECRETS_KEY: "voice-master-key-canonical",
	});
	for (const gone of ["DATABASE_URL", "BETTER_AUTH_SECRET", "OMP_SQUAD_SECRETS_KEY", "GLANCE_SECRETS_KEY"]) {
		expect(env[gone]).toBeUndefined();
	}
	expect(env.PATH).toBe("/usr/bin"); // sanity: the host still gets a usable env, not an empty one
});

test("hostSpawnEnv re-admits GLANCE_STATE_DIR/OMP_SQUAD_STATE_DIR under BOTH names despite the OMP_SQUAD_*/GLANCE_* prefix denial — agent-host-main.ts resolves its OWN socket dir via state-dir.ts (pruneStaleSockets) and must agree with the daemon's, or a custom state dir (every test run) leaves it scanning the wrong directory for its opportunistic stale-socket GC", () => {
	const env = hostSpawnEnv({ PATH: "/usr/bin", OMP_SQUAD_STATE_DIR: "/tmp/glance-test-state-abc" });
	expect(env.OMP_SQUAD_STATE_DIR).toBe("/tmp/glance-test-state-abc");
	expect(env.GLANCE_STATE_DIR).toBe("/tmp/glance-test-state-abc");
});

test("hostSpawnEnv prefers GLANCE_STATE_DIR over OMP_SQUAD_STATE_DIR when both are set, matching resolveStateDir's own precedence", () => {
	const env = hostSpawnEnv({ PATH: "/usr/bin", GLANCE_STATE_DIR: "/tmp/canonical", OMP_SQUAD_STATE_DIR: "/tmp/legacy" });
	expect(env.GLANCE_STATE_DIR).toBe("/tmp/canonical");
	expect(env.OMP_SQUAD_STATE_DIR).toBe("/tmp/canonical");
});

test("hostSpawnEnv omits GLANCE_STATE_DIR/OMP_SQUAD_STATE_DIR entirely when neither is set in source (nothing to mirror, no spurious injection)", () => {
	const env = hostSpawnEnv({ PATH: "/usr/bin" });
	expect("GLANCE_STATE_DIR" in env).toBe(false);
	expect("OMP_SQUAD_STATE_DIR" in env).toBe(false);
});

test("hostSpawnEnv narrows the injected provider credential to the harness's own vendor — a 'codex' host spawn carries OPENAI_API_KEY forward for agent-host.ts's own harnessAuthEnv call, never the operator's other configured provider keys", () => {
	const env = hostSpawnEnv({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-anthropic", OPENAI_API_KEY: "sk-openai", GOOGLE_API_KEY: "sk-google" }, "codex");
	expect(env.OPENAI_API_KEY).toBe("sk-openai");
	expect(env.ANTHROPIC_API_KEY).toBeUndefined();
	expect(env.GOOGLE_API_KEY).toBeUndefined();
});

test("mutation proof (rpc-agent.ts spawnHost, host env): a real agent-host spawn boots successfully with DATABASE_URL, BETTER_AUTH_SECRET, and the voice master key all present in the daemon's env — the new outer-spawn scrub doesn't break the host (the required 'agent-host still starts' smoke), and the inner tenant child still never sees any of the three", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-spawn-env-host-secrets-"));
	tmps.push(dir);
	const binPath = path.join(dir, "fake-omp-envdump.ts");
	const dumpPath = path.join(dir, "env.json");
	await fs.writeFile(binPath, fakeOmpEnvDump(dumpPath));
	await fs.chmod(binPath, 0o755);
	const socket = path.join(dir, "agent.sock");

	const secrets = { DATABASE_URL: "postgres://host-env-smoke", BETTER_AUTH_SECRET: "auth-secret-smoke", OMP_SQUAD_SECRETS_KEY: "voice-master-key-smoke" };
	const prev: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(secrets)) {
		prev[k] = process.env[k];
		process.env[k] = v;
	}
	try {
		const agent = new RpcAgent({ id: `spawn-env-host-secrets-${Date.now().toString(36)}`, cwd: dir, bin: binPath, socket, approvalMode: "yolo", thinking: "minimal" });
		agents.push(agent);
		await agent.start(20_000); // must not throw — the host still boots fine with the scrubbed env
		await agent.stop();
		const dumped = JSON.parse(await fs.readFile(dumpPath, "utf8")) as Record<string, string>;
		for (const k of Object.keys(secrets)) expect(dumped[k]).toBeUndefined();
		expect(dumped.PATH).toBeDefined();
	} finally {
		for (const [k, v] of Object.entries(prev)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
});

// ── Mutation proof: the round-3 hole — a tenant worktree's OWN bunfig.toml/preload, one level above ─
//    the scrubbed omp/pi child (RpcAgent.spawnHost's `bun agent-host-main.ts` process itself) ────────
//
// Bun auto-loads a `bunfig.toml` from a process's spawn cwd and RUNS its `preload` scripts before the
// entry file's own imports execute — verified empirically (not asserted): `bun <absolute-entry-path>`
// run from a cwd containing `bunfig.toml` executes that cwd's preload regardless of the entry path
// form, and a cwd WITHOUT its own `bunfig.toml` never picks one up from a parent directory (no upward
// search, unlike package.json resolution). Before the fix, `RpcAgent.spawnHost` ran `bun
// agent-host-main.ts` with `cwd: this.opts.cwd` (the TENANT worktree) and the daemon's full,
// unscrubbed `process.env` (documented at rpc-agent.ts, "env is passed EXPLICITLY as the live
// process.env") — so a tenant repo committing `bunfig.toml` + a preload script got that preload
// executed inside the HOST process, with every daemon secret, before `runAgentHost`'s own scrub
// (`scrubbedSpawnEnv`) ever applied to the inner omp/pi child one level down.
//
// The SAME `bunfig.toml` also legitimately fires a second time, inside the INNER omp/pi child itself
// (agent-host.ts's own `Bun.spawn` also uses `cwd: opts.cwd` — the tenant worktree, by necessity, since
// that's where the agent operates) — but that spawn's env is already `scrubbedSpawnEnv`-scrubbed, so its
// preload only ever sees the scrubbed env. Per the design ruling this concern operates under ("Scrubbed
// omp/land/vision spawns are fine — their preloads only see the scrubbed env"), that second firing is
// expected and NOT a hole. So the preload here APPENDS one JSON line per invocation (never overwrites —
// overwriting would let the inner child's later, scrubbed-and-safe run silently mask an earlier
// unscrubbed leak from the host) and the assertion covers every captured invocation: DATABASE_URL must
// never appear in ANY of them. If `spawnHost` regresses to `cwd: this.opts.cwd`, the HOST process's
// preload fires first with the daemon's real, unscrubbed env (DATABASE_URL included) and this goes red.
test("mutation proof (rpc-agent.ts spawnHost): a hostile bunfig.toml + preload committed in the tenant worktree never sees DATABASE_URL in ANY invocation, including inside the host process itself", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-spawn-env-bunfig-"));
	tmps.push(dir);
	const leakPath = path.join(dir, "leaked-preload-env.ndjson");
	await fs.writeFile(path.join(dir, "bunfig.toml"), `preload = ["./preload.ts"]\n`);
	await fs.writeFile(path.join(dir, "preload.ts"), `require("fs").appendFileSync(${JSON.stringify(leakPath)}, JSON.stringify(process.env) + "\\n");\n`);

	const binPath = path.join(dir, "fake-omp-envdump.ts");
	const dumpPath = path.join(dir, "env.json");
	await fs.writeFile(binPath, fakeOmpEnvDump(dumpPath));
	await fs.chmod(binPath, 0o755);
	const socket = path.join(dir, "agent.sock");

	await withEnv("DATABASE_URL", "postgres://mutation-proof-bunfig-preload", async () => {
		const agent = new RpcAgent({ id: `spawn-env-bunfig-${Date.now().toString(36)}`, cwd: dir, bin: binPath, socket, approvalMode: "yolo", thinking: "minimal" });
		agents.push(agent);
		await agent.start(20_000);
		await agent.stop();

		// Sanity: the tenant's actual omp/pi child (the legitimately-scrubbed inner spawn) still ran fine
		// and still never saw DATABASE_URL — the fix didn't just move the leak, it closed it.
		const dumped = JSON.parse(await fs.readFile(dumpPath, "utf8")) as Record<string, string>;
		expect(dumped.DATABASE_URL).toBeUndefined();
		expect(dumped.PATH).toBeDefined();

		// Every captured preload invocation (host process and/or inner child, however many fired) never
		// saw DATABASE_URL — the property this test exists to prove, independent of firing count.
		const raw = await fs.readFile(leakPath, "utf8").catch(() => "");
		const invocations = raw
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l) as Record<string, string>);
		expect(invocations.length).toBeGreaterThan(0); // sanity: the hostile preload really did fire at least once (via the inner child)
		for (const env of invocations) expect(env.DATABASE_URL).toBeUndefined();
	});
});

/** A minimal ACP agent that dumps its env to `dumpPath` before anything else, then answers the
 *  handshake (`initialize`, `session/new`) so `start()` resolves. */
function fakeAcpEnvDump(dumpPath: string): string {
	return String.raw`
require("fs").writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify(process.env));
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let buf = "";
process.stdin.on("data", (ch) => {
  buf += ch;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const { id, method } = msg;
    if (method === "initialize") send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: {} } });
    else if (method === "session/new") send({ jsonrpc: "2.0", id, result: { sessionId: "s1" } });
    else if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
  }
});
`;
}

test("mutation proof (acp-agent-driver.ts): the real ACP child — the site with NO env option at all, i.e. today's implicit full inheritance — never sees DATABASE_URL", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-spawn-env-acp-"));
	tmps.push(dir);
	const script = path.join(dir, "fake-acp-envdump.ts");
	const dumpPath = path.join(dir, "env.json");
	await fs.writeFile(script, fakeAcpEnvDump(dumpPath));

	await withEnv("DATABASE_URL", "postgres://mutation-proof-acp", async () => {
		const driver = new AcpAgentDriver({ cwd: dir, command: ["bun", script] });
		drivers.push(driver);
		await driver.start();
		await driver.stop();
		const dumped = JSON.parse(await fs.readFile(dumpPath, "utf8")) as Record<string, string>;
		expect(dumped.DATABASE_URL).toBeUndefined();
		expect(dumped.PATH).toBeDefined(); // sanity: the child still got a usable env
	});
});

test("mutation proof (acp-agent-driver.ts, hardened): a real spawn-time environ carrying DATABASE_URL — not a process.env runtime mutation — never survives the scrub", async () => {
	// The proof above sets DATABASE_URL via `process.env.X = …` at TEST runtime (withEnv). Bun.spawn
	// without an `env` option inherits the process's ORIGINAL environ, not runtime process.env
	// mutations (documented at rpc-agent.ts:164) — so deleting acp-agent-driver.ts's `env:` option
	// entirely (the exact regression this module exists to catch) makes the child inherit an environ
	// that never had DATABASE_URL in it, and the proof above stays green even with the scrub gone.
	// This version runs the driver inside a CHILD bun process whose own environ genuinely carries
	// DATABASE_URL from its creation (the same shape as the daemon's real process.env) — deleting the
	// scrub then makes the grandchild inherit that real environ and this test goes red for real.
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-spawn-env-acp-hardened-"));
	tmps.push(dir);
	const acpScript = path.join(dir, "fake-acp-envdump.ts");
	const dumpPath = path.join(dir, "env.json");
	await fs.writeFile(acpScript, fakeAcpEnvDump(dumpPath));

	const acpDriverPath = path.join(import.meta.dir, "..", "src", "acp-agent-driver.ts");
	const harnessPath = path.join(dir, "harness.ts");
	await fs.writeFile(
		harnessPath,
		[
			`import { AcpAgentDriver } from ${JSON.stringify(acpDriverPath)};`,
			`const driver = new AcpAgentDriver({ cwd: ${JSON.stringify(dir)}, command: ["bun", ${JSON.stringify(acpScript)}] });`,
			`await driver.start();`,
			`await driver.stop();`,
		].join("\n"),
	);

	const proc = Bun.spawn(["bun", harnessPath], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		// This IS the grandchild's real process-start environ — not a runtime mutation — exactly what
		// the daemon's own process.env looks like when it spawns an ACP unit.
		env: { ...process.env, DATABASE_URL: "postgres://mutation-proof-acp-hardened" },
	});
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const code = await proc.exited;
	if (code !== 0) throw new Error(`harness process failed (exit ${code}):\n${err}\n${out}`);

	const dumped = JSON.parse(await fs.readFile(dumpPath, "utf8")) as Record<string, string>;
	expect(dumped.DATABASE_URL).toBeUndefined();
	expect(dumped.PATH).toBeDefined(); // sanity: the grandchild still got a usable env
});

test("mutation proof (acp-agent-driver.ts): the harness's own provider key DOES survive the scrub when set, via the deliberate injection allowance", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-spawn-env-acp-key-"));
	tmps.push(dir);
	const script = path.join(dir, "fake-acp-envdump.ts");
	const dumpPath = path.join(dir, "env.json");
	await fs.writeFile(script, fakeAcpEnvDump(dumpPath));

	await withEnv("ANTHROPIC_API_KEY", "sk-mutation-proof-harness-key", async () => {
		const driver = new AcpAgentDriver({ cwd: dir, command: ["bun", script] });
		drivers.push(driver);
		await driver.start();
		await driver.stop();
		const dumped = JSON.parse(await fs.readFile(dumpPath, "utf8")) as Record<string, string>;
		expect(dumped.ANTHROPIC_API_KEY).toBe("sk-mutation-proof-harness-key");
	});
});

test("mutation proof (acp-agent-driver.ts): a spawn for harness 'codex' never sees ANTHROPIC_API_KEY, even though the operator has it set for a DIFFERENT unit's harness — the narrowing pin", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-spawn-env-acp-narrow-"));
	tmps.push(dir);
	const script = path.join(dir, "fake-acp-envdump.ts");
	const dumpPath = path.join(dir, "env.json");
	await fs.writeFile(script, fakeAcpEnvDump(dumpPath));

	const prevAnthropic = process.env.ANTHROPIC_API_KEY;
	const prevOpenai = process.env.OPENAI_API_KEY;
	process.env.ANTHROPIC_API_KEY = "sk-anthropic-belongs-to-a-different-unit";
	process.env.OPENAI_API_KEY = "sk-openai-this-codex-spawn-needs";
	try {
		const driver = new AcpAgentDriver({ cwd: dir, command: ["bun", script], harness: "codex" });
		drivers.push(driver);
		await driver.start();
		await driver.stop();
		const dumped = JSON.parse(await fs.readFile(dumpPath, "utf8")) as Record<string, string>;
		expect(dumped.OPENAI_API_KEY).toBe("sk-openai-this-codex-spawn-needs");
		expect(dumped.ANTHROPIC_API_KEY).toBeUndefined();
	} finally {
		if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
		else process.env.ANTHROPIC_API_KEY = prevAnthropic;
		if (prevOpenai === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = prevOpenai;
	}
});

// ── Mutation proof: `bun install` PROVISIONING spawns are tenant repo content too ────────────────
//
// `installNodeModules` (worktree.ts) and `SquadManager.installWorker` (squad-manager.ts) run `bun
// install` in a TENANT repo directory — its root `package.json` can declare a `postinstall` script.
// Bun blocks *dependency* lifecycle scripts by default but always runs the project's OWN scripts, so
// a hostile tenant repo's postinstall runs under whatever env `bun install` was spawned with, at
// provisioning time, before any agent even starts. Confirmed empirically (not asserted): a real
// `bun install` with no `env` option lets a planted postinstall read `DATABASE_URL` straight out of
// the inherited environ.
//
// Both proofs below use the SAME hardened shape as the ACP "hardened" proof above, for the SAME
// reason: `Bun.spawn` without an `env` option inherits the process's ORIGINAL start-time environ, not
// runtime `process.env` mutations (`withEnv` here, or rpc-agent.ts:164's note) — so a naive proof that
// sets `process.env.DATABASE_URL` at test runtime and then calls `installNodeModules`/`installWorker`
// directly stays green even with the scrub deleted (verified: it does). Each proof instead spawns a
// CHILD bun process whose own environ genuinely carries `DATABASE_URL` from process creation — the
// same shape as the daemon's real `process.env` — and calls the function under test from inside that
// child, so a deleted scrub makes the grandchild `bun install` inherit the real secret for real.

/** Writes a `package.json` with a `postinstall` script that dumps `process.env` to `leakPath`, plus
 *  the script itself. No dependencies, so `bun install` never needs the network — the postinstall
 *  hook alone is what's under test. */
async function writePostinstallProbe(dir: string, leakPath: string): Promise<void> {
	await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "postinstall-probe", version: "0.0.0", scripts: { postinstall: "bun leak.ts" } }));
	await fs.writeFile(path.join(dir, "leak.ts"), `require("fs").writeFileSync(${JSON.stringify(leakPath)}, JSON.stringify(process.env));\n`);
}

/** Runs `harnessScript` in a child bun process whose real spawn-time environ carries
 *  `DATABASE_URL=value` (not a runtime `process.env` mutation), and asserts it exits 0. */
async function runHardenedHarness(harnessPath: string, script: string, value: string): Promise<void> {
	await fs.writeFile(harnessPath, script);
	const proc = Bun.spawn(["bun", harnessPath], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, DATABASE_URL: value },
	});
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const code = await proc.exited;
	if (code !== 0) throw new Error(`harness process failed (exit ${code}):\n${err}\n${out}`);
}

test("mutation proof (worktree.ts installNodeModules): a hostile tenant repo's root postinstall never sees DATABASE_URL", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-spawn-env-postinstall-"));
	tmps.push(dir);
	const leakPath = path.join(dir, "leaked-env.json");
	await writePostinstallProbe(dir, leakPath);

	const worktreePath = path.join(import.meta.dir, "..", "src", "worktree.ts");
	const harnessPath = path.join(dir, "harness.ts");
	await runHardenedHarness(
		harnessPath,
		[
			`import { installNodeModules } from ${JSON.stringify(worktreePath)};`,
			`const err = await installNodeModules(${JSON.stringify(dir)});`,
			`if (err) throw new Error("installNodeModules failed: " + err);`,
		].join("\n"),
		"postgres://mutation-proof-postinstall",
	);

	const leaked = JSON.parse(await fs.readFile(leakPath, "utf8")) as Record<string, string>;
	expect(leaked.DATABASE_URL).toBeUndefined();
	expect(leaked.PATH).toBeDefined(); // sanity: bun install still had a usable env, not an empty one
});

test("mutation proof (squad-manager.ts installWorker): a hostile flue-worker repo's root postinstall never sees DATABASE_URL", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-spawn-env-postinstall-worker-"));
	tmps.push(dir);
	const leakPath = path.join(dir, "leaked-env.json");
	await writePostinstallProbe(dir, leakPath);

	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-spawn-env-postinstall-worker-state-"));
	tmps.push(stateDir);

	const squadManagerPath = path.join(import.meta.dir, "..", "src", "squad-manager.ts");
	const harnessPath = path.join(dir, "harness.ts");
	// installWorker is private — reached through the real call site (cast, same as production code
	// never does) instead of reimplementing its body, so a regression that drops ITS `env:` option
	// (not just installNodeModules') fails this test too.
	await runHardenedHarness(
		harnessPath,
		[
			`import { SquadManager } from ${JSON.stringify(squadManagerPath)};`,
			`const mgr = new SquadManager({ stateDir: ${JSON.stringify(stateDir)} });`,
			`await mgr.installWorker(${JSON.stringify(dir)});`,
		].join("\n"),
		"postgres://mutation-proof-postinstall-worker",
	);

	const leaked = JSON.parse(await fs.readFile(leakPath, "utf8")) as Record<string, string>;
	expect(leaked.DATABASE_URL).toBeUndefined();
	expect(leaked.PATH).toBeDefined(); // sanity: the install still had a usable env, not an empty one
});

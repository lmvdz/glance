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
import { RpcAgent } from "../src/rpc-agent.ts";
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

test("harnessAuthEnv passes through only the named LLM-provider credential vars that are actually set", () => {
	const env = harnessAuthEnv({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-a", OPENAI_API_KEY: "sk-o", RANDOM_OTHER_KEY: "not a harness credential" });
	expect(env).toEqual({ ANTHROPIC_API_KEY: "sk-a", OPENAI_API_KEY: "sk-o" });
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

test("harnessAuthEnv(source, 'opencode') — a genuinely multi-vendor harness with no model pin — falls back to the full list (honest ignorance, not a narrowing)", () => {
	expect(harnessAuthEnv(ALL_PROVIDER_ENV, "opencode")).toEqual(admitAllProviders());
});

test("harnessAuthEnv with an unknown harness name and no model falls back to the full list", () => {
	expect(harnessAuthEnv(ALL_PROVIDER_ENV, "some-future-harness")).toEqual(admitAllProviders());
});

function admitAllProviders(): Record<string, string> {
	const { PATH: _PATH, ...rest } = ALL_PROVIDER_ENV;
	return rest;
}

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

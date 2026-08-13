/**
 * The disposable FIXTURE TENANT generator (B5 #394, on G2 #386's fidelity resolution).
 *
 * Mints a fresh foreign-stack repo per run — NEVER a fork of ~/atrium, NEVER a committed
 * node_modules, NEVER a built artifact. It reproduces the gate CLASSES atrium's shape defines and
 * that R2 #384 proved the old detection path gets wrong, and nothing deeper (17 migrations, Better
 * Auth, three surfaces add fidelity the RAIL never sees). The classes, per #386:
 *
 *   1. `pnpm install --frozen-lockfile` — a real pnpm workspace with a committed lockfile. GENUINELY
 *      REAL and hermetic: a zero-dependency workspace resolves offline in ~200ms, so this exercises
 *      the real pnpm class (killing the bun-install literals — R2 gap S) without a network fetch.
 *   2. a `typecheck` gate (tsc-shape) — discovered via the CONTRACT, not by package.json name-matching.
 *   3. a `lint` gate (Biome-shape) — the class detection was BLIND to (R2: Biome invisible).
 *   4. a `test` gate (Vitest-shape) with an ASSERTED count — the `--passWithNoTests` killer.
 *   5. an integration gate needing a docker-compose Postgres with a real healthcheck (R2 gap L).
 *   6. a count-asserting CI-style script (`node scripts/assert-counts.mjs`) — atrium's discipline in
 *      miniature (asserts on counts and sets, not exit codes).
 *
 * HONESTY NOTE — what is real vs. representational, stated rather than implied (narrowed after the B5
 * gauntlet's H-2). THREE classes are fully real end to end:
 *   - gate 1 runs real pnpm against a real committed lockfile (offline);
 *   - the R6 `test` gate runs a REAL test-runner BINARY (`bun test`) over REAL `.test.ts` files with
 *     REAL assertions, so its count assertion is checked against a genuine runner summary, not a
 *     printed one (the H-2 fix — "a real tool executed", not just "the parser parsed");
 *   - gate 5 brings up a real Postgres via real `docker compose --wait` and connects with a real `psql`.
 * The remaining classes (typecheck / lint / ci-counts, and the R2 Vitest-shape refusal gate) are
 * PARSER-SEAM exercises: committed node scripts that emit the canonical toolchain OUTPUT (`name=count`
 * lines, a Vitest summary line) `readGateEvidence` consumes. That is deliberate and inside the rail's
 * own documented guarantee (tenant-gates.ts: "a builder controls its own gate's stdout … the real
 * defense is the hermetic sandbox + independent reviewer, not this parser") — the rail is a
 * parser-not-executor and never ran tsc/biome/vitest itself even for glance. What R6 proves, exactly:
 * the rail parses a foreign tenant's gate output AND lands a green contract via a real merge, real
 * pnpm, a REAL test-runner, and real compose Postgres — NOT that a real tsc/Biome binary executed
 * (those stay simulated, and the claim is narrowed to say so). Rigging is a committed
 * `gates/control.json` the real scripts read — a "red fixture" is a real repo really producing the
 * rigged output, not a stub.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeRepoPath } from "../../src/project-registry.ts";
import { openTenantGateRegistry } from "../../src/tenant-gate-registry.ts";
import { decodeTenantGateManifest, type TenantGate, type TenantGateManifest } from "../../src/tenant-gates.ts";

// ── The rig ───────────────────────────────────────────────────────────────────────────────────────

/** How each committed gate script behaves — written to `gates/control.json`, read by the scripts. A
 *  rigged-red row mutates one field; the script then really produces that output. */
export interface FixtureControl {
	typecheck?: { exit?: number };
	lint?: { exit?: number };
	/** `tests` is how many the Vitest-shape summary claims ran; `0` emits the real zero-marker phrasing. */
	vitest?: { exit?: number; tests?: number };
	counts?: { files?: number; cases?: number; exit?: number };
}

const GREEN_CONTROL: Required<FixtureControl> = {
	typecheck: { exit: 0 },
	lint: { exit: 0 },
	vitest: { exit: 0, tests: 12 },
	counts: { files: 3, cases: 12, exit: 0 },
};

export interface FixtureTenant {
	/** The main checkout (a real git repo on `main`). Also the registry key. */
	repo: string;
	/** A worktree checked out on {@link workBranch}, one landable commit ahead of `main`. */
	worktree: string;
	workBranch: string;
	/** `main`'s HEAD at mint time — the sha a refused land must roll back to. */
	head0: string;
	/** Remove every temp dir this fixture created. */
	cleanup(): Promise<void>;
}

async function run(cmd: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
	const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}
async function git(cwd: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return run(["git", "-C", cwd, ...args], cwd);
}

// ── The committed fixture files ─────────────────────────────────────────────────────────────────

/** A gate script that reads `gates/control.json` and emits canonical toolchain output at the rigged
 *  exit code. Real Node, run by real pnpm — the rail sees exactly what a real toolchain would print. */
function typecheckScript(): string {
	return `import { readFileSync } from "node:fs";
const c = JSON.parse(readFileSync(new URL("./control.json", import.meta.url), "utf8"));
// A tsc-shape gate: a real (tiny) source scan, then the summary. Discovered by the CONTRACT's
// "typecheck" gate, not by package.json name-matching — the point of the class.
process.stdout.write("tsc: 2 workspace projects, 0 errors\\n");
// F1 (gauntlet): set exitCode and let the process exit NATURALLY — process.exit() can terminate before
// the async stdout buffer flushes under PIPED capture (the rail's gate runner pipes stdout), dropping
// this summary. A proof that lands or refuses on flush-timing is no proof.
process.exitCode = c.typecheck?.exit ?? 0;
`;
}
function lintScript(): string {
	return `import { readFileSync } from "node:fs";
const c = JSON.parse(readFileSync(new URL("./control.json", import.meta.url), "utf8"));
// Biome-shape: the class detection was BLIND to (R2 — Biome invisible to package.json guessing).
process.stdout.write("biome: checked 4 files, no fixes applicable\\n");
process.exitCode = c.lint?.exit ?? 0; // F1: natural exit flushes piped stdout; process.exit() can truncate it
`;
}
function vitestScript(): string {
	return `import { readFileSync } from "node:fs";
const c = JSON.parse(readFileSync(new URL("./control.json", import.meta.url), "utf8"));
const tests = c.vitest?.tests ?? 12;
const exit = c.vitest?.exit ?? 0;
// The canonical Vitest summary shapes readGateEvidence(parser:"vitest") consumes. A tests:0 rig emits
// the real zero-marker phrasing, so the rail proves ZERO ran rather than trusting exit 0.
if (tests === 0) {
  process.stdout.write("\\n No test files found, exiting with code 0\\n");
} else {
  process.stdout.write(" Test Files  2 passed (2)\\n");
  process.stdout.write("      Tests  " + tests + " passed (" + tests + ")\\n");
}
process.exitCode = exit; // F1: natural exit flushes piped stdout; process.exit() can truncate it
`;
}
function assertCountsScript(): string {
	return `import { readFileSync } from "node:fs";
const c = JSON.parse(readFileSync(new URL("../gates/control.json", import.meta.url), "utf8"));
// atrium's CI discipline in miniature: asserts on COUNTS and SETS, emitted as name=count lines the
// rail's counts-script parser reads and checks against the manifest's exactCounts.
process.stdout.write("files=" + (c.counts?.files ?? 3) + "\\n");
process.stdout.write("cases=" + (c.counts?.cases ?? 12) + "\\n");
process.exitCode = c.counts?.exit ?? 0; // F1: natural exit flushes piped stdout; process.exit() can truncate it
`;
}

async function writeFixtureFiles(repo: string, control: FixtureControl): Promise<void> {
	const merged: FixtureControl = {
		typecheck: { ...GREEN_CONTROL.typecheck, ...control.typecheck },
		lint: { ...GREEN_CONTROL.lint, ...control.lint },
		vitest: { ...GREEN_CONTROL.vitest, ...control.vitest },
		counts: { ...GREEN_CONTROL.counts, ...control.counts },
	};
	const write = async (rel: string, body: string): Promise<void> => {
		const full = path.join(repo, rel);
		await fs.mkdir(path.dirname(full), { recursive: true });
		await fs.writeFile(full, body);
	};

	await write("package.json", `${JSON.stringify(
		{
			name: "glance-fixture-tenant",
			private: true,
			version: "0.0.0",
			// The manifest's gate commands are the pnpm invocations below — proving pnpm-as-runner and
			// contract-declared discovery, not package.json name-matching.
			scripts: { typecheck: "node gates/typecheck.mjs", lint: "node gates/lint.mjs", test: "node gates/vitest.mjs" },
		},
		null,
		2,
	)}\n`);
	await write("pnpm-workspace.yaml", `packages:\n  - "packages/*"\n`);
	await write(".gitignore", "node_modules/\n");
	await write("tsconfig.json", `${JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "esnext", target: "esnext" } }, null, 2)}\n`);
	await write("biome.json", `${JSON.stringify({ $schema: "https://biomejs.dev/schemas/1.0.0/schema.json", linter: { enabled: true } }, null, 2)}\n`);
	await write("README.md", "# glance-fixture-tenant\n\nA disposable foreign-stack fixture minted by B5 #394. Not a fork of atrium.\n");

	// Two real workspace projects with REAL test files (>=2 projects, literally). The R6 `test` gate
	// runs `bun test` over these — a REAL runner executing REAL assertions, 3 cases total (a:2 + b:1),
	// so the count assertion (minTests) is checked against a genuine summary, not a printed one (H-2).
	const testCases: Record<string, string[]> = {
		a: [`test("a is 1", () => { expect(a).toBe(1); });`, `test("a doubled is 2", () => { expect(a * 2).toBe(2); });`],
		b: [`test("b is 2", () => { expect(b).toBe(2); });`],
	};
	for (const pkg of ["a", "b"]) {
		const val = pkg === "a" ? 1 : 2;
		await write(`packages/${pkg}/package.json`, `${JSON.stringify({ name: `@fixture/${pkg}`, version: "0.0.0", private: true }, null, 2)}\n`);
		await write(`packages/${pkg}/index.ts`, `export const ${pkg}: number = ${val};\n`);
		await write(
			`packages/${pkg}/${pkg}.test.ts`,
			`import { test, expect } from "bun:test";\nimport { ${pkg} } from "./index.ts";\n${testCases[pkg]!.join("\n")}\n`,
		);
	}

	await write("gates/typecheck.mjs", typecheckScript());
	await write("gates/lint.mjs", lintScript());
	await write("gates/vitest.mjs", vitestScript());
	await write("scripts/assert-counts.mjs", assertCountsScript());
	await write("gates/control.json", `${JSON.stringify(merged, null, 2)}\n`);
}

// ── Mint ────────────────────────────────────────────────────────────────────────────────────────

export interface MintOptions {
	control?: FixtureControl;
	/** Register the fixture's manifest into a glance-side registry at this stateDir — the authority
	 *  round-trip (register → get → drive) the whole tenant capability rests on. */
	register?: { stateDir: string; manifest: TenantGateManifest };
	/**
	 * The repo directory basename (M-1: run-unique teardown scoping). The rail derives its compose
	 * project name from `basename(gate cwd)`, so a run-unique label makes every container/network this
	 * fixture's gates create share a `glance-gate-<sanitized-label>-*` prefix — which a teardown sweep
	 * can target WITHOUT touching a concurrent suite's or a live daemon's `glance-gate-*` resources.
	 * Alphanumeric only (the rail strips the rest); defaults to a random run-unique token.
	 */
	label?: string;
}

/** The compose project prefix the rail will use for a fixture minted with `label` — mirrors the
 *  rail's own basename sanitization (tenant-services.ts). A teardown sweep filters on exactly this. */
export function composeProjectPrefix(label: string): string {
	const sanitized = label.replace(/[^a-z0-9]+/gi, "").toLowerCase().slice(0, 20) || "t";
	return `glance-gate-${sanitized}`;
}

/**
 * Mint a fresh fixture tenant: a real git repo on `main` with the foreign-stack files committed, a
 * generated + committed `pnpm-lock.yaml`, and a `work` branch (in its own worktree) one landable
 * commit ahead — the scratch branch a green land merges into `main`.
 */
export async function mintFixtureTenant(opts: MintOptions = {}): Promise<FixtureTenant> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "glance-fixture-"));
	// The repo basename becomes the rail's compose-project prefix (M-1 scoping). Sanitize to what the
	// rail keeps so the dir name and the derived project prefix cannot drift.
	const label = (opts.label ?? `b5${Math.random().toString(36).slice(2, 10)}`).replace(/[^a-z0-9]+/gi, "").toLowerCase().slice(0, 20) || "t";
	const repo = path.join(root, label);
	await fs.mkdir(repo, { recursive: true });
	const tmps = [root];

	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.email", "fixture@glance.test");
	await git(repo, "config", "user.name", "glance-fixture");
	await git(repo, "config", "commit.gpgsign", "false");

	await writeFixtureFiles(repo, opts.control ?? {});

	// Generate the lockfile in the tree (offline, zero deps) so `pnpm install --frozen-lockfile` at gate
	// time has a real lockfile to validate against — then commit it, but NEVER node_modules (.gitignore'd).
	const lock = await run(["pnpm", "install", "--lockfile-only"], repo);
	if (lock.code !== 0) throw new Error(`fixture: pnpm lockfile generation failed (is pnpm installed?): ${lock.stderr || lock.stdout}`);
	await fs.rm(path.join(repo, "node_modules"), { recursive: true, force: true }).catch(() => undefined);

	await git(repo, "add", "-A");
	const commit = await git(repo, "commit", "-qm", "fixture: foreign-stack tenant base");
	if (commit.code !== 0) throw new Error(`fixture: base commit failed: ${commit.stderr || commit.stdout}`);
	const head0 = (await git(repo, "rev-parse", "HEAD")).stdout;

	// The scratch `work` branch + its worktree, one trivial commit ahead — what a green land merges.
	await git(repo, "branch", "work");
	const wtParent = await fs.mkdtemp(path.join(os.tmpdir(), "glance-fixture-wt-"));
	tmps.push(wtParent);
	const worktree = path.join(wtParent, "work");
	const wt = await git(repo, "worktree", "add", "-q", worktree, "work");
	if (wt.code !== 0) throw new Error(`fixture: worktree add failed: ${wt.stderr || wt.stdout}`);
	await fs.writeFile(path.join(worktree, "CHANGELOG.md"), "- landable change from the scratch branch\n");
	await git(worktree, "add", "-A");
	await git(worktree, "commit", "-qm", "work: a landable change");

	if (opts.register) {
		const reg = openTenantGateRegistry(opts.register.stateDir);
		const result = reg.register(opts.register.manifest);
		if (result !== "registered") throw new Error(`fixture: manifest registration returned "${result}" (expected "registered")`);
	}

	return {
		repo,
		worktree,
		workBranch: "work",
		head0,
		async cleanup() {
			// Detach the worktree admin link first so its temp dir can be removed cleanly.
			await git(repo, "worktree", "remove", "--force", worktree).catch(() => undefined);
			for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
		},
	};
}

// ── Manifest builders ───────────────────────────────────────────────────────────────────────────
//
// The gate CLASSES as TenantGate objects, so each matrix row composes exactly the gates it needs and
// the rigging (control + manifest) sits together. `sandboxStrict:false` on the composed manifests lets
// the host-pinned suite (tests/setup.ts pins OMP_SQUAD_GATE_SANDBOX=host) run the plain gates on the
// host; the integration gate carries its own per-gate runnerImage, which overrides the host pin so it
// runs sandboxed on the compose network (the production service path).

const DEFAULT_TIMEOUT_MS = 120_000;

export const gatePnpmInstall: TenantGate = {
	name: "install",
	command: "pnpm install --frozen-lockfile",
	timeoutMs: DEFAULT_TIMEOUT_MS,
	expects: { exit: 0, parser: "raw" },
};
export const gateTypecheck: TenantGate = {
	name: "typecheck",
	command: "pnpm typecheck",
	timeoutMs: DEFAULT_TIMEOUT_MS,
	expects: { exit: 0, parser: "raw" },
};
export const gateLint: TenantGate = {
	name: "lint",
	command: "pnpm lint",
	timeoutMs: DEFAULT_TIMEOUT_MS,
	expects: { exit: 0, parser: "raw" },
};
/** The Vitest-SHAPE gate — a parser-seam exercise (emits a canonical Vitest summary). Used by R2 to
 *  drive the `count-violated` refusal against the vitest parser. */
export function gateVitest(minTests: number): TenantGate {
	return { name: "test", command: "pnpm test", timeoutMs: DEFAULT_TIMEOUT_MS, expects: { exit: 0, parser: "vitest", minTests } };
}
/**
 * The REAL test-runner gate (H-2): a genuine `bun test` binary over the fixture's REAL `.test.ts`
 * files with REAL assertions (3 cases: a×2 + b×1). The count assertion is checked against a real
 * runner summary, not a printed one. Scoped to the two files so the run count is deterministic.
 */
export function gateRealBunTest(minTests: number): TenantGate {
	return { name: "test", command: "bun test packages/a/a.test.ts packages/b/b.test.ts", timeoutMs: DEFAULT_TIMEOUT_MS, expects: { exit: 0, parser: "bun-test", minTests } };
}
/** The count-asserting CI script gate. */
export function gateCountsScript(exactCounts: Record<string, number>): TenantGate {
	return { name: "ci-counts", command: "node scripts/assert-counts.mjs", timeoutMs: DEFAULT_TIMEOUT_MS, expects: { exit: 0, parser: "counts-script", exactCounts } };
}
/**
 * The integration gate: a docker-compose Postgres with a real pg_isready healthcheck, plus a
 * per-gate `runnerImage` (postgres:16 — it carries bash + psql) so the gate runs sandboxed ON the
 * compose network and reaches the service by name. A real `psql select` proves connectivity and emits
 * a `rows=N` count the manifest asserts. On a host without docker this whole gate refuses
 * service-unavailable (R3) — never a host fallback.
 */
export function gateIntegrationPostgres(): TenantGate {
	return {
		name: "integration",
		// On the joined compose network the service is reachable as <name>:<container-port>; the rail
		// publishes GLANCE_SERVICE_DB_HOST/PORT, and we fall back to db:5432 (the compose defaults).
		command:
			'H="${GLANCE_SERVICE_DB_HOST:-db}"; P="${GLANCE_SERVICE_DB_PORT:-5432}"; ' +
			'pg_isready -h "$H" -p "$P" -U postgres && ' +
			"n=$(PGPASSWORD=postgres psql -h \"$H\" -p \"$P\" -U postgres -d postgres -tAc 'select count(*) from (values (1),(2),(3)) v'); " +
			'echo "rows=$n"',
		timeoutMs: DEFAULT_TIMEOUT_MS,
		expects: { exit: 0, parser: "counts-script", exactCounts: { rows: 3 } },
		requires: {
			services: [{ name: "db", image: "postgres:16", healthcheckCommand: "pg_isready -U postgres", healthcheckRetries: 30, healthcheckIntervalMs: 1000, env: { POSTGRES_PASSWORD: "postgres" }, ports: ["5432"] }],
			runnerImage: "postgres:16",
		},
	};
}
/**
 * R3's rigged gate: declares a required compose service but NO runnerImage, so the docker probe lands
 * inside `startGateServices` and refuses `service-unavailable` whether docker is ABSENT (probe false)
 * or PRESENT-but the service cannot start (a deliberately-unpullable image → compose `up --wait`
 * fails). Either way the refusal code is the same and the gate command NEVER runs — the marker touch
 * would land in the repo only on an (impossible) host fallback, so the test asserts its absence.
 */
export function gateServiceUnstartable(): TenantGate {
	return {
		name: "integration",
		command: "touch R3_MARKER_RAN; echo rows=3",
		timeoutMs: 30_000,
		expects: { exit: 0, parser: "counts-script", exactCounts: { rows: 3 } },
		requires: { services: [{ name: "db", image: "glance-fixture-refused.invalid/no-such-postgres:v0", healthcheckCommand: "pg_isready -U postgres", healthcheckRetries: 1, healthcheckIntervalMs: 1000, env: { POSTGRES_PASSWORD: "postgres" }, ports: ["5432"] }] },
	};
}

/** R5's gate: a command whose binary/script is missing from the repo entirely → exit 127 /
 *  "No such file or directory" → `command-unregistered` (the end-to-end cousin of the named
 *  `{ ok:true, skipped:true }` defect — a registered gate whose command does not exist must refuse,
 *  never report a pass). */
export function gateMissingCommand(): TenantGate {
	return { name: "typecheck", command: "bash ./gates/does-not-exist.sh", timeoutMs: DEFAULT_TIMEOUT_MS, expects: { exit: 0, parser: "raw" } };
}

/** The DECLARED-but-refused Playwright/e2e gate (#386's omission list): declares a runnerImage; on a
 *  host that cannot provide it the gate REFUSES runner-unavailable — browsers are never fetched, the
 *  gate never silently skips. `image` is deliberately unpullable so the refusal is deterministic even
 *  where docker IS present. */
export function gatePlaywrightRefused(image = "glance-fixture-refused.invalid/no-such-runner:v0"): TenantGate {
	return { name: "e2e", command: "pnpm exec playwright test", timeoutMs: DEFAULT_TIMEOUT_MS, expects: { exit: 0, parser: "raw" }, requires: { runnerImage: image } };
}

/** Decode a composed manifest through the REAL contract schema — a fixture that does not decode is a
 *  test bug, so this throws rather than returning a half-manifest. */
export function assembleManifest(repo: string, gates: TenantGate[], policy?: TenantGateManifest["policy"]): TenantGateManifest {
	const decoded = decodeTenantGateManifest({ version: 1, repo: normalizeRepoPath(repo), gates, policy: { sandboxStrict: false, ...policy } });
	if (!("manifest" in decoded)) throw new Error(`fixture manifest must decode: ${decoded.error}`);
	return decoded.manifest;
}

/** The full six-class GREEN manifest (R6). */
export function greenManifest(repo: string): TenantGateManifest {
	return assembleManifest(repo, [
		gatePnpmInstall,
		gateTypecheck,
		gateLint,
		gateRealBunTest(3), // H-2: a REAL runner over real .test.ts, not a printed summary
		gateIntegrationPostgres(),
		gateCountsScript({ files: 3, cases: 12 }),
	]);
}

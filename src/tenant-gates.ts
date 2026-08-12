/**
 * TenantGateManifest — the contract by which a tenant repo declares its gates to the rail.
 *
 * WHY THIS EXISTS (G3 #387, on R2 #384's measured gap list): until now the rail GUESSED a tenant's
 * gates. `detectVerifyStages` (intake.ts) reads package.json for a script literally named
 * `typecheck`/`check`/`test`, joins them with `&&`, and every land path treats that guess as the
 * gate. For glance's own repo that guess happens to be right. For a foreign tenant it is wrong in
 * ways that FAIL OPEN:
 *   - a repo whose scripts are `test:unit` / `ci:counts` / `lint` detects to `[]`, and
 *     `runMainGateUncached` returns `{ ok: true, skipped: true }` — structurally green forever
 *     (squad-manager.ts's no-verify-command path);
 *   - a Vitest suite run with `--passWithNoTests` exits 0 having executed nothing, and the
 *     bun-shaped `ZERO_TESTS_RE` (gate-runner.ts) cannot see it — so the land is trusted;
 *   - a gate that needs a composed Postgres runs unsandboxed on the daemon host when docker is
 *     absent, against whatever database the host happens to have.
 *
 * AUTHORITY (the load-bearing decision): the manifest is GLANCE-SIDE and human-registered. A
 * `.glance/gates.json` file in the tenant repo is permitted as registration INPUT — a human reads
 * and approves it, like a PR review — but at land time the validator consults ONLY the glance-side
 * record. The unit whose work is being gated must not be able to edit the gate; a tenant-repo file
 * consulted at land time is fail-open by construction, because an agent with write access to the
 * repo has write access to its own gate.
 *
 * SEMANTICS: fail-closed is not a field, it is the only mode. There is no strictness knob, because
 * R2 measured what opt-in strictness costs — `OMP_SQUAD_GATE_SANDBOX_STRICT` is daemon-global, so
 * tenant A cannot demand hermetic gates while tenant B stays permissive, and the host-fallback
 * warning is `warnedHostFallback`-guarded once per PROCESS, meaning orgs 2..N are never warned at
 * all. A registered manifest replaces that global policy with a per-org record.
 *
 * WHAT THIS MODULE IS: the schema, its hash, the parser-aware count evaluation, and the distinct
 * refusal vocabulary. It runs nothing — {@link ./tenant-gate-run.ts} executes, and
 * {@link ./tenant-gate-registry.ts} stores. Pure by design so every fail-closed row is unit-testable
 * without docker, a daemon, or a repo.
 *
 * SCHEMA LIBRARY NOTE: G3's resolution says "zod". This repo has no zod dependency and does have an
 * established boundary-decoding convention — Effect `Schema` + `decodeJsonWith` (src/schema/
 * external-json.ts), used by project-registry.ts, plan-proposals.ts, memory/*. A second schema
 * library for one module would be the drift, not the fidelity. Same guarantee, repo's own idiom.
 */

import { createHash } from "node:crypto";
import { Result, Schema } from "effect";
import type { GateStage } from "./intake.ts";
import { detectVerifyStages } from "./intake.ts";

// ── The contract ────────────────────────────────────────────────────────────────────────────────

/**
 * How a gate's output is read for evidence that it ACTUALLY RAN. `raw` asserts nothing beyond the
 * exit code and therefore cannot carry `minTests`/`exactCounts` — declaring counts under `raw` is a
 * decode error, not a silently-ignored field (an ignored count assertion is a fail-open dressed as
 * a contract).
 */
export const GATE_PARSERS = ["bun-test", "vitest", "counts-script", "raw"] as const;
export type GateParser = (typeof GATE_PARSERS)[number];

const GateExpectSchema = Schema.Struct({
	/** Required exit code. Always 0 in practice; explicit so a receipt states what was demanded. */
	exit: Schema.Number,
	parser: Schema.Literals(GATE_PARSERS),
	/** Floor on tests demonstrably executed. The Vitest `--passWithNoTests` killer. */
	minTests: Schema.optional(Schema.Number),
	/**
	 * Exact `name -> count` assertions parsed from the gate's own output (`counts-script`). atrium's
	 * CI asserts counts and sets, not exit codes; this is that discipline expressed in the contract.
	 */
	exactCounts: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
});

const ComposeServiceSchema = Schema.Struct({
	name: Schema.String,
	image: Schema.String,
	/** Shell command run INSIDE the service container; the gate waits for it to succeed. */
	healthcheckCommand: Schema.String,
	healthcheckRetries: Schema.optional(Schema.Number),
	healthcheckIntervalMs: Schema.optional(Schema.Number),
	/** Env for the service container (e.g. POSTGRES_PASSWORD). */
	env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
	/** `host:container` publications, so the gate can reach the service from its own network. */
	ports: Schema.optional(Schema.Array(Schema.String)),
});

const GateRequiresSchema = Schema.Struct({
	services: Schema.optional(Schema.Array(ComposeServiceSchema)),
	/**
	 * A sandbox image this gate cannot run without (Playwright browsers, a pinned Node). Declaring
	 * one makes docker MANDATORY for this gate — absent docker is a refusal, never a host fallback.
	 */
	runnerImage: Schema.optional(Schema.String),
});

const TenantGateSchema = Schema.Struct({
	name: Schema.String,
	command: Schema.String,
	/** Relative to the gate cwd (a workspace package dir). Absent ⇒ the worktree root. */
	cwd: Schema.optional(Schema.String),
	timeoutMs: Schema.Number,
	expects: GateExpectSchema,
	requires: Schema.optional(GateRequiresSchema),
	/** Shell run after the gate regardless of outcome (before service teardown). */
	teardown: Schema.optional(Schema.String),
});

/**
 * Per-tenant replacements for the daemon-global `OMP_SQUAD_GATE_SANDBOX*` env knobs (R2's second
 * seam). A registered tenant's policy BEATS the environment — that is the whole point: the
 * environment belongs to the daemon operator, the policy belongs to the tenant.
 */
const TenantGatePolicySchema = Schema.Struct({
	/** Refuse to run any gate on the host when docker is unavailable. Defaults TRUE for a registered
	 *  manifest — a tenant that registered gates asked for them to mean something. */
	sandboxStrict: Schema.optional(Schema.Boolean),
	sandboxImage: Schema.optional(Schema.String),
	sandboxNetwork: Schema.optional(Schema.String),
	/** Per-tenant env-var names re-admitted into the gate's POSITIVE-allowlist env (round 3, THEME B).
	 *  The gate env is a boundary (only PATH/HOME/… + GLANCE_SERVICE_* by default); a tenant whose
	 *  suite genuinely needs `CARGO_HOME`/`NODE_ENV` names it HERE — an explicit per-tenant act, never
	 *  a denylist that a new secret name slips past. Values still come from the daemon env; this only
	 *  chooses which NAMES cross the boundary. */
	env: Schema.optional(Schema.Array(Schema.String)),
});

export const TenantGateManifestSchema = Schema.Struct({
	/** Bumped when the contract changes shape; an unknown version fails the decode (fail-closed). */
	version: Schema.Literals([1]),
	/** Absolute repo root this manifest governs — the same key `ProjectDTO.id` uses. */
	repo: Schema.String,
	gates: Schema.Array(TenantGateSchema),
	policy: Schema.optional(TenantGatePolicySchema),
	/**
	 * Per-tenant reviewer ledger (R1's subtler coupling: `DEFAULT_REVIEWER_LEDGER_PATH` is pinned to
	 * glance's own tree, so tenant 2's land receipts would cite GLANCE's reviewer precision). Absent
	 * ⇒ the default, which is correct only for tenant zero.
	 */
	reviewerLedgerPath: Schema.optional(Schema.String),
	/** Registration provenance — a human approved this. */
	registeredBy: Schema.optional(Schema.String),
	registeredAt: Schema.optional(Schema.Number),
});

export type TenantGateExpect = typeof GateExpectSchema.Type;
export type TenantComposeService = typeof ComposeServiceSchema.Type;
export type TenantGate = typeof TenantGateSchema.Type;
export type TenantGatePolicy = typeof TenantGatePolicySchema.Type;
export type TenantGateManifest = typeof TenantGateManifestSchema.Type;

const decodeManifest = Schema.decodeUnknownResult(TenantGateManifestSchema);

/**
 * Decode an untrusted manifest value (registration input, persisted record). Returns a reason
 * string instead of a partial object — a manifest that does not decode WHOLE is not a manifest, and
 * half-reading one would produce a gate contract nobody wrote.
 */
export function decodeTenantGateManifest(value: unknown): { manifest: TenantGateManifest } | { error: string } {
	const decoded = decodeManifest(value);
	if (Result.isFailure(decoded)) return { error: `manifest does not match the TenantGateManifest contract: ${String(decoded.failure)}`.slice(0, 400) };
	const manifest = decoded.success;
	const semantic = semanticManifestError(manifest);
	return semantic ? { error: semantic } : { manifest };
}

/**
 * Contract rules the shape check cannot express. Each one exists because violating it would be a
 * fail-open: a count assertion the parser cannot evaluate is a promise the rail cannot keep, and a
 * manifest with no gates would register a repo as "gated" while gating nothing.
 */
function semanticManifestError(m: TenantGateManifest): string | undefined {
	if (m.gates.length === 0) return "manifest declares zero gates — a registered tenant with no gates would read as gated while gating nothing";
	const names = new Set<string>();
	for (const g of m.gates) {
		if (!g.name.trim()) return "a gate has an empty name";
		if (names.has(g.name)) return `duplicate gate name "${g.name}" — per-gate receipts would collide`;
		names.add(g.name);
		if (!g.command.trim()) return `gate "${g.name}" has an empty command`;
		if (g.timeoutMs <= 0) return `gate "${g.name}" has a non-positive timeoutMs`;
		const e = g.expects;
		// H-4 (gauntlet round 1): `expects.exit` is validated to 0, not merely accepted. Equality-only
		// evaluation against an arbitrary value let a manifest declare `exit: 1` and land a broken script
		// green — fail-closed has exactly one passing exit code, and it is 0. The field survives (a
		// receipt that prints `exit: 0` states what was demanded) but only 0 is a legal demand.
		if (e.exit !== 0) return `gate "${g.name}" declares expects.exit ${e.exit} — fail-closed accepts only exit 0 as a pass`;
		if (e.parser === "raw" && (e.minTests !== undefined || e.exactCounts !== undefined)) {
			return `gate "${g.name}" declares count assertions under parser "raw", which reads nothing but the exit code — the assertion could never be evaluated`;
		}
		if (e.minTests !== undefined && e.minTests < 0) return `gate "${g.name}" has a negative minTests`;
		if (e.exactCounts !== undefined && e.parser !== "counts-script") {
			return `gate "${g.name}" declares exactCounts under parser "${e.parser}" — only "counts-script" emits named counts`;
		}
	}
	return undefined;
}

// ── Identity ────────────────────────────────────────────────────────────────────────────────────

/**
 * Stable hash of the CONTRACT (not of its provenance). Stamped into the land receipt so a receipt
 * states WHICH contract it passed — a manifest edited between two lands produces two different
 * hashes, and a receipt from before the edit can never be mistaken for one from after.
 *
 * `registeredBy`/`registeredAt` are excluded deliberately: re-registering an identical contract
 * under a new approver must not invalidate a receipt that proved the same gates.
 */
export function manifestHash(m: TenantGateManifest): string {
	const contract = { version: m.version, repo: m.repo, gates: m.gates, policy: m.policy, reviewerLedgerPath: m.reviewerLedgerPath };
	return createHash("sha256").update(canonicalJson(contract)).digest("hex");
}

/** Key-sorted JSON so a hash depends on the contract's CONTENT, never on object literal order. */
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** The manifest's gates as the `GateStage[]` shape `runProof` already threads (name + command). */
export function manifestStages(m: TenantGateManifest): GateStage[] {
	return m.gates.map((g) => ({ name: g.name, command: g.command }));
}

/** The `&&`-join every proof-freshness fingerprint keys on. One source of truth with the stages. */
export function manifestCommand(m: TenantGateManifest): string {
	return m.gates.map((g) => g.command).join(" && ");
}

/** True when any gate needs docker for reasons beyond hermeticity (a service or a pinned image). */
export function manifestNeedsDocker(m: TenantGateManifest): boolean {
	return m.gates.some((g) => (g.requires?.services?.length ?? 0) > 0 || !!g.requires?.runnerImage);
}

/**
 * A registered manifest is strict unless it explicitly says otherwise. Registration is the act of
 * saying "these gates mean something"; defaulting to permissive would reproduce the daemon-global
 * opt-in strictness R2 found nobody ever opts into.
 */
export function manifestStrict(m: TenantGateManifest): boolean {
	return m.policy?.sandboxStrict !== false;
}

// ── Refusal vocabulary ──────────────────────────────────────────────────────────────────────────

/**
 * Every way a manifest-governed gate can refuse. DISTINCT codes because "it refused" is not a
 * receipt — an operator staring at a blocked land needs to know whether to start docker, fix a
 * test, or register a gate, and a single "gate failed" string answers none of those. G2 #386's
 * rigged-red matrix rows map onto these one-to-one.
 */
export type GateRefusalCode =
	/** R1: the gate ran and exited non-zero. */
	| "gate-red"
	/** R2: exit 0, but fewer tests executed than the contract demands (or none). */
	| "count-violated"
	/** R2 (degenerate): the contract demands a count and the output proves ZERO tests ran. */
	| "zero-tests"
	/** R2 (unparseable): the contract demands a count and the output carries no count at all. */
	| "count-unreadable"
	/** R3: a `requires.services` dependency could not be started or never became healthy. */
	| "service-unavailable"
	/** R4: a gate declared a runner (image/docker) that this host cannot provide. */
	| "runner-unavailable"
	/** R5: the repo is registered but the gate's command does not exist / detection found nothing. */
	| "command-unregistered"
	/** The sandbox degraded to the bare base image — the environment cannot be trusted either way. */
	| "degraded-sandbox";

export interface GateRefusal {
	code: GateRefusalCode;
	/** Human-readable, names the gate, and says what would fix it. */
	reason: string;
}

/**
 * Is this refusal about the ENVIRONMENT (or the registration) rather than about the tenant's code?
 * The Observer files a `regression:` finding for a red gate and classifies an unrunnable one as
 * `gate-unrunnable` — mis-sorting a missing docker daemon into the first bucket manufactures a
 * phantom regression against a branch that is perfectly fine, which is the failure mode
 * `runMainGateUncached`'s own `unrunnable` flag was added for.
 */
export function refusalIsEnvironmental(code: GateRefusalCode): boolean {
	return code === "service-unavailable" || code === "runner-unavailable" || code === "degraded-sandbox" || code === "command-unregistered";
}

// ── Parser-aware evidence extraction ────────────────────────────────────────────────────────────

/** bun test: `12 pass` / `1 fail`, and its two explicit nothing-ran phrasings. `skip`/`todo` are
 *  separate tokens bun never folds into `pass`/`fail`, so summing pass+fail already excludes them. */
const BUN_PASS_RE = /\b(\d+) pass\b/g;
const BUN_FAIL_RE = /\b(\d+) fail\b/g;
const BUN_ZERO_RE = /\bRan 0 tests\b|did not match any test files/i;
/** vitest: the `Tests  1 failed | 11 passed | 1 skipped (13)` summary line, and its zero phrasings. */
const VITEST_TESTS_LINE_RE = /^\s*Tests\s+(.+)$/m;
const VITEST_PASS_FAIL_RE = /(\d+)\s+(passed|failed)\b/g;
const VITEST_ZERO_RE = /No test files found|no tests found|passWithNoTests/i;
/** counts-script: `name=12` or `name: 12`, one per line — the shape a CI assert script emits. */
const COUNTS_LINE_RE = /^\s*([A-Za-z0-9_.:-]+)\s*[=:]\s*(\d+)\s*$/gm;

export interface GateEvidence {
	/** Tests demonstrably executed (passed + failed; skipped/todo do NOT count as ran). `0` means the
	 *  output PROVES none ran; `undefined` means the output carries no readable count — a different,
	 *  equally-refusable thing under a count contract. */
	tests?: number;
	/** Named counts from a counts-script gate. */
	counts?: Record<string, number>;
}

/**
 * Read a gate's output for evidence it ran, under the parser the CONTRACT declares — never guessed
 * from the command string. The bun-only `ZERO_TESTS_RE`/`TESTS_RAN_RE` pair in gate-runner.ts is
 * exactly this function collapsed to one runner; a foreign tenant gets its own row instead of
 * silently inheriting bun's phrasing (R2 fail-open #4).
 *
 * THE GUARANTEE'S REAL SCOPE (opus, round 1, Medium — stated rather than implied): a builder controls
 * its own gate's stdout, so a `tests: N` here proves the runner EMITTED a summary claiming N ran, not
 * that N independent tests truly executed. A determined builder can forge "Tests 9999 passed". This
 * closes the accidental fail-opens (a `--passWithNoTests` run, a stale summary line, skipped counted
 * as ran); it is not, and cannot be, a defense against a builder deliberately forging its own output.
 * The real defense against that is the hermetic sandbox + independent reviewer, not this parser.
 *
 * Two H-3 orderings are load-bearing:
 *   - zero-markers are checked BEFORE any positive line, so a run that prints "No test files found"
 *     AND carries a stale "Tests 3 passed" from earlier output reads as ZERO, not 3.
 *   - only `passed`+`failed` count as ran; `skipped`/`todo` are excluded (vitest's `(N)` total folds
 *     skipped in, so the total is deliberately not used).
 */
export function readGateEvidence(parser: GateParser, output: string): GateEvidence {
	if (parser === "raw") return {};
	if (parser === "counts-script") {
		const counts: Record<string, number> = {};
		COUNTS_LINE_RE.lastIndex = 0;
		for (const m of output.matchAll(COUNTS_LINE_RE)) counts[m[1]!] = Number(m[2]);
		// A counts script may also print a test total; `tests` stays undefined unless it names one.
		const tests = counts.tests;
		return { counts, tests };
	}
	if (parser === "bun-test") {
		if (BUN_ZERO_RE.test(output)) return { tests: 0 }; // zero-markers FIRST
		let total = 0;
		let saw = false;
		for (const re of [BUN_PASS_RE, BUN_FAIL_RE]) {
			re.lastIndex = 0;
			for (const m of output.matchAll(re)) {
				total += Number(m[1]);
				saw = true;
			}
		}
		return saw ? { tests: total } : {};
	}
	// vitest
	if (VITEST_ZERO_RE.test(output)) return { tests: 0 }; // zero-markers FIRST — before any Tests line
	const line = VITEST_TESTS_LINE_RE.exec(output)?.[1];
	if (line) {
		let ran = 0;
		let sawPassFail = false;
		VITEST_PASS_FAIL_RE.lastIndex = 0;
		for (const m of line.matchAll(VITEST_PASS_FAIL_RE)) {
			ran += Number(m[1]);
			sawPassFail = true;
		}
		// A Tests summary that names only `skipped`/`todo` executed nothing — proven zero, not unknown.
		return { tests: sawPassFail ? ran : 0 };
	}
	return {};
}

/**
 * Judge ONE gate run against its declared expectations. `undefined` ⇒ the gate passed its contract.
 *
 * Order matters and is deliberate: a degraded sandbox is checked BEFORE the exit code, because a
 * degraded environment cannot be trusted in either direction (the same reasoning
 * `greenGateUnproven` documents — a bare-image run can print "N pass" for the handful of tests that
 * happened to resolve). Then the exit code, then the counts. A gate that exits 0 having proven
 * nothing is refused as loudly as one that exits 1.
 */
/** Executable-resolution failure shapes across the shells/runtimes a gate runs under. A missing
 *  binary is an ENVIRONMENT fault (retryable), never the tenant's code failing (a permanent wedge). */
const MISSING_BINARY_RE = /Executable not found in \$PATH|command not found|not found in \$PATH|is not recognized as an internal or external command|No such file or directory/i;

export function evaluateGateRun(gate: TenantGate, run: { code: number; output: string; degraded?: boolean }): GateRefusal | undefined {
	if (run.degraded) {
		return { code: "degraded-sandbox", reason: `gate "${gate.name}" ran inside the DEGRADED bare sandbox image — the environment cannot be trusted as evidence either way; fix the sandbox image build and re-run` };
	}
	// H-4 (gauntlet round 1): a missing binary (exit 127, or a non-127 exit whose output shows an
	// executable-resolution failure) is the ENVIRONMENT lacking a tool the gate needs — retryable, and
	// classified `command-unregistered` (which `refusalIsEnvironmental` reads as environmental) rather
	// than `gate-red`. `gate-red` is non-retryable; misfiling a missing binary there wedges the branch
	// permanently against a fault that has nothing to do with its code.
	if (run.code === 127 || MISSING_BINARY_RE.test(run.output)) {
		return { code: "command-unregistered", reason: `gate "${gate.name}" could not execute — the command was not found (exit ${run.code}): ${gate.command}. The environment lacks a binary the gate needs; retryable once it is provisioned.` };
	}
	// Fail-closed has exactly one passing exit code, and the schema already forced `expects.exit` to 0.
	if (run.code !== 0) {
		return { code: "gate-red", reason: `gate "${gate.name}" exited ${run.code}, contract demands 0: ${gate.command}` };
	}
	const { exactCounts, parser } = gate.expects;
	const evidence = readGateEvidence(parser, run.output);
	// H-3: a test parser (bun-test/vitest) requires POSITIVE evidence even when the contract names no
	// explicit floor — declaring `parser: "bun-test"` IS the declaration that this gate runs tests, so
	// an empty run under it is a fail-open, not a pass. `raw`/`counts-script` opt out (raw asserts only
	// the exit; counts-script is judged by `exactCounts` below). An explicit `minTests` raises the bar.
	const effectiveMin = gate.expects.minTests ?? (parser === "bun-test" || parser === "vitest" ? 1 : undefined);
	if (effectiveMin !== undefined) {
		if (evidence.tests === undefined) {
			return { code: "count-unreadable", reason: `gate "${gate.name}" exited 0 but its output carries no readable ${parser} test count, and a test gate must prove at least ${effectiveMin} ran — refusing to accept a pass that proves nothing ran` };
		}
		if (evidence.tests === 0) {
			return { code: "zero-tests", reason: `gate "${gate.name}" exited 0 having executed ZERO tests (must run at least ${effectiveMin}) — the suite never ran` };
		}
		if (evidence.tests < effectiveMin) {
			return { code: "count-violated", reason: `gate "${gate.name}" executed ${evidence.tests} tests, contract demands at least ${effectiveMin} — the suite ran short` };
		}
	}
	if (exactCounts) {
		for (const [key, want] of Object.entries(exactCounts)) {
			const got = evidence.counts?.[key];
			if (got === undefined) {
				return { code: "count-unreadable", reason: `gate "${gate.name}" declares an exact count for "${key}" (${want}) but its output never emitted one — expected a \`${key}=<n>\` line` };
			}
			if (got !== want) {
				return { code: "count-violated", reason: `gate "${gate.name}" reported ${key}=${got}, contract demands ${key}=${want}` };
			}
		}
	}
	return undefined;
}

// ── Registration input (suggest-only detection) ─────────────────────────────────────────────────

/**
 * Build a DRAFT manifest from `detectVerifyStages` for a human to review and register. This is what
 * detection becomes once a repo can be registered: a suggestion, never a gate. The draft is
 * deliberately conservative — `parser: "raw"` and no count assertions, because detection genuinely
 * does not know how many tests a repo has, and inventing a number would be the fabrication the whole
 * contract exists to prevent. A human adds the counts; that act is the registration.
 *
 * Returns undefined when detection recognised no toolchain — there is nothing to suggest.
 */
export async function suggestTenantGateManifest(repo: string): Promise<TenantGateManifest | undefined> {
	const stages = await detectVerifyStages(repo);
	if (!stages.length) return undefined;
	return {
		version: 1,
		repo,
		gates: stages.map((s) => ({
			name: s.name,
			command: s.command,
			timeoutMs: 900_000,
			expects: { exit: 0, parser: "raw" as const },
		})),
	};
}

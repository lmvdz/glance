/**
 * Run a registered TenantGateManifest FAIL-CLOSED — the runner half of the contract.
 *
 * Everything here is a refusal path with a distinct reason. The rule the whole module encodes:
 * a gate that did not demonstrably exercise the tenant's code is a REFUSAL, and it is never
 * quieter than a red one. Concretely, against G2 #386's rigged-red matrix:
 *
 *   R1 gate exits non-zero           → `gate-red`
 *   R2 exit 0, count assertion short → `count-violated` / `zero-tests` / `count-unreadable`
 *   R3 required service absent       → `service-unavailable` (NOT the unsandboxed host fallback)
 *   R4 declared runner unavailable   → `runner-unavailable`
 *   R5 command missing from the repo  → `command-unregistered` (the caller's job — see
 *                                       `manifestGateForMissingCommand`)
 *   R6 all green                     → `ok`, with per-gate counts for the receipt
 *
 * Gates run in DECLARED order and FAIL FAST, mirroring `runProof`'s cheap-first staging: a tenant
 * puts typecheck before its 10-minute integration suite for a reason, and a receipt that says which
 * gate stopped the run (and which never got to run) is more useful than one that says "failed".
 *
 * Teardown is unconditional. A gate's own `teardown` shell runs after the gate whatever happened,
 * then the compose project comes down — including on every refusal path, so a refusing land does
 * not leak containers onto the daemon host.
 */

import { errText } from "./err-text.ts";
import { gateEnv } from "./gate-env.ts";
import { execGatedCommand, GateSandboxUnavailableError, dockerAvailable } from "./gate-runner.ts";
import { startGateServices, type ServiceSpawn } from "./tenant-services.ts";
import {
	evaluateGateRun,
	manifestHash,
	manifestStrict,
	readGateEvidence,
	type GateRefusal,
	type TenantGate,
	type TenantGateManifest,
} from "./tenant-gates.ts";
import * as path from "node:path";

/** One gate's receipt line. `exitCode: null` ⇒ the gate never ran (an earlier gate failed fast). */
export interface ManifestGateResult {
	name: string;
	command: string;
	exitCode: number | null;
	durationMs: number;
	/** Tests the parser could prove executed. Undefined ⇒ the parser reads no count (`raw`). */
	tests?: number;
	/** Named counts from a `counts-script` gate. */
	counts?: Record<string, number>;
	sandboxed?: boolean;
	/** Set only on the gate that refused. */
	refusal?: GateRefusal;
}

export interface ManifestRunOutcome {
	ok: boolean;
	/** The contract this run was judged against — stamped into the receipt. */
	manifestHash: string;
	/** First (and only) refusal; fail-fast means there is at most one. */
	refusal?: GateRefusal;
	results: ManifestGateResult[];
	/** Output tail across the gates that ran, for the proof detail. */
	output: string;
}

/** The exec seam, injected in tests so every refusal row is provable without docker or a repo. */
export type GateCommandRunner = (
	command: string,
	cwd: string,
	opts: { mounts?: string[]; env?: Record<string, string>; policy?: { sandboxStrict?: boolean; sandboxImage?: string; sandboxNetwork?: string }; requireSandbox?: string; timeoutMs?: number },
) => Promise<{ code: number; stdout: string; stderr: string; sandboxed: boolean; degraded?: boolean }>;

export interface ManifestRunOpts {
	manifest: TenantGateManifest;
	/** The worktree the gates run in. */
	cwd: string;
	/** Extra dirs the gate needs mounted (the main repo, for a worktree's `.git` gitdir pointer). */
	mounts?: string[];
	exec?: GateCommandRunner;
	serviceSpawn?: ServiceSpawn;
	dockerProbe?: () => boolean | Promise<boolean>;
	/** Ensure `image` is present on the host, pulling if needed (H-2). Returns false ⇒ unpullable ⇒
	 *  `runner-unavailable`. Injected in tests; production probes docker. */
	ensureImage?: (image: string) => Promise<boolean>;
}

/** Default runner-image provisioning: present already, else one `docker pull`. Missing image with no
 *  registry access ⇒ false ⇒ the gate refuses `runner-unavailable` rather than silently running in the
 *  wrong (default/bun) image (H-2). Never throws. */
async function ensureImagePresent(image: string): Promise<boolean> {
	try {
		const inspect = Bun.spawn(["docker", "image", "inspect", image], { stdout: "ignore", stderr: "ignore" });
		if ((await inspect.exited) === 0) return true;
		const pull = Bun.spawn(["docker", "pull", image], { stdout: "ignore", stderr: "ignore" });
		return (await pull.exited) === 0;
	} catch {
		return false;
	}
}

/**
 * R5 — the "no verify command" row, which lives at the CALLER because it is a question about the
 * repo, not about a run: `runMainGateUncached` returns `{ ok: true, skipped: true }` when detection
 * finds no command, and every `.ok`-only reader sees green forever (R2 fail-open #5). For a
 * REGISTERED tenant that is not a skip, it is a broken contract, and this is the refusal it earns.
 */
export function missingCommandRefusal(repo: string, detail: string): GateRefusal {
	return {
		code: "command-unregistered",
		reason: `${repo} has a registered gate manifest but no runnable verify command (${detail}) — refusing to report a gate as passed when none ran. Fix the manifest's commands or unregister the repo.`,
	};
}

const MAX_OUTPUT = 8000;

/**
 * Execute the manifest. TRULY never throws (C-4, gauntlet round 1): the sandbox refusal, the compose
 * setup (temp-dir/compose-file — moved inside `startGateServices`'s own catch), the runner-image
 * probe, and the gate evaluation are each caught and returned as a structured refusal. A throw at
 * this seam surfaces to the land paths as an unclassified error on an already-merged local main — the
 * land layer additionally restores head0 on any refusal, but the runner must never be the thing that
 * throws. The loop below is wrapped as a last-ditch belt so even an unforeseen escape becomes a
 * refusal, never an exception.
 */
export async function runManifestGates(opts: ManifestRunOpts): Promise<ManifestRunOutcome> {
	const exec: GateCommandRunner = opts.exec ?? execGatedCommand;
	const hash = manifestHash(opts.manifest);
	const results: ManifestGateResult[] = [];
	const chunks: string[] = [];
	const policy = {
		sandboxStrict: manifestStrict(opts.manifest),
		sandboxImage: opts.manifest.policy?.sandboxImage,
		sandboxNetwork: opts.manifest.policy?.sandboxNetwork,
	};

	for (let i = 0; i < opts.manifest.gates.length; i++) {
		const gate = opts.manifest.gates[i]!;
		const started = Date.now();
		const outcome = await runOneGate(gate, policy, opts, exec).catch(
			(e: unknown): OneGateOutcome => ({ code: null, output: "", refusal: { code: "service-unavailable", reason: `gate "${gate.name}" runner threw before it could judge (${errText(e)}) — treated as a refusal, never a silent pass` } }),
		);
		chunks.push(outcome.output);
		results.push({
			name: gate.name,
			command: gate.command,
			exitCode: outcome.code,
			durationMs: Date.now() - started,
			tests: outcome.evidence?.tests,
			counts: outcome.evidence?.counts,
			sandboxed: outcome.sandboxed,
			refusal: outcome.refusal,
		});
		if (outcome.refusal) {
			// Fail fast: record the gates that never ran, so the receipt cannot be misread as "the rest
			// were fine". A skipped gate is not a passed gate.
			for (const skipped of opts.manifest.gates.slice(i + 1)) {
				results.push({ name: skipped.name, command: skipped.command, exitCode: null, durationMs: 0 });
			}
			return { ok: false, manifestHash: hash, refusal: outcome.refusal, results, output: tail(chunks) };
		}
	}
	return { ok: true, manifestHash: hash, results, output: tail(chunks) };
}

function tail(chunks: string[]): string {
	const joined = chunks.join("\n").trim();
	return joined.length > MAX_OUTPUT ? joined.slice(-MAX_OUTPUT) : joined;
}

interface OneGateOutcome {
	code: number | null;
	output: string;
	sandboxed?: boolean;
	evidence?: { tests?: number; counts?: Record<string, number> };
	refusal?: GateRefusal;
}

async function runOneGate(
	gate: TenantGate,
	policy: { sandboxStrict?: boolean; sandboxImage?: string; sandboxNetwork?: string },
	opts: ManifestRunOpts,
	exec: GateCommandRunner,
): Promise<OneGateOutcome> {
	const cwd = gate.cwd ? path.resolve(opts.cwd, gate.cwd) : opts.cwd;
	const refuse = (code: GateRefusal["code"], reason: string): OneGateOutcome => ({ code: null, output: "", refusal: { code, reason } });

	// R4 — a declared runner this host cannot provide. Checked BEFORE anything starts, so a gate that
	// can never run does not first spin up a Postgres. H-2 (round 1): the declared image must become the
	// ACTUAL sandbox image the gate runs in — a docker-presence probe alone let a Playwright gate "pass"
	// in the bun image with the declared image absent. Present-or-pullable, else `runner-unavailable`.
	let gatePolicy = policy;
	if (gate.requires?.runnerImage) {
		const available = await (opts.dockerProbe ? opts.dockerProbe() : dockerAvailable());
		if (!available) {
			return refuse("runner-unavailable", `gate "${gate.name}" declares runnerImage "${gate.requires.runnerImage}" and docker is unavailable — this gate has no runner on this host, so its result would be no result. Refusing to land.`);
		}
		const present = await (opts.ensureImage ?? ensureImagePresent)(gate.requires.runnerImage);
		if (!present) {
			return refuse("runner-unavailable", `gate "${gate.name}" declares runnerImage "${gate.requires.runnerImage}" which is not present and could not be pulled — refusing to run the gate in a different image than it demands.`);
		}
		// Override the sandbox image for THIS gate: it runs in the image it declared, not the default.
		gatePolicy = { ...policy, sandboxImage: gate.requires.runnerImage };
	}

	// R3 — required services. Fail-closed on docker absence, on a failed `up`, on a healthcheck that
	// never goes green, and (C-4) on a setup throw — all now structured refusals, never exceptions.
	const services = await startGateServices({
		services: gate.requires?.services ?? [],
		gateName: gate.name,
		cwd,
		timeoutMs: gate.timeoutMs,
		spawn: opts.serviceSpawn,
		dockerProbe: opts.dockerProbe,
	});
	if (!services.ok) {
		await services.stop();
		return { code: null, output: "", refusal: services.refusal };
	}
	const stopServices = services.handle.stop;

	// The gate runs, then teardown, then service `down` — none in a `finally`, because a failed `down`
	// must be able to turn a GREEN gate into a refusal (a gate that "passed" with its Postgres still
	// running has contaminated the host — H-5). `runGate` computes the gate's own outcome; teardown and
	// `down` run unconditionally afterward.
	const runGate = async (): Promise<OneGateOutcome> => {
		const requireSandbox = gate.requires?.services?.length
			? `gate "${gate.name}" requires composed services`
			: gate.requires?.runnerImage
				? `gate "${gate.name}" requires runner image ${gate.requires.runnerImage}`
				: undefined;
		let run: { code: number; stdout: string; stderr: string; sandboxed: boolean; degraded?: boolean };
		try {
			run = await exec(gate.command, cwd, {
				mounts: opts.mounts,
				policy: gatePolicy,
				requireSandbox,
				timeoutMs: gate.timeoutMs,
				// H-1 (SECURITY, round 1): merge service vars INTO gateEnv's scrub — never over raw
				// process.env. The old `{...process.env, ...serviceEnv}` REPLACED the scrub, handing
				// agent-authored tenant tests the daemon's DATABASE_URL / *_API_KEY / OMP_SQUAD_* inside
				// the container — the exact host-DB fall-through the module claims to refuse. gateEnv
				// already runs for the no-service path (inside gateExec); this makes the service path use
				// the SAME scrubbed base, then layers only the GLANCE_SERVICE_* discovery vars on top.
				...(Object.keys(services.handle.env).length ? { env: { ...gateEnv(process.env), ...services.handle.env } } : {}),
			});
		} catch (e) {
			// A strict-policy sandbox refusal. Returned as a refusal rather than rethrown: the land paths
			// need a reason string, not a stack.
			if (e instanceof GateSandboxUnavailableError) return refuse("runner-unavailable", `gate "${gate.name}" could not run hermetically: ${e.message}`);
			return refuse("runner-unavailable", `gate "${gate.name}" could not be launched: ${errText(e)}`);
		}
		const output = `${run.stdout}${run.stderr}`.trim();
		const evidence = readGateEvidence(gate.expects.parser, output);
		const refusal = evaluateGateRun(gate, { code: run.code, output, degraded: run.degraded });
		return { code: run.code, output: `[gate ${gate.name}] ${output}`, sandboxed: run.sandboxed, evidence, refusal };
	};

	let outcome = await runGate().catch((e: unknown) => refuse("runner-unavailable", `gate "${gate.name}" threw during evaluation: ${errText(e)}`));

	// Teardown (the tenant's own cleanup shell) — bounded, best-effort: a non-zero teardown is the
	// tenant's problem to notice, not grounds to fail an otherwise-green gate.
	if (gate.teardown) await exec(gate.teardown, cwd, { mounts: opts.mounts, policy: gatePolicy, timeoutMs: gate.timeoutMs }).catch(() => undefined);
	// Service `down` — its failure DOES block a green receipt (H-5). If the gate already refused, keep
	// that (more specific) refusal; if it passed but `down` failed, the pass becomes a service-unavailable
	// refusal so a human deals with the live containers instead of the receipt hiding them.
	const stopped = await stopServices();
	if (!stopped.ok && !outcome.refusal) {
		outcome = { ...outcome, refusal: { code: "service-unavailable", reason: `gate "${gate.name}" passed but its service teardown did not complete (${stopped.detail ?? "unknown"}) — refusing the green receipt while containers may still be running on the host.` } };
	}
	return outcome;
}

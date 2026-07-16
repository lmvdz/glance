#!/usr/bin/env bun
/**
 * glance CLI.
 *
 *   glance here                                   chat on the current directory, in this terminal
 *   glance up [--port N] [--no-tui] [--restore]   start the daemon (server + TUI)
 *   glance add <repo> [--name --branch --model --approval --task]
 *   glance list
 *   glance prompt <id> <message…>
 *   glance rm <id> [--delete-worktree]
 *   glance ask "<question>" [--repo …]           answer a question; no branch, nothing to merge
 *   glance answers [<id>]                        list or read durable answers
 *   glance open
 *   glance doctor [--json]                        diagnose the factory: on? armed? pointed where?
 *
 * `up` is the long-lived process that owns the agents. The other verbs are thin
 * HTTP clients that talk to a running daemon's REST surface.
 */

import "./env-compat.ts";
import * as os from "node:os";
import * as path from "node:path";
import { readdir, readFile, realpath } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { loadOrCreateToken } from "./auth.ts";
import { renderDoctor, runDoctor } from "./doctor.ts";
import { makeDoctorProbe } from "./doctor-probe.ts";
import { envBool, envInt, rootFactoryEnabledWith } from "./config.ts";
import { installHarnessHooks, uninstallHarnessHooks } from "./harness-hooks.ts";
import { PushService } from "./push.ts";
import { LocalFederationBus, NullFederationBus } from "./federation.ts";
import { all as allPresence, who as whoPresence } from "./presence.ts";
import { matchUnit, openWorktree } from "./open-worktree.ts";
import { SquadServer, type AuthInstance } from "./server.ts";
import { SquadManager } from "./squad-manager.ts";
import { ManagerRegistry } from "./manager-registry.ts";
import { SquadTui } from "./tui.ts";
import { startExternalSessionTracker } from "./sessions.ts";
import { startSupervisor } from "./supervisor.ts";
import { acquireStateLock, StateLockError } from "./state-lock.ts";
import { loadEnvFile } from "./plane-secrets.ts";
import { planeRepos } from "./plane.ts";
import { openDatabase } from "./db/index.ts";
import { DbStore } from "./dal/store.ts";
import type { OrgContext } from "./dal/context.ts";
import { DEV_INSECURE_SECRET, makeAuth } from "./db/auth.ts";
import { curatePlaneIssues, renderClusterReport } from "./plane-curator.ts";
import { concernNumFromFile, parsePlanConcerns, validatePlanConcerns } from "./features.ts";
import { decompose, DECOMPOSE_TIMEOUT_MS, type VerifiedConcern } from "./planner.ts";
import { writeConcernDrafts } from "./plan-writer.ts";
import { ompClassify } from "./intake.ts";
import { RuntimeSettingsStore } from "./runtime-settings.ts";
import { PolicyStore } from "./policy.ts";
import { backendFromEnv, setStorageBackend } from "./dal/storage.ts";
import { normalizeRepoPath } from "./project-registry.ts";
import type { AutomationRollupRow } from "./automation-log.ts";
import type { Actor, AgentDTO, ApprovalMode, AutomationEvent, ClientCommand, CommissionResult, CommissionSpec, CreateAgentOptions, FrictionEntry, ThinkingLevel, TranscriptEntry } from "./types.ts";
import { base, DEFAULT_PORT, parseArgs, stateDirPath, tokenHeader } from "./cli-args.ts";
import { cmdHere } from "./here.ts";

/** Global default binary override for the default harness (a custom omp/pi fork at a nonstandard path).
 *  Wires the `bin` field that existed on SquadManager/ManagerRegistry but was never populated in the
 *  bootstrap — so `GLANCE_BIN` now actually reaches WorkflowDriver + the omp-rpc drivers. */
const glanceBin = (): string | undefined => process.env.GLANCE_BIN?.trim() || undefined;

/**
 * Gating for the DB-mode root/operator factory (opt-in). In multi-tenant DB mode the per-org managers
 * behind the registry are lazy + org-scoped, so the operator's OWN autonomous factory (Plane
 * auto-dispatch → build → prove → auto-land → self-heal) never runs. This is the explicit trigger to
 * ALSO stand up a single root SquadManager that owns the global Plane loops: OMP_SQUAD_ROOT_FACTORY=1
 * AND at least one Plane repo configured (PLANE_PROJECT_MAP). Default OFF — a bare SaaS deployment never
 * silently spins a global factory. Exported for the boot-gate test.
 */
export function rootFactoryEnabled(repoCount: number = planeRepos().length): boolean {
	return rootFactoryEnabledWith(repoCount);
}

const HELP = `glance — manage a fleet of Oh My Pi agents across git worktrees

USAGE
  glance here [--model M]                       Chat with an agent on THIS directory, in this terminal
  glance up [--port N] [--no-tui] [--restore]   Start the daemon (web + TUI)
  glance add <repo> [flags]                     Spawn an agent in a new worktree
  glance list [--json]                          Show the roster
  glance harnesses [--json]                     Honest capability tiers for every registered harness
  glance install-hooks --harness [--uninstall]  Register lifecycle hooks so raw claude/codex sessions report in
  glance open <id|name|branch>                  Open a unit's worktree in your editor (OMP_SQUAD_OPEN_CMD, else terax/code)
  glance prompt <id> <message...>               Send an instruction to an agent
  glance notify <id> <summary...> [--detail x]  Flag an agent needs a human's attention (non-blocking)
  glance kill <id>                              Stop an agent but keep it in the roster
  glance rm <id> [--delete-worktree]            Remove an agent
  glance who [repo]                             Who/what is working a repo (any omp agent)
  glance logs <id> [--limit N]                  Print an agent's recent transcript
  glance automation [--window 1h] [--loop L]    Show what the background loops are doing (and Scout's LLM cost)
  glance ask "<question>" [--repo R]            Ask; the deliverable is a written answer, not a branch
  glance grr "<gripe>" [--list]                 Log a friction gripe to the dogfood ledger in <5s
  glance answers [<id>] [--repo R]              List answers, or print one
  glance open                                   Print the dashboard URL
  glance doctor [--json]                       Is the factory on, armed, and pointed at the right world?
  glance curate-plane [repo] [--file]             Group recurring Plane issues into unified fixes
  glance plan-validate <dir> [--json]           Check a plan dir's dep graph for cycles / dangling deps (offline)
  glance plan-decompose <dir> [--json]          One-shot: decompose <dir>/OBJECTIVE.md into a concern-DAG (needs \`omp\`)

ADD FLAGS
  --name <s>        Agent name (default: agent-N)
  --branch <s>      Worktree branch (default: squad/<name>)
  --model <s>       Model (fuzzy, e.g. opus / gpt-5.2)
  --approval <m>    always-ask | write | yolo (default: write)
  --thinking <l>    minimal | low | medium | high | xhigh (default: low)
  --task <s>        Initial instruction sent once the agent is ready
  --workflow <name|path>  Run a bundled workflow by name (research-plan-implement, plan-implement, fan-out) or a .fabro path; --task is the goal
  --verify <cmd>    Wrap --task in an implement → verify → fixup loop (gate = exit 0)
  --sandbox <image> Run the agent inside a container from <image> (mounts the worktree)
  --acp             Run an ACP runtime (auggie --acp) instead of omp --mode rpc
  --plain           Skip auto-routing; spawn a plain agent (no verify/plan/fan-out)

COMMISSION FLAGS
  --purpose <s>            What the worker does (required)
  --model <spec>           Model specifier, or "false" for a deterministic worker (default: false)
LIST FLAGS
  --json           Emit the raw roster JSON from GET /api/agents

CURATE-PLANE FLAGS
  --file                    File one [curator] do-not-auto-land issue per cluster

GLOBAL
  --port <N>        Daemon port (default: ${DEFAULT_PORT}, or $OMP_SQUAD_PORT)
  --host <addr>     Bind address (default: 127.0.0.1). A non-loopback bind (e.g. 0.0.0.0)
                    requires TLS ($OMP_SQUAD_TLS_CERT/$OMP_SQUAD_TLS_KEY) or a TLS tunnel
                    (tailscale serve / cloudflared); override with OMP_SQUAD_INSECURE=1.
                    Env: $OMP_SQUAD_HOST, $OMP_SQUAD_TLS_CERT/$OMP_SQUAD_TLS_KEY (in-process TLS).
                    A bearer token is auto-generated in the state dir and printed on boot.
  --no-supervise    Don't auto-answer agent prompts (default on; or OMP_SQUAD_AUTO_SUPERVISE=0)
`;

// parseArgs / base / stateDirPath / tokenHeader now live in cli-args.ts (shared with `glance here`).

/** Enumerate org ids that have persisted state (the `<stateDir>/orgs/<id>` dir names). Tolerates a missing dir. */
async function listOrgIds(stateDir: string): Promise<string[]> {
	try {
		const entries = await readdir(path.join(stateDir, "orgs"), { withFileTypes: true });
		return entries.filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return [];
	}
}

/** Every URL the dashboard is reachable on — loopback plus each non-internal IPv4 when bound to all interfaces. */
function reachableUrls(host: string, port: number, scheme: string): string[] {
	if (host !== "0.0.0.0" && host !== "::") return [`${scheme}://${host}:${port}`];
	const urls = [`${scheme}://127.0.0.1:${port}`];
	for (const list of Object.values(os.networkInterfaces())) {
		for (const ni of list ?? []) {
			if (ni.family === "IPv4" && !ni.internal) urls.push(`${scheme}://${ni.address}:${port}`);
		}
	}
	return urls;
}

async function postCommand(flags: Record<string, string | boolean>, cmd: ClientCommand): Promise<Response> {
	try {
		return await fetch(`${base(flags)}/api/command`, {
			method: "POST",
			headers: { "content-type": "application/json", ...tokenHeader() },
			body: JSON.stringify(cmd),
		});
	} catch {
		throw new Error(`No squad daemon on ${base(flags)}. Start one with: glance up`);
	}
}

/** Whether a host binds only the loopback interface (local-only). */
export function isLoopbackHost(host: string): boolean {
	return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * True iff binding `host` without TLS would put the bearer token on the wire in
 * cleartext: a non-loopback bind (anything but 127.0.0.1 / ::1 / localhost) with hasTls false.
 */
export function bindIsInsecure(host: string, hasTls: boolean): boolean {
	return !isLoopbackHost(host) && !hasTls;
}

/**
 * DB-mode boot decision for the session-signing secret. A missing or dev-default BETTER_AUTH_SECRET
 * makes every session forgeable (total auth bypass). Refuse to boot when bound non-loopback;
 * warn-but-allow on loopback (local dev only).
 */
export function secretBootDecision(secret: string | undefined, host: string): "ok" | "warn" | "refuse" {
	const weak = !secret || secret === DEV_INSECURE_SECRET;
	if (!weak) return "ok";
	return isLoopbackHost(host) ? "warn" : "refuse";
}

async function cmdUp(args: string[]): Promise<void> {
	const { flags } = parseArgs(args);
	// Configure Plane from the shared secret so the squad runs Plane-connected with no manual sourcing.
	const planeKeys = loadEnvFile(path.join(os.homedir(), ".claude", "secrets", "plane.env"));
	if (planeKeys.length) process.stderr.write(`plane: loaded ${planeKeys.length} var(s) from ~/.claude/secrets/plane.env\n`);
	const port = flags.port ? Number(flags.port) : DEFAULT_PORT;
	const host = process.env.OMP_SQUAD_HOST || (typeof flags.host === "string" ? flags.host : undefined) || "127.0.0.1";
	const stateDir = stateDirPath();
	// Select the durable-storage substrate BEFORE any persistence runs. Default local disk; a different
	// backend (Archil, S3, …) is a drop-in via setStorageBackend — see src/dal/storage.ts. `archil` loud-
	// fails until the pilot's follow-up implements it, so a misconfig can never silently lose state.
	setStorageBackend(backendFromEnv());
	const runtimeSettings = new RuntimeSettingsStore(stateDir);
	await runtimeSettings.apply();
	const policy = new PolicyStore(stateDir);
	const tls = process.env.OMP_SQUAD_TLS_CERT && process.env.OMP_SQUAD_TLS_KEY ? { cert: process.env.OMP_SQUAD_TLS_CERT, key: process.env.OMP_SQUAD_TLS_KEY } : undefined;
	if (bindIsInsecure(host, Boolean(tls)) && !envBool("OMP_SQUAD_INSECURE", false)) {
		process.stderr.write(
			`refusing to bind ${host} over plaintext HTTP.\n` +
				`The bearer token and all dashboard traffic would cross the network in cleartext,\n` +
				`letting an on-path attacker capture the token and gain host code execution.\n` +
				`Fix with one of:\n` +
				`  (a) set OMP_SQUAD_TLS_CERT + OMP_SQUAD_TLS_KEY for in-process TLS;\n` +
				`  (b) front the daemon with a TLS tunnel such as \`tailscale serve\` or \`cloudflared\`;\n` +
				`  (c) set OMP_SQUAD_INSECURE=1 to override deliberately.\n`,
		);
		process.exit(1);
	}
	const coordinator = process.env.OMP_SQUAD_COORDINATOR;
	const coordinatorToken = process.env.OMP_SQUAD_COORDINATOR_TOKEN || undefined;
	const operator: Actor = { id: process.env.OMP_SQUAD_OPERATOR || os.userInfo().username || "local", origin: "local" };
	// DB mode (DATABASE_URL set): open + migrate the shared DB (openDatabase migrates at boot) and
	// build the live better-auth instance the server gates on. FILE mode (default): openDatabase()
	// returns null, `auth` stays undefined, and nothing about today's behavior changes.
	const dbHandle = await openDatabase();
	// F1: DB mode signs sessions with BETTER_AUTH_SECRET. A missing/default secret lets anyone forge
	// any user's session — refuse to boot when exposed (non-loopback); warn loudly on loopback dev.
	if (dbHandle) {
		const decision = secretBootDecision(process.env.BETTER_AUTH_SECRET, host);
		if (decision !== "ok") {
			const suggestion = randomBytes(32).toString("hex");
			if (decision === "refuse") {
				process.stderr.write(
					`refusing to boot DB mode on ${host} without a strong BETTER_AUTH_SECRET.\n` +
						`Sessions are signed with this secret; a missing or default value lets anyone forge any\n` +
						`user's session — a total auth bypass. Set a strong secret and restart:\n` +
						`  export BETTER_AUTH_SECRET=${suggestion}\n`,
				);
				process.exit(1);
			}
			process.stderr.write(
				`WARNING: DB mode on loopback with a missing/default BETTER_AUTH_SECRET — sessions are forgeable.\n` +
					`OK for local dev only. Before exposing this daemon, set a strong secret:\n` +
					`  export BETTER_AUTH_SECRET=${suggestion}\n`,
			);
		}
	}
	const scheme = tls ? "https" : "http";
	// F4/F5: trust the reachable daemon origins plus the external BETTER_AUTH_URL origin (TLS tunnel).
	// The same set gates better-auth's origin check AND the squad's own cross-site mutation defense.
	const externalOrigin = process.env.BETTER_AUTH_URL ? new URL(process.env.BETTER_AUTH_URL).origin : undefined;
	const trustedOrigins = [...new Set([...reachableUrls(host, port, scheme).map((u) => new URL(u).origin), ...(externalOrigin ? [externalOrigin] : [])])];
	const auth: AuthInstance | undefined = dbHandle
		? (makeAuth({
				dialect: dbHandle.dialect,
				type: dbHandle.type,
				trustedOrigins,
				baseURL: process.env.BETTER_AUTH_URL || `${scheme}://${host}:${port}`,
			}) as unknown as AuthInstance)
		: undefined;
	// Single-writer guard: refuse to boot if another daemon already owns this state dir.
	let lock: Awaited<ReturnType<typeof acquireStateLock>>;
	try {
		lock = await acquireStateLock(stateDir);
	} catch (err) {
		if (err instanceof StateLockError) {
			process.stderr.write(`${err.message}\n`);
			process.exit(1);
		}
		throw err;
	}
	// A daemon must never die from a stray async error in a fire-and-forget path (a poll / dispatch /
	// orchestrator tick, a WS handler, an agent RPC). Without this, a single unhandled rejection takes
	// the whole fleet down with no log flushed — the silent ~5-min deaths. Log it loudly and STAY UP;
	// the known sources are fixed at the source, this is the backstop for the rest.
	process.on("unhandledRejection", (reason) => {
		process.stderr.write(`[unhandledRejection] ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`);
	});
	process.on("uncaughtException", (err) => {
		process.stderr.write(`[uncaughtException] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
	});
	const autoLand = envBool("OMP_SQUAD_AUTOLAND", true);
	let manager: SquadManager | undefined;
	let registry: ManagerRegistry | undefined;
	if (dbHandle) {
		// DB mode: one daemon, a per-org SquadManager fleet behind the registry. Each org manager runs
		// isolated under <stateDir>/orgs/<orgId>, created lazily on the first webapp session for that org.
		const ctx: OrgContext = { db: dbHandle.db, type: dbHandle.type };
		registry = new ManagerRegistry({
			root: stateDir,
			store: (orgId) => new DbStore(ctx, orgId, path.join(stateDir, "orgs", orgId)),
			operator,
			autoLand,
			bin: glanceBin(),
			listOrgIds: () => listOrgIds(stateDir),
		});
		registry.start();
		// Root/operator factory (opt-in). The tenant registry above serves per-org webapp sessions, but
		// those managers are LAZY and org-scoped — so the operator's OWN autonomous factory (Plane
		// auto-dispatch → build → prove → auto-land → auto-close → self-heal/orchestrator) never runs in
		// DB mode: enabling multi-tenancy silently turned the factory off. Fix: ALSO stand up a single
		// root SquadManager at the state-dir root that owns the global Plane loops — alongside, and fully
		// isolated from, the tenant registry (its own FileStore at the root, never a tenant DbStore).
		//
		// GATING: OMP_SQUAD_ROOT_FACTORY=1 AND planeRepos().length > 0. Default OFF — no SaaS deployment
		// silently spins a global factory; the operator opts in from up.sh (which already wires
		// PLANE_PROJECT_MAP). Federation stays inert (NullFederationBus): the WS supervisor + cross-host
		// lease sync are file-mode-only for auth reasons (below), and the root factory is operator-local.
		if (rootFactoryEnabled()) {
			manager = new SquadManager({ bus: new NullFederationBus(), operator, stateDir, autoLand, bin: glanceBin() });
			await manager.start();
			process.stderr.write(`root factory: on — operator autonomous factory active for ${planeRepos().join(", ")}\n`);
		} else if (envBool("OMP_SQUAD_ROOT_FACTORY", false)) {
			process.stderr.write("root factory: OMP_SQUAD_ROOT_FACTORY=1 but no Plane repos configured (PLANE_PROJECT_MAP) — not started\n");
		}
	} else {
		// File mode: today's single root manager at the state-dir root.
		// Federation is ON by default — a real LocalFederationBus that works locally with no
		// coordinator (loopback pub/sub + own roster) and gossips to peers only once a coordinator
		// URL is configured. OMP_SQUAD_FEDERATION=0 is the explicit opt-out back to the inert NullFederationBus.
		const federationOff = !envBool("OMP_SQUAD_FEDERATION", true);
		const bus = federationOff ? new NullFederationBus() : new LocalFederationBus({ operator, coordinatorUrl: coordinator, token: coordinatorToken });
		// Extra repos to gossip file leases for, beyond those discovered from the presence registry.
		// The daemon gossips leases IN-PROCESS over `bus` (SquadManager, SEAM 1) — no separate worker.
		const fedRepos = (process.env.OMP_SQUAD_FED_REPOS ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		manager = new SquadManager({ bus, operator, stateDir, autoLand, fedRepos, bin: glanceBin() });
		await manager.start();
		if (federationOff) process.stderr.write("federation: disabled (OMP_SQUAD_FEDERATION=0)\n");
		else if (coordinator) process.stderr.write(`federation: joined ${coordinator} as ${operator.id}\n`);
		else process.stderr.write(`federation: local (no coordinator) as ${operator.id}\n`);
		if (flags.restore) {
			const n = await manager.loadPersisted();
			if (n) process.stderr.write(`restored ${n} agent(s)\n`);
		}
	}
	const token = await loadOrCreateToken(stateDir);
	const push = new PushService(stateDir);
	await push.init();
	const roleTokens = { operator: process.env.OMP_SQUAD_OPERATOR_TOKEN || undefined, viewer: process.env.OMP_SQUAD_VIEWER_TOKEN || undefined };
	// In DB mode `manager` is the opt-in root factory (or undefined). Pass it as the single manager AND the
	// registry: the server routes the operator's own org (OMP_SQUAD_ROOT_ORG) + the on-box loopback admin to
	// the root factory, and every tenant org to its per-org registry manager (server.ts managerFor).
	const rootOrgId = process.env.OMP_SQUAD_ROOT_ORG?.trim() || undefined;
	// Resolved BEFORE the server so `/api/doctor` can report the supervisor that actually runs, not the one
	// the flag implies: it is also gated on `--no-supervise` and on file mode.
	const superviseExternal = !dbHandle && envBool("OMP_SQUAD_AUTO_SUPERVISE", true) && flags["no-supervise"] !== true;
	// pushRoot: per-org push services in DB-registry mode live under the same per-org state dirs the
	// ManagerRegistry uses (`<stateDir>/orgs/<orgId>`) — see server.ts's orgPush field.
	const server = new SquadServer(manager, { port, hostname: host, token, tls, push, pushRoot: stateDir, roleTokens, auth, db: dbHandle ?? undefined, trustedOrigins, registry, runtimeSettings, policy, rootOrgId, superviseExternal });
	const url = server.start();

	// Persistent autonomy: surface raw omp sessions in presence, and (unless opted out) answer
	// pending agent prompts hands-free — both started by the daemon so they live and die with it.
	// The external supervisor is a single global WS client that authenticates with the file-mode
	// bearer token; DB mode's WS requires a per-org session, so it runs in FILE MODE ONLY. DB-mode
	// auto-supervision is the per-org, in-process maybeAutoSupervise inside each manager (lifecycle 05).
	const stopTracker = startExternalSessionTracker();
	// risk #7: the external supervisor authenticates with the file-mode bearer token; DB mode has none, so file-mode only.
	const stopSupervisor = superviseExternal ? startSupervisor({ port, model: process.env.OMP_SQUAD_SUPERVISE_MODEL || undefined }) : undefined;

	// Cross-host file leasing: the file-mode daemon now gossips its own leases IN-PROCESS over the
	// manager's LocalFederationBus (SquadManager, SEAM 1) and mirrors peers' leases the same way — no
	// separate coordinator socket, no standalone worker. (federation-sync-main.ts still runs the same
	// engine standalone for hosts that want lease gossip decoupled from the daemon.) DB mode gossips
	// nothing: each per-org manager runs a NullFederationBus, matching the prior no-global-sync behavior.
	// The root factory (opt-in) also runs a NullFederationBus, so it adds no cross-host gossip either.

	const shutdown = async () => {
		stopSupervisor?.();
		stopTracker();
		if (registry) await registry.stopAll();
		// Stop the root factory too (DB mode); in file mode this is the sole root manager. No-op when unset.
		await manager?.stop();
		server.stop();
		if (dbHandle) await dbHandle.close();
		lock.release();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());

	const useTui = !flags["no-tui"] && process.stdin.isTTY;
	const access = reachableUrls(host, port, tls ? "https" : "http").map((u) => `    ${u}/?token=${token}`).join("\n");
	// File mode drops into the TUI over the root manager; DB mode stays headless even with a root factory
	// (the operator watches the factory in the webapp, mapped to OMP_SQUAD_ROOT_ORG / the loopback admin).
	if (manager && !registry && useTui) {
		process.stdout.write(`glance dashboard: ${url}\n  access token: ${token}\n`);
		process.stdout.write(`  autonomy: session-tracker on · auto-supervisor ${superviseExternal ? "on" : "off"}\n`);
		const tui = new SquadTui(manager);
		await tui.run();
		await shutdown();
	} else {
		process.stdout.write(`glance daemon running\n  dashboard: ${url}\n  access token: ${token}\n  open from any device on this network (tap to sign in):\n${access}\n  add an agent: glance add <repo> --task "…"\n`);
		process.stdout.write(`  autonomy: session-tracker on · auto-supervisor ${superviseExternal ? "on" : "off"}\n`);
		await new Promise<void>(() => {}); // run until signal
	}
}

async function cmdAdd(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const repo = positional[0] ?? process.cwd();
	const options: CreateAgentOptions = { repo };
	if (typeof flags.name === "string") options.name = flags.name;
	if (typeof flags.branch === "string") options.branch = flags.branch;
	if (typeof flags.model === "string") options.model = flags.model;
	if (typeof flags.task === "string") options.task = flags.task;
	if (typeof flags.approval === "string") options.approvalMode = flags.approval as ApprovalMode;
	if (typeof flags.thinking === "string") options.thinking = flags.thinking as ThinkingLevel;
	if (typeof flags.workflow === "string") options.workflow = flags.workflow;
	if (typeof flags.verify === "string") options.verify = flags.verify;
	if (typeof flags.sandbox === "string") options.sandbox = { image: flags.sandbox };
	if (flags.acp === true || flags.runtime === "acp") options.runtime = "acp";
	// Any registered harness by name (omp/pi/claude-code/codex/opencode/gemini/…). Supersedes --acp;
	// --bin overrides the harness's binary for this one agent.
	if (typeof flags.harness === "string") options.harness = flags.harness;
	if (typeof flags.bin === "string") options.bin = flags.bin;
	// Spawn from a named capability bundle (env OMP_SQUAD_PROFILES or repo .glance/profiles.json) —
	// its harness/bin/model/thinking/memory/capabilities apply unless the flags above override them.
	if (typeof flags.profile === "string") options.profileId = flags.profile;
	if (flags.plain === true) options.autoRoute = false;

	// Discoverability: warn if anyone (squad agent or raw omp session) is already on this repo.
	const present = await whoPresence(repo).catch(() => []);
	if (present.length) {
		process.stderr.write(`⚠ ${present.length} agent(s) already active on ${repo}:\n`);
		for (const p of present) process.stderr.write(`    ${p.source} ${p.operator}/${p.agent}${p.branch ? ` (${p.branch})` : ""}\n`);
	}

	const res = await postCommand(flags, { type: "create", options });
	if (!res.ok) {
		process.stderr.write(`add failed: ${res.status} ${await res.text()}\n`);
		process.exit(1);
	}
	const dto = (await res.json()) as AgentDTO;
	process.stdout.write(`spawned ${dto.name} [${dto.status}]\n  id: ${dto.id}\n  worktree: ${dto.worktree}\n`);
}

export function renderAgentRoster(agents: AgentDTO[], opts: { json?: boolean } = {}): string {
	if (opts.json) return `${JSON.stringify(agents, null, 2)}\n`;
	if (!agents.length) return "no agents\n";
	const rows = agents.map((a) => ({
		status: a.status,
		name: a.name,
		branch: a.branch ?? "—",
		activity: a.activity ?? a.todo?.active ?? "—",
		pend: a.pending.length ? `⛔${a.pending.length}` : "",
	}));
	const w = {
		status: Math.max(6, ...rows.map((r) => r.status.length)),
		name: Math.max(4, ...rows.map((r) => r.name.length)),
		branch: Math.max(6, ...rows.map((r) => r.branch.length)),
	};
	return rows
		.map((r) => `${r.status.padEnd(w.status)}  ${r.name.padEnd(w.name)}  ${r.branch.padEnd(w.branch)}  ${r.pend.padEnd(4)}  ${r.activity}`)
		.join("\n") + "\n";
}

async function cmdList(args: string[]): Promise<void> {
	const { flags } = parseArgs(args);
	let agents: AgentDTO[];
	try {
		const res = await fetch(`${base(flags)}/api/agents`, { headers: tokenHeader() });
		if (!res.ok) {
			process.stderr.write(`list failed: ${res.status} ${await res.text()}\n`);
			process.exit(1);
		}
		agents = (await res.json()) as AgentDTO[];
	} catch {
		process.stderr.write(`No squad daemon on ${base(flags)}. Start one with: glance up\n`);
		process.exit(1);
	}
	process.stdout.write(renderAgentRoster(agents, { json: flags.json === true }));
}

/** GET /api/harnesses shape (server.ts's noFleet handler) — the tier fields are additive to the
 *  pre-existing name/protocol/verified/capabilities/note response. */
interface HarnessListingRow {
	name: string;
	protocol: string;
	verified: boolean;
	tier?: "verified" | "detected-unverified" | "registered-unverified";
	binDetected?: boolean;
	usageVerified?: boolean;
	alert?: string;
	note?: string;
}

const TIER_LABEL: Record<string, string> = {
	verified: "verified",
	"detected-unverified": "detected",
	"registered-unverified": "registered",
};

export function renderHarnessTable(rows: HarnessListingRow[], defaultHarness: string, opts: { json?: boolean } = {}): string {
	if (opts.json) return `${JSON.stringify(rows, null, 2)}\n`;
	if (!rows.length) return "no harnesses registered\n";
	const nameW = Math.max(4, ...rows.map((r) => r.name.length));
	const tierW = Math.max(4, ...rows.map((r) => (TIER_LABEL[r.tier ?? ""] ?? "—").length));
	const lines = rows.map((r) => {
		const name = (r.name === defaultHarness ? `${r.name}*` : r.name).padEnd(nameW + 1);
		const tier = (TIER_LABEL[r.tier ?? ""] ?? "—").padEnd(tierW);
		const usage = r.usageVerified ? "usage-verified" : "usage-unconfirmed";
		const alert = r.alert ? `  ⚠ ${r.alert}` : "";
		return `${name} ${tier}  ${r.protocol.padEnd(7)} ${usage}${alert}`;
	});
	return `${lines.join("\n")}\n`;
}

/** `glance harnesses [--json]` — the honest capability tier matrix (concern 06): every
 *  REGISTERED harness (not just the create-surface-visible verified ones) with its tier, a
 *  verified-binary-missing alert, and the usage-verified bit. Always queries the create API's
 *  `?all=1` under the hood — this listing is always the full roster, so there is no `--all` flag
 *  to pass. */
async function cmdHarnesses(args: string[]): Promise<void> {
	const { flags } = parseArgs(args);
	let body: { default: string; harnesses: HarnessListingRow[] };
	try {
		const res = await fetch(`${base(flags)}/api/harnesses?all=1`, { headers: tokenHeader() });
		if (!res.ok) {
			process.stderr.write(`harnesses failed: ${res.status} ${await res.text()}\n`);
			process.exit(1);
		}
		body = (await res.json()) as { default: string; harnesses: HarnessListingRow[] };
	} catch {
		process.stderr.write(`No squad daemon on ${base(flags)}. Start one with: glance up\n`);
		process.exit(1);
	}
	process.stdout.write(renderHarnessTable(body.harnesses, body.default, { json: flags.json === true }));
}

async function cmdPrompt(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const id = positional[0];
	const message = positional.slice(1).join(" ");
	if (!id || !message) {
		process.stderr.write("usage: glance prompt <id> <message...>\n");
		process.exit(1);
	}
	const res = await postCommand(flags, { type: "prompt", id, message });
	process.stdout.write(res.ok ? "sent\n" : `failed: ${await res.text()}\n`);
}

/** `glance notify <id> "<summary>" [--detail x]` — the operator/scriptable ingress for the
 *  non-blocking attention primitive (cmux-research concern 03): any program/CI/hook can raise
 *  attention on a unit without stopping or blocking it. Mirrors cmdPrompt's shape. */
/** `glance install-hooks --harness [--uninstall]` — register the lifecycle shim in each
 *  VERIFIED foreign harness's own hook config, so a raw `claude` session inside a fleet repo
 *  becomes visible to `glance who` the instant it starts (fleet-ide-bridge B03). */
async function cmdInstallHooks(args: string[]): Promise<void> {
	const { flags } = parseArgs(args);
	if (!flags.harness) {
		process.stderr.write("usage: glance install-hooks --harness [--uninstall]\n");
		process.exit(1);
	}
	const stateDir = stateDirPath();
	const port = flags.port ? Number(flags.port) : DEFAULT_PORT;
	const reports = flags.uninstall ? await uninstallHarnessHooks(stateDir) : await installHarnessHooks(stateDir, port);
	for (const r of reports) {
		const verb = flags.uninstall ? "removed" : r.installed ? "installed" : "skipped";
		process.stdout.write(`${r.harness}: ${verb}${r.reason ? ` — ${r.reason}` : ""}\n`);
	}
}

/** `glance open <id|name|branch>` — the fleet→worktree jump (fleet-ide-bridge B02):
 *  resolve the unit's worktree from the roster and launch the configured opener
 *  LOCALLY (this machine), falling back to printing the path when no opener exists. */
async function cmdOpen(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const key = positional[0];
	if (!key) {
		process.stderr.write("usage: glance open <id|name|branch>\n");
		process.exit(1);
	}
	const res = await fetch(`${base(flags)}/api/agents`, { headers: tokenHeader() });
	if (!res.ok) {
		process.stderr.write(`daemon unreachable or refused: ${res.status}\n`);
		process.exit(1);
	}
	const unit = matchUnit((await res.json()) as AgentDTO[], key);
	if (!unit) {
		process.stderr.write(`no unit matching "${key}" (tried id, name, branch, unique id prefix)\n`);
		process.exit(1);
	}
	const out = openWorktree(unit.worktree);
	if (out.spawned && out.argv) process.stdout.write(`opening ${out.path} (${out.argv[0]})\n`);
	else {
		process.stdout.write(`${out.path}\n`);
		if (out.hint) process.stderr.write(`${out.hint}\n`);
	}
}

async function cmdNotify(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const id = positional[0];
	const summary = positional.slice(1).join(" ") || (typeof flags.summary === "string" ? flags.summary : "");
	if (!id || !summary) {
		process.stderr.write('usage: glance notify <id> <summary...> [--detail "..."]\n');
		process.exit(1);
	}
	const detail = typeof flags.detail === "string" ? flags.detail : undefined;
	const res = await postCommand(flags, { type: "notify", id, summary, detail });
	process.stdout.write(res.ok ? "sent\n" : `failed: ${await res.text()}\n`);
}

async function cmdRm(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const id = positional[0];
	if (!id) {
		process.stderr.write("usage: glance rm <id> [--delete-worktree]\n");
		process.exit(1);
	}
	const res = await postCommand(flags, { type: "remove", id, deleteWorktree: !!flags["delete-worktree"] });
	process.stdout.write(res.ok ? "removed\n" : `failed: ${await res.text()}\n`);
}

async function cmdKill(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const id = positional[0];
	if (!id) {
		process.stderr.write("usage: glance kill <id>\n");
		process.exit(1);
	}
	const res = await postCommand(flags, { type: "kill", id });
	process.stdout.write(res.ok ? "killed\n" : `failed: ${await res.text()}\n`);
}

async function cmdLogs(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const id = positional[0];
	if (!id) {
		process.stderr.write("usage: glance logs <id> [--limit N]\n");
		process.exit(1);
	}
	const limit = flags.limit ? Number(flags.limit) : 40;
	let entries: TranscriptEntry[];
	try {
		const res = await fetch(`${base(flags)}/api/agents/${encodeURIComponent(id)}/transcript`, { headers: tokenHeader() });
		entries = (await res.json()) as TranscriptEntry[];
	} catch {
		process.stderr.write(`No squad daemon on ${base(flags)}. Start one with: glance up\n`);
		process.exit(1);
	}
	if (!entries.length) {
		process.stdout.write("no transcript\n");
		return;
	}
	const recent = entries.slice(-limit);
	const w = Math.max(...recent.map((e) => e.kind.length));
	for (const e of recent) {
		process.stdout.write(`${e.kind.toUpperCase().padEnd(w)}  ${e.text}\n`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function cmdCommission(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const name = positional[0];
	const purpose = typeof flags.purpose === "string" ? flags.purpose : "";
	if (!name || !purpose) {
		process.stderr.write('usage: glance commission <name> --purpose "..." [--model <spec|false>] [--target node|cloudflare] [--capabilities a,b] [--accept-payload <json> --accept-expect <json>]\n');
		process.exit(1);
	}
	const spec: CommissionSpec = { name, purpose, model: false };
	if (typeof flags.model === "string") spec.model = flags.model === "false" ? false : flags.model;
	if (typeof flags.target === "string") spec.deployTarget = flags.target === "cloudflare" ? "cloudflare" : "node";
	if (typeof flags.capabilities === "string") {
		spec.capabilities = flags.capabilities
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}
	if (typeof flags["accept-payload"] === "string") {
		const payload: unknown = JSON.parse(flags["accept-payload"]);
		let expect: Record<string, unknown> | undefined;
		if (typeof flags["accept-expect"] === "string") {
			const parsed: unknown = JSON.parse(flags["accept-expect"]);
			if (isRecord(parsed)) expect = parsed;
		}
		spec.accept = { payload, expect };
	}
	process.stdout.write(`commissioning "${name}" — authoring + validating (this can take a while)…\n`);
	const res = await postCommand(flags, { type: "commission", spec });
	if (!res.ok) {
		process.stderr.write(`commission failed: ${res.status} ${await res.text()}\n`);
		process.exit(1);
	}
	const result = (await res.json()) as CommissionResult;
	for (const c of result.report.checks) {
		const mark = c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : "·";
		process.stdout.write(`  ${mark} ${c.name}${c.detail ? ` — ${c.detail}` : ""}\n`);
	}
	if (result.ok && result.member) {
		process.stdout.write(`onboarded ${result.member.name} [flue-service${result.member.verified ? ", verified" : ""}]\n  id: ${result.member.id}\n  dir: ${result.dir}\n`);
	} else {
		process.stdout.write(`rejected — gate failed; worker left at ${result.dir}\n`);
		process.exit(1);
	}
}

/**
 * Offline plan-DAG validator — reads a plan dir straight off disk (no daemon) and reports
 * dependency cycles + dangling deps, using the same core the UI diagram uses. Exit 0 = clean,
 * 1 = issues found (a signal the pipeline skills branch on, warning-first not a hard gate).
 */
async function cmdPlanValidate(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const dir = positional[0];
	if (!dir) {
		process.stderr.write("usage: omp-squad plan-validate <plan-dir> [--json]\n");
		process.exit(1);
		return;
	}
	// Accept an absolute or cwd-relative plan dir; validatePlanConcerns joins repo+planDir,
	// so passing repo="" + the resolved absolute path works for both.
	const abs = path.resolve(dir);
	const issues = await validatePlanConcerns("", abs);
	if (flags.json) {
		process.stdout.write(`${JSON.stringify({ dir: abs, issues }, null, 2)}\n`);
		if (issues.length) process.exit(1);
		return;
	}
	if (!issues.length) {
		process.stdout.write(`✓ ${path.basename(abs)} — plan dependency graph is clean (no cycles or dangling deps)\n`);
		return;
	}
	process.stdout.write(`⚠ ${path.basename(abs)} — ${issues.length} plan dependency issue${issues.length === 1 ? "" : "s"}:\n`);
	for (const issue of issues) process.stdout.write(`  • [${issue.kind}] ${issue.message}\n`);
	process.exit(1);
}

/** STATUS values that mean "finished" — mirrors plan-sync.ts's own local TERMINAL set. */
const TERMINAL_STATUSES = new Set(["done", "complete", "completed", "closed", "cancelled", "canceled"]);

/**
 * One-shot decompose→write→validate cycle against a plans/<name>/OBJECTIVE.md — the manual
 * dogfood path for the resident planner (resident-planner.ts) AND the deterministic end-to-end
 * harness for its epic's top-level Verify, without standing up the daemon loop. The verified set
 * here is local-terminal-STATUS only: the DoneProof ledger (done-proof.ts) that lets the live
 * daemon loop react to a land BEFORE plan-sync catches STATUS up is only available inside a
 * running SquadManager (resident-planner.ts, wired in squad-manager.ts) — this off-daemon path
 * has no ledger to consult, so it falls back to whatever STATUS is already on disk.
 */
async function cmdPlanDecompose(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const dir = positional[0];
	if (!dir) {
		process.stderr.write("usage: omp-squad plan-decompose <plan-dir> [--json]\n");
		process.exit(1);
		return;
	}
	const abs = path.resolve(dir);
	const objective = await readFile(path.join(abs, "OBJECTIVE.md"), "utf8").catch(() => undefined);
	if (objective === undefined || !objective.trim()) {
		const msg = `no OBJECTIVE.md found in ${abs} (create one to seed the resident planner)`;
		if (flags.json) process.stdout.write(`${JSON.stringify({ dir: abs, error: msg })}\n`);
		else process.stderr.write(`✗ ${msg}\n`);
		process.exit(1);
		return;
	}

	const existing = await parsePlanConcerns("", abs);
	const verified: VerifiedConcern[] = existing.filter((c) => TERMINAL_STATUSES.has(c.status)).map((c) => ({ num: concernNumFromFile(c.file) ?? undefined, title: c.title, planeId: c.planeId }));
	const openExisting = existing.filter((c) => !TERMINAL_STATUSES.has(c.status));
	const drafts = await decompose({ objective, verified, existing: openExisting, classify: ompClassify(undefined, DECOMPOSE_TIMEOUT_MS) });

	if (drafts.length === 0) {
		// Never attempt a destructive empty write (that would prune every open concern) — a failed
		// or empty decompose is a no-op, not a gate failure. Exit 0: nothing was wrong, nothing changed.
		if (flags.json) process.stdout.write(`${JSON.stringify({ dir: abs, written: [], removed: [], issues: [], ok: true, concernsWritten: 0 }, null, 2)}\n`);
		else process.stdout.write(`${path.basename(abs)} — decompose produced no concerns this pass (objective may already be fully planned, or the model call failed)\n`);
		return;
	}

	const result = await writeConcernDrafts("", abs, drafts);
	if (flags.json) {
		process.stdout.write(`${JSON.stringify({ dir: abs, written: result.written, removed: result.removed, issues: result.issues, ok: result.ok, concernsWritten: result.ok ? drafts.length : 0 }, null, 2)}\n`);
		if (!result.ok) process.exit(1);
		return;
	}
	if (!result.ok) {
		process.stdout.write(`✗ ${path.basename(abs)} — dependency graph gate refused (${result.issues.length} issue${result.issues.length === 1 ? "" : "s"}):\n`);
		for (const issue of result.issues) process.stdout.write(`  • [${issue.kind}] ${issue.message}\n`);
		process.exit(1);
		return;
	}
	process.stdout.write(`✓ ${drafts.length} concern${drafts.length === 1 ? "" : "s"} written to ${path.basename(abs)}\n`);
}

async function cmdCuratePlane(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	loadEnvFile(path.join(os.homedir(), ".claude", "secrets", "plane.env"));
	const rawRepo = positional[0];
	const repo = rawRepo ? (rawRepo === "." || rawRepo.startsWith("./") || rawRepo.startsWith("../") || rawRepo.startsWith("/") ? path.resolve(rawRepo) : rawRepo) : process.cwd();
	const report = await curatePlaneIssues(repo, { file: flags.file === true });
	if (!report) {
		process.stderr.write("Plane is not configured or unreachable\n");
		process.exit(1);
	}
	process.stdout.write(`${renderClusterReport(report)}\n`);
}


async function cmdWho(args: string[]): Promise<void> {
	const { positional } = parseArgs(args);
	const repo = positional[0];
	const entries = repo ? await whoPresence(repo) : await allPresence();
	if (!entries.length) {
		process.stdout.write(repo ? `nobody is working on ${repo}\n` : "no active agents\n");
		return;
	}
	for (const e of entries) {
		const s = Math.max(0, Math.round((Date.now() - e.heartbeat) / 1000));
		const ago = s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
		process.stdout.write(`${e.source.padEnd(5)} ${e.operator}/${e.agent}  ${e.repoName}${e.branch ? ` (${e.branch})` : ""}  ${ago} ago\n`);
	}
}

const AUTOMATION_WINDOWS: Record<string, number> = { "15m": 900_000, "1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000 };
/** Compact "Ns/Nm/Nh ago" for the CLI automation view. */
function relAgo(ts: number): string {
	const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
	return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

/** `glance automation` — what the daemon's background loops (scout/observer/opportunity/dispatch) are
 *  doing on their own, and what the Scout is costing in LLM calls. The terminal twin of GET /api/automation. */
async function cmdAutomation(args: string[]): Promise<void> {
	const { flags } = parseArgs(args);
	const winKey = String(flags.window ?? flags.w ?? "1h");
	const windowMs = AUTOMATION_WINDOWS[winKey] ?? 3_600_000;
	const loop = typeof flags.loop === "string" ? flags.loop : undefined;
	const limit = Number(flags.limit) || 20;
	let data: { events: AutomationEvent[]; rollup: AutomationRollupRow[] };
	try {
		const q = new URLSearchParams({ windowMs: String(windowMs), limit: String(limit) });
		if (loop) q.set("loop", loop);
		const res = await fetch(`${base(flags)}/api/automation?${q.toString()}`, { headers: tokenHeader() });
		data = (await res.json()) as { events: AutomationEvent[]; rollup: AutomationRollupRow[] };
	} catch {
		process.stderr.write(`No squad daemon on ${base(flags)}. Start one with: glance up\n`);
		process.exit(1);
		return;
	}
	if (flags.json) {
		process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
		return;
	}
	const winLbl = Object.keys(AUTOMATION_WINDOWS).find((k) => AUTOMATION_WINDOWS[k] === windowMs) ?? `${Math.round(windowMs / 60_000)}m`;
	process.stdout.write(`background automation — last ${winLbl}\n\n`);
	const rollup = data.rollup ?? [];
	if (!rollup.length) process.stdout.write("  (no background activity recorded yet — loops run once agents + Plane repos are configured)\n");
	for (const r of rollup) {
		const extra = `${r.spawned ? `  ${r.spawned} spawned` : ""}${r.errors ? `  ${r.errors} err` : ""}`;
		process.stdout.write(`  ${r.loop.padEnd(12)}${String(r.events).padStart(4)} ev   ${String(r.llmCalls).padStart(3)} LLM   ${String(r.filed).padStart(3)} filed   ${String(r.found).padStart(3)} found${extra}   last ${r.lastAt ? `${relAgo(r.lastAt)} ago` : "—"}\n`);
	}
	const evs = data.events ?? [];
	if (evs.length) {
		process.stdout.write(`\nrecent (${evs.length}):\n`);
		for (const e of evs) {
			const metrics = [e.llmCalls ? `${e.llmCalls} LLM` : "", e.found ? `${e.found} found` : "", e.filed ? `${e.filed} filed` : "", e.spawned ? `${e.spawned} spawned` : "", e.level && e.level !== "info" ? e.level : ""].filter(Boolean).join(" ") || "—";
			const who = e.agent ?? (e.repo ? (e.repo.split("/").pop() ?? e.repo) : "fleet");
			process.stdout.write(`  ${`${relAgo(e.at)} ago`.padStart(8)}  ${e.loop.padEnd(11)} ${who.padEnd(22)} ${metrics}${e.detail ? `  — ${e.detail}` : ""}\n`);
		}
	}
}

/**
 * Canonicalize a repo argument to the same key `project-registry.ts` uses (`AgentDTO.repo` /
 * `ProjectDTO.id`): resolve `input` to an absolute path, then — if it sits inside a git
 * checkout — walk UP to the repo root via `git rev-parse --show-toplevel` rather than trusting
 * the caller's cwd literally. Without this, a gripe logged from a subdirectory (e.g.
 * `glance grr` run from `<repo>/webapp`) persists with `repo=<repo>/webapp`, and every
 * repo-filtered read (`GET /api/friction?repo=`, the dogfood-drain skill) uses exact-string
 * equality against the registered repo ROOT — so the entry is silently invisible to any
 * repo-scoped list even though `glance grr --list` (unfiltered) still shows it.
 *
 * Falls back to the resolved input path when it isn't a git checkout (git missing, bare dir,
 * `rev-parse` fails) — `normalizeRepoPath` still runs, so the fallback path collapses the same
 * way a registered non-git "repo" would.
 */
export async function canonicalRepoRoot(input: string): Promise<string> {
	const resolved = path.resolve(input);
	try {
		const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], { cwd: resolved, stdout: "pipe", stderr: "ignore" });
		const out = (await new Response(proc.stdout).text()).trim();
		await proc.exited;
		if (proc.exitCode === 0 && out) return normalizeRepoPath(await realpath(out).catch(() => out));
	} catch {
		/* git missing or spawn failed — fall through to the resolved path */
	}
	return normalizeRepoPath(resolved);
}

/**
 * `glance grr "<gripe>" [--repo <path>] [--context <s>]` / `glance grr --list [--repo <path>] [--json]`
 *
 * The friction ledger's five-second capture (plans/daily-dogfood-engine/01). Fire-and-forget by
 * design: one POST, print "logged.", exit — anything slower than a few seconds would never get
 * used mid-annoyance, and then the whole dogfood epic loses its raw material. No polling, no
 * confirmation round trip beyond the 2xx.
 */
async function cmdGrr(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const repo = await canonicalRepoRoot(typeof flags.repo === "string" ? flags.repo : process.cwd());

	if (flags.list) {
		const q = new URLSearchParams();
		if (typeof flags.repo === "string") q.set("repo", repo);
		if (typeof flags.limit === "string") q.set("limit", flags.limit);
		const res = await fetch(`${base(flags)}/api/friction?${q.toString()}`, { headers: tokenHeader() }).catch(() => null);
		if (!res || !res.ok) {
			process.stderr.write(res ? `${res.status} ${await res.text()}\n` : `No glance daemon on ${base(flags)}. Start one with: glance up\n`);
			process.exit(1);
		}
		const { entries } = (await res.json()) as { entries: FrictionEntry[] };
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
			return;
		}
		if (!entries.length) {
			process.stdout.write('no gripes yet. log one: glance grr "the thing that just annoyed you"\n');
			return;
		}
		for (const e of entries) {
			const where = [e.repo ? (e.repo.split("/").pop() ?? e.repo) : "—", e.context, e.agentId].filter(Boolean).join(" · ");
			process.stdout.write(`  ${`${relAgo(e.ts)} ago`.padStart(8)}  ${where.padEnd(28)} ${e.gripe}\n`);
		}
		return;
	}

	const gripe = positional.join(" ").trim();
	if (!gripe) {
		process.stderr.write('usage: glance grr "<gripe>" [--repo <path>] [--context <s>]\n       glance grr --list [--repo <path>] [--json]\n');
		process.exit(1);
	}
	const res = await fetch(`${base(flags)}/api/friction`, {
		method: "POST",
		headers: { ...tokenHeader(), "content-type": "application/json" },
		body: JSON.stringify({ repo, context: typeof flags.context === "string" ? flags.context : "cli", gripe }),
	}).catch(() => null);
	if (!res || !res.ok) {
		process.stderr.write(res ? `grr failed: ${res.status} ${await res.text()}\n` : `No glance daemon on ${base(flags)}. Start one with: glance up\n`);
		process.exit(1);
	}
	process.stdout.write("logged.\n");
}

/**
 * `glance ask "<question>" [--repo <path>] [--json] [--no-wait]`
 *
 * R5: the second deliverable. A question in, a written answer out — no branch, no PR, nothing to merge.
 * The unit is an observer (`is-landing-unit.ts` refuses to land one), so this cannot mutate the repo.
 *
 * Waits by default. An `ask` you have to poll for is an `ask` nobody uses: the whole point is that the
 * answer arrives where the question was asked.
 */
async function cmdAsk(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const question = positional.join(" ").trim();
	if (!question) {
		process.stderr.write('usage: glance ask "<question>" [--repo <path>] [--model M] [--json] [--no-wait]\n');
		process.exit(1);
	}
	const repo = typeof flags.repo === "string" ? path.resolve(flags.repo) : process.cwd();
	const post = await fetch(`${base(flags)}/api/answers`, {
		method: "POST",
		headers: { ...tokenHeader(), "content-type": "application/json" },
		body: JSON.stringify({ repo, question, model: typeof flags.model === "string" ? flags.model : undefined, harness: typeof flags.harness === "string" ? flags.harness : undefined }),
	}).catch(() => null);
	if (!post || !post.ok) {
		process.stderr.write(post ? `ask failed: ${post.status} ${await post.text()}\n` : `No glance daemon on ${base(flags)}. Start one with: glance up\n`);
		process.exit(1);
	}
	const dto = (await post.json()) as AgentDTO;
	if (flags["no-wait"]) {
		process.stdout.write(`asked. ${dto.id}\n  read it later: glance ask --read ${dto.id}\n`);
		return;
	}

	// Poll the ANSWER, not the agent: the agent row is reaped, the answer is durable. A unit that dies
	// without answering must not hang the operator forever, so an ended agent ends the wait too.
	const started = Date.now();
	const deadline = started + envInt("GLANCE_ASK_TIMEOUT_MS", 30 * 60_000);
	if (!flags.json) process.stderr.write(`thinking… (${dto.id})\n`);
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 2_000));
		const res = await fetch(`${base(flags)}/api/answers/${encodeURIComponent(dto.id)}`, { headers: tokenHeader() }).catch(() => null);
		const answer = res?.ok ? ((await res.json()) as { markdown?: string; answeredAt?: number; durationMs?: number }) : undefined;
		if (answer?.answeredAt && answer.markdown) {
			process.stdout.write(flags.json ? `${JSON.stringify(answer, null, 2)}\n` : `\n${answer.markdown}\n`);
			return;
		}
		const agents = await fetch(`${base(flags)}/api/agents`, { headers: tokenHeader() }).then((r) => (r.ok ? (r.json() as Promise<AgentDTO[]>) : [])).catch(() => []);
		const live = agents.find((a) => a.id === dto.id);
		if (!live) {
			// Gone from the roster with no answer on disk: say so, rather than spinning until the timeout.
			process.stderr.write(`the unit ended without answering (${dto.id})\n`);
			process.exit(1);
		}
		if (live.status === "error") {
			process.stderr.write(`the unit failed: ${live.blockedReason ?? "unknown error"}\n`);
			process.exit(1);
		}
	}
	process.stderr.write(`timed out after ${Math.round((Date.now() - started) / 60_000)}m — the unit is still running; read it later with: glance ask --read ${dto.id}\n`);
	process.exit(1);
}

/** `glance answers [--repo R]` / `glance ask --read <id>` — the durable side of the deliverable. */
async function cmdAnswers(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const id = positional[0] ?? (typeof flags.read === "string" ? flags.read : undefined);
	const url = id ? `${base(flags)}/api/answers/${encodeURIComponent(id)}` : `${base(flags)}/api/answers${flags.repo ? `?repo=${encodeURIComponent(String(flags.repo))}` : ""}`;
	const res = await fetch(url, { headers: tokenHeader() }).catch(() => null);
	if (!res || !res.ok) {
		process.stderr.write(res ? `${res.status} ${await res.text()}\n` : `No glance daemon on ${base(flags)}\n`);
		process.exit(1);
	}
	const body = await res.json();
	if (flags.json) {
		process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
		return;
	}
	if (id) {
		const a = body as { question: string; markdown: string; answeredAt?: number };
		process.stdout.write(`${a.question}\n\n${a.answeredAt ? a.markdown : "(not answered yet)"}\n`);
		return;
	}
	const list = body as Array<{ id: string; question: string; answeredAt?: number; repo: string }>;
	if (list.length === 0) {
		process.stdout.write('no answers yet. ask one: glance ask "why is dispatch slow?"\n');
		return;
	}
	for (const a of list) process.stdout.write(`${a.answeredAt ? "✔" : "…"} ${a.id.padEnd(34)} ${a.question.slice(0, 60)}\n`);
}

/**
 * `glance doctor` — R6's answer. Exit code IS the verdict, so CI and the operator's `&&` both work:
 * 0 = nothing blocking, 1 = the factory cannot do its job. A warning never fails the command; a warning
 * that failed the command would be turned off within a week.
 */
async function cmdDoctor(args: string[]): Promise<void> {
	const { flags } = parseArgs(args);
	const report = await runDoctor(makeDoctorProbe({ base: base(flags), headers: tokenHeader(), cwd: process.cwd() }));
	process.stdout.write(flags.json ? `${JSON.stringify(report, null, 2)}
` : renderDoctor(report));
	if (!report.healthy) process.exit(1);
}

async function main(): Promise<void> {
	const [cmd, ...rest] = process.argv.slice(2);
	switch (cmd) {
		case undefined:
		case "up":
			await cmdUp(rest);
			break;
		case "here":
			await cmdHere(rest);
			break;
		case "add":
			await cmdAdd(rest);
			break;
		case "who":
			await cmdWho(rest);
			break;
		case "list":
		case "ls":
			await cmdList(rest);
			break;
		case "harnesses":
			await cmdHarnesses(rest);
			break;
		case "prompt":
		case "say":
			await cmdPrompt(rest);
			break;
		case "notify":
			await cmdNotify(rest);
			break;
		case "install-hooks":
			await cmdInstallHooks(rest);
			break;
		case "open":
			await cmdOpen(rest);
			break;
		case "kill":
		case "stop":
			await cmdKill(rest);
			break;
		case "rm":
		case "remove":
			await cmdRm(rest);
			break;
		case "logs":
			await cmdLogs(rest);
			break;
		case "automation":
		case "auto":
			await cmdAutomation(rest);
			break;
		case "commission":
		case "hire":
			await cmdCommission(rest);
			break;
		case "curate-plane":
		case "plane-curator":
			await cmdCuratePlane(rest);
			break;
		case "plan-validate":
		case "validate-plan":
			await cmdPlanValidate(rest);
			break;
		case "plan-decompose":
			await cmdPlanDecompose(rest);
			break;
		case "ask":
			if (typeof parseArgs(rest).flags.read === "string") await cmdAnswers(rest);
			else await cmdAsk(rest);
			break;
		case "grr":
			await cmdGrr(rest);
			break;
		case "answers":
			await cmdAnswers(rest);
			break;
		case "doctor":
			await cmdDoctor(rest);
			break;
		case "open": {
			const { flags } = parseArgs(rest);
			process.stdout.write(`${base(flags)}\n`);
			break;
		}
		case "help":
		case "-h":
		case "--help":
			process.stdout.write(HELP);
			break;
		default:
			process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
			process.exit(1);
	}
}

if (import.meta.main) void main();

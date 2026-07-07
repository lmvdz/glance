#!/usr/bin/env bun
/**
 * glance CLI.
 *
 *   glance up [--port N] [--no-tui] [--restore]   start the daemon (server + TUI)
 *   glance add <repo> [--name --branch --model --approval --task]
 *   glance list
 *   glance prompt <id> <message…>
 *   glance rm <id> [--delete-worktree]
 *   glance open
 *
 * `up` is the long-lived process that owns the agents. The other verbs are thin
 * HTTP clients that talk to a running daemon's REST surface.
 */

import "./env-compat.ts";
import * as os from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { loadOrCreateToken } from "./auth.ts";
import { PushService } from "./push.ts";
import { LocalFederationBus, NullFederationBus } from "./federation.ts";
import { all as allPresence, who as whoPresence } from "./presence.ts";
import { SquadServer, type AuthInstance } from "./server.ts";
import { SquadManager } from "./squad-manager.ts";
import { ManagerRegistry } from "./manager-registry.ts";
import { SquadTui } from "./tui.ts";
import { startExternalSessionTracker } from "./sessions.ts";
import { startSupervisor } from "./supervisor.ts";
import { acquireStateLock, StateLockError } from "./state-lock.ts";
import { resolveStateDir } from "./state-dir.ts";
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
import type { AutomationRollupRow } from "./automation-log.ts";
import type { Actor, AgentDTO, ApprovalMode, AutomationEvent, ClientCommand, CommissionResult, CommissionSpec, CreateAgentOptions, ThinkingLevel, TranscriptEntry } from "./types.ts";

const DEFAULT_PORT = Number(process.env.OMP_SQUAD_PORT ?? 7878);

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
	return process.env.OMP_SQUAD_ROOT_FACTORY === "1" && repoCount > 0;
}

const HELP = `glance — manage a fleet of Oh My Pi agents across git worktrees

USAGE
  glance up [--port N] [--no-tui] [--restore]   Start the daemon (web + TUI)
  glance add <repo> [flags]                     Spawn an agent in a new worktree
  glance list [--json]                          Show the roster
  glance prompt <id> <message...>               Send an instruction to an agent
  glance kill <id>                              Stop an agent but keep it in the roster
  glance rm <id> [--delete-worktree]            Remove an agent
  glance who [repo]                             Who/what is working a repo (any omp agent)
  glance logs <id> [--limit N]                  Print an agent's recent transcript
  glance automation [--window 1h] [--loop L]    Show what the background loops are doing (and Scout's LLM cost)
  glance open                                   Print the dashboard URL
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

interface ParsedArgs {
	positional: string[];
	flags: Record<string, string | boolean>;
}

function parseArgs(args: string[]): ParsedArgs {
	const positional: string[] = [];
	const flags: Record<string, string | boolean> = {};
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags[key] = next;
				i++;
			} else {
				flags[key] = true;
			}
		} else {
			positional.push(a);
		}
	}
	return { positional, flags };
}

function base(flags: Record<string, string | boolean>): string {
	const port = flags.port ? Number(flags.port) : DEFAULT_PORT;
	return `http://127.0.0.1:${port}`;
}
function stateDirPath(): string {
	// Canonical resolution lives in state-dir.ts (shared with ttl-registry, worktrees, sockets, proof):
	// env override → ~/.glance if present → legacy ~/.omp/squad if present → ~/.glance for fresh installs.
	return resolveStateDir();
}

/** Enumerate org ids that have persisted state (the `<stateDir>/orgs/<id>` dir names). Tolerates a missing dir. */
async function listOrgIds(stateDir: string): Promise<string[]> {
	try {
		const entries = await readdir(path.join(stateDir, "orgs"), { withFileTypes: true });
		return entries.filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return [];
	}
}

/** Authorization header for CLI→daemon calls, read from the persisted token (empty if the daemon has none). */
function tokenHeader(): Record<string, string> {
	try {
		const t = readFileSync(path.join(stateDirPath(), "access-token"), "utf8").trim();
		return t ? { Authorization: `Bearer ${t}` } : {};
	} catch {
		return {};
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
	const runtimeSettings = new RuntimeSettingsStore(stateDir);
	await runtimeSettings.apply();
	const policy = new PolicyStore(stateDir);
	const tls = process.env.OMP_SQUAD_TLS_CERT && process.env.OMP_SQUAD_TLS_KEY ? { cert: process.env.OMP_SQUAD_TLS_CERT, key: process.env.OMP_SQUAD_TLS_KEY } : undefined;
	if (bindIsInsecure(host, Boolean(tls)) && process.env.OMP_SQUAD_INSECURE !== "1") {
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
	const autoLand = process.env.OMP_SQUAD_AUTOLAND !== "0";
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
		} else if (process.env.OMP_SQUAD_ROOT_FACTORY === "1") {
			process.stderr.write("root factory: OMP_SQUAD_ROOT_FACTORY=1 but no Plane repos configured (PLANE_PROJECT_MAP) — not started\n");
		}
	} else {
		// File mode: today's single root manager at the state-dir root.
		// Federation is ON by default — a real LocalFederationBus that works locally with no
		// coordinator (loopback pub/sub + own roster) and gossips to peers only once a coordinator
		// URL is configured. OMP_SQUAD_FEDERATION=0 is the explicit opt-out back to the inert NullFederationBus.
		const federationOff = process.env.OMP_SQUAD_FEDERATION === "0";
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
	const server = new SquadServer(manager, { port, hostname: host, token, tls, push, roleTokens, auth, db: dbHandle ?? undefined, trustedOrigins, registry, runtimeSettings, policy, rootOrgId });
	const url = server.start();

	// Persistent autonomy: surface raw omp sessions in presence, and (unless opted out) answer
	// pending agent prompts hands-free — both started by the daemon so they live and die with it.
	// The external supervisor is a single global WS client that authenticates with the file-mode
	// bearer token; DB mode's WS requires a per-org session, so it runs in FILE MODE ONLY. DB-mode
	// auto-supervision is the per-org, in-process maybeAutoSupervise inside each manager (lifecycle 05).
	const stopTracker = startExternalSessionTracker();
	// risk #7: the external supervisor authenticates with the file-mode bearer token; DB mode has none, so file-mode only.
	const supervise = !dbHandle && process.env.OMP_SQUAD_AUTO_SUPERVISE !== "0" && flags["no-supervise"] !== true;
	const stopSupervisor = supervise ? startSupervisor({ port, model: process.env.OMP_SQUAD_SUPERVISE_MODEL || undefined }) : undefined;

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
		process.stdout.write(`  autonomy: session-tracker on · auto-supervisor ${supervise ? "on" : "off"}\n`);
		const tui = new SquadTui(manager);
		await tui.run();
		await shutdown();
	} else {
		process.stdout.write(`glance daemon running\n  dashboard: ${url}\n  access token: ${token}\n  open from any device on this network (tap to sign in):\n${access}\n  add an agent: glance add <repo> --task "…"\n`);
		process.stdout.write(`  autonomy: session-tracker on · auto-supervisor ${supervise ? "on" : "off"}\n`);
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

async function main(): Promise<void> {
	const [cmd, ...rest] = process.argv.slice(2);
	switch (cmd) {
		case undefined:
		case "up":
			await cmdUp(rest);
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
		case "prompt":
		case "say":
			await cmdPrompt(rest);
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

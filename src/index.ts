#!/usr/bin/env bun
/**
 * omp-squad CLI.
 *
 *   omp-squad up [--port N] [--no-tui] [--restore]   start the daemon (server + TUI)
 *   omp-squad add <repo> [--name --branch --model --approval --task]
 *   omp-squad list
 *   omp-squad prompt <id> <message…>
 *   omp-squad rm <id> [--delete-worktree]
 *   omp-squad open
 *
 * `up` is the long-lived process that owns the agents. The other verbs are thin
 * HTTP clients that talk to a running daemon's REST surface.
 */

import * as os from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { loadOrCreateToken } from "./auth.ts";
import { PushService } from "./push.ts";
import { TailnetFederationBus } from "./federation.ts";
import { all as allPresence, who as whoPresence } from "./presence.ts";
import { SquadServer, type AuthInstance } from "./server.ts";
import { SquadManager } from "./squad-manager.ts";
import { ManagerRegistry } from "./manager-registry.ts";
import { SquadTui } from "./tui.ts";
import { startExternalSessionTracker } from "./sessions.ts";
import { startSupervisor } from "./supervisor.ts";
import { acquireStateLock, StateLockError } from "./state-lock.ts";
import { loadEnvFile } from "./plane-secrets.ts";
import { openDatabase } from "./db/index.ts";
import { DbStore } from "./dal/store.ts";
import type { OrgContext } from "./dal/context.ts";
import { DEV_INSECURE_SECRET, makeAuth } from "./db/auth.ts";
import type { Actor, AgentDTO, ApprovalMode, ClientCommand, CommissionResult, CommissionSpec, CreateAgentOptions, ThinkingLevel, TranscriptEntry } from "./types.ts";

const DEFAULT_PORT = Number(process.env.OMP_SQUAD_PORT ?? 7878);

const HELP = `omp-squad — manage a fleet of Oh My Pi agents across git worktrees

USAGE
  omp-squad up [--port N] [--no-tui] [--restore]   Start the daemon (web + TUI)
  omp-squad add <repo> [flags]                     Spawn an agent in a new worktree
  omp-squad list                                   Show the roster
  omp-squad prompt <id> <message...>               Send an instruction to an agent
  omp-squad rm <id> [--delete-worktree]            Remove an agent
  omp-squad who [repo]                             Who/what is working a repo (any omp agent)
  omp-squad logs <id> [--limit N]                  Print an agent's recent transcript
  omp-squad open                                   Print the dashboard URL
  omp-squad commission <name> --purpose <s> [flags]  Author + validate a Flue worker; onboard if it passes

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
  --target <t>             node | cloudflare (default: node)
  --capabilities <a,b>     Least-privilege tool allowlist (recorded in the manifest)
  --accept-payload <json>  Acceptance input · pair with --accept-expect <json> (expected result subset)

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
	return process.env.OMP_SQUAD_STATE_DIR || path.join(os.homedir(), ".omp", "squad");
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
		throw new Error(`No squad daemon on ${base(flags)}. Start one with: omp-squad up`);
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
		// DB mode: one daemon, a per-org SquadManager fleet behind the registry. No single root manager
		// and no global federation bus — each org manager runs isolated under <stateDir>/orgs/<orgId>.
		const ctx: OrgContext = { db: dbHandle.db, type: dbHandle.type };
		registry = new ManagerRegistry({
			root: stateDir,
			store: (orgId) => new DbStore(ctx, orgId, path.join(stateDir, "orgs", orgId)),
			operator,
			autoLand,
			listOrgIds: () => listOrgIds(stateDir),
		});
		registry.start();
	} else {
		// File mode: today's single root manager at the state-dir root.
		const bus = coordinator ? new TailnetFederationBus({ coordinatorUrl: coordinator, operator }) : undefined;
		manager = new SquadManager({ bus, operator, stateDir, autoLand });
		await manager.start();
		if (coordinator) process.stderr.write(`federation: joined ${coordinator} as ${operator.id}\n`);
		if (flags.restore) {
			const n = await manager.loadPersisted();
			if (n) process.stderr.write(`restored ${n} agent(s)\n`);
		}
	}
	const token = await loadOrCreateToken(stateDir);
	const push = new PushService(stateDir);
	await push.init();
	const roleTokens = { operator: process.env.OMP_SQUAD_OPERATOR_TOKEN || undefined, viewer: process.env.OMP_SQUAD_VIEWER_TOKEN || undefined };
	const server = new SquadServer(manager, { port, hostname: host, token, tls, push, roleTokens, auth, db: dbHandle ?? undefined, trustedOrigins, registry });
	const url = server.start();

	// Persistent autonomy: surface raw omp sessions in presence, and (unless opted out) answer
	// pending agent prompts hands-free — both started by the daemon so they live and die with it.
	const stopTracker = startExternalSessionTracker();
	// risk #7: the external supervisor authenticates with the file-mode bearer token; DB mode has none, so file-mode only.
	const supervise = !dbHandle && process.env.OMP_SQUAD_AUTO_SUPERVISE !== "0" && flags["no-supervise"] !== true;
	const stopSupervisor = supervise ? startSupervisor({ port, model: process.env.OMP_SQUAD_SUPERVISE_MODEL || undefined }) : undefined;

	const shutdown = async () => {
		stopSupervisor?.();
		stopTracker();
		if (registry) await registry.stopAll();
		else await manager?.stop();
		server.stop();
		if (dbHandle) await dbHandle.close();
		lock.release();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());

	const useTui = !flags["no-tui"] && process.stdin.isTTY;
	const access = reachableUrls(host, port, tls ? "https" : "http").map((u) => `    ${u}/?token=${token}`).join("\n");
	if (manager && useTui) {
		process.stdout.write(`omp-squad dashboard: ${url}\n  access token: ${token}\n`);
		process.stdout.write(`  autonomy: session-tracker on · auto-supervisor ${supervise ? "on" : "off"}\n`);
		const tui = new SquadTui(manager);
		await tui.run();
		await shutdown();
	} else {
		process.stdout.write(`omp-squad daemon running\n  dashboard: ${url}\n  access token: ${token}\n  open from any device on this network (tap to sign in):\n${access}\n  add an agent: omp-squad add <repo> --task "…"\n`);
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

async function cmdList(args: string[]): Promise<void> {
	const { flags } = parseArgs(args);
	let agents: AgentDTO[];
	try {
		const res = await fetch(`${base(flags)}/api/agents`, { headers: tokenHeader() });
		agents = (await res.json()) as AgentDTO[];
	} catch {
		process.stderr.write(`No squad daemon on ${base(flags)}. Start one with: omp-squad up\n`);
		process.exit(1);
	}
	if (!agents.length) {
		process.stdout.write("no agents\n");
		return;
	}
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
	for (const r of rows) {
		process.stdout.write(
			`${r.status.padEnd(w.status)}  ${r.name.padEnd(w.name)}  ${r.branch.padEnd(w.branch)}  ${r.pend.padEnd(4)}  ${r.activity}\n`,
		);
	}
}

async function cmdPrompt(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const id = positional[0];
	const message = positional.slice(1).join(" ");
	if (!id || !message) {
		process.stderr.write("usage: omp-squad prompt <id> <message...>\n");
		process.exit(1);
	}
	const res = await postCommand(flags, { type: "prompt", id, message });
	process.stdout.write(res.ok ? "sent\n" : `failed: ${await res.text()}\n`);
}

async function cmdRm(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const id = positional[0];
	if (!id) {
		process.stderr.write("usage: omp-squad rm <id> [--delete-worktree]\n");
		process.exit(1);
	}
	const res = await postCommand(flags, { type: "remove", id, deleteWorktree: !!flags["delete-worktree"] });
	process.stdout.write(res.ok ? "removed\n" : `failed: ${await res.text()}\n`);
}

async function cmdLogs(args: string[]): Promise<void> {
	const { positional, flags } = parseArgs(args);
	const id = positional[0];
	if (!id) {
		process.stderr.write("usage: omp-squad logs <id> [--limit N]\n");
		process.exit(1);
	}
	const limit = flags.limit ? Number(flags.limit) : 40;
	let entries: TranscriptEntry[];
	try {
		const res = await fetch(`${base(flags)}/api/agents/${encodeURIComponent(id)}/transcript`, { headers: tokenHeader() });
		entries = (await res.json()) as TranscriptEntry[];
	} catch {
		process.stderr.write(`No squad daemon on ${base(flags)}. Start one with: omp-squad up\n`);
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
		process.stderr.write('usage: omp-squad commission <name> --purpose "..." [--model <spec|false>] [--target node|cloudflare] [--capabilities a,b] [--accept-payload <json> --accept-expect <json>]\n');
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
		case "rm":
		case "remove":
			await cmdRm(rest);
			break;
		case "logs":
			await cmdLogs(rest);
			break;
		case "commission":
		case "hire":
			await cmdCommission(rest);
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

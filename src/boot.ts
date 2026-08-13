/**
 * The daemon's composition root — `glance up`. Split out of src/index.ts (deepen concern 22):
 * this is the ~255-line block that wires every subsystem (storage backend, DB/file mode, TLS/
 * origin trust, root factory, federation bus, server, supervisor, TUI) into one running process.
 * Its ordering is incident-documented — several lines below exist because getting them out of
 * order caused a real production incident (see the inline comments). Moved VERBATIM from
 * index.ts, comments included, per the deletion-test split: this module's whole job is "boot the
 * daemon", and deleting it would leave nowhere else for that composition logic to live.
 */
import * as os from "node:os";
import * as path from "node:path";
import { readdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { loadOrCreateToken } from "./auth.ts";
import { applyWellKnownDirsToProcessPath } from "./bin-dirs.ts";
import { envBool, rootFactoryEnabledWith } from "./config.ts";
import { warmModelDiscovery } from "./model-discovery.ts";
import { PushService } from "./push.ts";
import { LocalFederationBus, NullFederationBus } from "./federation.ts";
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
import { DbStore, FileStore } from "./dal/store.ts";
import type { OrgContext } from "./dal/context.ts";
import { DEV_INSECURE_SECRET, expandLoopbackOrigins, makeAuth } from "./db/auth.ts";
import { RuntimeSettingsStore } from "./runtime-settings.ts";
import { PolicyStore } from "./policy.ts";
import { backendFromEnv, setStorageBackend } from "./dal/storage.ts";
import type { Actor } from "./types.ts";
import { DEFAULT_PORT, parseArgs, stateDirPath } from "./cli-args.ts";

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
 *
 * @substrate exported for the boot-gate test (tests/root-factory.test.ts); live caller is cmdUp,
 * in this same file — a cross-file dead-export scan can't see that.
 */
export function rootFactoryEnabled(repoCount: number = planeRepos().length): boolean {
	return rootFactoryEnabledWith(repoCount);
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

/** Whether a host binds only the loopback interface (local-only). */
function isLoopbackHost(host: string): boolean {
	return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * True iff binding `host` without TLS would put the bearer token on the wire in
 * cleartext: a non-loopback bind (anything but 127.0.0.1 / ::1 / localhost) with hasTls false.
 *
 * @substrate exported for the boot-gate test (tests/safe-bind.test.ts); live caller is cmdUp,
 * in this same file — a cross-file dead-export scan can't see that.
 */
export function bindIsInsecure(host: string, hasTls: boolean): boolean {
	return !isLoopbackHost(host) && !hasTls;
}

/**
 * DB-mode boot decision for the session-signing secret. A missing or dev-default BETTER_AUTH_SECRET
 * makes every session forgeable (total auth bypass). Refuse to boot when bound non-loopback;
 * warn-but-allow on loopback (local dev only).
 *
 * @substrate exported for the boot-gate test (tests/db-auth.test.ts); live caller is cmdUp, in
 * this same file — a cross-file dead-export scan can't see that.
 */
export function secretBootDecision(secret: string | undefined, host: string): "ok" | "warn" | "refuse" {
	const weak = !secret || secret === DEV_INSECURE_SECRET;
	if (!weak) return "ok";
	return isLoopbackHost(host) ? "warn" : "refuse";
}

export async function cmdUp(args: string[]): Promise<void> {
	// FIRST line, before anything below can spawn a harness child: widen this real daemon process's
	// OWN PATH once (bin-dirs.ts) — a bare `nohup omp-squad up &` respawn from a non-interactive shell
	// never sources the user's profile, so a genuinely-installed harness binary otherwise reads as
	// missing for the rest of this process's life (2026-07-28 production incident). Every later spawn
	// (agent-host.ts/omp-call.ts/acp-agent-driver.ts's `scrubbedSpawnEnv`, harness-registry.ts's
	// `binResolvable`) just reads `process.env.PATH` at call time, so widening it here once is enough —
	// deliberately NOT inside `scrubbedSpawnEnv` itself, which unit tests share and rely on being able
	// to narrow (see bin-dirs.ts's doc).
	applyWellKnownDirsToProcessPath();
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
	// Loopback aliases are DISTINCT origins to a browser and to better-auth's allowlist, but the same
	// daemon to a person: bound to 127.0.0.1 and browsed as http://localhost:<port>, the SPA sends
	// `callbackURL: window.location.origin` = the localhost spelling, which fails the origin check with
	// "Invalid callbackURL" — SSO and social sign-in dead-end on the URL a human naturally types.
	// So when the bind is loopback, trust every spelling of it (127.0.0.1 / localhost / [::1]). This
	// widens nothing reachable: all three already resolve to this host only.
	const trustedOrigins = [
		...new Set([
			...expandLoopbackOrigins(reachableUrls(host, port, scheme).map((u) => new URL(u).origin)),
			...(externalOrigin ? [externalOrigin] : []),
		]),
	];
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
			// Protect the root factory's agents from the machine-global orphan-host reap (2026-07-20
			// incident: every console chat's host was SIGTERM'd within a maintenance tick). Union of
			// the LIVE root roster (closure over `manager`, assigned below after this constructor) and
			// the PERSISTED root FileStore roster — the persisted half is the boot-safety seed, so a
			// surviving host is protected even before (or without) the root factory standing up.
			// Deliberately NO catch on the store read: a corrupt/unreadable root state.json must reject
			// so protectedIds() rejects and the registry SKIPS that reap pass (fail closed) — degrading
			// to an empty root half would reap every surviving root host, the exact incident class.
			rootRosterIds: async () => {
				const live = manager ? manager.list().map((a) => a.id) : [];
				const persisted = (await new FileStore(stateDir).load()).agents.map((a) => a.id);
				return [...live, ...persisted];
			},
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
			// skipGlobalJanitors: the registry above owns the machine-global reaps (protected by the
			// union INCLUDING this manager via rootRosterIds). Without it this manager's own poll
			// janitor ran reapOrphanHosts with only ITS roster protected — the mirror-image kill,
			// SIGTERMing every tenant org's live hosts every ~30s.
			manager = new SquadManager({ bus: new NullFederationBus(), operator, stateDir, autoLand, bin: glanceBin(), skipGlobalJanitors: true });
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

	// Cold per-harness model discovery (model-discovery.ts): ARM it here — real daemon boot only,
	// mirroring applyWellKnownDirsToProcessPath's discipline above, so no test-constructed
	// SquadServer ever spawns genuine harness CLIs — and warm the cache immediately, so the create
	// surface's first `/api/models` fetch finds real per-harness rosters instead of eating the
	// probes' full latency (or, before this existed, showing one bare "default" per harness).
	warmModelDiscovery();

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

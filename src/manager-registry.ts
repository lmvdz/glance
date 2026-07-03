/**
 * ManagerRegistry — per-org SquadManager fleet behind a lazy map (MT-SaaS P2).
 *
 * DB mode runs ONE daemon process owning all orgs under one root lock, but each
 * organization gets its OWN SquadManager with an org-scoped stateDir + worktree
 * base + Store. Isolation is structural: manager A's `agents` Map physically
 * cannot hold org B's agents, so no per-call org filter is ever required.
 *
 * Managers are created lazily on first request for an org and evicted when idle.
 * The machine-global janitors (orphan-host reap, stale-socket prune, registry
 * sweep) are hoisted HERE — a per-org manager runs with `skipGlobalJanitors`,
 * so it can never reap another org's live hosts (risk #1). The reap-protected
 * set is the UNION of every live manager's agent ids AND every org's persisted
 * roster, so a not-yet-adopted surviving host is never killed at boot.
 *
 * File mode does not use the registry at all (index.ts keeps the single root
 * manager); the registry exists only when a DB/auth layer is present.
 */

import * as path from "node:path";
import { pruneStaleSockets, reapOrphanHosts } from "./agent-host.ts";
import type { Store } from "./dal/store.ts";
import { NullFederationBus } from "./federation.ts";
import { sweepLeases } from "./leases.ts";
import { sweepPresence } from "./presence.ts";
import { sweepProofs } from "./proof.ts";
import { SquadManager } from "./squad-manager.ts";
import type { Actor, SquadEvent } from "./types.ts";

export interface RegistryDeps {
	/** The resolved glance state dir (state-dir.ts). Per-org state lives under `<root>/orgs/<orgId>/`. */
	root: string;
	/** Build the per-org persistence store (DbStore(ctx, orgId, dir) in DB mode). */
	store: (orgId: string) => Store;
	/** Daemon operator identity (stamped, per-org, with orgId). */
	operator: Actor;
	/** omp binary override, forwarded to each manager. */
	bin?: string;
	/** Autonomous-land mode, forwarded to each manager. */
	autoLand?: boolean;
	/** Enumerate every org that has persisted state, for the boot-safe reap-protected union.
	 *  Absent ⇒ no cross-org seed (tests / no DB). */
	listOrgIds?: () => Promise<string[]>;
	/** Maintenance cadence (evict + janitor) in ms. Default 60s. */
	maintenanceMs?: number;
	/** Idle TTL before an agent-less manager is evicted. Default 10min (OMP_SQUAD_ORG_IDLE_MS). */
	idleMs?: number;
}

interface Entry {
	manager: SquadManager;
	listener: (e: SquadEvent) => void;
	lastUsed: number;
}

export class ManagerRegistry {
	private readonly managers = new Map<string, Entry>();
	/** In-flight creates, so two concurrent first requests for an org share one manager. */
	private readonly creating = new Map<string, Promise<SquadManager>>();
	private readonly idleMs: number;
	private maintenanceTimer?: Timer;
	/** Server-supplied per-org event sink; set before start(). */
	onEvent: (orgId: string, e: SquadEvent) => void = () => {};

	constructor(private readonly deps: RegistryDeps) {
		this.idleMs = deps.idleMs ?? (Number(process.env.OMP_SQUAD_ORG_IDLE_MS) || 600_000);
	}

	/** Start the maintenance loop (evict idle + machine-global janitors). */
	start(): void {
		const ms = this.deps.maintenanceMs ?? 60_000;
		this.maintenanceTimer = setInterval(() => void this.maintain(), ms);
		this.maintenanceTimer.unref?.();
	}

	/** Existing manager for `orgId`, or undefined — never creates (does this org have a live fleet?). */
	peek(orgId: string): SquadManager | undefined {
		return this.managers.get(orgId)?.manager;
	}

	/** Lazily create (+start +attach listener) or return the manager for `orgId`. Idempotent under concurrency. */
	async get(orgId: string): Promise<SquadManager> {
		const existing = this.managers.get(orgId);
		if (existing) {
			existing.lastUsed = Date.now();
			return existing.manager;
		}
		const inFlight = this.creating.get(orgId);
		if (inFlight) return inFlight;
		const create = this.create(orgId);
		this.creating.set(orgId, create);
		try {
			return await create;
		} finally {
			this.creating.delete(orgId);
		}
	}

	private async create(orgId: string): Promise<SquadManager> {
		const stateDir = path.join(this.deps.root, "orgs", orgId);
		const manager = new SquadManager({
			operator: { ...this.deps.operator, orgId },
			bus: new NullFederationBus(),
			stateDir,
			worktreeBase: path.join(stateDir, "worktrees"),
			store: this.deps.store(orgId),
			bin: this.deps.bin,
			autoLand: this.deps.autoLand,
			skipGlobalJanitors: true,
		});
		const listener = (e: SquadEvent) => this.onEvent(orgId, e);
		manager.on("event", listener);
		await manager.start();
		this.managers.set(orgId, { manager, listener, lastUsed: Date.now() });
		return manager;
	}

	/** Stop + drop managers that have no live agents and have been idle past the TTL. Returns the count evicted. */
	async evictIdle(now: number): Promise<number> {
		let n = 0;
		for (const [orgId, entry] of [...this.managers]) {
			if (now - entry.lastUsed <= this.idleMs) continue;
			// Never evict a manager with an in-flight agent (working/starting/input) — only fully-quiet fleets.
			const busy = entry.manager.list().some((a) => a.status === "working" || a.status === "starting" || a.status === "input");
			if (busy) continue;
			entry.manager.off("event", entry.listener);
			await entry.manager.stop(); // detaches (does not kill) hosts + persists; a later get() re-adopts
			this.managers.delete(orgId);
			n++;
		}
		return n;
	}

	/** Stop every manager and clear timers (shutdown). */
	async stopAll(): Promise<void> {
		clearInterval(this.maintenanceTimer);
		for (const [orgId, entry] of [...this.managers]) {
			entry.manager.off("event", entry.listener);
			await entry.manager.stop();
			this.managers.delete(orgId);
		}
	}

	/** One maintenance pass: machine-global reaping over the protected union, then idle eviction. */
	private async maintain(): Promise<void> {
		await this.reapGlobal().catch(() => {});
		await this.evictIdle(Date.now()).catch(() => {});
	}

	/**
	 * The reap-protected id set: the UNION of every live manager's agent ids and every org's
	 * persisted roster (so a host awaiting lazy re-adoption is never killed at boot, when no
	 * manager has been created yet). Seeding from the persisted rosters is the boot-safety trap
	 * the lifecycle plan calls out — an empty union would reap ALL surviving hosts.
	 * ponytail: re-scans every org's persisted roster each pass (bounded by org count). Upgrade path:
	 * a dedicated roster-id query if the per-org store load proves too heavy at high tenant counts.
	 */
	async protectedIds(): Promise<Set<string>> {
		const ids = new Set<string>();
		for (const entry of this.managers.values()) for (const a of entry.manager.list()) ids.add(a.id);
		if (this.deps.listOrgIds) {
			for (const orgId of await this.deps.listOrgIds()) {
				for (const a of (await this.deps.store(orgId).load()).agents) ids.add(a.id);
			}
		}
		return ids;
	}

	/**
	 * Reap orphan agent-host processes machine-wide, protecting the union (above), then prune stale
	 * sockets + sweep the global lease/presence/proof registries once (a per-org manager must not).
	 */
	private async reapGlobal(): Promise<void> {
		await reapOrphanHosts(await this.protectedIds()).catch(() => []);
		await pruneStaleSockets().catch(() => []);
		await Promise.all([sweepLeases(), sweepPresence(), sweepProofs()]).catch(() => []);
	}
}

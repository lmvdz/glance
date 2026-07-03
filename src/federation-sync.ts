/**
 * Federation sync — cross-host file leasing over the tailnet.
 *
 * The reusable engine is {@link attachLeaseGossip}: given ANY federation bus it
 * wires both halves of cross-host leasing onto it, with no coupling to the
 * daemon (it works entirely off the shared on-disk registries under ~/.omp/squad):
 *
 *   publish : every tick, read this operator's own live leases per repo and
 *             gossip them to the bus, keyed by the repo's cross-host identity
 *             (normalized git origin — see repo-identity.ts).
 *   mirror  : a peer's leases for a repo we ALSO have locally are written into
 *             our local registry (preserving the remote operator/host) so the
 *             lease-hook's `holdersOf` warns about cross-host edits and the
 *             command center's "Files in flight" panel shows them. The TTL
 *             prunes a mirrored lease once the peer stops gossiping.
 *
 * Two callers share this one engine:
 *   - The daemon (src/squad-manager.ts) attaches it to its OWN in-process
 *     LocalFederationBus, so a normal daemon gossips leases through the single
 *     coordinator socket it already holds — no separate process required. This
 *     is the primary path (see SquadManager.start).
 *   - {@link startFederationSync} runs it against a dedicated TailnetFederationBus
 *     as a STANDALONE worker (src/federation-sync-main.ts) for hosts that want
 *     lease gossip decoupled from the daemon. Superseded for the in-daemon case,
 *     but kept fully functional for that decoupled deployment.
 *
 * Discovery of which repos we have locally comes from the presence registry
 * (every squad agent + raw omp session claims one), plus any `repos` passed in.
 */

import { type FederationBus, type RemoteLeases, TailnetFederationBus } from "./federation.ts";
import { leasesFor, mirrorLease } from "./leases.ts";
import { all as livePresence } from "./presence.ts";
import { repoIdentity } from "./repo-identity.ts";
import type { Actor } from "./types.ts";

/** Default cadence for the owned-lease publish tick, shared by the daemon and the standalone worker. */
export const LEASE_GOSSIP_INTERVAL_MS = 15_000;

/** The half of a federation bus lease gossip needs: publish our leases, observe peers'. */
type LeaseBus = Pick<FederationBus, "publishLeases" | "onLeases">;

export interface LeaseGossipOptions {
	/** Bus to gossip over — the daemon's in-process LocalFederationBus, or a standalone TailnetFederationBus. */
	bus: LeaseBus;
	operator: Actor;
	/** Repo paths to always gossip, in addition to those discovered from the presence registry. */
	repos?: string[];
	/** Observability seam: fired after a peer's leases are mirrored into the local registry. */
	onMirror?: (frame: RemoteLeases) => void;
}

export interface LeaseGossip {
	/** Refresh the identity→paths map and gossip this operator's leases once. Returns the repo identities published. */
	publishNow(): Promise<string[]>;
}

/**
 * Wire both halves of cross-host file leasing onto an existing federation bus:
 * subscribe `onLeases` to mirror peers' leases into the local registry, and
 * expose `publishNow()` to gossip THIS operator's owned leases. The bus is not
 * started/stopped here — the caller owns its lifecycle (the daemon's bus is
 * already running; the worker starts its own). Returns immediately; no timer of
 * its own (the caller drives the cadence).
 */
export function attachLeaseGossip(opts: LeaseGossipOptions): LeaseGossip {
	const { bus, operator } = opts;
	/** Cross-host repo identity → the local repo paths that resolve to it. */
	const localByIdentity = new Map<string, Set<string>>();

	async function localRepos(): Promise<string[]> {
		const set = new Set<string>(opts.repos ?? []);
		for (const entry of await livePresence().catch(() => [])) {
			if (entry.repo.length > 0) set.add(entry.repo);
		}
		return [...set];
	}

	async function refreshMap(): Promise<void> {
		localByIdentity.clear();
		for (const repo of await localRepos()) {
			const id = repoIdentity(repo);
			let paths = localByIdentity.get(id);
			if (paths === undefined) {
				paths = new Set<string>();
				localByIdentity.set(id, paths);
			}
			paths.add(repo);
		}
	}

	bus.onLeases((frame) => {
		// Ignore our own gossip relayed back to us (loopback on the LocalFederationBus, or the
		// coordinator echo — neither should re-mirror our own leases).
		if (frame.operator.id === operator.id) return;
		const targets = localByIdentity.get(frame.repoId);
		if (targets === undefined) return;
		void (async () => {
			for (const repo of targets) {
				for (const lease of frame.leases) await mirrorLease(repo, lease);
			}
			opts.onMirror?.(frame);
		})();
	});

	async function publishNow(): Promise<string[]> {
		await refreshMap();
		const published: string[] = [];
		for (const [id, paths] of localByIdentity) {
			// One path per identity sources the leases; same identity ⇒ same logical repo.
			const [repo] = paths;
			if (repo === undefined) continue;
			// Only gossip leases this operator OWNS — never re-broadcast leases we mirrored from peers.
			const mine = (await leasesFor(repo).catch(() => [])).filter((l) => l.operator === operator.id);
			bus.publishLeases(id, mine);
			published.push(id);
		}
		return published;
	}

	return { publishNow };
}

export interface FederationSyncOptions {
	coordinatorUrl: string;
	operator: Actor;
	/** Pre-shared token presented to the coordinator's auth gate. */
	token?: string;
	/** Repo paths to always gossip, in addition to those discovered from the presence registry. */
	repos?: string[];
	publishIntervalMs?: number;
	/** Observability seam: fired after a peer's leases are mirrored into the local registry. */
	onMirror?: (frame: RemoteLeases) => void;
}

export interface FederationSyncHandle {
	/** Refresh the identity→paths map and gossip this operator's leases once. Returns the repo identities published. */
	publishNow(): Promise<string[]>;
	stop(): Promise<void>;
}

/**
 * STANDALONE lease-sync worker: run {@link attachLeaseGossip} against its own
 * dedicated TailnetFederationBus + timer, decoupled from the daemon. The daemon
 * itself no longer needs this (it attaches the same engine to its own bus — see
 * SquadManager.start); kept for the decoupled deployment (federation-sync-main.ts).
 */
export async function startFederationSync(opts: FederationSyncOptions): Promise<FederationSyncHandle> {
	const bus = new TailnetFederationBus({ coordinatorUrl: opts.coordinatorUrl, operator: opts.operator, token: opts.token });
	const gossip = attachLeaseGossip({ bus, operator: opts.operator, repos: opts.repos, onMirror: opts.onMirror });

	await bus.start();
	await gossip.publishNow();
	const timer: Timer = setInterval(() => void gossip.publishNow(), opts.publishIntervalMs ?? LEASE_GOSSIP_INTERVAL_MS);
	timer.unref?.();

	return {
		publishNow: gossip.publishNow,
		async stop(): Promise<void> {
			clearInterval(timer);
			await bus.stop();
		},
	};
}

/**
 * Federation sync — cross-host file leasing over the tailnet.
 *
 * A standalone companion (run via federation-sync-main.ts, or embed via
 * `startFederationSync`) that promotes the LOCAL lease registry to the tailnet,
 * with no coupling to the daemon: it works entirely off the shared on-disk
 * registries under ~/.omp/squad.
 *
 *   publish : every tick, read this operator's own live leases per repo and
 *             gossip them to the coordinator, keyed by the repo's cross-host
 *             identity (normalized git origin — see repo-identity.ts).
 *   mirror  : a peer's leases for a repo we ALSO have locally are written into
 *             our local registry (preserving the remote operator/host) so the
 *             lease-hook's `holdersOf` warns about cross-host edits and the
 *             command center's "Files in flight" panel shows them. The TTL
 *             prunes a mirrored lease once the peer stops gossiping.
 *
 * Discovery of which repos we have locally comes from the presence registry
 * (every squad agent + raw omp session claims one), plus any `repos` passed in.
 */

import * as os from "node:os";
import { type RemoteLeases, TailnetFederationBus } from "./federation.ts";
import { leasesFor, mirrorLease } from "./leases.ts";
import { all as livePresence } from "./presence.ts";
import { repoIdentity } from "./repo-identity.ts";
import type { Actor } from "./types.ts";

const PUBLISH_INTERVAL_MS = 15_000;

export interface FederationSyncOptions {
	coordinatorUrl: string;
	operator: Actor;
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

export async function startFederationSync(opts: FederationSyncOptions): Promise<FederationSyncHandle> {
	const bus = new TailnetFederationBus({ coordinatorUrl: opts.coordinatorUrl, operator: opts.operator });
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
		// Ignore our own gossip relayed back to us.
		if (frame.operator.id === opts.operator.id) return;
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
			const mine = (await leasesFor(repo).catch(() => [])).filter((l) => l.operator === opts.operator.id);
			bus.publishLeases(id, mine);
			published.push(id);
		}
		return published;
	}

	await bus.start();
	await publishNow();
	const timer: Timer = setInterval(() => void publishNow(), opts.publishIntervalMs ?? PUBLISH_INTERVAL_MS);
	timer.unref?.();

	return {
		publishNow,
		async stop(): Promise<void> {
			clearInterval(timer);
			await bus.stop();
		},
	};
}

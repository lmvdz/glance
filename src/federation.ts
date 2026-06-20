/**
 * Federation seam (Phase 2).
 *
 * The single-operator SquadManager programs against this interface so the
 * cross-operator "team room" drops in as a transport, not a rewrite.
 *
 * Planned implementations:
 *  - NullFederationBus  — v1 default; no peers, everything is local.
 *  - TailnetFederationBus (Phase 2) — WS over a Tailscale tailnet. Identity is
 *    verified via the local `tailscale whois <peer-ip>` (LocalAPI); ACLs gate
 *    reachability; availability/delegation policy authorizes remote steering;
 *    every cross-operator command is audited.
 *  - RelayFederationBus (optional) — omp's content-blind collab relay for
 *    zero-infra / cross-org rooms (E2E key-is-trust).
 */

import type { Actor, ClientCommand, OperatorPresence } from "./types.ts";
import type { LeaseEntry } from "./leases.ts";

export const LOCAL_ACTOR: Actor = { id: "local", origin: "local" };

/** A command arriving from a federation peer, tagged with its verified actor. */
export interface RemoteCommand {
	cmd: ClientCommand;
	actor: Actor;
}

export interface TeamMessage {
	from: Actor;
	text: string;
	ts: number;
}

/** A batch of one repo's live file leases, gossiped by its operator. The repo is identified across hosts by `repoId` (a normalized git origin URL — see repo-identity.ts), not a host-local path. */
export interface RemoteLeases {
	repoId: string;
	operator: Actor;
	leases: LeaseEntry[];
}

export interface FederationBus {
	/** Begin participating in the team room. */
	start(): Promise<void>;
	stop(): Promise<void>;

	/** Push this operator's roster/availability to peers (called on every change, debounced by the bus). */
	publishPresence(presence: OperatorPresence): void;

	/** Peer rosters changed (for the roster-of-rosters view). */
	onPresence(cb: (presence: OperatorPresence) => void): void;

	/** A peer wants to steer one of *our* agents. The manager authorizes via policy + actor before applying. */
	onRemoteCommand(cb: (remote: RemoteCommand) => void): void;

	/** Team chat. */
	sendMessage(text: string): void;
	onMessage(cb: (msg: TeamMessage) => void): void;

	/** Publish this host's live file leases for a repo (cross-host advisory leasing). */
	publishLeases(repoId: string, leases: LeaseEntry[]): void;

	/** A peer published its file leases for a repo. */
	onLeases(cb: (frame: RemoteLeases) => void): void;
}

/** v1 default: a bus with no peers. Keeps the manager's federation paths live but inert. */
export class NullFederationBus implements FederationBus {
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	publishPresence(_presence: OperatorPresence): void {}
	onPresence(_cb: (presence: OperatorPresence) => void): void {}
	onRemoteCommand(_cb: (remote: RemoteCommand) => void): void {}
	sendMessage(_text: string): void {}
	onMessage(_cb: (msg: TeamMessage) => void): void {}
	publishLeases(_repoId: string, _leases: LeaseEntry[]): void {}
	onLeases(_cb: (frame: RemoteLeases) => void): void {}
}

// ── Cross-operator layer (Phase 2) ───────────────────────────────────────────

/** Two or more agents owned by DIFFERENT operators sharing one repo + ref. */
export interface Collision {
	repo: string;
	ref: string;
	operators: string[];
	agents: string[];
}

/**
 * Merge peer rosters into one operator list for the roster-of-rosters view.
 * Deduped by `operator.id` with the newest `updatedAt` winning; `self` is always
 * first — its slot is pinned to the head regardless of peer timestamps (a peer
 * may only refresh self's entry by being strictly newer, never reorder it).
 */
export function mergeRosters(self: OperatorPresence, peers: OperatorPresence[]): OperatorPresence[] {
	const byId = new Map<string, OperatorPresence>();
	// Seed self first so its key occupies the head of the insertion-ordered map.
	byId.set(self.operator.id, self);
	for (const presence of peers) {
		const existing = byId.get(presence.operator.id);
		if (existing === undefined || presence.updatedAt > existing.updatedAt) byId.set(presence.operator.id, presence);
	}
	return [...byId.values()];
}

/**
 * Flag repos where agents owned by DIFFERENT operators share the same branch
 * (the `ref`) — so two people don't unknowingly run agents over the same
 * checkout. Same-operator overlaps never collide; agents with no branch are
 * skipped (no known ref to compare against).
 */
export function detectCollisions(presences: OperatorPresence[]): Collision[] {
	interface CollisionGroup {
		repo: string;
		ref: string;
		operators: Set<string>;
		agents: Set<string>;
	}
	const groups = new Map<string, CollisionGroup>();
	for (const presence of presences) {
		for (const agent of presence.agents) {
			if (agent.branch === undefined) continue;
			const key = `${agent.repo}\u0000${agent.branch}`;
			let group = groups.get(key);
			if (group === undefined) {
				group = { repo: agent.repo, ref: agent.branch, operators: new Set(), agents: new Set() };
				groups.set(key, group);
			}
			group.operators.add(presence.operator.id);
			group.agents.add(agent.id);
		}
	}
	const collisions: Collision[] = [];
	for (const group of groups.values()) {
		if (group.operators.size < 2) continue;
		collisions.push({ repo: group.repo, ref: group.ref, operators: [...group.operators], agents: [...group.agents] });
	}
	return collisions;
}

// ── Tailnet transport ────────────────────────────────────────────────────────

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

/** Wire frames exchanged with the coordinator. */
type FederationFrame =
	| { kind: "presence"; presence: OperatorPresence }
	| { kind: "command"; cmd: ClientCommand; actor: Actor; ip?: string }
	| { kind: "message"; from: Actor; text: string; ts: number }
	| { kind: "leases"; repoId: string; operator: Actor; leases: LeaseEntry[] };

/** Shape of `tailscale whois --json <ip>` output we care about. */
interface TailscaleWhoisResult {
	UserProfile?: { LoginName?: string; DisplayName?: string };
}

/**
 * Default `whois`: resolve a tailnet peer IP to its SSO-backed `Actor` via the
 * local `tailscale whois --json <ip>` LocalAPI. Best-effort — returns undefined
 * if the tailscale binary is absent or the IP is not a known tailnet peer.
 */
async function tailscaleWhois(ip: string): Promise<Actor | undefined> {
	try {
		const proc = Bun.spawn(["tailscale", "whois", "--json", ip], { stdout: "pipe", stderr: "ignore" });
		const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (code !== 0) return undefined;
		const parsed = JSON.parse(out) as TailscaleWhoisResult;
		const id = parsed.UserProfile?.LoginName;
		if (id === undefined || id === "") return undefined;
		return { id, displayName: parsed.UserProfile?.DisplayName, origin: "remote" };
	} catch {
		return undefined;
	}
}

/**
 * Tailnet-backed federation bus (Phase 2).
 *
 * REQUIRES a reachable coordinator on the tailnet at `coordinatorUrl` — a
 * WebSocket endpoint, typically run by your org on a Tailscale node. Identity
 * comes from the tailnet: `whois` maps a peer IP to its SSO-backed `Actor` via
 * the local `tailscale whois --json <ip>` LocalAPI; WireGuard encrypts the wire
 * and Tailscale ACLs gate who can even reach the coordinator.
 *
 * Wire protocol (one JSON frame per message):
 *   {kind:"presence", presence}      — roster/availability gossip
 *   {kind:"command",  cmd, actor}    — a peer steering one of our agents
 *   {kind:"message",  from, text, ts} — team chat
 *
 * Resilient by construction: the socket auto-reconnects with capped backoff and
 * NO transport error is ever thrown to the caller — failures are swallowed (and
 * never written to the console; the manager's own log surface owns user noise).
 */
export class TailnetFederationBus implements FederationBus {
	private readonly coordinatorUrl: string;
	private readonly operator: Actor;
	private readonly whois: (ip: string) => Promise<Actor | undefined>;
	private readonly presenceCbs: ((presence: OperatorPresence) => void)[] = [];
	private readonly commandCbs: ((remote: RemoteCommand) => void)[] = [];
	private readonly messageCbs: ((msg: TeamMessage) => void)[] = [];
	private readonly leasesCbs: ((frame: RemoteLeases) => void)[] = [];
	private ws?: WebSocket;
	private reconnectTimer?: Timer;
	private backoffMs = INITIAL_BACKOFF_MS;
	private stopped = true;
	private lastPresence?: OperatorPresence;
	private readonly lastLeases = new Map<string, LeaseEntry[]>();

	constructor(opts: { coordinatorUrl: string; operator: Actor; whois?: (ip: string) => Promise<Actor | undefined> }) {
		this.coordinatorUrl = opts.coordinatorUrl;
		this.operator = opts.operator;
		this.whois = opts.whois ?? tailscaleWhois;
	}

	async start(): Promise<void> {
		this.stopped = false;
		this.connect();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		const ws = this.ws;
		this.ws = undefined;
		if (ws !== undefined) {
			try {
				ws.close();
			} catch {
				// swallow: closing a half-open socket may throw; never propagate
			}
		}
	}

	publishPresence(presence: OperatorPresence): void {
		this.lastPresence = presence;
		this.send({ kind: "presence", presence });
	}

	onPresence(cb: (presence: OperatorPresence) => void): void {
		this.presenceCbs.push(cb);
	}

	onRemoteCommand(cb: (remote: RemoteCommand) => void): void {
		this.commandCbs.push(cb);
	}

	sendMessage(text: string): void {
		this.send({ kind: "message", from: this.operator, text, ts: Date.now() });
	}

	onMessage(cb: (msg: TeamMessage) => void): void {
		this.messageCbs.push(cb);
	}

	publishLeases(repoId: string, leases: LeaseEntry[]): void {
		this.lastLeases.set(repoId, leases);
		this.send({ kind: "leases", repoId, operator: this.operator, leases });
	}

	onLeases(cb: (frame: RemoteLeases) => void): void {
		this.leasesCbs.push(cb);
	}

	private connect(): void {
		if (this.stopped) return;
		let ws: WebSocket;
		try {
			ws = new WebSocket(this.coordinatorUrl);
		} catch {
			// swallow: a bad URL throws synchronously — retry on backoff
			this.scheduleReconnect();
			return;
		}
		this.ws = ws;
		ws.onopen = (): void => {
			this.backoffMs = INITIAL_BACKOFF_MS;
			// Re-announce our latest presence to the (re)connected coordinator.
			if (this.lastPresence !== undefined) this.send({ kind: "presence", presence: this.lastPresence });
			// Re-announce our latest per-repo leases too, so a sync that publishes before the socket opens still reaches the coordinator.
			for (const [repoId, leases] of this.lastLeases) this.send({ kind: "leases", repoId, operator: this.operator, leases });
		};
		ws.onmessage = (event: MessageEvent): void => {
			void this.handleFrame(event.data);
		};
		ws.onclose = (): void => {
			if (this.ws === ws) this.ws = undefined;
			this.scheduleReconnect();
		};
		ws.onerror = (): void => {
			// swallow: an error event is always followed by close, which reconnects
		};
	}

	private scheduleReconnect(): void {
		if (this.stopped) return;
		clearTimeout(this.reconnectTimer);
		const delay = this.backoffMs;
		this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
		this.reconnectTimer = setTimeout(() => this.connect(), delay);
	}

	private send(frame: FederationFrame): void {
		const ws = this.ws;
		if (ws === undefined || ws.readyState !== WebSocket.OPEN) return;
		try {
			ws.send(JSON.stringify(frame));
		} catch {
			// swallow: the socket may have closed between the readyState check and send
		}
	}

	private async handleFrame(data: unknown): Promise<void> {
		try {
			if (typeof data !== "string") return;
			const frame = JSON.parse(data) as FederationFrame;
			switch (frame.kind) {
				case "presence":
					for (const cb of this.presenceCbs) cb(frame.presence);
					break;
				case "command": {
					const actor = await this.resolveActor(frame);
					for (const cb of this.commandCbs) cb({ cmd: frame.cmd, actor });
					break;
				}
				case "message":
					for (const cb of this.messageCbs) cb({ from: frame.from, text: frame.text, ts: frame.ts });
					break;
				case "leases":
					for (const cb of this.leasesCbs) cb({ repoId: frame.repoId, operator: frame.operator, leases: frame.leases });
					break;
			}
		} catch {
			// swallow: a malformed frame or a throwing callback must not kill the socket
		}
	}

	/** Prefer a tailnet-verified identity when the frame carries the peer IP; fall back to the coordinator-stamped actor. */
	private async resolveActor(frame: { actor: Actor; ip?: string }): Promise<Actor> {
		if (frame.ip === undefined) return frame.actor;
		const verified = await this.whois(frame.ip).catch(() => undefined);
		return verified ?? frame.actor;
	}
}

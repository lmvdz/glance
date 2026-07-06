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

import { Result } from "effect";
import type { Actor, AgentDTO, ClientCommand, OperatorPresence } from "./types.ts";
import type { LeaseEntry } from "./leases.ts";
import { repoIdentity } from "./repo-identity.ts";
import { decodeClientCommand } from "./schema/client-command.ts";

export const LOCAL_ACTOR: Actor = { id: "local", origin: "local" };

/** A command arriving from a federation peer, tagged with its verified actor. */
export interface RemoteCommand {
	cmd: ClientCommand;
	actor: Actor;
	/** Sender-minted correlation id — echo it in the ack so the sender can match the outcome. */
	cmdId?: string;
	/** CLAIMED sender operator id — used ONLY to address the ack frame, never for authority. */
	replyTo?: string;
}

/** The outcome of a remote command, reported back to its sender. Advisory — never authority. */
export interface CommandAck {
	cmdId: string;
	outcome: "applied" | "denied" | "error";
	detail?: string;
	/** Claimed responder operator id (display/audit only). */
	from?: string;
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

	/**
	 * Steer a PEER operator's agent — the outbound half of `onRemoteCommand` (this was the
	 * principal missing cross-operator capability: the receive side existed, nothing sent).
	 * `to` addresses one operator id; receivers drop frames not addressed to them. The
	 * receiving manager still authorizes via whois-verified actor + RBAC — sending grants
	 * nothing. Returns the minted correlation id; the peer's outcome arrives on `onAck`
	 * (best-effort — no delivery guarantee).
	 */
	sendCommand(cmd: ClientCommand, to?: string): string;

	/** Report a remote command's outcome back to its sender (advisory; carries no authority). */
	sendAck(ack: CommandAck, to: string): void;

	/** An ack for a command THIS host sent arrived. */
	onAck(cb: (ack: CommandAck) => void): void;

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
	sendCommand(_cmd: ClientCommand, _to?: string): string {
		return "";
	}
	sendAck(_ack: CommandAck, _to: string): void {}
	onAck(_cb: (ack: CommandAck) => void): void {}
	sendMessage(_text: string): void {}
	onMessage(_cb: (msg: TeamMessage) => void): void {}
	publishLeases(_repoId: string, _leases: LeaseEntry[]): void {}
	onLeases(_cb: (frame: RemoteLeases) => void): void {}
}

// ── Cross-operator layer (Phase 2) ───────────────────────────────────────────

/** Two or more agents owned by DIFFERENT operators sharing one repo + ref. */
export interface Collision {
	/** Cross-host repo identity the collision is keyed on (normalized git origin / `name:<dir>`). */
	repoId: string;
	/** A host-local path for ONE of the colliding agents — display only; peers have their own. */
	repo: string;
	ref: string;
	operators: string[];
	agents: string[];
}

/**
 * Cross-host repo identity for an agent: its wire-carried `repoId` when a peer
 * already computed it (we can't reach the peer's path to run git ourselves), else
 * derived from the host-local `repo` path. Memoized per path so detection over a
 * roster never shells out to git more than once per distinct checkout.
 */
export function agentRepoId(agent: Pick<AgentDTO, "repo" | "repoId">, cache?: Map<string, string>): string {
	if (typeof agent.repoId === "string" && agent.repoId.length > 0) return agent.repoId;
	const cached = cache?.get(agent.repo);
	if (cached !== undefined) return cached;
	const id = repoIdentity(agent.repo);
	cache?.set(agent.repo, id);
	return id;
}

/** Process-wide path→identity memo: a repo's origin is stable for the process lifetime. */
const REPO_ID_MEMO = new Map<string, string>();

/**
 * Stamp every agent's cross-host `repoId` onto an OUTGOING presence frame, derived
 * locally (only this host can run git on its own paths). A peer can't reach our
 * paths to derive identity itself, so without this its `detectCollisions` would
 * fall back to `name:<basename>` and miss / mis-key cross-host overlaps. Returns a
 * shallow copy; the caller's roster is never mutated.
 */
export function stampRepoIds(presence: OperatorPresence): OperatorPresence {
	return {
		...presence,
		agents: presence.agents.map((a) => (typeof a.repoId === "string" && a.repoId.length > 0 ? a : { ...a, repoId: agentRepoId(a, REPO_ID_MEMO) })),
	};
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
 *
 * Keyed on the repo's CROSS-HOST identity (normalized git origin — see
 * repo-identity.ts), NOT the host-local `agent.repo` path: two operators working
 * the same GitHub repo at different absolute paths now collide, and two unrelated
 * repos that merely share a basename no longer false-collide.
 */
export function detectCollisions(presences: OperatorPresence[]): Collision[] {
	interface CollisionGroup {
		repoId: string;
		repo: string;
		ref: string;
		operators: Set<string>;
		agents: Set<string>;
	}
	const idCache = new Map<string, string>();
	const groups = new Map<string, CollisionGroup>();
	for (const presence of presences) {
		for (const agent of presence.agents) {
			if (agent.branch === undefined) continue;
			const repoId = agentRepoId(agent, idCache);
			const key = `${repoId}\u0000${agent.branch}`;
			let group = groups.get(key);
			if (group === undefined) {
				group = { repoId, repo: agent.repo, ref: agent.branch, operators: new Set(), agents: new Set() };
				groups.set(key, group);
			}
			group.operators.add(presence.operator.id);
			group.agents.add(agent.id);
		}
	}
	const collisions: Collision[] = [];
	for (const group of groups.values()) {
		if (group.operators.size < 2) continue;
		collisions.push({ repoId: group.repoId, repo: group.repo, ref: group.ref, operators: [...group.operators], agents: [...group.agents] });
	}
	return collisions;
}

/** TTL after which a peer that stopped gossiping presence drops off the roster-of-rosters. Matches the presence registry's 90s. */
export const PEER_PRESENCE_TTL_MS = 90_000;

/** The roster-of-rosters surfaced to a local command center: every operator's roster merged, with cross-operator branch collisions flagged. */
export interface FederationView {
	/** self (pinned head) + peers, deduped by operator id. */
	operators: OperatorPresence[];
	/** repos where agents owned by DIFFERENT operators share a branch. */
	collisions: Collision[];
}

/** One host's federation snapshot for the `/api/federation` surface — the view plus the configured coordinator (null = federation off, panel stays hidden). */
export interface FederationSnapshot extends FederationView {
	coordinator: string | null;
}

/**
 * Compose the two cross-operator primitives into the surface the UI/API wants:
 * merge self + peer rosters, then flag the branches different operators share.
 * Collisions key on each agent's cross-host repo identity (via detectCollisions →
 * agentRepoId), so two operators on the same GitHub repo at different checkout
 * paths now collide and same-basename-but-unrelated repos don't false-collide.
 */
export function federationView(self: OperatorPresence, peers: OperatorPresence[]): FederationView {
	const operators = mergeRosters(self, peers);
	return { operators, collisions: detectCollisions(operators) };
}

/**
 * Pure collector of peer operator presence: keeps the newest frame per remote
 * operator, drops our own echo (peers only), and prunes a peer once it stops
 * gossiping past the TTL. Origin is remapped to "remote" — from this host's
 * vantage every gossiped peer is a federation peer, whatever it labels itself.
 */
export class PeerRoster {
	private readonly peers = new Map<string, OperatorPresence>();
	constructor(
		private readonly selfId: string,
		private readonly ttlMs = PEER_PRESENCE_TTL_MS,
	) {}

	/** Record a presence frame from the coordinator; ignores our own echo, newest-per-operator wins. */
	record(presence: OperatorPresence): void {
		if (presence.operator.id === this.selfId) return;
		const prev = this.peers.get(presence.operator.id);
		if (prev !== undefined && presence.updatedAt < prev.updatedAt) return;
		this.peers.set(presence.operator.id, { ...presence, operator: { ...presence.operator, origin: "remote" } });
	}

	/** Live peer rosters; prunes (and forgets) any peer past the TTL. */
	live(now = Date.now()): OperatorPresence[] {
		const out: OperatorPresence[] = [];
		for (const [id, p] of this.peers) {
			if (now - p.updatedAt > this.ttlMs) {
				this.peers.delete(id);
				continue;
			}
			out.push(p);
		}
		return out;
	}
}

// ── Tailnet transport ────────────────────────────────────────────────────────

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

/** Wire frames exchanged with the coordinator. */
type FederationFrame =
	| { kind: "presence"; presence: OperatorPresence }
	| { kind: "command"; cmd: ClientCommand; actor: Actor; ip?: string; to?: string; cmdId?: string }
	| { kind: "command-ack"; cmdId: string; to: string; from?: string; outcome: CommandAck["outcome"]; detail?: string }
	| { kind: "message"; from: Actor; text: string; ts: number }
	| { kind: "leases"; repoId: string; operator: Actor; leases: LeaseEntry[] };

/** Correlation id for a command → ack round trip. */
function mintCmdId(): string {
	return `cmd-${crypto.randomUUID()}`;
}

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
		// Bounded: a missing/hung tailscale binary must not stall inbound command processing
		// (a failed PATH lookup alone costs ~14s on WSL). Timeout ⇒ unverified ⇒ viewer.
		const timer = setTimeout(() => proc.kill(), 3000);
		const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]).finally(() => clearTimeout(timer));
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
 * Stamp the actor for an inbound federation COMMAND. The wire is untrusted: a peer
 * controls every byte of the command frame, so its claimed `role` and `origin` are
 * authority forgeries we MUST drop — otherwise a peer self-grants `admin`/`local`
 * and drives the local fleet (OMPSQ-162). Identity comes only from the tailnet
 * (`verified`, from `whois`); without it we keep the claimed id for audit but the
 * actor stays `origin:"remote"` and role-less, which `effectiveRole` reads as the
 * read-only `viewer` tier. NEVER copy `role`/`origin` off the frame.
 */
export function remoteCommandActor(claimed: Actor | undefined, verified: Actor | undefined): Actor {
	if (verified !== undefined) return { id: verified.id, displayName: verified.displayName, origin: "remote" };
	const id = typeof claimed?.id === "string" && claimed.id !== "" ? claimed.id : "unknown";
	return { id, origin: "remote" };
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
	private readonly ackCbs: ((ack: CommandAck) => void)[] = [];
	private readonly messageCbs: ((msg: TeamMessage) => void)[] = [];
	private readonly leasesCbs: ((frame: RemoteLeases) => void)[] = [];
	private ws?: WebSocket;
	private reconnectTimer?: Timer;
	private backoffMs = INITIAL_BACKOFF_MS;
	private stopped = true;
	private lastPresence?: OperatorPresence;
	private readonly lastLeases = new Map<string, LeaseEntry[]>();

	private readonly token?: string;

	constructor(opts: { coordinatorUrl: string; operator: Actor; token?: string; whois?: (ip: string) => Promise<Actor | undefined> }) {
		this.coordinatorUrl = opts.coordinatorUrl;
		this.operator = opts.operator;
		this.token = opts.token;
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
		// Stamp cross-host repoId on each agent before it leaves this host — only we can
		// derive identity from our own paths, and peers key collisions on it (#9).
		const stamped = stampRepoIds(presence);
		this.lastPresence = stamped;
		this.send({ kind: "presence", presence: stamped });
	}

	onPresence(cb: (presence: OperatorPresence) => void): void {
		this.presenceCbs.push(cb);
	}

	onRemoteCommand(cb: (remote: RemoteCommand) => void): void {
		this.commandCbs.push(cb);
	}

	sendCommand(cmd: ClientCommand, to?: string): string {
		// `actor` here is only a CLAIM for the peer's audit trail — the receiver derives
		// authority solely from the coordinator-stamped ip via whois (remoteCommandActor).
		const cmdId = mintCmdId();
		this.send({ kind: "command", cmd, actor: this.operator, to, cmdId });
		return cmdId;
	}

	sendAck(ack: CommandAck, to: string): void {
		this.send({ kind: "command-ack", cmdId: ack.cmdId, to, from: this.operator.id, outcome: ack.outcome, detail: ack.detail });
	}

	onAck(cb: (ack: CommandAck) => void): void {
		this.ackCbs.push(cb);
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
			ws = this.token !== undefined ? new WebSocket(this.coordinatorUrl, ["ompsq-token", this.token]) : new WebSocket(this.coordinatorUrl);
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
					// Addressed to a specific operator ⇒ everyone else drops it (the coordinator broadcasts).
					if (frame.to !== undefined && frame.to !== this.operator.id) break;
					// The wire is untrusted (OMPSQ-162): validate the command envelope before it reaches
					// applyCommand. A peer that ships a malformed/hostile command frame is dropped here.
					const decoded = decodeClientCommand(frame.cmd);
					if (Result.isFailure(decoded)) break;
					const actor = await this.resolveActor(frame);
					// The CLAIMED sender id addresses the ack only — never authority (that's `actor`).
					for (const cb of this.commandCbs) cb({ cmd: decoded.success, actor, cmdId: frame.cmdId, replyTo: frame.actor?.id });
					break;
				}
				case "command-ack": {
					if (frame.to !== this.operator.id) break;
					for (const cb of this.ackCbs) cb({ cmdId: frame.cmdId, outcome: frame.outcome, detail: frame.detail, from: frame.from });
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

	/**
	 * Resolve the actor for an inbound command. The frame's claimed `role`/`origin` are
	 * NEVER trusted (a peer would self-grant admin); identity comes only from the tailnet
	 * via `whois`. Without a verifiable IP the actor stays remote + role-less ⇒ viewer.
	 */
	private async resolveActor(frame: { actor: Actor; ip?: string }): Promise<Actor> {
		const verified = frame.ip !== undefined ? await this.whois(frame.ip).catch(() => undefined) : undefined;
		return remoteCommandActor(frame.actor, verified);
	}
}

/**
 * The DEFAULT bus: a real, always-functioning federation bus.
 *
 * Single-host / no-coordinator is the COMMON case and must work with zero
 * config: this bus then behaves as a local pub/sub — every `publish*` is
 * delivered straight back to the local `on*` subscribers (loopback), so the
 * manager's own roster/leases are live and observable in-process without any
 * peer. It maintains its own {@link PeerRoster} for the merged view.
 *
 * When a `coordinatorUrl` IS configured it additionally opens a
 * {@link TailnetFederationBus} to the coordinator: local publishes are forwarded
 * to peers, and inbound peer frames fan out to the local subscribers AND update
 * the roster — so collision detection runs over the merged local+peer roster.
 *
 * Resilient by construction: with no coordinator (or an unreachable one) it
 * NEVER throws and NEVER blocks startup — `start()` resolves immediately and the
 * inner Tailnet bus reconnects on its own capped backoff. This is what
 * `NullFederationBus` is the explicit opt-out of (OMP_SQUAD_FEDERATION=0).
 *
 * Note on loopback vs. echo: the bus does NOT echo our OWN presence/leases back
 * to us as if from a peer — loopback fires the same frame we published, tagged
 * with our own operator id, and {@link PeerRoster.record} drops our own id. The
 * inner Tailnet bus likewise never receives its own frames (the coordinator
 * fans out to everyone BUT the sender), so a peer's frame arrives exactly once.
 */
export class LocalFederationBus implements FederationBus {
	private readonly operator: Actor;
	private readonly presenceCbs: ((presence: OperatorPresence) => void)[] = [];
	private readonly commandCbs: ((remote: RemoteCommand) => void)[] = [];
	private readonly ackCbs: ((ack: CommandAck) => void)[] = [];
	private readonly messageCbs: ((msg: TeamMessage) => void)[] = [];
	private readonly leasesCbs: ((frame: RemoteLeases) => void)[] = [];
	/** Peer transport; created only when a coordinator URL is configured. */
	private readonly peer?: TailnetFederationBus;
	/** Merged peer roster (peers only — own echo dropped), surfaced to the federation view. */
	readonly roster: PeerRoster;
	private started = false;

	constructor(opts: { operator: Actor; coordinatorUrl?: string | null; token?: string; ttlMs?: number; whois?: (ip: string) => Promise<Actor | undefined> }) {
		this.operator = opts.operator;
		this.roster = new PeerRoster(opts.operator.id, opts.ttlMs);
		const url = opts.coordinatorUrl ?? undefined;
		if (url !== undefined && url.length > 0) {
			this.peer = new TailnetFederationBus({ coordinatorUrl: url, operator: opts.operator, token: opts.token, whois: opts.whois });
			// Inbound peer frames update the roster AND fan out to local subscribers.
			this.peer.onPresence((p) => {
				this.roster.record(p);
				this.fanoutPresence(p);
			});
			this.peer.onLeases((f) => this.fanoutLeases(f));
			this.peer.onMessage((m) => this.fanoutMessage(m));
			this.peer.onRemoteCommand((c) => this.fanoutCommand(c));
			this.peer.onAck((a) => this.fanoutAck(a));
		}
	}

	/** True when a coordinator is configured (peer gossip active); false ⇒ local-only loopback. */
	get federated(): boolean {
		return this.peer !== undefined;
	}

	async start(): Promise<void> {
		this.started = true;
		// Best-effort: a bad/unreachable coordinator must never throw or block — the
		// inner bus connects in the background and reconnects on backoff.
		await this.peer?.start().catch(() => {});
	}

	async stop(): Promise<void> {
		this.started = false;
		await this.peer?.stop().catch(() => {});
	}

	publishPresence(presence: OperatorPresence): void {
		// Stamp cross-host repoId locally before it leaves this host (peers key collisions on it).
		const stamped = stampRepoIds(presence);
		// Loopback: local subscribers see our own roster immediately, coordinator or not.
		this.fanoutPresence(stamped);
		this.peer?.publishPresence(stamped);
	}

	onPresence(cb: (presence: OperatorPresence) => void): void {
		this.presenceCbs.push(cb);
	}

	onRemoteCommand(cb: (remote: RemoteCommand) => void): void {
		this.commandCbs.push(cb);
	}

	sendCommand(cmd: ClientCommand, to?: string): string {
		// Self-addressed (or single-host, no peer): loopback through the same remote-command
		// path a peer delivery would take — same code path, locally-verified identity.
		if (to === undefined || to === this.operator.id) {
			const cmdId = mintCmdId();
			this.fanoutCommand({ cmd, actor: { id: this.operator.id, displayName: this.operator.displayName, origin: "remote" }, cmdId, replyTo: this.operator.id });
			if (to === this.operator.id || this.peer === undefined) return cmdId;
		}
		return this.peer?.sendCommand(cmd, to) ?? "";
	}

	sendAck(ack: CommandAck, to: string): void {
		// Self-addressed acks loop back (the solo/self-steer case); peer acks ride the coordinator.
		if (to === this.operator.id) {
			this.fanoutAck({ ...ack, from: this.operator.id });
			return;
		}
		this.peer?.sendAck(ack, to);
	}

	onAck(cb: (ack: CommandAck) => void): void {
		this.ackCbs.push(cb);
	}

	private fanoutAck(ack: CommandAck): void {
		for (const cb of this.ackCbs) {
			try {
				cb(ack);
			} catch {
				// swallow
			}
		}
	}

	sendMessage(text: string): void {
		const msg: TeamMessage = { from: this.operator, text, ts: Date.now() };
		this.fanoutMessage(msg);
		this.peer?.sendMessage(text);
	}

	onMessage(cb: (msg: TeamMessage) => void): void {
		this.messageCbs.push(cb);
	}

	publishLeases(repoId: string, leases: LeaseEntry[]): void {
		this.fanoutLeases({ repoId, operator: this.operator, leases });
		this.peer?.publishLeases(repoId, leases);
	}

	onLeases(cb: (frame: RemoteLeases) => void): void {
		this.leasesCbs.push(cb);
	}

	private fanoutPresence(presence: OperatorPresence): void {
		for (const cb of this.presenceCbs) {
			try {
				cb(presence);
			} catch {
				// swallow: a throwing subscriber must not break the fan-out
			}
		}
	}

	private fanoutLeases(frame: RemoteLeases): void {
		for (const cb of this.leasesCbs) {
			try {
				cb(frame);
			} catch {
				// swallow
			}
		}
	}

	private fanoutMessage(msg: TeamMessage): void {
		for (const cb of this.messageCbs) {
			try {
				cb(msg);
			} catch {
				// swallow
			}
		}
	}

	private fanoutCommand(remote: RemoteCommand): void {
		for (const cb of this.commandCbs) {
			try {
				cb(remote);
			} catch {
				// swallow
			}
		}
	}
}

/**
 * Peer-presence for a local surface (the command center) is now read directly off the
 * manager's own {@link LocalFederationBus} — the manager subscribes to the bus's presence
 * stream into a {@link PeerRoster} and exposes it (SquadManager.peerPresence). The former
 * PeerPresenceTracker opened a SECOND, read-only coordinator socket to observe the same
 * frames; it was collapsed into that single stream (SEAM 2) and removed.
 */

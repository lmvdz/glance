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
}

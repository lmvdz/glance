/**
 * The card-kind registry (concern 09 of plans/deepen-modules) — ONE home per channel-card kind.
 *
 * Before this module a kind's client-side behavior was scattered across three tables in two
 * files: `toneFor`'s if-chain and `DOOR_LABELS` (both string-keyed with SILENT fallbacks — the
 * two spots slice 1's review named as the remaining hand-sync surface) and `ChannelTimeline`'s
 * `iconClass` Record. One registration below now carries tone policy + door label + icon, and
 * those tables are DERIVED. `satisfies Record<RegisteredCardKind, CardKindSpec>` makes the
 * registry exhaustive over the SHARED daemon kind list (concern 08's module) plus the client's
 * local kinds: a new daemon kind is a compile error HERE — one entry, all three behaviors —
 * instead of three quiet fallbacks in three places.
 *
 * The daemon half of a kind (payload schema) deliberately stays in src/schema/channel-card.ts:
 * Effect Schema cannot cross into the browser bundle, and that table is ALREADY compile-forced
 * over the same shared list (`satisfies Record<TranscriptEventKind, Schema.Top>`). Both trees
 * therefore break at compile time on an unregistered kind, keyed by one list — which is the
 * registry the concern asked for, expressed as the type system rather than codegen.
 *
 * Every doorLabel is EXPLICIT, including the kinds that render the generic "Open" — that was a
 * silent `?? 'Open'` fallback before; now it is a named per-kind decision (same rendered text).
 */
import { AlertCircle, CheckCircle2, CircleDot, FileText, Flame, GitMerge, Phone, Rocket, ShieldAlert, ShieldQuestion } from 'lucide-react';
import type { TranscriptEventKind } from '../../../src/transcript-event-kinds.ts';
import type { ChannelCardTone, LocalCardKind, PointerCardFace } from './channelTimeline';

/** Every kind the registry must cover: the daemon's shared wire list + the client-minted locals.
 *  `message` / `unknown-event` are NOT kinds — they are the two structural defaults the timeline
 *  itself owns (a plain chat row; a wire kind this build predates). */
export type RegisteredCardKind = TranscriptEventKind | LocalCardKind;

export interface CardKindSpec {
	/** Static tone, or a face-dependent policy (status-driven kinds). `face.tone` — the daemon's
	 *  explicit override — always wins before this is consulted (see `toneFor`). */
	tone: ChannelCardTone | ((face: PointerCardFace | undefined) => ChannelCardTone);
	/** The door button's label. Explicit for every kind — "Open" is a decision, not a fallback. */
	doorLabel: string;
	/** Timeline row icon (lucide component). */
	icon: typeof ShieldAlert;
}

export const CARD_KIND_REGISTRY = {
	'needs-you': { tone: 'warning', doorLabel: 'Answer it', icon: ShieldAlert },
	// HONEST LABEL: GateVerdictCard.tsx owns the live icon (status-dependent) and door text
	// ("Open proof record") — this entry's icon/doorLabel serve the generic fallback path only.
	'gate-verdict': {
		tone: (face) => (face?.status === 'pass' || face?.status === 'approved' ? 'success' : face?.status === 'fail' || face?.status === 'veto' ? 'destructive' : 'info'),
		doorLabel: 'Open the proof',
		icon: CheckCircle2,
	},
	// HONEST LABEL (codex M, concern 09 round): the three land kinds and gate-verdict have BESPOKE
	// renderers (LandCards.tsx, GateVerdictCard.tsx) that own their LIVE tone/icon/door — these
	// registry fields are consumed only on the generic-card FALLBACK path (an old build, a card
	// arriving without its bespoke route). Changing a land tone here does NOT change LandCards;
	// unifying the bespoke renderers onto registry policies is recorded follow-up, not claimed done.
	'land-attempt': { tone: 'neutral', doorLabel: 'Open the land record', icon: GitMerge },
	'land-assessment': { tone: 'neutral', doorLabel: 'Open the land record', icon: ShieldAlert },
	'land-merge': { tone: (face) => (face?.status === 'merged' || face?.status === 'landed' ? 'success' : 'info'), doorLabel: 'Open the land record', icon: GitMerge },
	'token-burn-snapshot': { tone: (face) => (face?.status === 'deny' ? 'destructive' : face?.status === 'ask' ? 'warning' : 'info'), doorLabel: 'Open fleet economics', icon: Flame },
	'mention-steer': { tone: 'info', doorLabel: 'Open', icon: CircleDot },
	// Disclosure, not refusal (see squad-manager.ts's goalConflict comment) — nothing was blocked,
	// so this is a heads-up to check, not an alarm.
	'goal-overlap': { tone: 'warning', doorLabel: 'Open', icon: ShieldAlert },
	'plan-card': { tone: 'info', doorLabel: 'Open plan DAG', icon: FileText },
	'return-emit': { tone: 'neutral', doorLabel: 'Step into the agent', icon: CircleDot },
	'design-revised': { tone: 'neutral', doorLabel: 'Open plan DAG', icon: FileText },
	'unit-spawned': { tone: 'neutral', doorLabel: 'Open', icon: Rocket },
	'unit-turn-finished': { tone: 'neutral', doorLabel: 'Open', icon: CheckCircle2 },
	// A unit that stopped in a way it did not choose rendered NEUTRAL — identical to a unit
	// starting. Every lifecycle card looked the same, so the one that mattered was invisible
	// among the ones that did not. Failure is the loudest lifecycle fact there is.
	'unit-failed': { tone: 'destructive', doorLabel: 'Open', icon: AlertCircle },
	'pr-opened': { tone: 'neutral', doorLabel: 'Open', icon: GitMerge },
	'verification-ran': { tone: 'neutral', doorLabel: 'Open', icon: CheckCircle2 },
	// voice-call: connecting/live are ordinary in-progress facts; degraded is a warning (socket
	// lost, liveness unconfirmed); ended is neutral — the honest terminal state, not bad news.
	'voice-call': { tone: (face) => (face?.status === 'degraded' ? 'warning' : face?.status === 'ended' ? 'neutral' : 'info'), doorLabel: 'Open the call', icon: Phone },
	// voice-decision: open/awaiting-confirmation genuinely need a human; answered is a success; a
	// decision that never got one (expired/cancelled/failed) is neutral, not a failure of the room.
	// Deliberately NOT needs-you's "Answer it" label: a fleet question and a call question are
	// different work with different vocabulary — two doors reading the same three words is how a
	// person learns the label does not tell them where they are going.
	'voice-decision': { tone: (face) => (face?.status === 'answered' ? 'success' : face?.status === 'open' || face?.status === 'awaiting-confirmation' ? 'warning' : 'neutral'), doorLabel: 'Answer the question', icon: ShieldQuestion },
	// voice-fleet-action: an executed approval is a success; a routine relayed action is ordinary
	// info; deferred (held for a human) and failed both genuinely want a look; declined is the
	// neutral, honest record of a human saying no. Its door steps into the unit the action touched.
	'voice-fleet-action': { tone: (face) => (face?.status === 'executed' ? 'success' : face?.status === 'relayed' ? 'info' : face?.status === 'declined' ? 'neutral' : 'warning'), doorLabel: 'Open the unit', icon: CircleDot },
	'local:mention-confirm-required': { tone: 'warning', doorLabel: 'Open', icon: ShieldAlert },
	'local:mention-steer-failed': { tone: 'destructive', doorLabel: 'Open', icon: AlertCircle },
	'local:spawn-proposal': { tone: 'info', doorLabel: 'Open the proposal', icon: CircleDot },
} satisfies Record<RegisteredCardKind, CardKindSpec>;

/** Registry lookup that tolerates the timeline's two structural defaults and unknown wire kinds. */
export function cardKindSpec(kind: string): CardKindSpec | undefined {
	return Object.prototype.hasOwnProperty.call(CARD_KIND_REGISTRY, kind) ? CARD_KIND_REGISTRY[kind as RegisteredCardKind] : undefined;
}

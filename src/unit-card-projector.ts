/**
 * The unit-card projector — turns a unit's transcript events and pending-request deltas into the
 * room cards a human actually sees (concern 21 of plans/deepen-modules). CallProjectionStore
 * (voice-call-projection.ts) already proves this shape for voice events; this is the hand-rolled
 * unit-event equivalent, extracted from SquadManager.
 *
 * The manager is visible only through the small `UnitCardProjectorDeps` port (log, node,
 * appendCard, emitUnitTranscriptEvent, label, operatorId, isSettling, gateClassOf) plus the
 * structural `ProjectedUnitSession` slice of AgentRecord — no AgentRecord, roster map, transcript
 * array, or event bus ever crosses the seam. Every projection comment (the accountable-human
 * naming rule, the "announced thirteen times" replay-suppression discipline, the resolved-vs-
 * abandoned distinction) moved VERBATIM with its code — they are load-bearing.
 *
 * `ensureProjectedNode` (node binding) deliberately STAYS a manager method — it has five call
 * sites outside this region — and reaches the projector only as the `node` closure.
 * `emitUnitTranscriptEvent` (transcript-append + project) also stays manager-side — it has nine
 * external call sites across the land/PR/token-burn/plan-card lanes — and reaches the projector
 * as the `emitUnitTranscriptEvent` closure; `needsYou()` routes its own cards through the SAME
 * funnel so a needs-you card is a transcript row like every other unit event, never a shortcut
 * around it.
 */
import { ForgedCardError, assertAuthentic, projectsToRoom, type CardProvenance } from "./projection-classes.ts";
import { errText } from "./err-text.ts";
import {
	TRANSCRIPT_EVENT_GATE_VERDICT,
	TRANSCRIPT_EVENT_LAND_ATTEMPT,
	TRANSCRIPT_EVENT_LAND_ASSESSMENT,
	TRANSCRIPT_EVENT_LAND_MERGE,
	TRANSCRIPT_EVENT_NEEDS_YOU,
	TRANSCRIPT_EVENT_PLAN_CARD,
	TRANSCRIPT_EVENT_TOKEN_BURN_SNAPSHOT,
	isTranscriptEventKind,
} from "./transcript-event-kinds.ts";
import { tokenBurnFace } from "./token-burn.ts";
import { DEFAULT_CHANNEL_ID, type ChannelEntry, type ManagerChannelPost } from "./channels.ts";
import type { DerivedReason } from "./agent-lifecycle.ts";
import type { AgentDTO, PendingRequest } from "./types.ts";
import type { TranscriptEntry } from "./core-types.ts";

/** The per-session slice the projector reads — kept structural so AgentRecord, the roster map,
 *  and the transcript array all stay inside the manager. `dto` is the full `AgentDTO` (as
 *  `BoundarySyncSession` does) because the projector legitimately reads a broad slice of it
 *  (id, name, status, repo, branch, issue, proof, channelId, pending) rather than a narrow one. */
export interface ProjectedUnitSession {
	dto: AgentDTO;
	/** `task` is read by node materialization (`ensureProjectedNode` persists it as the node's goal)
	 *  — it crosses the port even though the projector itself never reads it, so it belongs in the
	 *  declared slice rather than behind a cast (codex M, concern 21 round). */
	options: { channelId?: string; task?: string };
}

/** Where a projected card lands: the unit's room, or its own node thread (mirrors the
 *  `projectsToRoom(kind)` branch `event()` uses to pick between `channelStore.appendManager` and
 *  `channelStore.appendNodeManager`). */
export type ManagerChannelCardTarget = { room: string } | { nodeId: string; inheritedFromChannelId: string | undefined };

export interface UnitCardProjectorDeps {
	log(level: "info" | "warn", msg: string): void;
	/** The manager's projected-node binding (`ensureProjectedNode`) — kept manager-side (5 call
	 *  sites outside this region); the projector only ever needs the bound node id. */
	node(rec: ProjectedUnitSession): Promise<{ id: string }>;
	/** Append one card to a room or a node's own thread AND broadcast the paired channel-entry
	 *  event, wired together so a projector call can never append without also broadcasting — the
	 *  single card-emit chokepoint `event()` uses (channelStore.appendManager/appendNodeManager,
	 *  same shape as the manager's own `voiceCall.emitCard` wiring). */
	appendCard(target: ManagerChannelCardTarget, input: ManagerChannelPost): Promise<ChannelEntry>;
	/** The manager's own transcript-append-then-project funnel — stays manager-side (9+ external
	 *  call sites across land/PR/token-burn/plan-card lanes). */
	emitUnitTranscriptEvent(id: string, kind: string, text: string, payload: unknown): void;
	/** Room-facing display label (`safeEventLabel`) — stays manager-side (21 call sites well beyond
	 *  this region). */
	label(value: unknown): string;
	/** The accountable-human identity `needsYouFace`'s payload names — the daemon operator. */
	operatorId(): string;
	/** True while `rec`'s pending backlog is being rebuilt by replay — suppresses re-announcing a
	 *  pending that was already announced before a restart. */
	isSettling(id: string): boolean;
	/** Does this pending deserve a CARD IN THE ROOM? (`isRoomWorthyPending`, squad-manager.ts.)
	 *  Deliberately a SEPARATE closure from `gateClassOf` even though their predicates currently
	 *  coincide — the manager documents them as two different questions (room = permanent history,
	 *  lane = act-now), and the planned grace-period widening (plans/the-room/26) changes this one
	 *  without changing gate classification. Collapsing them here would silently pin needs-you cards
	 *  to gate-only forever (codex M, concern 21 round). */
	roomWorthy(req: PendingRequest): boolean;
	/** A gate-class request is never auto-answered by any supervisor — the same predicate the
	 *  attention lane uses (`gateClassOf`, squad-manager.ts). Feeds only the payload's `gateClass`
	 *  field; the emit filter is `roomWorthy` above. Kept manager-side rather than duplicated here:
	 *  it is public, independently tested (tests/acp-permission-is-a-gate.test.ts), and
	 *  security-relevant (an untrusted agent frame must never opt itself out of human review). */
	gateClassOf(req: PendingRequest): boolean;
}

export class UnitCardProjector {
	/** Manager card projections that exhausted ChannelStore's bounded append retry. Read externally
	 *  by the factory-status surface via the `projectionFailures` getter below. */
	private failures = 0;
	/** First-sight-per-kind debug log for `event()`'s `isTranscriptEventKind` guard — mirrors
	 *  `schema/channel-card.ts`'s `warnedUnknownKinds` (re-port review follow-up, concern 02): a
	 *  transcript event carrying a kind this build doesn't recognize used to be silently skipped with
	 *  no signal anywhere; now it logs once per newly-seen kind rather than either staying silent or
	 *  spamming a line per emit (a chatty unit could emit the same unknown kind hundreds of times). */
	private readonly warnedUnknownKinds = new Set<string>();

	constructor(private readonly deps: UnitCardProjectorDeps) {}

	/** Manager card projections that exhausted ChannelStore's bounded append retry. */
	get projectionFailures(): number {
		return this.failures;
	}

	/** Resolve an event's subject before routing it. Missing bindings are failures, never root
	 *  fallbacks. Reimplements the manager's own `projectedNodeId` wrapper against the `node`
	 *  closure rather than sharing it — `projectedNodeId` itself stays manager-side (it has a call
	 *  site outside this region too) and is not part of this seam. */
	private async nodeId(rec: ProjectedUnitSession): Promise<string | undefined> {
		try {
			return (await this.deps.node(rec))?.id;
		} catch (err) {
			this.deps.log("warn", `projection ${rec.dto.id}: node binding unavailable: ${errText(err)}`);
			return undefined;
		}
	}

	private doorSurface(kind: string): string {
		switch (kind) {
			case TRANSCRIPT_EVENT_NEEDS_YOU:
				return "intervence";
			case TRANSCRIPT_EVENT_GATE_VERDICT:
				return "gate-verdict";
			case TRANSCRIPT_EVENT_LAND_MERGE:
				return "land-merge";
			case TRANSCRIPT_EVENT_PLAN_CARD:
				return "plan";
			case TRANSCRIPT_EVENT_LAND_ATTEMPT:
			case TRANSCRIPT_EVENT_LAND_ASSESSMENT:
				return "land";
			default:
				return "unit";
		}
	}

	private payload(entry: TranscriptEntry): Record<string, unknown> {
		const payload = entry.event?.payload;
		return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
	}

	private refs(rec: ProjectedUnitSession, entry: TranscriptEntry): Record<string, unknown> {
		const objectPayload = this.payload(entry);
		const refs: Record<string, unknown> = { unitId: rec.dto.id };
		if (entry.id) refs.entryId = entry.id;
		for (const [from, to] of [["featureId", "planId"], ["planPath", "planPath"], ["candidateId", "candidateId"], ["attemptId", "landId"], ["issueId", "issueId"], ["issueIdentifier", "issueIdentifier"]] as const) {
			const value = objectPayload[from];
			if (typeof value === "string" && value) refs[to] = value;
		}
		return refs;
	}

	private needsYouFace(rec: ProjectedUnitSession, payload: Record<string, unknown>, entry: TranscriptEntry): Record<string, unknown> {
		const pendingStatus = typeof payload.status === "string" ? payload.status : undefined;
		const title = typeof payload.title === "string" && payload.title ? payload.title : "operator input";
		const accountableHuman = typeof payload.accountableHuman === "string" && payload.accountableHuman ? payload.accountableHuman : undefined;
		const message = typeof payload.message === "string" && payload.message ? payload.message : undefined;
		const createdAt = typeof payload.createdAt === "number" && Number.isFinite(payload.createdAt) ? payload.createdAt : entry.ts;
		const ageMs = Math.max(0, entry.ts - createdAt);
		const age = ageMs < 60_000 ? "just now" : `${Math.floor(ageMs / 60_000)}m`;
		const resolved = pendingStatus === "resolved";
		// A resolved card is one of two facts, and they are not close: somebody answered, or the unit
		// went away without an answer. `answered` is stamped by needsYou() from the same `reason` that
		// already distinguishes them; an OLD card carries no flag and is read as answered, which is
		// what it always claimed.
		const abandoned = resolved && payload.answered === false;
		// Concern 19 wants ONE NAMED accountable human, and a name is the point. In file mode the actor
		// id is literally "local", so appending it produces "local is accountable", which names nobody
		// and lengthens every headline to say it. An unnamed operator is left off rather than rendered
		// as a name — an identifier that identifies no one is worse than silence, because it reads like
		// an answer. The accountable id still rides on the payload for anyone who can resolve it.
		const namedTitle = accountableHuman && accountableHuman !== "local" ? `${title} — ${accountableHuman} is accountable.` : title;
		return {
			unitId: rec.dto.id,
			unitName: rec.dto.name,
			eventKind: entry.event?.kind,
			pendingId: typeof payload.pendingId === "string" ? payload.pendingId : undefined,
			pendingStatus,
			accountableHuman,
			title: abandoned ? `Never answered · ${namedTitle}` : resolved ? `Resolved · ${namedTitle}` : `Needs you · ${namedTitle}`,
			eyebrow: abandoned ? "Never answered" : resolved ? "Resolved" : "Needs you",
			// A card that says the same sentence three times (title, body, "why stopped") reads as
			// broken, and for approval-shaped pendings `message` IS the title. Say it once.
			body: message && message.trim() !== title.trim() ? message : undefined,
			detail: abandoned
				? "The unit stopped before anyone replied. Nothing is waiting on you for it, and nothing came of it."
				: resolved
					? "Follow-up resolution card. Original pending card remains unchanged."
					: "Click to step into the agent.",
			// Abandoned is NOT success. A green card for a question nobody answered is the room
			// congratulating itself for losing something.
			tone: abandoned ? "neutral" : resolved ? "success" : "warning",
			pinned: {
				agent: rec.dto.name || rec.dto.id,
				age,
			},
		};
	}

	private face(rec: ProjectedUnitSession, entry: TranscriptEntry): Record<string, unknown> {
		const objectPayload = this.payload(entry);
		const customFace = objectPayload.face && typeof objectPayload.face === "object" && !Array.isArray(objectPayload.face) ? (objectPayload.face as Record<string, unknown>) : {};
		if (entry.event?.kind === TRANSCRIPT_EVENT_NEEDS_YOU) return this.needsYouFace(rec, objectPayload, entry);
		if (entry.event?.kind === TRANSCRIPT_EVENT_TOKEN_BURN_SNAPSHOT) return tokenBurnFace(objectPayload as never);
		return {
			...customFace,
			unitId: rec.dto.id,
			unitName: rec.dto.name,
			status: typeof customFace.status === "string" ? customFace.status : rec.dto.status,
			repo: rec.dto.repo,
			branch: rec.dto.branch,
			issue: rec.dto.issue ? { id: rec.dto.issue.id, identifier: rec.dto.issue.identifier, name: rec.dto.issue.name } : undefined,
			eventKind: entry.event?.kind,
			title: typeof customFace.title === "string" ? customFace.title : entry.text,
			stage: typeof objectPayload.stage === "string" ? objectPayload.stage : undefined,
			sha: typeof objectPayload.sha === "string" ? objectPayload.sha : typeof objectPayload.resultCommit === "string" ? objectPayload.resultCommit : rec.dto.proof?.commit,
			target: typeof objectPayload.target === "string" ? objectPayload.target : typeof objectPayload.baseRef === "string" ? objectPayload.baseRef : "HEAD",
			risk: typeof objectPayload.risk === "string" ? objectPayload.risk : typeof objectPayload.riskTier === "string" ? objectPayload.riskTier : typeof objectPayload.code === "string" ? objectPayload.code : undefined,
			recommendation: typeof objectPayload.recommendation === "string" ? objectPayload.recommendation : typeof objectPayload.recommendedAction === "string" ? objectPayload.recommendedAction : undefined,
			detail: typeof objectPayload.detail === "string" ? objectPayload.detail : typeof objectPayload.message === "string" ? objectPayload.message : undefined,
			outcome: typeof objectPayload.outcome === "string" ? objectPayload.outcome : typeof objectPayload.prState === "string" ? objectPayload.prState : undefined,
			mode: typeof objectPayload.mode === "string" ? objectPayload.mode : undefined,
			prUrl: typeof objectPayload.prUrl === "string" ? objectPayload.prUrl : undefined,
			prNumber: typeof objectPayload.prNumber === "number" || typeof objectPayload.prNumber === "string" ? objectPayload.prNumber : undefined,
			doneProofVerified: typeof objectPayload.doneProofVerified === "string" ? objectPayload.doneProofVerified : undefined,
			verdict: typeof objectPayload.verdict === "string" ? objectPayload.verdict : undefined,
			ok: typeof objectPayload.ok === "boolean" ? objectPayload.ok : undefined,
			merged: typeof objectPayload.merged === "boolean" ? objectPayload.merged : undefined,
			pendingId: typeof objectPayload.pendingId === "string" ? objectPayload.pendingId : undefined,
			pendingStatus: typeof objectPayload.status === "string" ? objectPayload.status : undefined,
			validation: entry.event?.kind === TRANSCRIPT_EVENT_GATE_VERDICT ? objectPayload : undefined,
			agreement: typeof objectPayload.agreement === "number" ? objectPayload.agreement : undefined,
			confidence: typeof objectPayload.confidence === "number" ? objectPayload.confidence : undefined,
			perCriterion: Array.isArray(objectPayload.perCriterion) ? objectPayload.perCriterion : undefined,
			planName: typeof objectPayload.planName === "string" ? objectPayload.planName : undefined,
			concernCount: typeof objectPayload.concernCount === "number" ? objectPayload.concernCount : undefined,
		};
	}

	/** Project one already-appended (or synthetic, transcript-row-free) transcript entry as a room
	 *  card. The manager's `emitUnitTranscriptEvent` (transcript row + project) and
	 *  `projectLifecycleCard` (project only, no transcript row) both call this as their project step. */
	async event(rec: ProjectedUnitSession, entry: TranscriptEntry): Promise<void> {
		const event = entry.event;
		if (!event?.kind) return;
		if (!isTranscriptEventKind(event.kind)) {
			if (!this.warnedUnknownKinds.has(event.kind)) {
				this.warnedUnknownKinds.add(event.kind);
				this.deps.log("warn", `projection ${rec.dto.id}: unknown transcript event kind "${event.kind}" — skipped (newer daemon, or unregistered kind; logged once)`);
			}
			return;
		}
		const nodeId = await this.nodeId(rec);
		if (!nodeId) return;
		try {
			const input = {
				authorActor: "manager",
				kind: "system" as const,
				format: "stage" as const,
				text: entry.text,
				event: {
					kind: event.kind,
					payload: {
						refs: this.refs(rec, entry),
						doorSurface: this.doorSurface(event.kind),
						face: this.face(rec, entry),
					},
				},
			};
			// An escalation surfaces in the unit's ROOM, which is the channel it was spawned from —
			// NOT unconditionally in #fleet. #fleet is org-public, so routing every escalation there
			// would publish a private room's needs-you, gate and land cards to the whole org.
			const room = rec.options.channelId ?? rec.dto.channelId ?? DEFAULT_CHANNEL_ID;
			// Provenance travels WITH the card and is checked before it is written. A unit may say
			// anything about itself and nothing about anyone else, so a card whose subject is a
			// different node is a forgery regardless of which emit site produced it.
			const provenance: CardProvenance = {
				nodeId,
				agentId: rec.dto.id,
				evidenceIds: Object.values(this.refs(rec, entry)).filter((ref): ref is string => typeof ref === "string" && ref.length > 0),
			};
			assertAuthentic(event.kind, provenance, nodeId);
			const projectedInput = { ...input, event: { ...input.event, payload: { ...input.event.payload, provenance } } };
			// `appendCard` both writes the card and broadcasts the paired channel-entry event (see its
			// doc) — mirroring the original `channelStore.appendManager(...)` + `this.emit("event", ...)`
			// pair exactly, just wrapped behind one deps closure.
			await (projectsToRoom(event.kind)
				? this.deps.appendCard({ room }, projectedInput)
				: this.deps.appendCard({ nodeId, inheritedFromChannelId: rec.options.channelId ?? rec.dto.channelId }, projectedInput));
		} catch (err) {
			this.failures++;
			// A forgery is not a transient failure and must not read as one in the log. A projection that
			// could not be written is worth retrying; a card that claimed to be about someone else's work
			// is worth investigating.
			const label = err instanceof ForgedCardError ? "REFUSED as forged" : "failed";
			this.deps.log("warn", `projection ${rec.dto.id}/${event.kind} → ${nodeId} ${label} (${this.failures} total): ${errText(err)}`);
		}
	}

	/**
	 * Announce a pending ONCE — not once per daemon restart.
	 *
	 * Seen live, in the room, on real data: `gate_1` was announced thirteen times and `gate_2` three,
	 * for two questions. The timestamps matched the daemon's restarts exactly. On boot a record is
	 * rebuilt with an empty `pending`, replay re-adds the outstanding requests, and the id-diff below
	 * correctly reports every one of them as new — because to a freshly constructed record, it is.
	 *
	 * The room's own fold hides the repeats, which is why this survived: the SCREEN looked right. But
	 * the channel is the durable record, and everything else reading it — search, the weekly episode,
	 * a digest, anyone scrolling back — saw one unanswered question thirteen times. A restart is not
	 * news about the work.
	 *
	 * `deps.isSettling` is the manager's existing replay-window marker; it already suppresses the
	 * PERSIST directly at the manager's call site, for the same reason and in the same words ("a
	 * ghost pending rebuilt by ring replay must never resurrect a stale question"). This extends that
	 * reasoning to the projection, which is where a person actually meets it.
	 *
	 * Resolutions are deliberately NOT suppressed. A question that was answered while the daemon was
	 * down is news, and the worse failure is a room still showing something as waiting when it is not.
	 */
	needsYou(rec: ProjectedUnitSession, next: PendingRequest[], reason?: DerivedReason): void {
		const replaying = this.deps.isSettling(rec.dto.id);
		const previous = new Map(rec.dto.pending.map((request) => [request.id, request]));
		const upcoming = new Map(next.map((request) => [request.id, request]));
		for (const request of next) {
			if (previous.has(request.id)) continue;
			// A pending restored by replay was announced before the restart. Re-announcing it says the
			// fleet stopped again, which it did not.
			if (replaying) continue;
			if (!this.deps.roomWorthy(request)) continue;
			this.deps.emitUnitTranscriptEvent(rec.dto.id, TRANSCRIPT_EVENT_NEEDS_YOU, `${this.deps.label(request.title)} — ${this.deps.label(rec.dto.name)} stopped rather than guess. Everything else in the fleet is still moving.`, {
				status: "pending",
				pendingId: request.id,
				gateClass: this.deps.gateClassOf(request),
				title: request.title,
				accountableHuman: this.deps.operatorId(),
				message: request.message,
				createdAt: request.createdAt,
				agentId: rec.dto.id,
			});
		}
		for (const request of previous.values()) {
			if (upcoming.has(request.id)) continue;
			// Symmetric with the emit above: a pending that never became a card must never emit a
			// resolution card, or the room fills with orphan "resolved" faces for facts it never showed.
			if (!this.deps.roomWorthy(request)) continue;
			// A pending goes away for two very different reasons and the card said "is answered" for
			// both. `pending-cancel` is the unit being stopped, killed, reaped or replay-pruned —
			// nobody answered it and nothing is picking the work back up. Telling a person their
			// question was answered when it was abandoned is the room lying about the one thing it
			// exists to be trusted on. The distinction was already in `reason`; it was just not read.
			const answered = reason !== "pending-cancel";
			this.deps.emitUnitTranscriptEvent(rec.dto.id, TRANSCRIPT_EVENT_NEEDS_YOU, answered
				? `${this.deps.label(request.title)} is answered. ${this.deps.label(rec.dto.name)} picks the work back up from where it stopped.`
				: `${this.deps.label(request.title)} went away without being answered — ${this.deps.label(rec.dto.name)} stopped before anyone replied. Nothing is waiting on you for it any more, and nothing came of it either.`, {
				status: "resolved",
				answered,
				pendingId: request.id,
				gateClass: this.deps.gateClassOf(request),
				title: request.title,
				accountableHuman: this.deps.operatorId(),
				createdAt: request.createdAt,
				agentId: rec.dto.id,
			});
		}
	}
}

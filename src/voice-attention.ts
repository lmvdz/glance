/**
 * voice-attention.ts — voice decisions projected into a voice-specific attention source (concern 02).
 *
 * Reuses `attention-ladder.ts`'s ranked enum and ordering utilities directly — `LADDER_RANK`/
 * `maxLadderPriority` are plain data/functions, not coupled to `AgentDTO` — without ever constructing
 * a fake `AgentDTO` for the OMP live session (DESIGN.md's explicit risk: "the daemon must not pretend
 * the OMP agent is a fleet AgentDTO"). A decision requiring confirmation ranks as `pending-approval`
 * (the same rung a workflow-gate gets); an ordinary open decision ranks `awaiting-input`; a decision
 * that has already resolved carries no ladder priority at all — it simply stops appearing.
 *
 * Push reuses `push.ts`'s `PushService` substrate directly (same VAPID/encryption pipeline as every
 * other escalation). De-duplication is durable — a decision that already fired a push is remembered
 * in a small per-channel JSON set on disk, so a daemon restart between mint and resolution never
 * re-sends the same push a second time.
 */

import * as path from "node:path";
import { LADDER_RANK, type LadderPriority, maxLadderPriority } from "./attention-ladder.ts";
import { getStorageBackend } from "./dal/storage.ts";
import { errText } from "./err-text.ts";
import type { PushPayload, PushService } from "./push.ts";
import type { JournalDecisionSnapshot } from "./voice-call-journal.ts";

const ACTIVE_DECISION_STATES = new Set(["open", "awaiting-confirmation"]);

/** One decision's ladder rung, or `undefined` once it's no longer something a human needs to act on. */
export function voiceDecisionLadderPriority(decision: Pick<JournalDecisionSnapshot, "state" | "requiresConfirmation">): LadderPriority | undefined {
	if (decision.state === "awaiting-confirmation") return "pending-approval";
	if (decision.state === "open") return "awaiting-input";
	return undefined;
}

/** Roll-up across every currently-open/awaiting decision in a channel, using the SAME ranked cascade
 *  (`LADDER_RANK`) the fleet roster uses — an empty or all-resolved set reads `"idle"`, exactly like
 *  `maxLadderPriority`'s own documented empty-group contract. */
export function voiceChannelLadderPriority(decisions: readonly Pick<JournalDecisionSnapshot, "state" | "requiresConfirmation">[]): LadderPriority {
	const priorities = decisions.map(voiceDecisionLadderPriority).filter((p): p is LadderPriority => p !== undefined);
	return maxLadderPriority(priorities);
}

export { LADDER_RANK };

export function activeVoiceDecisions(decisions: readonly JournalDecisionSnapshot[]): JournalDecisionSnapshot[] {
	return decisions.filter((d) => ACTIVE_DECISION_STATES.has(d.state));
}

/** The push payload for one decision, or `null` for a decision that isn't (or is no longer) active —
 *  a terminal decision never gets a push, so a caller can pass any decision without checking state
 *  first. `tag` collapses on `(channelId, decisionId)`: a later push for the SAME decision (open →
 *  awaiting-confirmation) replaces the notification tray entry rather than stacking a second one. */
export function voiceDecisionPushPayload(channelId: string, decision: JournalDecisionSnapshot): PushPayload | null {
	if (!ACTIVE_DECISION_STATES.has(decision.state)) return null;
	const title = decision.state === "awaiting-confirmation" ? `⏳ Confirm: ${decision.prompt}` : `📞 ${decision.prompt}`;
	const body = decision.options.map((o) => o.label).join(" · ") || "Waiting on your call.";
	return { title, body, url: `/#/room/${encodeURIComponent(channelId)}?push=1`, tag: `voice-decision:${channelId}:${decision.id}` };
}

function pushSentPath(stateDir: string, channelId: string): string {
	return path.join(stateDir, "voice-push-sent", `${channelId}.json`);
}

/**
 * Durable per-channel dedup/dismissal for voice-decision pushes. `notifyIfDue` fires at most one
 * push per decision id, ever (across restarts, since the "already sent" set is persisted); `dismiss`
 * drops a decision's entry once it resolves — bounding the set's growth and letting a hypothetical
 * FUTURE decision that happens to reuse an id (never true in practice — decision ids are UUIDs) push
 * again rather than being silently blocked forever.
 */
export class VoiceAttentionSource {
	private readonly stateDir: string;
	private readonly log: (msg: string) => void;
	private readonly push: PushService | undefined;
	private readonly sent = new Map<string, Set<string>>();

	constructor(stateDir: string, opts?: { log?: (msg: string) => void; push?: PushService }) {
		this.stateDir = stateDir;
		this.log = opts?.log ?? (() => {});
		this.push = opts?.push;
	}

	private sentFor(channelId: string): Set<string> {
		let set = this.sent.get(channelId);
		if (!set) {
			set = new Set(this.loadSent(channelId));
			this.sent.set(channelId, set);
		}
		return set;
	}

	private loadSent(channelId: string): string[] {
		try {
			const raw = getStorageBackend().readTextSync(pushSentPath(this.stateDir, channelId));
			if (!raw) return [];
			const parsed = JSON.parse(raw) as unknown;
			return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
		} catch (err) {
			this.log(`voice-push-sent/${channelId}.json unreadable — starting empty: ${errText(err)}`);
			return [];
		}
	}

	private persist(channelId: string): void {
		try {
			getStorageBackend().writeDurableSync(pushSentPath(this.stateDir, channelId), JSON.stringify([...this.sentFor(channelId)]));
		} catch (err) {
			this.log(`voice-push-sent/${channelId}.json write failed: ${errText(err)}`);
		}
	}

	hasSent(channelId: string, decisionId: string): boolean {
		return this.sentFor(channelId).has(decisionId);
	}

	/** Sends the push exactly once per decision id, ever. Returns `{sent:false, reason}` for every
	 *  case that isn't a genuine first send — no-push-substrate-wired, decision not active, or
	 *  already sent — so a caller can log/branch without re-deriving the reason. */
	async notifyIfDue(channelId: string, decision: JournalDecisionSnapshot, userIds?: readonly string[]): Promise<{ sent: boolean; reason?: string }> {
		if (!this.push) return { sent: false, reason: "no-push-service" };
		const payload = voiceDecisionPushPayload(channelId, decision);
		if (!payload) return { sent: false, reason: "not-active" };
		const set = this.sentFor(channelId);
		if (set.has(decision.id)) return { sent: false, reason: "already-sent" };
		set.add(decision.id);
		this.persist(channelId);
		const count = await this.push.notify(payload, userIds);
		return { sent: count > 0 };
	}

	/** Drop this decision's dedup entry once it resolves — keeps the persisted set from growing
	 *  without bound over a long-lived channel's whole history of decisions. */
	dismiss(channelId: string, decisionId: string): void {
		const set = this.sentFor(channelId);
		if (!set.delete(decisionId)) return;
		this.persist(channelId);
	}
}

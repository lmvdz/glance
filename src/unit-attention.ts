/**
 * The per-unit attention lane (concern 19 of plans/deepen-modules, round-2 rank 2) — the ONE
 * raiser behind `AgentDTO.attentionEvents` plus the escalation ledger every bounded "needs a
 * human" path shares.
 *
 * Before this module, eight squad-manager sites re-implemented append-then-emit by hand — some
 * try/catch'd the emit, some didn't — and five manager fields (two Map/Set pairs plus an episode
 * map) duplicated one dedupe job. The lane owns both jobs; the manager keeps the DOMAIN text of
 * each escalation (what to say) and hands the lane the mechanics (how to record it exactly once
 * and never let observability break the path that raised it).
 *
 * NOTE (two lanes, deliberately): src/attention.ts is the OPERATOR attention lane (repo-scoped,
 * has its own module); this is the PER-UNIT DTO lane (`AgentDTO.attentionEvents`). Concern 18's
 * boundary-sync lane keeps its own kind-keyed REPLACE-semantics rows (one row per sync kind,
 * freshest wins) — those are a different behavior from this lane's append-only raisers and were
 * deliberately not forced through this chokepoint.
 */
import { randomUUID } from "node:crypto";
import { errText } from "./err-text.ts";
import type { AgentDTO, AttentionEvent } from "./types.ts";

/** The per-session slice the lane touches — structural, so AgentRecord stays in the manager. */
export interface AttentionSession {
	dto: AgentDTO;
}

export interface UnitAttentionDeps {
	log(level: "info" | "warn", msg: string): void;
	/** DTO changed — broadcast it (the manager's emitAgent). */
	emit(rec: AttentionSession): void;
}

export class UnitAttentionLane {
	constructor(private readonly deps: UnitAttentionDeps) {}

	/**
	 * THE append-then-emit chokepoint: attach a "Needs you" row to the unit's non-blocking
	 * attention channel and broadcast it. Fail-open BY CONTRACT — an attention write must never
	 * break the path that raised it (land loop, tool handler, command router), so every failure
	 * is a warn log, never a throw. Returns the event (id minted here) so callers can reference
	 * it in transcripts/audits.
	 *
	 * `opts.quiet` skips the emit for call sites whose surrounding method already broadcasts
	 * unconditionally (onUi's notify) — the append still happens through the one chokepoint.
	 */
	raise(rec: AttentionSession, input: { summary: string; detail?: string; source: AttentionEvent["source"] } & Partial<Pick<AttentionEvent, "id" | "createdAt">>, opts?: { quiet?: boolean }): AttentionEvent {
		// Pre-minted id/createdAt pass through untouched — upstream modules (baseline-tracker's
		// staleness events, the membrane breaker) build full AttentionEvents before a rec exists.
		const event: AttentionEvent = { id: input.id ?? randomUUID(), summary: input.summary, detail: input.detail, source: input.source, createdAt: input.createdAt ?? Date.now() };
		try {
			rec.dto.attentionEvents = [...(rec.dto.attentionEvents ?? []), event];
			if (!opts?.quiet) this.deps.emit(rec);
		} catch (err) {
			this.deps.log("warn", `attention-lane attach failed for ${rec.dto.name} (non-fatal): ${errText(err)}`);
		}
		return event;
	}
}

/**
 * Bounded once-per-episode escalation state — the shape both the land-blocked and ahead-unknown
 * escalations hand-rolled as parallel Map/Set manager fields. One instance per escalation KIND;
 * keys are caller-defined scopes (`${repo}::${branch}` today).
 *
 * Semantics preserved verbatim from the fields it replaces:
 * - `noteEpisode(scope, episode)`: true (and attempts/escalated reset) iff `episode` differs from
 *   the scope's recorded one — a NEW retryable episode gets a fresh budget (landBlockedEpisode).
 * - `bump(scope)`: increment and return the scope's attempt/streak counter.
 * - `escalateOnce(scope)`: true exactly once per scope until `clear(scope)` — the caller fires
 *   its one-time "Needs you" item on true (landBlockedEscalated / aheadUnknownEscalated).
 * - `clear(scope)`: drop all three trackers — the condition healed or the episode closed.
 */
export class EscalationLedger {
	private readonly episodes = new Map<string, string>();
	private readonly attempts = new Map<string, number>();
	private readonly escalated = new Set<string>();

	noteEpisode(scope: string, episode: string): boolean {
		if (this.episodes.get(scope) === episode) return false;
		this.episodes.set(scope, episode);
		this.attempts.set(scope, 0);
		this.escalated.delete(scope);
		return true;
	}

	bump(scope: string): number {
		const n = (this.attempts.get(scope) ?? 0) + 1;
		this.attempts.set(scope, n);
		return n;
	}

	escalateOnce(scope: string): boolean {
		if (this.escalated.has(scope)) return false;
		this.escalated.add(scope);
		return true;
	}

	clear(scope: string): void {
		this.episodes.delete(scope);
		this.attempts.delete(scope);
		this.escalated.delete(scope);
	}
}

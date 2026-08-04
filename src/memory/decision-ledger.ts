/**
 * The decision ledger — the memory lane's single write path (capture → persist → supersede).
 *
 * Extracted from SquadManager.recordAgentDecision / handleRecordDecisionTool and server.ts's
 * PATCH sanitizer so the write rule has ONE home with ONE interface, testable without
 * constructing a SquadManager (13 test files used to reach past the missing seam with
 * `(mgr as unknown as { featureStore: Map })` casts).
 *
 * The ledger rules (plans/research-long-horizon-agent-memory/POSITION.md):
 *  - one current assertion per subject: a superseded target gets `supersededBy`/`supersededAt`
 *    stamped in the same write as its replacement — invalidate, never delete, never coexist;
 *  - the text de-dupe considers only CURRENT (non-superseded) decisions, so re-asserting a fact
 *    that was later reversed (A→B→A) is legal ledger history, not a silent no-op;
 *  - superseding an already-superseded target is rejected — supersede the current decision, not
 *    a historical one (prevents forked "current" chains under concurrent writers);
 *  - `source:"model-delta"` is evidence-gated at capture time (`validateModelDelta`) — the
 *    lane's only mechanical anti-slop pressure — and immutable through the PATCH sanitizer.
 *
 * Seam discipline: the ledger accepts its feature store as a three-method port
 * (`DecisionLedgerStore`) rather than reaching into SquadManager — two adapters justify it:
 * the manager's store-resident Map in production, a bare Map in tests.
 */
import { randomUUID } from "node:crypto";
import type { PersistedFeature } from "../types.ts";
import { validateModelDelta } from "./decision-evidence.ts";

// ── FeatureDecision (deepen 06 slice 2: moved from types.ts — the ledger owns its core type) ────
export interface FeatureDecision {
	id: string;
	text: string;
	/** "model-delta" (comprehension lane, concern 05): a mental-model delta — what changed about how
	 *  the system works, before vs after — recorded by the implementing unit mid-run via
	 *  `squad_record_decision`. Requires `evidence` (validated at record time against the run's
	 *  `filesTouched`); see `validateModelDelta` in decision-evidence.ts. */
	source?: "plan" | "human" | "agent" | "model-delta";
	createdAt?: number;
	/** Provenance backlink for agent-CAPTURED decisions (source:"agent"|"model-delta") — the run that
	 *  recorded it. Populated only on the agent/model-delta path; never fabricated for plan/human
	 *  sources (mirrors the "never-faked timestamp" discipline in fabric-search.ts). */
	sourceRef?: { agentId?: string; runId?: string };
	/** Evidence anchors for a `source:"model-delta"` decision: repo-relative `file` or `file:start-end`
	 *  entries, each required to name a file the recording run actually touched (the anti-slop floor —
	 *  DESIGN.md "Delta quality floor"). Absent for every other source. */
	evidence?: string[];
	/** Ledger supersession (plans/research-long-horizon-agent-memory): id of a prior decision on the
	 *  SAME feature that this one replaces. `recordAgentDecision` stamps the target's
	 *  `supersededBy`/`supersededAt` in the same write — invalidate, never delete, never coexist. */
	supersedes?: string;
	/** Set when a later decision replaced this one (the id of the replacement). A superseded decision
	 *  stays on the record for audit and history, but is EXCLUDED from the fabric/primer projection —
	 *  a stale fact in a spawned agent's context gets adopted regardless of labeling (compliance
	 *  trap, arXiv 2607.10608); see the decisions loop in fabric.ts. Server-authoritative through
	 *  the webapp PATCH merge (`featureDecisions` keeps stored fields, takes only `text`). */
	supersededBy?: string;
	/** Epoch ms when superseded — the close of this decision's validity window. */
	supersededAt?: number;
}

export type RecordDecisionOutcome = "recorded" | "duplicate" | "no-feature" | "supersede-missing" | "supersede-superseded";

/** Everything the ledger needs from the world: resolve a feature, adopt a plan-derived one,
 *  and be told a durable write happened. The adapter owns persistence + event fan-out. */
export interface DecisionLedgerStore {
	/** Synchronous read of the store-resident feature (the object writes land on). */
	get(featureId: string): PersistedFeature | undefined;
	/** Resolve + persist a plan-derived feature ("adopt"); undefined if the id is unknown.
	 *  Must be race-guarded so the store-resident object always wins (see recordAgentDecision's
	 *  original adopt race-guard note — that guarantee lives with the adapter). */
	adopt(featureId: string, repo?: string): Promise<PersistedFeature | undefined>;
	/** A decision write landed on the feature: persist and notify. */
	changed(): void;
}

/** Agents copy decision ids from kb-search output, where they render as `decision:<id>` doc
 *  ids — accept that form rather than bouncing a correct reference (blind-review finding: a
 *  false refusal steered agents toward recording WITHOUT `supersedes`, the exact
 *  two-live-currents failure this path exists to prevent). */
export function normalizeSupersedesRef(ref: string): string {
	return ref.trim().replace(/^decision:/, "");
}

/** Evidence anchors persist NORMALIZED (code-review finding): validateModelDelta normalizes
 *  only for its comparison, but every downstream consumer (surprise-tap fog keys,
 *  evidence-link jump, PR-body anchors) keys on the STORED string — a raw "./src/x.ts" would
 *  silently no-op them all. */
function normalizeEvidenceAnchor(e: string): string {
	return e.trim().replace(/^\.\//, "").replace(/^\/+/, "");
}

/** Input to `capture` — the agent-tool mint path. `filesTouched` is a provider, invoked only
 *  when the model-delta evidence gate needs it. */
export interface CaptureDecisionInput {
	featureId: string;
	text: string;
	modelDelta: boolean;
	evidence?: string[];
	supersedes?: string;
	repo?: string;
	sourceRef?: { agentId?: string; runId?: string };
	filesTouched: () => Promise<string[]>;
}

export type CaptureDecisionResult =
	| { kind: "rejected"; rule: string; message: string }
	| { kind: RecordDecisionOutcome; decision: FeatureDecision };

export class DecisionLedger {
	constructor(private readonly store: DecisionLedgerStore) {}

	/** The decisions currently stored on a persisted feature. Derived (not-yet-adopted)
	 *  features return undefined, which is correct: model-deltas only ever live on persisted
	 *  features (`record` adopts before writing). */
	stored(featureId: string): FeatureDecision[] | undefined {
		return this.store.get(featureId)?.decisions;
	}

	/**
	 * The single write rule. Atomic, adopt-aware append: resolves plan-derived features and
	 * can't clobber a concurrent capture.
	 *
	 * Concurrency: the check-and-write below is one synchronous block over the STORE-RESIDENT
	 * feature object, re-resolved after the only await (the adopt path), and the adapter's
	 * `adopt` re-checks its store before setting — so two near-simultaneous captures serialize
	 * on the same object instead of one silently clobbering the other's adopt.
	 */
	async record(featureId: string, decision: FeatureDecision, repo?: string): Promise<RecordDecisionOutcome> {
		// After the adopt await, re-resolve from the store: the adapter's race guard guarantees
		// the store-resident object wins, and every read below must be against THAT object, in
		// the synchronous block, or a concurrent capture could be checked against a stale copy.
		const adopted = this.store.get(featureId) ?? (await this.store.adopt(featureId, repo));
		if (!adopted) return "no-feature";
		const pf = this.store.get(featureId) ?? adopted;
		if (decision.supersedes?.startsWith("decision:")) decision = { ...decision, supersedes: normalizeSupersedesRef(decision.supersedes) };
		const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
		const target = norm(decision.text);
		const existing = pf.decisions ?? [];
		if (existing.some((d) => !d.supersededBy && norm(d.text) === target)) return "duplicate";
		let superseded: FeatureDecision | undefined;
		if (decision.supersedes) {
			superseded = existing.find((d) => d.id === decision.supersedes);
			if (!superseded) return "supersede-missing";
			if (superseded.supersededBy) return "supersede-superseded";
		}
		const now = Date.now();
		pf.decisions = [
			...existing.map((d) => (superseded && d.id === superseded.id ? { ...d, supersededBy: decision.id, supersededAt: now } : d)),
			decision,
		];
		pf.updatedAt = now;
		this.store.changed();
		return "recorded";
	}

	/**
	 * The agent-tool capture path (`squad_record_decision`): evidence-gate a model-delta, mint
	 * the decision (id, source, provenance backlink, normalized anchors), then `record` it.
	 * The caller keeps only transport concerns: arg parsing and mapping outcomes to replies.
	 */
	async capture(input: CaptureDecisionInput): Promise<CaptureDecisionResult> {
		if (input.modelDelta) {
			const filesTouched = await input.filesTouched();
			const check = validateModelDelta(input.text, input.evidence, filesTouched);
			if (!check.ok) return { kind: "rejected", rule: check.rule, message: check.message };
		}
		const decision: FeatureDecision = {
			id: randomUUID(),
			text: input.text,
			source: input.modelDelta ? "model-delta" : "agent",
			createdAt: Date.now(),
			sourceRef: input.sourceRef,
			...(input.modelDelta ? { evidence: (input.evidence ?? []).map(normalizeEvidenceAnchor) } : {}),
			...(input.supersedes ? { supersedes: input.supersedes } : {}),
		};
		const outcome = await this.record(input.featureId, decision, input.repo);
		return { kind: outcome, decision };
	}

	/**
	 * The human lane's supersession verb (POST /api/features/:id/decisions/supersede): PATCH
	 * deliberately drops a client `supersedes` (anti-forgery — a round-tripping UI must never
	 * mint stamps), so this is the UI's only path to the ledger's core verb. Server-authored,
	 * atomic, through the same write rule.
	 *
	 * An empty or bare-prefix `supersedes` would evaluate falsy in the write rule and silently
	 * degrade this into an unconditional append while the verb advertises supersession —
	 * normalize like the write path, then reject empty outright (blind-review fix).
	 */
	async supersede(
		featureId: string,
		input: { text: string; supersedes: string; repo?: string },
	): Promise<{ outcome: "invalid" } | { outcome: RecordDecisionOutcome; decision: FeatureDecision }> {
		const text = input.text.trim();
		const supersedesId = normalizeSupersedesRef(input.supersedes);
		if (!text || !supersedesId) return { outcome: "invalid" };
		const decision: FeatureDecision = { id: randomUUID(), text, source: "human", createdAt: Date.now(), supersedes: supersedesId };
		const outcome = await this.record(featureId, decision, input.repo);
		return { outcome, decision };
	}
}

/**
 * Sanitize a PATCH body's `decisions` array against the feature's STORED decisions. The incoming
 * array defines membership and order (so deleting a decision still works), but for an entry whose
 * id already exists on the feature, the server-authoritative fields — `source`, `evidence`,
 * `sourceRef`, `createdAt` — are kept from the stored record and only the text is taken from the
 * client. Without this merge, the webapp's routine "add one decision" round-trip (it PATCHes the
 * FULL array back) coerced every stored `model-delta` decision to `source:"human"` and silently
 * dropped its evidence anchors — destroying the teaching content the comprehension lane exists to
 * produce. New entries (id not on the feature) are down-tiered exactly as before: a PATCH client
 * can never mint `model-delta` records, because those are only minted through `capture`'s
 * evidence validation. (Model-deltas always live on persisted features — `record` adopts before
 * writing — so `stored` is never missing for them.)
 *
 * Supersession-chain members (`supersedes`/`supersededBy` set) get ledger protection
 * (blind-review finding): a STALE client that loaded the feature before a replacement was
 * recorded PATCHes the full array back WITHOUT the replacement — omission-as-delete would then
 * destroy the current decision while its predecessor stays stamped superseded-by-a-ghost,
 * vanishing BOTH from projection. Chain members therefore survive omission (re-appended, stored
 * order), and a SUPERSEDED entry is immutable like a model-delta — it is history, and history
 * does not take text edits.
 */
export function sanitizePatchDecisions(value: unknown, stored: FeatureDecision[] | undefined): FeatureDecision[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const byId = new Map((stored ?? []).map((d) => [d.id, d]));
	const out = value.flatMap((item): FeatureDecision[] => {
		if (!item || typeof item !== "object") return [];
		const rec = item as Record<string, unknown>;
		const id = typeof rec.id === "string" ? rec.id : undefined;
		const text = typeof rec.text === "string" ? rec.text.trim() : "";
		if (!id || !text) return [];
		const existing = byId.get(id);
		// model-delta records are IMMUTABLE through PATCH: their text was validated against the
		// recording run's evidence anchors, and accepting a client text edit while keeping
		// source/evidence/sourceRef would present a rewritten claim as run-validated — the exact
		// fabricated-verification pattern the lane exists to prevent. A client may still DELETE
		// one by omitting it (unless it is a supersession-chain member — see below); editing any
		// other source's text stays allowed.
		if (existing?.source === "model-delta") return [existing];
		// Superseded entries are history: keep them verbatim, no text edits.
		if (existing?.supersededBy) return [existing];
		if (existing) return [{ ...existing, text }];
		return [{ id, text, source: rec.source === "plan" || rec.source === "human" || rec.source === "agent" ? rec.source : "human", createdAt: typeof rec.createdAt === "number" ? rec.createdAt : undefined }];
	});
	// Ledger guard: chain members cannot be deleted by omission. Re-append any stored
	// `supersedes`/`supersededBy` carrier the client's array dropped, in stored order.
	const present = new Set(out.map((d) => d.id));
	for (const d of stored ?? []) {
		if (!present.has(d.id) && (d.supersededBy || d.supersedes)) out.push(d);
	}
	return out;
}

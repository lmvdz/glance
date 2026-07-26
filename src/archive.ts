/**
 * archive.ts — what survives, what may be cut, and how a summary is stopped from passing as the record.
 *
 * The failure this exists to prevent is specific: a compacted record that reads like a complete one.
 * Once that happens the loss is invisible, which means nobody can decide whether it mattered, which
 * means it always mattered.
 *
 * Three rules, and the first is absolute:
 *
 * 1. **Decisions, the evidence known at the time, and human text are preserved at full fidelity.**
 *    They are never compaction candidates. Not under pressure, not by policy, not by an operator who
 *    would rather they were.
 * 2. **A compaction declares its own cut** — what was removed, when, who authorized it, and what was
 *    kept. A cut nobody can see is indistinguishable from data that never existed.
 * 3. **A compacted record says so at every read.** Not once at the top of a page; on the record
 *    itself, wherever it is rendered.
 *
 * Separate from concern 06, deliberately. That one owns the LIVE summary of a node — regenerated,
 * always current, never appended. This owns the immutable archive. A live summary is allowed to
 * replace itself; the archive is not allowed to lose anything without saying what.
 */

import type { NodeRecord, RetentionRecord } from "./node-records.ts";

/**
 * Record kinds that can never be cut.
 * @substrate the audit surface for the exhaustiveness test, which is what stops a new record kind from
 * being added without anyone deciding whether it may be destroyed. No production caller by design. Not configuration — the whole point is that no policy reaches
 * them. Kept as an explicit list rather than a predicate so the exhaustiveness test can assert that
 * every kind was considered.
 */
export const preservedKinds = ["decision", "rule", "objection", "instruction-readback", "human-authority", "delegation-boundary"] as const;
export type PreservedKind = (typeof preservedKinds)[number];

/**
 * Kinds a policy may compact. Every remaining archival kind must appear here, or the exhaustiveness
 * test fails. Live summaries are deliberately excluded: they are regenerated state, not history.
 */
export const compactableKinds = ["evidence", "plan-motion", "handover", "retention"] as const;
/** Current replace-in-place records that are neither archive evidence nor compaction candidates. */
export const liveKinds = ["summary"] as const;

function isPreserved(kind: NodeRecord["kind"]): boolean {
	return (preservedKinds as readonly string[]).includes(kind);
}

/** A human-authored policy. Compaction never runs as a background default. */
export interface CompactionPolicy {
	/** Who authorized it. There is no anonymous compaction. */
	authorizedBy: string;
	/** Records older than this may be cut, if their kind allows. */
	olderThanMs: number;
	/** The authorizer's own words for why. Rendered on the resulting record. */
	reason: string;
}

export interface CompactionPlan {
	/** Records this policy would remove. */
	cut: NodeRecord[];
	/** Records it would keep, and why each was spared. */
	kept: Array<{ record: NodeRecord; because: "preserved-kind" | "too-recent" }>;
	/** The retention record that would be written. Not written by planning — see `planCompaction`. */
	retention: Omit<RetentionRecord, "id" | "nodeId">;
}

/**
 * Work out what a policy would cut, WITHOUT cutting it. Planning and applying are separate so a human
 * can be shown the consequence before it happens — "every control says what it will do before it is
 * used" applies hardest to the one control that destroys things.
 */
export function planCompaction(records: readonly NodeRecord[], policy: CompactionPolicy, now: number): CompactionPlan {
	const cut: NodeRecord[] = [];
	const kept: CompactionPlan["kept"] = [];
	for (const record of records) {
		if ((liveKinds as readonly string[]).includes(record.kind)) continue;
		if (isPreserved(record.kind)) {
			kept.push({ record, because: "preserved-kind" });
			continue;
		}
		if (now - record.createdAt < policy.olderThanMs) {
			kept.push({ record, because: "too-recent" });
			continue;
		}
		cut.push(record);
	}
	return {
		cut,
		kept,
		retention: {
			kind: "retention",
			createdAt: now,
			authorizedBy: policy.authorizedBy,
			compactedAt: now,
			cut: cut.map(describe),
			preserved: kept.map(({ record }) => describe(record)),
			fidelity: cut.length > 0 ? "compacted" : "full",
		},
	};
}

/** One line per record, kept in the retention row so the cut is legible after the records are gone. */
function describe(record: NodeRecord): string {
	switch (record.kind) {
		case "decision":
			return `decision "${record.question}" → "${record.chose}" (${record.decidedBy})`;
		case "rule":
			return `rule "${record.sentence}" (${record.authorId})`;
		case "evidence":
			return `evidence "${record.claim}" (${record.verification}, n=${record.sampleSize})`;
		case "handover":
			return `handover ${record.fromActorId} → ${record.toActorId}`;
		case "plan-motion":
			return `plan motion, last movement ${new Date(record.lastMeaningfulMovementAt).toISOString()}`;
		case "objection":
			return `objection "${record.prediction}" (${record.agentId})`;
		case "instruction-readback":
			return `reading of "${record.instruction}" by ${record.agentId}`;
		case "human-authority":
			return `${record.role} ${record.humanId}`;
		case "delegation-boundary":
			return `boundary ${record.class}`;
		case "retention":
			return `an earlier compaction authorized by ${record.authorizedBy}`;
		case "summary":
			return `live ${record.direction} summary`;
}
	}

/**
 * How a compacted record must be introduced wherever it is read. Returned as a sentence rather than a
 * flag, because a flag gets rendered as a badge and a badge gets ignored — and this is the one thing
 * that must not be ignored.
 */
export function compactionNotice(retention: RetentionRecord): string {
	if (retention.fidelity === "full") {
		return `Nothing was cut here. ${retention.preserved.length} records kept in full, reviewed by ${retention.authorizedBy}.`;
	}
	return `This is not the full record. ${retention.cut.length} ${retention.cut.length === 1 ? "entry was" : "entries were"} cut on ${new Date(retention.compactedAt).toISOString().slice(0, 10)}, authorized by ${retention.authorizedBy}. ${retention.preserved.length} kept — every decision, every rule, and everything a person wrote.`;
}

// ── Evidence age and handover ────────────────────────────────────────────────

/** Past this, results are described as stale rather than merely old. */
const DEFAULT_FRESHNESS_MS = 30 * 60_000;

/**
 * How old evidence is, and what to do about it.
 * @substrate the staleness vocabulary concerns 18 and 21 consume, and user-visible copy — so it is
 * tested directly on its sentences rather than only through `planHandover`. Returns a sentence, not a boolean: "stale" alone tells
 * a person nothing about whether to act, and the design's own example is an instruction — "re-run them
 * against today's main" — rather than a label.
 */
export function evidenceAge(checkedAt: number | undefined, now: number, opts: { freshnessMs?: number; ref?: string } = {}): { stale: boolean; sentence: string } {
	const ref = opts.ref ?? "today's main";
	if (checkedAt === undefined) {
		// Never checked is NOT the same as checked long ago, and must not read as fresh.
		return { stale: true, sentence: `These results were never verified against ${ref}. Whoever picks this up should run them before relying on them.` };
	}
	const ageMs = Math.max(0, now - checkedAt);
	const mins = Math.round(ageMs / 60_000);
	if (ageMs < (opts.freshnessMs ?? DEFAULT_FRESHNESS_MS)) {
		return { stale: false, sentence: `These results are ${mins < 1 ? "less than a minute" : `${mins} ${mins === 1 ? "minute" : "minutes"}`} old and were checked against ${ref}.` };
	}
	const label = mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`;
	return { stale: true, sentence: `These results are ${label} old. Whoever picks this up should re-run them against ${ref}.` };
}

export interface HandoverPlan {
	carried: string[];
	notCarried: string[];
	staleEvidenceIds: string[];
	/** What the human is agreeing to, in one paragraph, BEFORE they confirm. */
	sentence: string;
}

/**
 * What moves to the next agent and what does not, stated before the handover is confirmed.
 *
 * The omission is the point. A human cannot consent to something they were not told about, so
 * `notCarried` is computed and named rather than left as whatever happens to be absent. Evidence past
 * its freshness window is marked stale AT THE POINT OF TRANSFER — carrying it forward silently is how
 * a new agent inherits a conclusion nobody has checked this week.
 */
export function planHandover(
	records: readonly NodeRecord[],
	opts: { from: string; to: string; carryKinds?: readonly NodeRecord["kind"][]; now: number; freshnessMs?: number; ref?: string },
): HandoverPlan {
	const carryKinds = opts.carryKinds ?? (["decision", "rule", "evidence", "instruction-readback", "objection"] as const);
	const carried: string[] = [];
	const notCarried: string[] = [];
	const staleEvidenceIds: string[] = [];
	for (const record of records) {
		if (!carryKinds.includes(record.kind)) {
			notCarried.push(describe(record));
			continue;
		}
		carried.push(describe(record));
		if (record.kind === "evidence" && evidenceAge(record.checkedAt, opts.now, { freshnessMs: opts.freshnessMs, ref: opts.ref }).stale) {
			staleEvidenceIds.push(record.id);
		}
	}
	const parts = [`${opts.to} picks this up from ${opts.from} with ${carried.length} ${carried.length === 1 ? "record" : "records"} — every decision and every rule comes across, still attributed to whoever made it.`];
	if (notCarried.length > 0) parts.push(`${notCarried.length} ${notCarried.length === 1 ? "thing does" : "things do"} not come across: ${notCarried.slice(0, 3).join("; ")}${notCarried.length > 3 ? `; and ${notCarried.length - 3} more` : ""}.`);
	if (staleEvidenceIds.length > 0) parts.push(`${staleEvidenceIds.length} of the carried results ${staleEvidenceIds.length === 1 ? "is" : "are"} past ${Math.round((opts.freshnessMs ?? DEFAULT_FRESHNESS_MS) / 60_000)} minutes old and ${staleEvidenceIds.length === 1 ? "is" : "are"} marked stale — re-run ${staleEvidenceIds.length === 1 ? "it" : "them"} against ${opts.ref ?? "today's main"} before relying on ${staleEvidenceIds.length === 1 ? "it" : "them"}.`);
	else parts.push("Nothing carried across is stale.");
	return { carried, notCarried, staleEvidenceIds, sentence: parts.join(" ") };
}

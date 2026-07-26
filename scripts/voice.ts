/**
 * voice.ts — the rule that a string states a fact AND what it means.
 *
 * This is the design's first law and the one that decays fastest, because every emit site is an
 * opportunity to write "land attempt finished · wren · ok" and move on. That string is true. It also
 * tells a person nothing they can act on: not whether the work is sound, not whether anything is
 * waiting on them, not what happens next.
 *
 * The rule cannot be enforced by good intentions across a twelve-thousand-line manager, so it is
 * enforced by a ratchet — the same shape `scripts/dead-exports.ts` uses, and it lives beside it for
 * the same reason: this is a lint over the source, not a runtime dependency of the product. The current number of
 * label-only strings is the baseline, and it may only go down. That is deliberately not "fix
 * everything now": a rule that demands a large rewrite before it can land is a rule that never lands,
 * and the point is to stop the count rising while the existing ones are worked off.
 *
 * What this CANNOT do, and why concern 10 was amended: a lint cannot recover a fact the event contract
 * never carried. "The gate passed" cannot become "the gate passed, and nothing is waiting on you"
 * unless the emitter knows the second clause. So the rule below tests shape, and the payload contracts
 * in `projection-classes.ts` are what make the shape achievable.
 */

/** A string that is only a state name, or only fields joined by separators. */
export interface VoiceVerdict {
	explains: boolean;
	/** Why it fails, phrased for the person who has to fix it. */
	why?: string;
}

/** Separator-joined field dumps: "land attempt finished · wren · ok". */
const FIELD_DUMP = /^[^.!?]*(?: · [^.!?]*){1,}$/;

/** Bare state words that carry no consequence on their own. */
const BARE_LABELS = new Set([
	"blocked", "queued", "running", "working", "idle", "failed", "done", "settled", "stopped",
	"pending", "waiting", "error", "ok", "pass", "fail", "merged", "landed", "parked", "unknown",
]);

/**
 * Does this string state a fact AND what it means?
 *
 * The test is deliberately shallow and mechanical, because a deep one would be a judgement call and
 * judgement calls do not ratchet. Two clauses of real prose, or one clause that names a consequence,
 * passes. A field dump or a bare label does not.
 */
export function explainsRatherThanLabels(text: string): VoiceVerdict {
	const trimmed = text.trim();
	if (trimmed.length === 0) return { explains: false, why: "an empty string tells a person nothing at all" };
	if (BARE_LABELS.has(trimmed.toLowerCase().replace(/[.!]$/, ""))) {
		return { explains: false, why: `"${trimmed}" names a state and stops — say what it means for the person reading it` };
	}
	if (FIELD_DUMP.test(trimmed)) {
		return { explains: false, why: `"${trimmed}" is fields joined by separators — true, but it does not say what follows from it` };
	}
	// Real prose: at least one sentence-ending mark with something after the first clause, or a long
	// enough single clause to be carrying meaning rather than naming a thing.
	const sentences = trimmed.split(/[.!?]\s+/).filter((part) => part.trim().length > 0);
	if (sentences.length >= 2) return { explains: true };
	if (trimmed.length >= 60 && /\s/.test(trimmed)) return { explains: true };
	return { explains: false, why: `"${trimmed}" is one short clause — state the fact and then what it means` };
}

/** Convenience for callers that only need the boolean. */
export function explains(text: string): boolean {
	return explainsRatherThanLabels(text).explains;
}

/**
 * Every interruption states what is NOT affected. Answering the anxious question before it is asked is
 * cheaper than the person going to look, and much cheaper than them not looking and worrying.
 */
export function statesBlastRadius(text: string): boolean {
	return /\bnothing else\b|\bunaffected\b|\bstill (?:moving|running)\b|\bnothing is waiting\b|\bwaiting behind\b|\bnothing here\b|\bonly \S+ is\b/i.test(text);
}

/** Every control says what it will do before it is used. */
export function statesConsequence(text: string): boolean {
	return /\bwill\b|\bhappens\b|\bstays\b|\bmoves on\b|\bstops\b|\bkeeps\b|\bwithout\b|\bthen\b/i.test(text);
}

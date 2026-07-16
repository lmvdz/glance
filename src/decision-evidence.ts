/**
 * Model-delta evidence validation (comprehension lane, concern 05 "teaching producers").
 *
 * A model-delta decision (`FeatureDecision.source === "model-delta"`) is a claim that the recording
 * unit's mental model of the system changed — what was true before, what is true now. Free-form claims
 * of that shape are the textbook slop pattern: plausible-sounding, unfalsifiable, and worthless to the
 * next reader. The one mechanical anti-slop pressure available without a human gate (the ndrstnd
 * research pass's pattern 1; DESIGN.md "Delta quality floor") is an EVIDENCE ANCHOR — every delta must
 * cite a file this run actually touched, so the claim is at minimum tied to a real diff rather than
 * invented wholesale. An anchor pointing OUTSIDE the run's changed files is rejected exactly the same
 * way as no anchor at all: a citation that isn't real evidence is worse than none, because it reads as
 * verified when it isn't.
 *
 * Pure — takes the run's `filesTouched` as a parameter (computed live via `runFilesTouched` in
 * squad-manager.ts, which already unifies "committed this run" and "the current working-tree diff", or
 * read off a persisted `RunReceipt`) so this module never touches git or the filesystem, and is
 * trivially unit-testable.
 */

const MIN_DELTA_TEXT_LEN = 20;
// Upper bounds: agent-tier input, but still an unbounded-write path into persisted feature state
// without them (batch-1 review, minor #2). Generous enough that no honest bullet ever hits them.
const MAX_DELTA_TEXT_LEN = 2000;
const MAX_EVIDENCE_ENTRIES = 8;
const MAX_EVIDENCE_ENTRY_LEN = 512;

export interface EvidenceRejection {
	ok: false;
	/** Machine-stable name of the violated rule, handed back to the agent in the tool-error text so it
	 *  can self-correct rather than guess what went wrong. */
	rule: string;
	message: string;
}

export interface EvidenceAccepted {
	ok: true;
}

export type EvidenceValidation = EvidenceAccepted | EvidenceRejection;

/** Strip an optional `:start-end` or `:line` line-range suffix off an evidence entry, leaving the bare
 *  repo-relative file path to compare against `filesTouched`. Only strips when the suffix is purely
 *  digits (optionally a range) — a colon that isn't a line range (vanishingly rare in a repo-relative
 *  path, but not impossible) is left alone.
 *  @substrate exported for tests only — `validateModelDelta` (below, same file) is the one production
 *  caller; the suffix-stripping edge cases (numeric vs. non-numeric, absent) are asserted directly. */
export function evidenceFilePath(entry: string): string {
	const trimmed = entry.trim();
	const idx = trimmed.lastIndexOf(":");
	if (idx <= 0) return trimmed;
	const suffix = trimmed.slice(idx + 1);
	return /^\d+(-\d+)?$/.test(suffix) ? trimmed.slice(0, idx) : trimmed;
}

/** Normalize for comparison: strip a leading `./` and any leading slashes. Evidence entries and
 *  `filesTouched` are both meant to be repo-relative, but an agent may type either form. */
function normalizeForCompare(p: string): string {
	return p.trim().replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * The delta quality floor. Bullet text must clear a real minimum length (so "removed the bug" doesn't
 * qualify), and the decision requires at least one evidence entry whose file is in the run's
 * `filesTouched` — anchorless bullets are rejected outright ("model-delta-requires-evidence"), and an
 * anchor outside the changed-file set is rejected as "model-delta-evidence-anchor". Every evidence
 * entry must resolve, not just the first — a bullet with one real anchor and one fabricated one still
 * fails, since only the fabricated citation would ever get checked by a human.
 */
export function validateModelDelta(text: string, evidence: string[] | undefined, filesTouched: string[]): EvidenceValidation {
	const trimmedText = text.trim();
	if (trimmedText.length < MIN_DELTA_TEXT_LEN) {
		return {
			ok: false,
			rule: "model-delta-text-too-short",
			message: `a model-delta bullet must be at least ${MIN_DELTA_TEXT_LEN} characters — state what was true before and what is true now`,
		};
	}
	if (trimmedText.length > MAX_DELTA_TEXT_LEN) {
		return {
			ok: false,
			rule: "model-delta-text-too-long",
			message: `a model-delta bullet must be at most ${MAX_DELTA_TEXT_LEN} characters — it is a bullet, not a document`,
		};
	}
	if (/[\r\n]/.test(trimmedText)) {
		return {
			ok: false,
			rule: "model-delta-text-multiline",
			message: "a model-delta bullet must be a single line — embedded newlines would let a bullet forge markdown sections in the rendered PR body",
		};
	}
	if (!evidence || evidence.length === 0) {
		return {
			ok: false,
			rule: "model-delta-requires-evidence",
			message: "model-delta decisions require at least one evidence entry (a repo-relative file or file:start-end) — delta bullets must cite a file this run touched",
		};
	}
	if (evidence.length > MAX_EVIDENCE_ENTRIES) {
		return {
			ok: false,
			rule: "model-delta-evidence-count",
			message: `at most ${MAX_EVIDENCE_ENTRIES} evidence entries per delta — cite the load-bearing files, not the whole diff`,
		};
	}
	if (evidence.some((e) => e.length > MAX_EVIDENCE_ENTRY_LEN)) {
		return {
			ok: false,
			rule: "model-delta-evidence-entry-too-long",
			message: `each evidence entry must be at most ${MAX_EVIDENCE_ENTRY_LEN} characters (a repo-relative path, optionally :start-end)`,
		};
	}
	const touched = new Set(filesTouched.map(normalizeForCompare));
	for (const raw of evidence) {
		const file = normalizeForCompare(evidenceFilePath(raw));
		if (!file || !touched.has(file)) {
			return {
				ok: false,
				rule: "model-delta-evidence-anchor",
				message: `delta bullets must cite a file this run touched — "${raw.trim()}" is not in this run's changed files`,
			};
		}
	}
	return { ok: true };
}

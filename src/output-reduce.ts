/**
 * Signal-ranked output reducer (noisegate-compaction concern 01, adopting patterns from
 * `plans/research-noisegate/BRIEF.md`). The gate/verify/land paths used to plain head-cut or
 * head+tail-cut (`truncate`, `gate-logs.ts`'s `headTail`) oversized tool output — a blunt instrument
 * that happily drops the ONE `error TS2304:` line or `(fail)` summary a human/judge/fixup-agent
 * needed most, if it happened to fall in the cut zone. This module ranks lines by a small,
 * measured-from-real-output preserve table (CRITICAL patterns matched in every class, plus
 * command/shape-classified patterns) and fills the budget tier-ascending, so the highest-signal
 * lines survive first and only the LEAST useful content is what actually gets cut.
 *
 * Two layers:
 *  - `classifyAndReduce` — pure sync core, no I/O, NEVER throws. Callers on a hot/sync path
 *    (checkpoint persistence, concern 04) use this directly.
 *  - `reduceOutput` — async wrapper that additionally offloads the FULL original via
 *    `writeGateLog` (gate-logs.ts, already-proven offload/pointer machinery — NOT duplicated here)
 *    and appends a budgeted `[N bytes omitted — full: <path>]` pointer, mirroring
 *    `budgetedExcerpt`'s contract but with signal-ranked bodies instead of raw head+tail.
 *
 * HARD INVARIANT (red-team arbitration, both lenses, both criticals): the returned `text` is
 * ALWAYS `<= budget` chars. Every path — no-gain, zero-priority-match, exception — lands on
 * `headTail(text, budget)`, never on the over-budget original. Noisegate's own "no-gain →
 * return original" shortcut is explicitly NOT adopted here; every converted call site enforces a
 * hard cap and an over-budget return would violate it.
 */

import * as path from "node:path";
import { headTail, writeGateLog } from "./gate-logs.ts";
import { TESTS_RAN_RE, ZERO_TESTS_RE } from "./gate-runner.ts";
import { JsonlLog } from "./jsonl-log.ts";
import { resolveStateDir } from "./state-dir.ts";
import { stripAnsi } from "./text-util.ts";

export type ReduceClass = "test" | "diagnostics" | "install" | "generic";
export type ReduceReason = "fit" | "reduced" | "headtail-fallback" | "error";

/** One compaction event, persisted to `compaction.jsonl` (see `setCompactionLogRoot` below) for
 *  forensic/tuning visibility — NOT logged for `reason: "fit"` (a no-op has nothing to report). */
export interface CompactionDecision {
	ts: number;
	/** First matched class, for a legible one-word summary; `classes` carries the full union. */
	class: ReduceClass;
	classes: ReduceClass[];
	reason: ReduceReason;
	/** Caller-input length, BEFORE stripAnsi — the honest "how big was this originally". */
	originalChars: number;
	/** originalChars − final returned text length (post-pointer, for `reduceOutput`). */
	charsSaved: number;
	/** Count of tier-matched (CRITICAL or class-tier) lines that survived into the final text. */
	preservedLines: number;
	/** Threaded through by `decisionFor` on every path — sync `classifyAndReduce` records carry it too,
	 *  not just `reduceOutput`'s enriched record. */
	command?: string;
	/** Wrapper-only: populated by `reduceOutput`, never by the sync core. */
	agentId?: string;
	/** Wrapper-only: populated by `reduceOutput`, never by the sync core. */
	source?: string;
	/** Wrapper-only: set only by `reduceOutput` when it durably offloaded the full original. */
	path?: string;
}

/**
 * Our own omission grammar — BOTH the per-gap fill marker this module emits (`[N lines omitted]`)
 * and gate-logs.ts's pointer (`[N bytes omitted — full: <path>]`) match this. Two uses:
 *  1. CRITICAL-tier classification (a marker surviving from a PRIOR reduction pass is itself
 *     high-signal — it tells a human/judge more got cut upstream).
 *  2. Neutralization: an INPUT line that happens to match this shape (agent-authored test output
 *     can print anything) is prefixed `> ` before reconstruction so it can never be mistaken for —
 *     or forge — a real pointer this module generated (red-team RT2-7: an unfenced channel with a
 *     forged `[N bytes omitted — full: /etc/passwd]` line could misdirect an operator).
 */
export const OMISSION_POINTER_RE = /^\[\d+ (?:lines?|bytes) omitted\b.*\]$/;

/** A marker/pointer-shaped input line AFTER this module's own `> ` neutralization prefix. Every
 *  input line matching `OMISSION_POINTER_RE` gets neutralized before tagging, so by tagging time
 *  it is THIS shape that appears — and it must keep CRITICAL-tier protection: a LEGIT pointer from
 *  a PRIOR reduction (executor output later re-reduced at the checkpoint boundary, concern 04)
 *  arrives as input here, and dropping it would amputate exactly the offload trail concern 04
 *  exists to preserve. A forged marker gets the same protection, but it is already harmless once
 *  neutralized — surviving as `> [...]` misdirects no one. */
const NEUTRALIZED_MARKER_RE = /^> \[\d+ (?:lines?|bytes) omitted\b.*\]$/;

/** The NONCE-CARRYING subset of the omission grammar: only `writeGateLog`'s offload pointer
 *  (`[N bytes omitted — full: <path>]`), never our own per-gap `[N lines? omitted]` fill marker. A
 *  fresh `writeGateLog` call mints a unique ts+nonce path on EVERY reduction, so a raw pointer line
 *  makes an otherwise-identical failure compare different on every visit unless it's stripped before
 *  identity comparison — but a gap marker's COUNT is real, reproducible signal about the SAME
 *  failure (two DIFFERENT failures commonly differ only in how many lines got cut), so stripping it
 *  too would falsely collapse two distinct failures to "no progress". Matches both the raw form (a
 *  reducer-generated pointer, never re-input) and the `> `-neutralized form (what re-reducing a
 *  prior pointer line, or a checkpoint round-trip, leaves behind). */
const OFFLOAD_POINTER_RE = /^(?:> )?\[\d+ bytes omitted — full: .*\]$/;

/** Tier 0, unioned into EVERY class — these patterns are high-signal regardless of what the
 *  command/shape classifier decided, so a misclassified or compound command (`tsc && bun test`)
 *  never silently drops them. Measured against real `bun test` output (see tests/output-reduce.test.ts
 *  fixtures) plus the existing gate-runner.ts/land.ts failure-shape conventions. */
const CRITICAL_PATTERNS: RegExp[] = [
	OMISSION_POINTER_RE,
	NEUTRALIZED_MARKER_RE,
	/error TS\d+:/,
	/^error(:| )/,
	// Node-style error heads (`Error: something`, `TypeError: x is not a function`,
	// `RangeError: …`) — the lowercase `^error(:| )` above only catches gate-runner/bun-style lowercase
	// heads, so a thrown-and-printed JS Error's class name+message was falling through with no
	// dedicated tier protection at all.
	/^[A-Za-z]*Error[: ]/,
	/\bAssertionError\b/,
	/ERESOLVE|EACCES|EPERM/,
	/panic:/,
	/command not found/,
	/\b[1-9]\d*\s+fail\b/,
];

/** Class-specific tiers, written from CAPTURED real `bun test`/`tsc`/`npm` output — see the ANSI +
 *  plain-mode fixtures in tests/output-reduce.test.ts. Deliberately does NOT include `"generic"`:
 *  a command/shape match that yields no more specific class has no dedicated preserve list, only
 *  the CRITICAL tier + untagged head/tail fallback. */
const CLASS_PATTERNS: Record<Exclude<ReduceClass, "generic">, RegExp[]> = {
	test: [/\(fail\)/, /✗/, /^error: expect/, /Expected:|Received:/, /^\s*at .*:\d+/, /\d+ pass\b.*\d+ fail\b/],
	diagnostics: [/error TS\d+:/, /^\s*\d+:\d+\s+(error|warning)\b/, /Found \d+ errors?/],
	install: [/npm ERR!/, /peer dep/i, /EACCES|EPERM/, /^error /],
};

/** Fixed tier-assignment priority for MATCHED classes — "class tiers 1..n" in document order of
 *  this list, not command-appearance order, so tier numbering is deterministic regardless of how
 *  `classifyCommand` happened to build its Set. */
const CLASS_PRIORITY: ReduceClass[] = ["test", "diagnostics", "install"];

/**
 * Classify a gate/tool run into ALL matching classes (never a single winner) so a compound command
 * (`tsc && bun test`) or an ambiguous command union their preserve tables instead of one crowding
 * out the other (red-team RT2-6). Command regexes are checked first (when `command` is given), then
 * shape fallback runs on the ANSI-stripped `text` UNCONDITIONALLY (additive, not "only if the
 * command matched nothing") — a `command` string is often unavailable (checkpoint path) or wrong
 * (a wrapper script), so shape signal from the actual output is never skipped just because the
 * command already matched something. Empty result ⇒ `["generic"]`.
 */
export function classifyCommand(command: string | undefined, strippedText: string): ReduceClass[] {
	const classes = new Set<ReduceClass>();
	if (command) {
		if (/\b(bun\s+test|vitest|jest)\b/.test(command)) classes.add("test");
		if (/\b(tsc|eslint)\b/.test(command)) classes.add("diagnostics");
		if (/\b(bun|npm|pnpm|yarn)\s+(install|add|ci)\b/.test(command)) classes.add("install");
	}
	if (/\(fail\)|✗/.test(strippedText) || TESTS_RAN_RE.test(strippedText) || ZERO_TESTS_RE.test(strippedText)) classes.add("test");
	if (/error TS\d+:/.test(strippedText) || /^\s*\d+:\d+\s+(error|warning)\b/m.test(strippedText)) classes.add("diagnostics");
	if (/npm ERR!|ERESOLVE|added \d+ packages/.test(strippedText)) classes.add("install");
	return classes.size > 0 ? [...classes] : ["generic"];
}

/** `CLASS_PRIORITY` filtered down to the classes that actually matched, in fixed priority order —
 *  this IS the tier-number assignment: `tierOrder[0]` is tier 1, `tierOrder[1]` is tier 2, etc. */
function tierOrderFor(classes: ReduceClass[]): ReduceClass[] {
	return CLASS_PRIORITY.filter((c) => classes.includes(c));
}

/** First-match tier per line: 0 = CRITICAL (checked first, always), 1..n = `tierOrder` position,
 *  `undefined` = untagged (falls to the final head/tail mop-up over whatever budget remains). */
function tagLines(lines: string[], tierOrder: ReduceClass[]): (number | undefined)[] {
	return lines.map((line) => {
		for (const p of CRITICAL_PATTERNS) if (p.test(line)) return 0;
		for (let i = 0; i < tierOrder.length; i++) {
			const cls = tierOrder[i] as Exclude<ReduceClass, "generic">;
			for (const p of CLASS_PATTERNS[cls]) if (p.test(line)) return i + 1;
		}
		return undefined;
	});
}

/**
 * Reconstruct in ORIGINAL document order from a set of admitted ORIGINAL line indices: admitted
 * lines appear verbatim, and each maximal run of non-admitted lines collapses to one
 * `[N lines omitted]` marker (counted against the budget by every caller BEFORE committing to a
 * candidate — the "marker cost counted during fill" the red team flagged as missing in the
 * noisegate original). Gap sizes come from ORIGINAL index arithmetic against `totalLines`, never
 * from scanning the full document — this is both the perf bound (O(|admitted| log |admitted|) per
 * call, independent of document size) and what keeps the omitted counts HONEST when the fill
 * machinery pre-collapses candidates (below): a line that was never even a candidate is simply
 * part of the gap between its admitted neighbors, counted exactly once.
 */
function reconstruct(lines: string[], admitted: ReadonlySet<number>, totalLines: number): string {
	const marker = (n: number) => `[${n} line${n === 1 ? "" : "s"} omitted]`;
	const sorted = [...admitted].sort((a, b) => a - b);
	const out: string[] = [];
	let prev = 0;
	for (const i of sorted) {
		if (i > prev) out.push(marker(i - prev));
		out.push(lines[i] ?? "");
		prev = i + 1;
	}
	if (totalLines > prev) out.push(marker(totalLines - prev));
	return out.join("\n");
}

/** Head/tail pre-collapse of a candidate index list: past `cap` entries, only the first and last
 *  `cap/2` survive as CANDIDATES for admission trials (conclusions live at both ends — same
 *  rationale as headTail). Dropped middle indices are never admitted, so `reconstruct`'s original-
 *  index gap arithmetic counts them in the omitted runs automatically — no separate bookkeeping.
 *  This is the work bound for pathological inputs (a 50k-line tsc dump where EVERY line matches
 *  `error TS` would otherwise trial all 50k lines inside the executor's gate semaphore). */
function headTailCap(indices: number[], cap: number): number[] {
	if (indices.length <= cap) return indices;
	const head = Math.ceil(cap / 2);
	return [...indices.slice(0, head), ...indices.slice(indices.length - (cap - head))];
}

/** Trial-admission candidates per tier group (and for the untagged mop-up). With realistic budgets
 *  (≤ ~4096 chars) the admitted set saturates after tens of lines, so 1000 candidates is already
 *  far past what any budget can admit — the cap only ever bites adversarially large inputs. */
const MAX_GROUP_CANDIDATES = 1000;

/** Consecutive failed admission trials before `headTailSelectWithinGroup` stops early. Once the
 *  budget is saturated nearly every further trial fails (only a rare shorter line could still
 *  squeeze in); 32 misses in a row is decisive without giving up on ordinary mixed-length docs. */
const MAX_CONSECUTIVE_MISSES = 32;

/**
 * Head/tail-select from `group` (a tier's candidate indices, document order) into `base`'s admitted
 * set, one candidate at a time from each end, keeping whatever fits within `budget` and skipping
 * what doesn't (never bisects — a candidate is either the WHOLE line or absent). Used both when a
 * single tier overflows the remaining budget (select within just that tier, stop admitting anything
 * lower) and for the final untagged mop-up pass. Stops early after `MAX_CONSECUTIVE_MISSES` failed
 * trials in a row — with the budget saturated, walking the rest of a large group would be O(group)
 * further reconstruct calls for near-zero admissions.
 */
function headTailSelectWithinGroup(lines: string[], base: ReadonlySet<number>, group: number[], budget: number, totalLines: number): Set<number> {
	const admitted = new Set(base);
	let lo = 0;
	let hi = group.length - 1;
	let misses = 0;
	const trialAdmit = (idx: number | undefined): void => {
		if (idx === undefined || admitted.has(idx)) return;
		const trial = new Set(admitted);
		trial.add(idx);
		if (reconstruct(lines, trial, totalLines).length <= budget) {
			admitted.add(idx);
			misses = 0;
		} else {
			misses++;
		}
	};
	while (lo <= hi && misses < MAX_CONSECUTIVE_MISSES) {
		trialAdmit(group[lo]);
		lo++;
		if (lo > hi || misses >= MAX_CONSECUTIVE_MISSES) break;
		trialAdmit(group[hi]);
		hi--;
	}
	return admitted;
}

/** Fill tiers ascending (0 = CRITICAL first), document order within a tier. Whichever tier first
 *  GENUINELY overflows the remaining budget gets head/tail-selected WITHIN ITSELF and fill stops
 *  there — no lower-priority tier is ever considered once one has overflowed. A tier that was
 *  pre-capped to `MAX_GROUP_CANDIDATES` (see `headTailCap`) but whose capped subset still fits the
 *  budget WHOLE does not count as an overflow — it admits and fill continues to lower tiers/mop-up,
 *  same as any other tier that fit. If every matched tier fits whole, whatever budget remains is
 *  finally split head/tail across the untagged lines. Every group is pre-collapsed to
 *  `MAX_GROUP_CANDIDATES` candidates first so total work is bounded regardless of document size. */
function fillTiers(lines: string[], tierGroups: number[][], untaggedIndices: number[], budget: number, totalLines: number): { admitted: Set<number>; tooSmall: boolean } {
	let admitted = new Set<number>();
	if (reconstruct(lines, admitted, totalLines).length > budget) {
		// Even "everything omitted" (one marker line) doesn't fit — budget is too small for this
		// document's line count to represent via markers at all; caller must use headTail instead.
		return { admitted, tooSmall: true };
	}
	let stopped = false;
	for (const rawGroup of tierGroups) {
		if (stopped || rawGroup.length === 0) continue;
		const group = headTailCap(rawGroup, MAX_GROUP_CANDIDATES);
		const candidate = new Set(admitted);
		for (const idx of group) candidate.add(idx);
		if (reconstruct(lines, candidate, totalLines).length <= budget) {
			// The capped subset fit WHOLE. A capped group (`group.length < rawGroup.length`) did drop its
			// unrepresented middle indices — those are gone regardless — but fitting whole is not an
			// overflow: only the `else` branch below (genuine overflow, requiring within-group head/tail
			// selection) stops fill early. A capped-but-fitting group must still let lower tiers and the
			// untagged mop-up use whatever budget remains, or the budget goes needlessly under-filled.
			admitted = candidate;
		} else {
			admitted = headTailSelectWithinGroup(lines, admitted, group, budget, totalLines);
			stopped = true;
		}
	}
	if (!stopped && untaggedIndices.length > 0) {
		admitted = headTailSelectWithinGroup(lines, admitted, headTailCap(untaggedIndices, MAX_GROUP_CANDIDATES), budget, totalLines);
	}
	return { admitted, tooSmall: false };
}

/** Count how many of the tier-matched (CRITICAL or class-tier) lines survived, verbatim, into
 *  `finalText` — used for `CompactionDecision.preservedLines` across every reason (fit trivially
 *  preserves all of them; fallback paths still get an honest count of what happened to survive the
 *  char-level cut). */
function countPreserved(taggedIndices: ReadonlySet<number>, lines: string[], finalText: string): number {
	if (taggedIndices.size === 0) return 0;
	const finalLineSet = new Set(finalText.split("\n"));
	let n = 0;
	for (const idx of taggedIndices) {
		const line = lines[idx];
		if (line !== undefined && finalLineSet.has(line)) n++;
	}
	return n;
}

/** `command` (and nothing else — `agentId`/`source`/`path` stay wrapper-only, populated by
 *  `reduceOutput`) is threaded through so EVERY logged decision, including `classifyAndReduce`'s own
 *  sync-path records, carries the command that produced it — previously only `reduceOutput`'s
 *  separately-enriched record had it. */
function decisionFor(text: string, reason: ReduceReason, classes: ReduceClass[], originalChars: number, taggedIndices: ReadonlySet<number>, lines: string[], command?: string): CompactionDecision {
	return {
		ts: Date.now(),
		class: classes[0] ?? "generic",
		classes,
		reason,
		originalChars,
		charsSaved: originalChars - text.length,
		preservedLines: countPreserved(taggedIndices, lines, text),
		command,
	};
}

/**
 * `headTail`, further clamped to `budget`. `headTail` (gate-logs.ts) is untouched by this concern
 * (no behavior change) and has its own quirk at the extreme: its fixed `"\n…\n"` separator (3 chars)
 * is NOT itself budget-aware, so for `0 < budget < 3` it returns exactly 3 chars — over budget. This
 * module's hard invariant (every path `<= budget`, red-team arbitration) has no such carve-out, so
 * every fallback site here clamps headTail's result down to `budget` rather than special-casing tiny
 * budgets inline at each call site.
 */
function boundedHeadTail(text: string, budget: number): string {
	const t = headTail(text, budget);
	return t.length <= budget ? t : t.slice(0, Math.max(0, budget));
}

/**
 * Pure sync reducer core — NO I/O, NEVER throws. Step 0 is always `stripAnsi` (bun colorizes even
 * piped output when `FORCE_COLOR` is set in the environment — plain-mode and ANSI-mode both need
 * their OWN preserve-pattern matches, so stripping first means one pattern set covers both). Input
 * lines that already look like our own omission grammar are neutralized (`> ` prefix) before
 * tier-tagging or reconstruction, so a forged/pre-existing marker can never inherit CRITICAL-tier
 * priority or be mistaken for a pointer this call generated.
 *
 * Result is ALWAYS `<= budget` chars: the fit check, the tier fill, the "no real gain over
 * headTail" check, the too-small-for-markers check, and the outer catch all resolve to
 * `headTail(text, budget)` rather than ever returning something over budget.
 */
function computeReduction(text: string, budget: number, opts: { command?: string } = {}): { text: string; decision: CompactionDecision } {
	const originalChars = text.length;
	try {
		const strippedRaw = stripAnsi(text);
		const rawLines = strippedRaw.split("\n");
		const lines = rawLines.map((l) => (OMISSION_POINTER_RE.test(l) ? `> ${l}` : l));
		const matchedClasses = classifyCommand(opts.command, strippedRaw);
		const workingText = lines.join("\n");

		if (workingText.length <= budget) {
			// Fit: nothing needs cutting. Still tag lines so preservedLines honestly reports "all of them".
			const tierOrder = tierOrderFor(matchedClasses);
			const tiersOf = tagLines(lines, tierOrder);
			const taggedIndices = new Set<number>();
			tiersOf.forEach((t, i) => {
				if (t !== undefined) taggedIndices.add(i);
			});
			return { text: workingText, decision: decisionFor(workingText, "fit", matchedClasses, originalChars, taggedIndices, lines, opts.command) };
		}

		const tierOrder = tierOrderFor(matchedClasses);
		const tiersOf = tagLines(lines, tierOrder);
		const taggedIndices = new Set<number>();
		const untaggedIndices: number[] = [];
		const tierGroups: number[][] = Array.from({ length: tierOrder.length + 1 }, () => []);
		tiersOf.forEach((t, i) => {
			if (t === undefined) {
				untaggedIndices.push(i);
			} else {
				taggedIndices.add(i);
				tierGroups[t]?.push(i);
			}
		});

		if (taggedIndices.size === 0) {
			// Zero priority lines matched anywhere — the tiered machinery degenerates to exactly the
			// untagged head/tail split, which is no better than the simpler, well-tested headTail. Prefer it.
			const fallback = boundedHeadTail(workingText, budget);
			return { text: fallback, decision: decisionFor(fallback, "headtail-fallback", matchedClasses, originalChars, taggedIndices, lines, opts.command) };
		}

		const { admitted, tooSmall } = fillTiers(lines, tierGroups, untaggedIndices, budget, lines.length);
		if (tooSmall) {
			const fallback = boundedHeadTail(workingText, budget);
			return { text: fallback, decision: decisionFor(fallback, "headtail-fallback", matchedClasses, originalChars, taggedIndices, lines, opts.command) };
		}

		const tierText = reconstruct(lines, admitted, lines.length);
		let admittedTaggedCount = 0;
		for (const idx of taggedIndices) if (admitted.has(idx)) admittedTaggedCount++;
		if (admittedTaggedCount === 0) {
			// Degenerate: tagged lines EXIST but every one of them was too costly to admit even alone
			// (e.g. a single overlong CRITICAL line blew the whole remaining budget) — the tiered result
			// carries zero signal, so it's no better than the simpler, well-tested headTail. Prefer it.
			//
			// The stale alternative this replaced — discarding tierText whenever it wasn't STRICTLY
			// shorter than headTailText — was wrong: headTail routinely returns EXACTLY `budget` chars,
			// and once the untagged mop-up saturates the budget tierText ALSO lands at exactly `budget`
			// chars, so the two compare equal (not "tierText bought nothing") even though tierText is the
			// one carrying the actual tagged failure lines headTail would otherwise have blindly cut.
			// Preferring tierText whenever at least one tagged line survived into it is the correct test —
			// length parity with headTail is not evidence of "no gain".
			const headTailText = boundedHeadTail(workingText, budget);
			return { text: headTailText, decision: decisionFor(headTailText, "headtail-fallback", matchedClasses, originalChars, taggedIndices, lines, opts.command) };
		}
		return { text: tierText, decision: decisionFor(tierText, "reduced", matchedClasses, originalChars, taggedIndices, lines, opts.command) };
	} catch {
		const fallback = boundedHeadTail(text, budget);
		return { text: fallback, decision: decisionFor(fallback, "error", ["generic"], originalChars, new Set(), [], opts.command) };
	}
}

let compactionLogRoot: string | undefined;
let compactionLog: JsonlLog<CompactionDecision> | undefined;
let compactionLogFilePath: string | undefined;

/** Manager/org state root owns the compaction decision log (mirrors `setGateLogRoot` — called
 *  beside it in `SquadManager`'s constructor). Deliberately NOT resolved at module scope: a
 *  module-scope `resolveStateDir()` call would freeze the wrong root for multi-tenant DB mode,
 *  where each org's manager has its own `stateDir` decided only at construction time. */
export function setCompactionLogRoot(stateDir: string): void {
	compactionLogRoot = path.join(stateDir, "compaction.jsonl");
}

/** Lazy singleton, created on first use — and RE-CREATED (re-pointed) whenever the resolved path has
 *  changed since the cached instance was built, so a `setCompactionLogRoot` call after first use (or
 *  a test switching state dirs) doesn't silently keep writing to the old file. */
function getCompactionLog(): JsonlLog<CompactionDecision> {
	const target = compactionLogRoot ?? path.join(resolveStateDir(), "compaction.jsonl");
	if (!compactionLog || compactionLogFilePath !== target) {
		compactionLog = new JsonlLog<CompactionDecision>({ path: target, maxBytes: 8_000_000 });
		compactionLogFilePath = target;
	}
	return compactionLog;
}

/** Ring tail (bounded recent-history, not a forensic archive — see DESIGN.md). */
export function recentCompactionDecisions(limit?: number): CompactionDecision[] {
	return getCompactionLog().recent(limit);
}

/**
 * Public sync entry point — runs the core AND logs the decision itself (sync fire-and-forget
 * `JsonlLog.append`), EXCEPT `reason: "fit"` is never logged (a no-op decided nothing, mirrors
 * `budgetedExcerpt`'s own "small input ⇒ no write at all" precedent). `reduceOutput` below calls
 * `computeReduction` directly instead of this function, so its own enriched (with `path`)
 * record is the only one written per event — never two.
 */
export function classifyAndReduce(text: string, budget: number, opts: { command?: string } = {}): { text: string; decision: CompactionDecision } {
	const result = computeReduction(text, budget, opts);
	if (result.decision.reason !== "fit") {
		try {
			getCompactionLog().append(result.decision);
		} catch {
			/* best-effort — a decision-log failure must never affect the returned text */
		}
	}
	return result;
}

/**
 * Async offload wrapper around the sync core — NEVER throws. When the core (run once at the FULL
 * caller budget) reports `reason: "fit"`, nothing further happens: no offload, no pointer, no log
 * (mirrors `budgetedExcerpt`'s free pass-through for small input). Otherwise the FULL original is
 * durably offloaded FIRST via `writeGateLog` (gate-logs.ts — not duplicated here), the exact
 * pointer line is built from the returned path/bytes, and the core is re-run at
 * `budget − pointerLine.length − 1` (the `− 1` is the joining newline) so body+pointer together are
 * EXACTLY within the caller's budget — no reserve guess (a fixed reserve either wastes body budget
 * or, worse, under-reserves for a long stateDir/agentId path and blows the caller's cap at small
 * budgets). Exactly ONE enriched decision (carrying the offload `path`) is logged per event. An
 * offload failure degrades to the probe's full-budget core text with no pointer (no third core
 * run — the probe IS that result) rather than throwing — a throw here would fail-CLOSE a
 * land/steer path (RT1-5). Worst case exactly two core runs: the probe and the pointer-budgeted body.
 */
export async function reduceOutput(text: string, budget: number, opts: { command?: string; agentId?: string; source: string }): Promise<{ text: string; decision: CompactionDecision }> {
	const originalChars = text.length;
	const probe = computeReduction(text, budget, opts);
	if (probe.decision.reason === "fit") {
		return { text: probe.text, decision: probe.decision };
	}

	// Degradation default: the probe already IS "the core at the full budget, no pointer".
	let finalText = probe.text;
	let finalDecision: CompactionDecision = {
		...probe.decision,
		originalChars,
		charsSaved: originalChars - probe.text.length,
		command: opts.command,
		agentId: opts.agentId,
		source: opts.source,
	};

	try {
		const { path: fullPath, bytes } = await writeGateLog(opts.agentId ?? "unknown", opts.source, text);
		const pointer = `[${bytes} bytes omitted — full: ${fullPath}]`;
		if (pointer.length + 1 <= budget) {
			const core = computeReduction(text, budget - pointer.length - 1, opts);
			finalText = `${core.text}\n${pointer}`;
			finalDecision = { ...core.decision, originalChars, charsSaved: originalChars - finalText.length, command: opts.command, agentId: opts.agentId, source: opts.source, path: fullPath };
		} else {
			// The budget cannot even hold the pointer line — keep the full-budget body, no pointer
			// (the offload file still exists and is findable via the decision log's `path`).
			finalDecision = { ...finalDecision, path: fullPath };
		}
	} catch {
		// Offload failed — degrade to the probe's bounded text, no pointer (never throws).
	}

	try {
		getCompactionLog().append(finalDecision);
	} catch {
		/* best-effort — a decision-log failure must never affect the returned text */
	}

	return { text: finalText, decision: finalDecision };
}

/**
 * Strip everything that varies run-to-run without the underlying failure actually changing, so two
 * runs of the SAME logical failure hash/compare identically: ANSI, our own NONCE-CARRYING offload
 * pointer lines (a fresh `writeGateLog` call mints a unique ts+nonce path EVERY reduction, so a raw
 * pointer line would make an otherwise-identical failure compare different on every single visit —
 * red-team RT2-1, "pointer nonce poisons identity detectors"), and bun's per-test duration suffix
 * (`[0.23ms]`) which jitters run to run for the SAME test.
 *
 * Deliberately does NOT strip `[N lines? omitted]` GAP markers — only `OFFLOAD_POINTER_RE`'s
 * nonce-carrying `— full:` pointer lines are dropped. Gap counts are real signal: two DIFFERENT
 * failures whose reductions differ only by how many lines got cut (`[12 lines omitted]` vs
 * `[7 lines omitted]`) must NOT compare equal, or the no-progress detector falsely aborts a
 * converging fixup loop by mistaking two distinct failures for the same one.
 *
 * Exported for concern 03's `noProgressRoute`/`hashOutput` identity checks — this module does not
 * call it itself.
 */
export function identityNormalize(text: string): string {
	const stripped = stripAnsi(text);
	return stripped
		.split("\n")
		// Drop ONLY offload-pointer lines (both raw and `> `-neutralized form — concern 04's persistence
		// pass neutralizes even on the fit path, so a cold-resume-restored lastOutput differs from a
		// fresh run's ONLY by that prefix; without stripping it too, the first refutation check after
		// every daemon restart would miss once and waste one reflect() LLM call). Gap markers pass
		// through untouched — their counts are kept as real signal (see doc comment above).
		.filter((line) => !OFFLOAD_POINTER_RE.test(line))
		.join("\n")
		.replace(/\[\d+(\.\d+)?ms\]/g, "");
}

/**
 * In-code cross-lineage gauntlet panel (T5, glance#333) — the daemon's own version of the blind
 * cross-lineage review this campaign has been running BY HAND (`.claude/skills/blind-review/SKILL.md`).
 * `landBranch` (via `validator.ts`'s `validatorGate`) spawns this panel for a diff whose risk tier
 * warrants it, records each verdict to the reviewer ledger, and attaches the outcome to the land's
 * `ValidationRecord` — visibility, NOT a new merge-blocking authority (see `runReviewPanel`'s doc).
 *
 * BLIND, per the skill's protocol: each reviewer gets ONLY the diff + the system's invariants stated as
 * PROPERTIES — never the builder's notes/commits, never what the criteria judge decided, never another
 * panel reviewer's verdict. Reviewers run independently (no shared prompt state), so there is structurally
 * nothing to leak between them.
 *
 * Scope (this ticket): panel spawning + recording + receipt-carry ONLY. Rendering the outcome in the
 * webapp is T6 (webapp/src/lib/dto.ts's `PanelVerdictDTO` mirror is prepared here so T6 has a stable
 * shape to render, but no UI ships in this change).
 */

import { errText } from "../err-text.ts";
import { envBool, envInt } from "../config.ts";
import { appendReviewerLedgerEntry, type ReviewerLedgerEntry } from "../memory/index.ts";
import { changedFilesFromDiff, selectLenses } from "../lens-select.ts";
import { decideTyped, extractJsonObject } from "../omp-call.ts";
import { type ModelLineage } from "../model-lineage.ts";
import { truncate } from "../text-util.ts";
import { maxDiffFiles, RISKY_PATH_RE } from "./land-risk.ts";

const CLAIM_MAX = 600;

/** OFF by default (rollout safety, mirrors `lensReviewEnabled`/`landRiskGateEnabled`) — an operator
 *  opts in once the panel's cost profile is understood on their fleet. */
export function reviewPanelEnabled(): boolean {
	return envBool("OMP_SQUAD_REVIEW_PANEL", false);
}

/** Hard cap on reviewers spawned per land (cost/safety) — also the upper bound on how many DISTINCT
 *  lineages the default reviewer pool draws from. `<= 1` disables the panel: a "panel" of one reviewer
 *  is not a cross-lineage panel, and the whole point is DISTINCT lineages corroborating or contradicting
 *  each other. */
export function panelMax(): number {
	return envInt("OMP_SQUAD_REVIEW_PANEL_MAX", 2);
}

/** Per-reviewer bound (and per-recheck bound) — a hung reviewer must never wedge a land. Applied BOTH as
 *  the subprocess's own `AbortSignal.timeout` (real CLI-backed reviewers, via `decideTyped`) AND as an
 *  outer `Promise.race` in `runOnePanelReviewer` (defense in depth: a fake/injected reviewer, or any
 *  future reviewer implementation that doesn't itself respect a spawn timeout, still can't block the
 *  panel — its promise is simply abandoned, never awaited past the bound). */
export function panelTimeoutMs(): number {
	return envInt("OMP_SQUAD_REVIEW_PANEL_TIMEOUT_MS", 120_000);
}

/** The minimum number of DISTINCT lineages required to run a panel at all — below this there is no
 *  cross-lineage corroboration to gain, so the panel simply does not fire (never a fabricated "panel of
 *  one"). */
const MIN_PANEL_LINEAGES = 2;

export type PanelReviewerVerdict = "accept" | "object" | "timeout" | "error";

/**
 * One panel reviewer's outcome, attached to the land's `ValidationRecord.panel` (T6 renders this; this
 * ticket only produces + records it). `survived` is present ONLY when a high-severity objection was
 * independently rechecked (mirrors `validator.ts`'s `lensVerify` re-check discipline) — never a fabricated
 * true/false for an objection nobody adjudicated. A `timeout`/`error` verdict carries neither `severity`
 * nor `claim`: there is no finding to report, only an honest "this reviewer did not answer".
 */
export interface PanelVerdict {
	lineage: ModelLineage;
	/** The CLI/harness that actually ran this reviewer (e.g. "grok", "codex", "omp", or a fixture tag
	 *  in tests) — distinct from `lineage` the same way `ValidationRecord.model` is distinct from
	 *  `reviewerLineage` elsewhere in this codebase. */
	harness: string;
	verdict: PanelReviewerVerdict;
	severity?: "low" | "high";
	/** One-line reason for an objection; truncated (~600 chars). Present only when `verdict === "object"`. */
	claim?: string;
	/** Kebab-case concern tag for the reviewer-ledger row (e.g. "fail-open", "permanent-wedge",
	 *  "toctou") — present only alongside `claim`. Falls back to a generic tag when a reviewer doesn't
	 *  supply one. */
	concernClass?: string;
	/** `true`/`false` only when a high-severity objection was independently rechecked and confirmed/
	 *  refuted; absent when no recheck ran (a low-severity objection, or `verdict` isn't `"object"`). */
	survived?: boolean;
	ranAt: number;
}

/** Injected reviewer seam — tests pass a fake; production wires `defaultPanelReviewers()`. Never throws
 *  by contract: a throw is caught by `runOnePanelReviewer` and treated as `"error"`, mirroring `Judge`/
 *  `LensJudge`'s fail-open discipline. `undefined` ⇒ no usable signal (also treated as `"error"`). */
export type PanelReviewer = (input: { diff: string; invariants: string }) => Promise<{ disposition: "accept" | "object"; severity?: "low" | "high"; claim?: string; concernClass?: string } | undefined>;

export interface PanelReviewerSpec {
	lineage: ModelLineage;
	harness: string;
	review: PanelReviewer;
}

/** Injected recheck seam — mirrors `validator.ts`'s `LensVerifyJudge`. `true` = confirmed, `false` =
 *  refuted, `undefined` = couldn't determine (treated as NOT confirmed — an unreachable recheck must
 *  never escalate a finding it couldn't verify). */
export type PanelVerifyReviewer = (input: { lineage: ModelLineage; claim: string; diff: string }) => Promise<boolean | undefined>;

/**
 * The system invariants every panel reviewer is handed, stated as PROPERTIES the land gate must uphold —
 * never a description of what any particular diff is trying to do (blind-review doctrine: "the invariants
 * the system must hold, stated as properties, not as a description of the change"). Reused verbatim for
 * every lineage so no reviewer gets a framing edge over another.
 */
export const PANEL_INVARIANTS =
	"This diff is part of a daemon that autonomously merges agent-written code onto a shared main branch, unattended. " +
	"The land gate that governs this must hold these properties at all times:\n" +
	"1. No NEW fail-open: a gate must never come to allow through what it used to block.\n" +
	"2. No NEW permanent wedge: a refusal must always have a bounded, escalating retry path — it must never be able to get stuck forever with no way out.\n" +
	"3. No TOCTOU: a check and the action it guards must not race against a concurrent state change.\n" +
	"4. A legitimate case must never be falsely refused, and a genuinely bad case must never be able to slip through silently.\n" +
	"5. A new or changed gate deserves the scrutiny of the failure mode it replaces — ask what the change OPENED, not only whether it closed the hole it targeted.";

const PANEL_SYSTEM_PROMPT =
	"You are ONE independent, adversarial reviewer on a blind panel. You have NOT been told what this diff is trying to " +
	"do, what any other reviewer found, or whether anyone else has already reviewed it — form your own judgment from the " +
	"diff and the invariants alone. Hunt for a violation of the stated invariants, with concrete file:line evidence and a " +
	"failure scenario. If you find nothing, say so plainly — do not manufacture a finding to look useful. " +
	'Respond with EXACTLY one JSON object and nothing else: {"disposition":"accept"|"object","severity":"low"|"high",' +
	'"claim":"<one-line finding with file:line evidence; empty string if accept>","concernClass":"<kebab-case tag, e.g. fail-open, permanent-wedge, toctou, false-refusal>"}.';

const PANEL_VERIFY_SYSTEM =
	"You are re-checking ONE specific concern another reviewer raised about a code diff. Decide only whether that " +
	'concern is substantiated by the diff itself. Respond with EXACTLY one JSON object: {"verdict":"confirmed"|"refuted"|"inconclusive"}.';

interface PanelRawVerdict {
	disposition: "accept" | "object";
	severity?: "low" | "high";
	claim?: string;
	concernClass?: string;
}

function coercePanelVerdict(obj: Record<string, unknown> | undefined): PanelRawVerdict | undefined {
	if (!obj) return undefined;
	const disposition = obj.disposition === "object" ? "object" : obj.disposition === "accept" ? "accept" : undefined;
	if (!disposition) return undefined;
	const severity = obj.severity === "high" ? "high" : obj.severity === "low" ? "low" : undefined;
	const claim = typeof obj.claim === "string" ? truncate(obj.claim, CLAIM_MAX) : undefined;
	const concernClass = typeof obj.concernClass === "string" && obj.concernClass.trim() ? obj.concernClass.trim() : undefined;
	return { disposition, severity, claim, concernClass };
}

/** Best-effort dig for the assistant text in a codex event object — same shape as `validator.ts`'s
 *  private `pickCodexText`, duplicated (not imported) to avoid a `validator.ts` <-> `rail/` import cycle
 *  (`validator.ts` imports this module via the rail barrel to CALL the panel). */
function pickCodexText(obj: Record<string, unknown>): string | undefined {
	const payload = (obj.payload ?? {}) as Record<string, unknown>;
	const item = (obj.item ?? {}) as Record<string, unknown>;
	for (const v of [payload.message, payload.text, obj.message, obj.text, item.text]) {
		if (typeof v === "string" && v.includes("{")) return v;
	}
	return undefined;
}

/** Plain single-object stdout (the `omp -p` case — no event framing). */
function parsePanelVerdictPlain(raw: string): PanelRawVerdict | undefined {
	return coercePanelVerdict(extractJsonObject(raw));
}

/** codex may emit a JSONL event stream — same stream-tolerant strategy as `validator.ts`'s
 *  `parseCodexVerdict` (line-by-line, last usable line wins; falls back to a whole-blob extract). */
function parsePanelVerdictCodex(raw: string): PanelRawVerdict | undefined {
	let found: PanelRawVerdict | undefined;
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t.startsWith("{")) continue;
		let obj: Record<string, unknown> | undefined;
		try {
			const parsed: unknown = JSON.parse(t);
			obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
		} catch {
			continue;
		}
		if (!obj) continue;
		const direct = coercePanelVerdict(obj);
		if (direct) {
			found = direct;
			continue;
		}
		const text = pickCodexText(obj);
		if (text) {
			const embedded = coercePanelVerdict(extractJsonObject(text));
			if (embedded) found = embedded;
		}
	}
	return found ?? parsePanelVerdictPlain(raw);
}

/** grok's `--json-schema` envelope: `{ "text": "<json string>", "structuredOutput": {…}, … }` — same
 *  strategy as `validator.ts`'s `parseGrokVerdict`. */
function parsePanelVerdictGrok(raw: string): PanelRawVerdict | undefined {
	const envelope = extractJsonObject(raw);
	if (envelope) {
		const structured = envelope.structuredOutput;
		if (structured && typeof structured === "object") {
			const direct = coercePanelVerdict(structured as Record<string, unknown>);
			if (direct) return direct;
		}
		if (typeof envelope.text === "string") {
			const embedded = coercePanelVerdict(extractJsonObject(envelope.text));
			if (embedded) return embedded;
		}
		const asVerdict = coercePanelVerdict(envelope);
		if (asVerdict) return asVerdict;
	}
	return undefined;
}

function parseVerifyConfirmed(raw: string): boolean | undefined {
	try {
		const v = extractJsonObject(raw)?.verdict;
		if (v === "confirmed") return true;
		if (v === "refuted" || v === "inconclusive") return false;
		return undefined;
	} catch {
		return undefined;
	}
}

const PANEL_VERDICT_SCHEMA = JSON.stringify({
	type: "object",
	properties: {
		disposition: { type: "string", enum: ["accept", "object"] },
		severity: { type: "string", enum: ["low", "high"] },
		claim: { type: "string" },
		concernClass: { type: "string" },
	},
	required: ["disposition"],
});

/** omp (native, Anthropic-lineage) reviewer — an independent one-shot `omp -p` call. */
function ompPanelReviewer(): PanelReviewer {
	return async ({ diff, invariants }) =>
		decideTyped<PanelRawVerdict | undefined>({
			args: ["-p", "--system-prompt", `${PANEL_SYSTEM_PROMPT}\n\n${invariants}`, `Diff:\n${diff}`],
			parse: parsePanelVerdictPlain,
			fallback: undefined,
			timeoutMs: panelTimeoutMs(),
		});
}

/** codex (OpenAI-lineage) reviewer via `codex exec -s read-only` — sandboxed, never edits the tree it
 *  is reviewing. */
function codexPanelReviewer(): PanelReviewer {
	return async ({ diff, invariants }) =>
		decideTyped<PanelRawVerdict | undefined>({
			bin: "codex",
			args: ["exec", "-s", "read-only", `${PANEL_SYSTEM_PROMPT}\n\n${invariants}\n\nDiff:\n${diff}`],
			parse: parsePanelVerdictCodex,
			fallback: undefined,
			timeoutMs: panelTimeoutMs(),
		});
}

/** grok (xAI-lineage) reviewer via the grok CLI — read-only sandbox, no web search, `--json-schema`
 *  constrains the model to the verdict shape (machine-parseable by construction). Stdin closed: grok is
 *  an agentic CLI and would otherwise wait on a TTY. */
function grokPanelReviewer(): PanelReviewer {
	return async ({ diff, invariants }) =>
		decideTyped<PanelRawVerdict | undefined>({
			bin: "grok",
			args: [
				"-p",
				`${PANEL_SYSTEM_PROMPT}\n\n${invariants}\n\nDiff:\n${diff}`,
				"--sandbox",
				"read-only",
				"--permission-mode",
				"dontAsk",
				"--disable-web-search",
				"--json-schema",
				PANEL_VERDICT_SCHEMA,
			],
			parse: parsePanelVerdictGrok,
			fallback: undefined,
			timeoutMs: panelTimeoutMs(),
		});
}

/** The recheck reviewer for a high-severity objection — always the native omp harness (a recheck is a
 *  narrow, scoped question; it does not need its own cross-lineage diversity, mirroring
 *  `validator.ts`'s `ompLensVerifyJudge`). */
function ompPanelVerifyReviewer(): PanelVerifyReviewer {
	return async ({ claim, diff }) =>
		decideTyped<boolean | undefined>({
			args: ["-p", "--system-prompt", PANEL_VERIFY_SYSTEM, `A reviewer flagged this specific concern about the diff:\n${truncate(claim, CLAIM_MAX)}\n\nDiff:\n${diff}`],
			parse: parseVerifyConfirmed,
			fallback: undefined,
			timeoutMs: panelTimeoutMs(),
		});
}

/** Candidate reviewer pool, foreign lineages preferred first (blind-review doctrine: a foreign lineage
 *  is preferred "precisely because it cannot have read the conversation" — native omp is the fallback
 *  fill, not the first choice). Filtered to binaries actually present (`Bun.which`), so the stamped
 *  lineage can never claim a cross-vendor review that didn't happen — the same discipline
 *  `validator.ts`'s `activeReviewer()` already applies to the single criteria judge. */
export function defaultPanelReviewers(): PanelReviewerSpec[] {
	const candidates: PanelReviewerSpec[] = [];
	if (Bun.which("grok")) candidates.push({ lineage: "xai", harness: "grok", review: grokPanelReviewer() });
	if (Bun.which("codex")) candidates.push({ lineage: "openai", harness: "codex", review: codexPanelReviewer() });
	if (Bun.which("omp")) candidates.push({ lineage: "anthropic", harness: "omp", review: ompPanelReviewer() });
	return candidates;
}

export function defaultPanelVerifyReviewer(): PanelVerifyReviewer {
	return ompPanelVerifyReviewer();
}

/**
 * Reuses `land-risk.ts`'s OWN signal (sensitive paths / blast-radius file count) — deliberately the
 * SIGNAL, not the blocking gate (`landRiskGateEnabled`/`landRiskReason` stay untouched, off by default,
 * and still the sole blocking authority). Computed from the SAME diff text the criteria judge already
 * scored (`changedFilesFromDiff`), so this never pays for a second git shell-out. Docs-only diffs never
 * warrant a panel regardless of file count — enforced by the caller via `selectLenses`'s own [] decision
 * (reused, not re-implemented, so the two "is there real code here" answers can never drift apart).
 */
export function diffRiskTier(diff: string): { warrants: boolean; sensitivePaths: string[]; fileCount: number; cap: number } {
	const files = changedFilesFromDiff(diff);
	const sensitivePaths = files.filter((f) => RISKY_PATH_RE.test(f));
	const cap = maxDiffFiles();
	return { warrants: sensitivePaths.length > 0 || files.length >= cap, sensitivePaths, fileCount: files.length, cap };
}

/** Bounded wrapper: races `reviewer(...)` against `panelTimeoutMs()`. A losing (hung) reviewer's promise
 *  is simply abandoned — never awaited past the bound — so it can NEVER wedge the land, even if the
 *  underlying implementation ignores its own internal timeout. A thrown/rejected reviewer call and an
 *  `undefined` result both resolve to `"error"` (no usable signal), mirroring `Judge`/`LensJudge`'s
 *  fail-open contract: a reviewer that can't answer contributes nothing, never a fabricated verdict. */
async function runOnePanelReviewer(spec: PanelReviewerSpec, diff: string): Promise<PanelVerdict> {
	const ranAt = Date.now();
	const TIMED_OUT = Symbol("panel-reviewer-timeout");
	let timer: ReturnType<typeof setTimeout> | undefined;
	const bound = new Promise<typeof TIMED_OUT>((resolve) => {
		timer = setTimeout(() => resolve(TIMED_OUT), panelTimeoutMs());
	});
	try {
		const result = await Promise.race([spec.review({ diff, invariants: PANEL_INVARIANTS }).catch(() => undefined), bound]);
		if (result === TIMED_OUT) return { lineage: spec.lineage, harness: spec.harness, verdict: "timeout", ranAt };
		if (!result) return { lineage: spec.lineage, harness: spec.harness, verdict: "error", ranAt };
		if (result.disposition === "accept") return { lineage: spec.lineage, harness: spec.harness, verdict: "accept", ranAt };
		return {
			lineage: spec.lineage,
			harness: spec.harness,
			verdict: "object",
			severity: result.severity ?? "low",
			claim: result.claim ?? "",
			concernClass: result.concernClass ?? "gauntlet-panel-finding",
			ranAt,
		};
	} catch {
		return { lineage: spec.lineage, harness: spec.harness, verdict: "error", ranAt };
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export interface ReviewPanelOpts {
	diff: string;
	/** Traceable `source` for the reviewer-ledger row (e.g. `"land <branch>@<commit>"`). */
	source: string;
	/** Injected reviewer pool (tests pass fakes); `undefined` ⇒ `defaultPanelReviewers()`. */
	reviewers?: () => PanelReviewerSpec[];
	/** Injected recheck reviewer (tests pass a fake); `undefined` ⇒ `defaultPanelVerifyReviewer()`. */
	verify?: () => PanelVerifyReviewer;
	/** Test-only DI hatch (mirrors `ValidatorGateOpts.reviewerLedgerPath`) — never an environment
	 *  variable in production, for the same "no launch-directory `.env` can redirect a trust-critical
	 *  read/write" reason `validator.ts` documents for the precision reader. `undefined` ⇒ the real
	 *  repo-committed ledger. */
	ledgerPath?: string;
}

/**
 * Spawn the blind cross-lineage gauntlet panel for `opts.diff`, IF its risk tier warrants one (see
 * `diffRiskTier`) and the master flag is on. Returns `undefined` when the panel did not fire (master
 * flag off, docs-only diff, tier doesn't warrant it, or fewer than `MIN_PANEL_LINEAGES` distinct-lineage
 * reviewers are available) — never an empty array standing in for "ran and found nothing" vs. "never
 * ran" (those are different facts; T6 needs to tell them apart).
 *
 * PURELY ADDITIVE: this function has no veto/inconclusive authority of its own. It never throws — every
 * fault (a reviewer error, a ledger-write fault) is absorbed here so a panel failure can only ever
 * shrink the reported panel, never break the land it is advisory to (mirrors `validator.ts`'s lens-panel
 * "advisory only" discipline verbatim).
 */
export async function runReviewPanel(opts: ReviewPanelOpts): Promise<PanelVerdict[] | undefined> {
	if (!reviewPanelEnabled()) return undefined;
	try {
		// Docs-only ⇒ no panel, reusing lens-select's OWN "is there real code here" decision (never a
		// re-implemented regex that could quietly drift from it) — `max:1` is a stand-in probe, not a
		// real lens dispatch; an empty result here means "nothing for ANY out-of-criteria reviewer to
		// look at", which applies equally to the criteria-blind gauntlet panel.
		if (selectLenses(opts.diff, { max: 1 }).length === 0) return undefined;
		const tier = diffRiskTier(opts.diff);
		if (!tier.warrants) return undefined;

		const pool = (opts.reviewers ?? defaultPanelReviewers)();
		const seen = new Set<ModelLineage>();
		const selected: PanelReviewerSpec[] = [];
		for (const spec of pool) {
			if (seen.has(spec.lineage)) continue; // distinct lineages only
			seen.add(spec.lineage);
			selected.push(spec);
			if (selected.length >= panelMax()) break;
		}
		if (selected.length < MIN_PANEL_LINEAGES) return undefined; // no real cross-lineage panel possible

		const settled = await Promise.allSettled(selected.map((spec) => runOnePanelReviewer(spec, opts.diff)));
		const verdicts: PanelVerdict[] = settled.map((r, i) =>
			r.status === "fulfilled" ? r.value : { lineage: selected[i].lineage, harness: selected[i].harness, verdict: "error", ranAt: Date.now() },
		);

		// High-severity objections get ONE independent recheck each (bounded — at most `panelMax()` of
		// them, since the panel itself is capped) — mirrors `validator.ts`'s `runLensVerify` discipline:
		// a recheck decides `survived`, but a `confirmed:true` NEVER escalates beyond recording it; it
		// still never vetoes (the land gate's own veto path is untouched by this module entirely).
		const verify = (opts.verify ?? defaultPanelVerifyReviewer)();
		for (let i = 0; i < verdicts.length; i++) {
			const v = verdicts[i];
			if (v.verdict !== "object" || v.severity !== "high" || !v.claim) continue;
			try {
				const confirmed = await verify({ lineage: v.lineage, claim: v.claim, diff: opts.diff });
				verdicts[i] = { ...v, survived: confirmed === true };
			} catch {
				// an unreachable recheck must never escalate — leave `survived` unset (not yet adjudicated)
			}
		}

		// Record every ADJUDICATED finding (an "object" verdict whose `survived` was actually determined
		// by the recheck above) to the reviewer ledger — the SAME rows a human runs
		// `reviewer-ledger.ts add` for today. A clean bill ("accept") is NOT a row (the ledger's own
		// honesty rule); an un-rechecked low-severity objection is ALSO not a row — recording an
		// adjudication that never happened would fabricate the exact "survived" measurement this ledger
		// exists to keep honest.
		for (const v of verdicts) {
			if (v.verdict !== "object" || v.survived === undefined) continue;
			const entry: ReviewerLedgerEntry = {
				at: new Date().toISOString().slice(0, 10),
				lineage: v.lineage,
				concernClass: v.concernClass ?? "gauntlet-panel-finding",
				survived: v.survived,
				source: opts.source,
				note: v.claim ?? "",
				severity: v.severity,
			};
			try {
				appendReviewerLedgerEntry(entry, opts.ledgerPath);
			} catch (err) {
				// A ledger-write fault degrades a MEASUREMENT, never a MERGE — the panel result is still
				// returned and still attached to the receipt even if this row didn't make it to disk.
				console.error(`review-panel: failed to append ledger row for ${v.lineage} (non-fatal): ${errText(err)}`);
			}
		}

		return verdicts;
	} catch (err) {
		// The panel is advisory only — an unexpected throw anywhere above must never reach the land path.
		console.error(`review-panel: panel run failed (non-fatal, advisory only): ${errText(err)}`);
		return undefined;
	}
}

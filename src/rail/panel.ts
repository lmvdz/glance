/**
 * In-code cross-lineage gauntlet panel (T5, glance#333) — the daemon's own version of the blind
 * cross-lineage review this campaign has been running BY HAND (`.claude/skills/blind-review/SKILL.md`).
 * `landBranch` (via `validator.ts`'s `validatorGate`) spawns this panel for a diff whose risk tier
 * warrants it, QUEUES each verdict for the reviewer ledger (never writes the tracked ledger file
 * directly — see `panel-ledger.ts`), and attaches the outcome to the land's `ValidationRecord` —
 * visibility, NOT a new merge-blocking authority (see `runReviewPanel`'s doc).
 *
 * BLIND, per the skill's protocol: each reviewer gets ONLY the diff + the system's invariants stated as
 * PROPERTIES — never the builder's notes/commits, never what the criteria judge decided, never another
 * panel reviewer's verdict, and (gauntlet round 1, finding C3) never the daemon's own launch directory
 * either — every reviewer/recheck subprocess runs with an explicit, freshly-scratch, empty `cwd`
 * (`panel-spawn.ts`'s `hermeticCwd`) so an agentic CLI has nothing nearby to explore into.
 *
 * GAUNTLET ROUND 1 (glance#333 PR #353, dual-lineage blind review — codex gpt-5.6-sol + grok-4.5, both
 * converged on the CRITICAL finding, codex added six more, all adjudicated real): this file changed
 * substantially to close them. Summary (full detail on each fix inline at its own site):
 *   A1 (CRITICAL) — the ledger write moved OUT of the land path entirely; see `panel-ledger.ts`'s module
 *       doc for the full story. This file now only QUEUES (`recordPendingPanelFinding`), never appends
 *       to the tracked file.
 *   A5 (HIGH) — an inconclusive/unreachable claim-verification call is a THIRD state, never coerced
 *       into a refutation; only a genuinely confirmed/refuted claim becomes a ledger row.
 *   A7 (MEDIUM) — ledger rows use the SAME canonical lineage tag T4's reader expects (grok/codex/native),
 *       not the raw vendor lineage string, so a finding updates the right lineage's measured history.
 *   B2 (HIGH) — every reviewer AND the claim-verification call is spawned in its own process GROUP and
 *       bounded independently; a timeout kills the whole group and the caller stops awaiting its pipes.
 *   B4 (HIGH) — a process-wide concurrency limiter plus single-flight coalescing (`panel-spawn.ts`,
 *       `inFlightPanels` below) so N concurrent lands of the same proof spawn ONE panel, not N.
 *   C3 (HIGH) — every subprocess runs in a hermetic scratch `cwd` (see the module doc above).
 *   C6 (MEDIUM) — the claim-verification step is honestly named as such (never "independent recheck")
 *       and prefers a DIFFERENT lineage than the objecting reviewer when one is available.
 *
 * Scope (this ticket): panel spawning + recording + receipt-carry ONLY. Rendering the outcome in the
 * webapp is T6 (webapp/src/lib/dto.ts's `PanelVerdictDTO` mirror is prepared here so T6 has a stable
 * shape to render, but no UI ships in this change).
 */

import { envBool, envInt } from "../config.ts";
import { errText } from "../err-text.ts";
import { changedFilesFromDiff, selectLenses } from "../lens-select.ts";
import { extractJsonObject } from "../omp-call.ts";
import { type ModelLineage } from "../model-lineage.ts";
import { recordPendingPanelFinding } from "./panel-ledger.ts";
import { boundedHermeticSpawn, hermeticCwd, removeHermeticCwd } from "./panel-spawn.ts";
import { truncate } from "../text-util.ts";
import type { ReviewerLedgerEntry } from "../memory/index.ts";
import { maxDiffFiles, RISKY_PATH_RE } from "./land-risk.ts";
import { openProjectRegistry } from "../project-registry.ts";

const CLAIM_MAX = 600;

/** OFF by default (rollout safety, mirrors `lensReviewEnabled`/`landRiskGateEnabled`) — an operator
 *  opts in once the panel's cost profile is understood on their fleet. */
export function reviewPanelEnabled(): boolean {
	return envBool("OMP_SQUAD_REVIEW_PANEL", false);
}

/** Hard cap on reviewers spawned per land (cost/safety) — also the upper bound on how many DISTINCT
 *  lineages the default reviewer pool draws from. `<= 1` disables the panel: a "panel" of one reviewer
 *  is not a cross-lineage panel, and the whole point is DISTINCT lineages corroborating or contradicting
 *  each other. Distinct from `panel-spawn.ts`'s `OMP_SQUAD_REVIEW_PANEL_GLOBAL_MAX`, which bounds
 *  concurrent OS processes across the WHOLE daemon, not one panel's own reviewer count. */
export function panelMax(): number {
	return envInt("OMP_SQUAD_REVIEW_PANEL_MAX", 2);
}

/** Per-reviewer bound (and per-claim-verification bound) — a hung reviewer must never wedge a land.
 *  Enforced by `panel-spawn.ts`'s process-GROUP kill (SIGTERM→SIGKILL, B2) for real CLI-backed
 *  reviewers, AND as an outer `Promise.race` here (defense in depth: a fake/injected reviewer, or any
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
 * ticket only produces + records it). `survived` is present ONLY when a high-severity objection's claim
 * was independently VERIFIED — confirmed or refuted (see the module doc's C6 note: this is claim
 * verification, not a second blind review) — never a fabricated true/false for an objection nobody
 * checked, and never coerced from an inconclusive check (A5). A `timeout`/`error` verdict carries
 * neither `severity` nor `claim`: there is no finding to report, only an honest "this reviewer did not
 * answer".
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
	/** `true`/`false` only when a high-severity objection's claim was independently verified and
	 *  confirmed/refuted; absent when no verification ran, OR when it ran but could not determine an
	 *  answer (A5 — an inconclusive check is a THIRD state, never coerced into `false`). */
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

/**
 * Injected claim-verification seam (C6 — deliberately NOT called "recheck"/"independent review" in any
 * doc comment: it is fed the exact claim under test, so it is confirmatory, not a fresh blind pass; see
 * the module doc). `true` = confirmed, `false` = refuted, `undefined` = couldn't determine (A5 — treated
 * as a genuinely unknown third state, never coerced to "refuted").
 */
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

/** C6: explicitly framed to the model as verifying a CLAIM, not conducting a fresh review — the honesty
 *  fix applies to the model-facing prompt too, not just this codebase's own doc comments. */
const PANEL_VERIFY_SYSTEM =
	"You are verifying ONE specific claim another reviewer made about a code diff — you are NOT conducting a fresh " +
	'review of your own. Decide only whether the claim is substantiated by the diff itself. Respond with EXACTLY one ' +
	'JSON object: {"verdict":"confirmed"|"refuted"|"inconclusive"}.';

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

/** The raw `verdict` string a claim-verification call emitted, or `undefined` if `obj` doesn't carry
 *  a string `verdict` field at all — kept SEPARATE from `coerceVerdictString` below (round 2, finding
 *  A5) because "no candidate found in this line yet, keep scanning" and "found a candidate that
 *  legitimately decodes to `undefined` (a genuine `\"inconclusive\"`)" are different facts; conflating
 *  them broke the codex/grok JSONL-stream scan's "last usable line wins" logic. */
function extractVerdictString(obj: Record<string, unknown> | undefined): string | undefined {
	const v = obj?.verdict;
	return typeof v === "string" ? v : undefined;
}

/**
 * A5 (round 2 — the bug lived HERE, in the real parser, not just at the call site): round 1's parser
 * mapped the literal string `"inconclusive"` to `false`, indistinguishable from a genuine `"refuted"` —
 * so a model that faithfully answered "inconclusive" per `PANEL_VERIFY_SYSTEM`'s own contract got
 * queued as a FABRICATED refutation. Round 1's fix only touched the CALL SITE's handling of an
 * injected-fake `undefined`; the real parser's `"inconclusive"` path was never exercised by a test.
 * Fixed here: `"confirmed"` → `true`, `"refuted"` → `false`, EVERYTHING else (`"inconclusive"`, a
 * missing/malformed verdict, garbage) → `undefined` — the genuine third state, never coerced.
 */
function coerceVerdictString(v: string | undefined): boolean | undefined {
	if (v === "confirmed") return true;
	if (v === "refuted") return false;
	return undefined;
}

/** Plain single-object stdout (the `omp` verify case — no event framing). */
/** @substrate exported for tests only. */
export function parseVerifyPlain(raw: string): boolean | undefined {
	try {
		return coerceVerdictString(extractVerdictString(extractJsonObject(raw)));
	} catch {
		return undefined;
	}
}

/**
 * codex's claim-verification call may ALSO emit a JSONL event stream, exactly like its review call
 * (`parsePanelVerdictCodex`) — round 1 shipped ONE generic parser (`extractJsonObject(raw)?.verdict`)
 * for every harness's verify output, which only ever matches plain `omp` stdout; codex's real output
 * silently failed to parse and ALWAYS degraded to "unavailable," defeating C6's cross-lineage
 * verification in production without ever showing up as a test failure (round 1 only exercised
 * verification through injected fakes, never the real parser against real CLI output shapes). Fixed:
 * the SAME stream-tolerant, "last usable line wins" scan `parsePanelVerdictCodex` uses, adapted to
 * pull a verdict STRING (not a whole verdict object) so an `"inconclusive"` line is recognized as a
 * real (if unconfirmed) answer rather than "no candidate yet, keep scanning".
 */
/** @substrate exported for tests only. */
export function parseVerifyCodex(raw: string): boolean | undefined {
	try {
		let verdictStr: string | undefined;
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
			const direct = extractVerdictString(obj);
			if (direct !== undefined) {
				verdictStr = direct;
				continue;
			}
			const text = pickCodexText(obj);
			if (text) {
				const embedded = extractVerdictString(extractJsonObject(text));
				if (embedded !== undefined) verdictStr = embedded;
			}
		}
		if (verdictStr !== undefined) return coerceVerdictString(verdictStr);
		return parseVerifyPlain(raw); // plain single-object stdout, no event framing
	} catch {
		return undefined;
	}
}

/**
 * grok's `--json-schema` envelope (`{ "text": "<json string>", "structuredOutput": {…}, … }`) — same
 * bug class as codex above: round 1's generic parser looked for `verdict` at the TOP level of the
 * envelope, but grok's real answer lives NESTED at `structuredOutput.verdict`, so it ALWAYS silently
 * failed to parse in production. Fixed: mirrors `parsePanelVerdictGrok`'s envelope-unwrapping, adapted
 * to pull a verdict STRING.
 */
/** @substrate exported for tests only. */
export function parseVerifyGrok(raw: string): boolean | undefined {
	try {
		const envelope = extractJsonObject(raw);
		if (envelope) {
			const structured = envelope.structuredOutput;
			if (structured && typeof structured === "object") {
				const v = extractVerdictString(structured as Record<string, unknown>);
				if (v !== undefined) return coerceVerdictString(v);
			}
			if (typeof envelope.text === "string") {
				const v = extractVerdictString(extractJsonObject(envelope.text));
				if (v !== undefined) return coerceVerdictString(v);
			}
			const v = extractVerdictString(envelope);
			if (v !== undefined) return coerceVerdictString(v);
		}
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

// ── production reviewers (B2/C3: boundedHermeticSpawn — process-group-killed, hermetic cwd) ────────

/** omp (native, Anthropic-lineage) reviewer — an independent one-shot `omp -p` call. LEAST hermetic of
 *  the three (module doc's C3 note): no sandbox flag exists for `omp` in this codebase, so the empty
 *  `cwd` is a real but not kernel-enforced mitigation. `avoid` (round 2, C3): paths `hermeticCwd`
 *  validates its scratch directory resolves OUTSIDE, on top of `process.cwd()` (checked internally). */
function ompPanelReviewer(avoid: string[]): PanelReviewer {
	return async ({ diff, invariants }) => {
		const cwd = await hermeticCwd(avoid);
		try {
			const { out, code, timedOut } = await boundedHermeticSpawn({
				bin: "omp",
				harness: "omp",
				cwd,
				args: ["-p", "--system-prompt", `${PANEL_SYSTEM_PROMPT}\n\n${invariants}`, `Diff:\n${diff}`],
				timeoutMs: panelTimeoutMs(),
			});
			if (timedOut || code !== 0 || !out) return undefined;
			return parsePanelVerdictPlain(out);
		} finally {
			await removeHermeticCwd(cwd);
		}
	};
}

/** codex (OpenAI-lineage) reviewer via `codex exec -s read-only` — sandboxed, never edits the tree it
 *  is reviewing. Combined with a hermetic cwd (C3), there is no repo present for it to read even if the
 *  sandbox's read restriction is scoped to writes rather than reads. */
function codexPanelReviewer(avoid: string[]): PanelReviewer {
	return async ({ diff, invariants }) => {
		const cwd = await hermeticCwd(avoid);
		try {
			const { out, code, timedOut } = await boundedHermeticSpawn({
				bin: "codex",
				harness: "codex",
				cwd,
				args: ["exec", "-s", "read-only", `${PANEL_SYSTEM_PROMPT}\n\n${invariants}\n\nDiff:\n${diff}`],
				timeoutMs: panelTimeoutMs(),
			});
			if (timedOut || code !== 0 || !out) return undefined;
			return parsePanelVerdictCodex(out);
		} finally {
			await removeHermeticCwd(cwd);
		}
	};
}

/** grok (xAI-lineage) reviewer via the grok CLI — read-only sandbox (Landlock-enforced on Linux, per
 *  this project's own model policy: "read-only really is read-only"), no web search, `--json-schema`
 *  constrains the model to the verdict shape. Combined with a hermetic cwd (C3), this reviewer is
 *  GENUINELY hermetic — kernel-enforced, not merely CLI-level. Stdin closed: grok is an agentic CLI and
 *  would otherwise wait on a TTY. */
function grokPanelReviewer(avoid: string[]): PanelReviewer {
	return async ({ diff, invariants }) => {
		const cwd = await hermeticCwd(avoid);
		try {
			const { out, code, timedOut } = await boundedHermeticSpawn({
				bin: "grok",
				harness: "grok",
				cwd,
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
				timeoutMs: panelTimeoutMs(),
			});
			if (timedOut || code !== 0 || !out) return undefined;
			return parsePanelVerdictGrok(out);
		} finally {
			await removeHermeticCwd(cwd);
		}
	};
}

/** Candidate reviewer pool, foreign lineages preferred first (blind-review doctrine: a foreign lineage
 *  is preferred "precisely because it cannot have read the conversation" — native omp is the fallback
 *  fill, not the first choice). Filtered to binaries actually present (`Bun.which`), so the stamped
 *  lineage can never claim a cross-vendor review that didn't happen — the same discipline
 *  `validator.ts`'s `activeReviewer()` already applies to the single criteria judge. */
export function defaultPanelReviewers(avoid: string[] = []): PanelReviewerSpec[] {
	const candidates: PanelReviewerSpec[] = [];
	if (Bun.which("grok")) candidates.push({ lineage: "xai", harness: "grok", review: grokPanelReviewer(avoid) });
	if (Bun.which("codex")) candidates.push({ lineage: "openai", harness: "codex", review: codexPanelReviewer(avoid) });
	if (Bun.which("omp")) candidates.push({ lineage: "anthropic", harness: "omp", review: ompPanelReviewer(avoid) });
	return candidates;
}

// ── claim verification (C6 — NOT "independent recheck"; see the module doc) ────────────────────────

interface VerifyCandidate {
	bin: "grok" | "codex" | "omp";
	lineage: ModelLineage;
	harness: string;
}
const VERIFY_CANDIDATES: VerifyCandidate[] = [
	{ bin: "grok", lineage: "xai", harness: "grok" },
	{ bin: "codex", lineage: "openai", harness: "codex" },
	{ bin: "omp", lineage: "anthropic", harness: "omp" },
];

/** C6 fix: prefer a DIFFERENT lineage than the one that raised the objection under verification — a
 *  same-lineage check (the previous default: always omp) is confirmation-prone (the same model family
 *  grading its own kind of claim). Falls back to the objecting lineage's OWN CLI only when no other
 *  binary is available at all; `undefined` only when nothing is available (shouldn't happen if the
 *  panel itself ran, since that needed >= 2 distinct lineages). */
function pickCrossLineageVerifier(objectorLineage: ModelLineage): VerifyCandidate | undefined {
	const crossLineage = VERIFY_CANDIDATES.filter((c) => c.lineage !== objectorLineage && Bun.which(c.bin));
	if (crossLineage.length > 0) return crossLineage[0];
	return VERIFY_CANDIDATES.find((c) => Bun.which(c.bin));
}

function verifyArgs(bin: VerifyCandidate["bin"], claim: string, diff: string): string[] {
	const user = `A reviewer flagged this specific claim about the diff — verify it, do not re-review from scratch:\n${truncate(claim, CLAIM_MAX)}\n\nDiff:\n${diff}`;
	if (bin === "codex") return ["exec", "-s", "read-only", `${PANEL_VERIFY_SYSTEM}\n\n${user}`];
	if (bin === "grok") {
		return [
			"-p",
			`${PANEL_VERIFY_SYSTEM}\n\n${user}`,
			"--sandbox",
			"read-only",
			"--permission-mode",
			"dontAsk",
			"--disable-web-search",
			"--json-schema",
			JSON.stringify({ type: "object", properties: { verdict: { type: "string", enum: ["confirmed", "refuted", "inconclusive"] } }, required: ["verdict"] }),
		];
	}
	return ["-p", "--system-prompt", PANEL_VERIFY_SYSTEM, user];
}

/** Dispatch to the per-harness verify parser (round 2, A5) — `candidate.bin` decides the SAME way
 *  `defaultJudge`/`activeReviewer` dispatch in `validator.ts`, so the parser used always matches the
 *  CLI that actually ran; never the single generic parser round 1 shipped, which only ever matched
 *  plain `omp` output and silently degraded codex/grok verification to "unavailable". */
function parseVerifyOutput(bin: VerifyCandidate["bin"], raw: string): boolean | undefined {
	if (bin === "codex") return parseVerifyCodex(raw);
	if (bin === "grok") return parseVerifyGrok(raw);
	return parseVerifyPlain(raw);
}

/** The claim-verification reviewer, cross-lineage-preferring (C6) and hermetic/process-group-bounded
 *  (B2/C3) like every other production spawn in this file. `avoid` (round 2, C3): threaded down to
 *  `hermeticCwd` exactly like the review reviewers above. */
export function defaultPanelVerifyReviewer(avoid: string[] = []): PanelVerifyReviewer {
	return async ({ lineage, claim, diff }) => {
		const candidate = pickCrossLineageVerifier(lineage);
		if (!candidate) return undefined;
		const cwd = await hermeticCwd(avoid);
		try {
			const { out, code, timedOut } = await boundedHermeticSpawn({
				bin: candidate.bin,
				harness: candidate.harness,
				cwd,
				args: verifyArgs(candidate.bin, claim, diff),
				timeoutMs: panelTimeoutMs(),
			});
			if (timedOut || code !== 0 || !out) return undefined;
			return parseVerifyOutput(candidate.bin, out);
		} finally {
			await removeHermeticCwd(cwd);
		}
	};
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
 *  underlying implementation ignores its own internal timeout (defense in depth over `panel-spawn.ts`'s
 *  own process-group kill, B2). A thrown/rejected reviewer call and an `undefined` result both resolve
 *  to `"error"` (no usable signal), mirroring `Judge`/`LensJudge`'s fail-open contract: a reviewer that
 *  can't answer contributes nothing, never a fabricated verdict. */
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

/** B2 (second finding): the claim-verification call gets its OWN independent race, exactly like
 *  `runOnePanelReviewer` above — the earlier version awaited `verify(...)` directly with no outer
 *  bound at all, so a hung verifier had nothing stopping it. `undefined` (timeout, throw, or the
 *  reviewer's own "couldn't determine") are ALL the same honest "no answer" — A5's fix lives at the
 *  CALL SITE (never coercing this `undefined` into `false`), not here. */
async function runVerifyWithBound(verify: PanelVerifyReviewer, input: { lineage: ModelLineage; claim: string; diff: string }): Promise<boolean | undefined> {
	const TIMED_OUT = Symbol("panel-verify-timeout");
	let timer: ReturnType<typeof setTimeout> | undefined;
	const bound = new Promise<typeof TIMED_OUT>((resolve) => {
		timer = setTimeout(() => resolve(TIMED_OUT), panelTimeoutMs());
	});
	try {
		const result = await Promise.race([verify(input).catch(() => undefined), bound]);
		return result === TIMED_OUT ? undefined : result;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** A7: translate `{lineage, harness}` into the SAME canonical ledger tag `validator.ts`'s
 *  `ledgerLineageTagForRecord` uses (grok/codex/native) — the harness that actually ran is the primary
 *  signal (mirrors that function's own "harness, not vendor" rule), falling back to the vendor lineage
 *  only for an exotic harness name (e.g. a test fixture), and finally to the raw harness/lineage string
 *  rather than ever fabricating a bucket. Without this, a grok finding created a separate `xai=1`
 *  bucket instead of updating `grok`'s measured history — T4's reader has never heard of `"xai"`. */
export function canonicalLedgerTag(harness: string, lineage: ModelLineage): string {
	if (harness === "grok") return "grok";
	if (harness === "codex") return "codex";
	if (harness === "omp") return "native";
	if (lineage === "xai") return "grok";
	if (lineage === "openai") return "codex";
	if (lineage === "anthropic" || lineage === "google") return "native";
	return harness || lineage || "unknown";
}

// ── single-flight coalescing (B4) ───────────────────────────────────────────────────────────────────
// 100 concurrent lands of the SAME proof (same source+diff) would otherwise each independently miss the
// per-panel result (there is no cache until a run finishes) and spawn their own N-reviewer panel — up
// to ~200 reviewer CLIs for one proof. Concurrent IDENTICAL requests instead share the ONE in-flight
// promise; distinct diffs/sources never coalesce (each gets its own key).

const inFlightPanels = new Map<string, Promise<PanelVerdict[] | undefined>>();

/** A stable per-reference identity marker for an injected callback (`opts.reviewers`/`opts.verify`),
 *  folded into the coalescing key (T5 gauntlet round 3, finding #5b — see the key-construction comment
 *  below). `WeakMap`-keyed so distinct function OBJECTS always get distinct markers (even two closures
 *  with byte-identical source text are different references and get different markers), while the SAME
 *  reference reused across calls always maps back to the SAME marker — no leak risk since a `WeakMap`
 *  never keeps a function alive past its own last real reference. */
const callbackIdentityMarkers = new WeakMap<object, number>();
let nextCallbackIdentityMarker = 1;
function callbackIdentity(fn: unknown): string {
	if (typeof fn !== "function") return "none";
	let marker = callbackIdentityMarkers.get(fn);
	if (marker === undefined) {
		marker = nextCallbackIdentityMarker++;
		callbackIdentityMarkers.set(fn, marker);
	}
	return `fn#${marker}`;
}

export interface ReviewPanelOpts {
	diff: string;
	/** Traceable `source` for the reviewer-ledger row (e.g. `"land <branch>@<commit>"`) — also part of
	 *  the single-flight coalescing key (B4), so two callers with the SAME source+diff share one run. */
	source: string;
	/** stateDir the panel QUEUES findings under (A1) — required whenever the panel might find anything
	 *  to record; `runReviewPanel` still runs (and returns verdicts) without it, but any finding that
	 *  would have queued is instead logged and dropped rather than risking a tracked-tree write. Also
	 *  part of the coalescing key (B4 round 2) — see `ReviewPanelOpts`'s module note below. */
	stateDir?: string;
	/** The repo/worktree of the land this diff belongs to — used for TWO things (round 2): (1) part of
	 *  the single-flight coalescing key (B4), so two DIFFERENT tenants/orgs landing an identical
	 *  cloned diff never share one panel run and cross-contaminate which tenant's queue/reviewers get
	 *  used; (2) threaded into `hermeticCwd`'s validation (C3) as an extra path a reviewer's scratch cwd
	 *  must resolve OUTSIDE. */
	repo?: string;
	worktree?: string;
	/** The land's proof tree hash and a stable digest of the declared criteria — round 2 (B4): both fold
	 *  into the coalescing key alongside `source`+`diff`, since `source`+`hash(diff)` ALONE was too
	 *  narrow — two different org managers landing an identical cloned SHA/diff (same source label,
	 *  same diff bytes) would otherwise coalesce onto the SAME in-flight promise, and the SECOND
	 *  tenant's finding would silently queue under the FIRST tenant's `stateDir`/reviewer pool. */
	proofTree?: string;
	criteriaKey?: string;
	/** Injected reviewer pool (tests pass fakes); `undefined` ⇒ `defaultPanelReviewers(avoid)`. */
	reviewers?: () => PanelReviewerSpec[];
	/** Injected claim-verification reviewer (tests pass a fake); `undefined` ⇒
	 *  `defaultPanelVerifyReviewer(avoid)`. */
	verify?: () => PanelVerifyReviewer;
}

/**
 * Every path a reviewer's hermetic scratch cwd must resolve outside of — T5 gauntlet round 3
 * (glance#356, finding #6): `opts.repo`/`opts.worktree` alone are only THIS call's land target. A
 * daemon manages a whole FLEET of registered repos (`ProjectLane`'s registry); a scratch cwd that lands
 * inside (or, per `panel-spawn.ts`'s bidirectional fix, that CONTAINS) some OTHER managed repo — one not
 * named by this particular call — used to pass validation entirely, since `hermeticCwd` only ever saw
 * the two paths this function threaded through. Best-effort: a broken/absent registry read must never
 * break the (advisory) panel, so a read fault here degrades to "no extra paths", never a thrown error.
 *
 * @substrate exported for a direct test of the "complete managed-repo set" fix — the production CLI
 * reviewers aren't available in the unit-test sandbox, so this pure function IS the testable surface for
 * what actually reaches `hermeticCwd`'s validation.
 */
export function avoidPathsFor(opts: Pick<ReviewPanelOpts, "repo" | "worktree" | "stateDir">): string[] {
	const named = [opts.repo, opts.worktree].filter((p): p is string => !!p);
	if (!opts.stateDir) return named;
	try {
		return [...named, ...openProjectRegistry(opts.stateDir).list()];
	} catch {
		return named;
	}
}

async function runPanelUncoalesced(opts: ReviewPanelOpts, selected: PanelReviewerSpec[]): Promise<PanelVerdict[] | undefined> {
	const settled = await Promise.allSettled(selected.map((spec) => runOnePanelReviewer(spec, opts.diff)));
	const verdicts: PanelVerdict[] = settled.map((r, i) =>
		r.status === "fulfilled" ? r.value : { lineage: selected[i].lineage, harness: selected[i].harness, verdict: "error", ranAt: Date.now() },
	);

	// High-severity objections get ONE claim-verification pass each (bounded — at most `panelMax()` of
	// them, since the panel itself is capped), cross-lineage-preferring (C6). A `confirmed:true` NEVER
	// escalates beyond recording it; it still never vetoes — the land gate's own veto path is untouched
	// by this module entirely.
	const avoidPaths = avoidPathsFor(opts);
	const verify = (opts.verify ?? (() => defaultPanelVerifyReviewer(avoidPaths)))();
	for (let i = 0; i < verdicts.length; i++) {
		const v = verdicts[i];
		if (v.verdict !== "object" || v.severity !== "high" || !v.claim) continue;
		const confirmed = await runVerifyWithBound(verify, { lineage: v.lineage, claim: v.claim, diff: opts.diff });
		// A5: `confirmed` is `true` | `false` | `undefined` (inconclusive/unreachable) — the THIRD state
		// is left as-is (never coerced into `false`/refuted). Only a REAL answer moves `survived` off
		// `undefined`.
		if (confirmed !== undefined) verdicts[i] = { ...v, survived: confirmed };
	}

	// Queue every ADJUDICATED finding (an "object" verdict whose `survived` was actually determined by
	// the verification above) for later ledger projection — the SAME rows a human runs
	// `reviewer-ledger.ts add` for today, but NEVER written to the tracked checkout from here (A1 — see
	// `panel-ledger.ts`). A clean bill ("accept") is NOT a row (the ledger's own honesty rule); an
	// un-verified low-severity objection is ALSO not a row; and (A5) an INCONCLUSIVE verification is
	// ALSO not a row — recording an adjudication that never actually resolved would fabricate the exact
	// "survived" measurement this ledger exists to keep honest.
	if (opts.stateDir) {
		for (const v of verdicts) {
			if (v.verdict !== "object" || v.survived === undefined) continue;
			const entry: ReviewerLedgerEntry = {
				at: new Date().toISOString().slice(0, 10),
				lineage: canonicalLedgerTag(v.harness, v.lineage),
				concernClass: v.concernClass ?? "gauntlet-panel-finding",
				survived: v.survived,
				source: opts.source,
				note: v.claim ?? "",
				severity: v.severity,
			};
			try {
				recordPendingPanelFinding(opts.stateDir, entry);
			} catch (err) {
				console.error(`review-panel: failed to queue pending ledger row for ${entry.lineage} (non-fatal): ${errText(err)}`);
			}
		}
	} else {
		const adjudicated = verdicts.filter((v) => v.verdict === "object" && v.survived !== undefined);
		if (adjudicated.length > 0) console.error(`review-panel: ${adjudicated.length} adjudicated finding(s) NOT queued — no stateDir was provided; the panel result is still returned/attached to the receipt.`);
	}

	return verdicts;
}

/**
 * Spawn the blind cross-lineage gauntlet panel for `opts.diff`, IF its risk tier warrants one (see
 * `diffRiskTier`) and the master flag is on. Returns `undefined` when the panel did not fire (master
 * flag off, docs-only diff, tier doesn't warrant it, or fewer than `MIN_PANEL_LINEAGES` distinct-lineage
 * reviewers are available) — never an empty array standing in for "ran and found nothing" vs. "never
 * ran" (those are different facts; T6 needs to tell them apart).
 *
 * PURELY ADDITIVE: this function has no veto/inconclusive authority of its own. It never throws — every
 * fault (a reviewer error, a ledger-queue fault) is absorbed here so a panel failure can only ever
 * shrink the reported panel, never break the land it is advisory to (mirrors `validator.ts`'s lens-panel
 * "advisory only" discipline verbatim). Concurrent IDENTICAL requests (same `source`+`diff`) share ONE
 * in-flight run (B4, single-flight coalescing) rather than each spawning their own reviewer pool.
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

		const avoidPaths = avoidPathsFor(opts);
		const pool = opts.reviewers ? opts.reviewers() : defaultPanelReviewers(avoidPaths);
		const seen = new Set<ModelLineage>();
		const selected: PanelReviewerSpec[] = [];
		for (const spec of pool) {
			if (seen.has(spec.lineage)) continue; // distinct lineages only
			seen.add(spec.lineage);
			selected.push(spec);
			if (selected.length >= panelMax()) break;
		}
		if (selected.length < MIN_PANEL_LINEAGES) return undefined; // no real cross-lineage panel possible

		// B4 round 2: `source`+`hash(diff)` ALONE was too narrow — two different org managers landing an
		// IDENTICAL cloned SHA/diff (same source label, same diff bytes, e.g. a shared upstream template
		// repo forked into two tenants) would coalesce onto the SAME in-flight promise; the first
		// tenant's `stateDir`/reviewer pool would win, and the SECOND tenant's finding would silently
		// queue under the FIRST tenant. The key now folds in everything that could make two "identical"
		// requests actually belong to different lands: the proof tree, the criteria digest, the
		// repo/worktree, the stateDir, AND the resolved reviewer pool's identity (lineage+harness pairs) —
		// only a request that agrees on ALL of these is genuinely the same panel run.
		//
		// T5 gauntlet round 3 (glance#356, finding #5): TWO more gaps in round 2's key, both closed here.
		//   (a) `.join("::")` is not injective — a field containing the literal separator can make two
		//       genuinely DIFFERENT tuples produce the IDENTICAL joined string (e.g. criteriaKey="x::y",
		//       repo="z" vs criteriaKey="x", repo="y::z" both join to "...x::y::z..."). `JSON.stringify`
		//       of the field ARRAY is injective regardless of any field's content — the same fix already
		//       applied to `semanticKey` in `memory/reviewer-weights.ts` for the identical class of bug,
		//       reused here rather than re-litigated.
		//   (b) `poolIdentity` was built ONLY from the selected specs' `{lineage, harness}` labels — two
		//       DIFFERENT injected `opts.reviewers`/`opts.verify` callbacks (e.g. two test fakes, or two
		//       callers wiring genuinely different behavior behind the same declared lineage/harness pair)
		//       were INDISTINGUISHABLE by that string alone and would wrongly coalesce onto one run, with
		//       the SECOND caller silently receiving the FIRST caller's verdicts/queue effects. Every
		//       distinct function reference now gets its own stable identity token (`callbackIdentity`
		//       below) folded into the key, so two different callback identities never coalesce even when
		//       their declared pool shape is identical; the SAME reference reused across calls (the
		//       common/production case — a shared `reviewers` closure, or no override at all) still
		//       coalesces exactly as before.
		const poolIdentity = selected.map((s) => `${s.lineage}:${s.harness}`).sort().join(",");
		const key = JSON.stringify([
			opts.source,
			Bun.hash(opts.diff).toString(),
			opts.proofTree ?? "",
			opts.criteriaKey ?? "",
			opts.repo ?? "",
			opts.worktree ?? "",
			opts.stateDir ?? "",
			poolIdentity,
			callbackIdentity(opts.reviewers),
			callbackIdentity(opts.verify),
		]);
		const existing = inFlightPanels.get(key);
		if (existing) return existing;
		const run = runPanelUncoalesced(opts, selected);
		inFlightPanels.set(key, run);
		try {
			return await run;
		} finally {
			inFlightPanels.delete(key);
		}
	} catch (err) {
		// The panel is advisory only — an unexpected throw anywhere above must never reach the land path.
		console.error(`review-panel: panel run failed (non-fatal, advisory only): ${errText(err)}`);
		return undefined;
	}
}

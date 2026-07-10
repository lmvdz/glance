/**
 * Independent validator (Epic 3) — scores a landed diff against its unit's DECLARED
 * `FeatureCriterion[]` using a judge lineage that is independent of the executor: a different
 * model (`OMP_SQUAD_VALIDATOR_MODEL ?? "opus"` vs the executor's sonnet default) and a different
 * process (a fresh one-shot `omp -p` call, no shared session). The judge never grades its own
 * work — see plans/meta-autonomous-fleet/epic-3-independent-validator/DESIGN.md.
 *
 * `scoreAgainstCriteria` is the pure scorer (headless-testable via an injected `Judge`, mirroring
 * `ObserverDeps`/`VisionProducer`). `validatorGate` wraps it with the land-time diff computation
 * and a per-(commit,tree) cache; it is the seam `SquadManager.landBranch` calls (DESIGN §1).
 */

import { envBool, envInt } from "./config.ts";
import { budgetedExcerpt } from "./gate-logs.ts";
import { GIT_HARDEN_ARGS, GIT_HARDEN_ENV } from "./git-harden.ts";
import { harnessLineage, type ModelLineage, modelLineage } from "./model-lineage.ts";
import { decideTyped, extractJsonObject } from "./omp-call.ts";
import type { Proof } from "./proof.ts";
import { type LensId, selectLenses } from "./lens-select.ts";
import type { FeatureCriterion, LensVerdict, ValidationRecord } from "./types.ts";

/** Raw per-criterion verdict shape the judge is asked to emit (before coercion into `perCriterion`). */
export interface RawVerdict {
	perCriterion: { id: string; satisfied: boolean; note?: string }[];
	confidence?: number;
	rationale?: string;
	/** Gate-log offload (concern 03): pointer path(s) to the full untruncated diff/proof text when
	 *  either exceeded its excerpt budget. NOT part of the judge's own JSON output — attached by the
	 *  production judge (`ompJudge`/`codexJudge`) after `decideTyped` resolves, so `scoreAgainstCriteria`
	 *  can copy it onto the `ValidationRecord` without widening the `Judge` return contract. Absent on
	 *  fakes/tests and on any run where nothing was oversized. */
	gateLogPaths?: string[];
}

/** Injected judge seam — the default is a one-shot `omp -p` call; tests pass a fake. Never throws
 *  by contract (a throw is treated the same as `undefined` — abstain, fail-open). */
export type Judge = (input: { criteria: FeatureCriterion[]; diff: string; proof?: Proof; agentId?: string }) => Promise<RawVerdict | undefined>;

const RATIONALE_MAX = 600;

function truncate(s: string, n: number): string {
	return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/** Independent of the executor's model default (sonnet) — see DESIGN §2. */
function validatorModel(): string {
	return process.env.OMP_SQUAD_VALIDATOR_MODEL ?? "opus";
}

/** The judge harness (plans/cross-lineage-review/ concern 05): "omp" (default, Claude-lineage judge)
 *  or "codex" (OpenAI-lineage judge via the codex CLI — opt-in, off until its live-verify test passes). */
function validatorHarness(): string {
	return process.env.OMP_SQUAD_VALIDATOR_HARNESS ?? "omp";
}

/**
 * The reviewer that will ACTUALLY run, as one source of truth for BOTH judge selection and the
 * lineage stamp — so the record can never claim a cross-vendor review that didn't happen. The codex
 * reviewer is chosen only when configured AND the binary is present; if codex is absent we fall back
 * to the omp judge at selection time and the stamp honestly says anthropic (no codex ran).
 */
function activeReviewer(): { model: string; lineage: ModelLineage; harness: "omp" | "codex" } {
	if (validatorHarness() === "codex" && Bun.which("codex")) return { model: "codex", lineage: "openai", harness: "codex" };
	return { model: validatorModel(), lineage: modelLineage(validatorModel()), harness: "omp" };
}

/**
 * The author↔reviewer VENDOR lineage pair for a review (plans/cross-lineage-review/). `reviewerLineage`
 * is the reviewer that actually ran; the author lineage is read from the executor's model, falling
 * back to the harness name only for vendor-pinned harnesses. `sameLineage` is left `undefined` unless
 * BOTH sides are known — an unreadable author is never assumed to match (or differ from) the reviewer.
 */
function lineageFields(reviewerLineage: ModelLineage, authorModel?: string, authorHarness?: string): {
	authorLineage: ModelLineage;
	reviewerLineage: ModelLineage;
	sameLineage?: boolean;
} {
	const fromModel = modelLineage(authorModel);
	const authorLineage = fromModel === "unknown" ? harnessLineage(authorHarness) : fromModel;
	const sameLineage = authorLineage !== "unknown" && reviewerLineage !== "unknown" ? authorLineage === reviewerLineage : undefined;
	return { authorLineage, reviewerLineage, sameLineage };
}

const SYSTEM_PROMPT =
	"You are an INDEPENDENT validator judging whether a code change satisfies a list of DECLARED acceptance criteria. " +
	"You did not write this code and must not trust the author's own claims — inspect the diff (and proof output, if given) " +
	'directly. For EACH criterion, decide satisfied:true only if the diff visibly implements it. Respond with EXACTLY one JSON ' +
	'object and nothing else: {"perCriterion":[{"id":"<criterion id>","satisfied":true|false,"note":"<short reason>"}],' +
	'"confidence":0..1,"rationale":"<short overall rationale>"}.';

/** Coerce a parsed object into a RawVerdict, or undefined if it has no usable `perCriterion`. */
function coerceVerdict(obj: Record<string, unknown> | undefined): RawVerdict | undefined {
	if (!obj) return undefined;
	const per = obj.perCriterion;
	if (!Array.isArray(per)) return undefined;
	const perCriterion = per
		.filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
		.map((e) => ({ id: String(e.id ?? ""), satisfied: e.satisfied === true, note: typeof e.note === "string" ? e.note : undefined }))
		.filter((e) => e.id.length > 0);
	if (perCriterion.length === 0) return undefined;
	const confidence = typeof obj.confidence === "number" ? Math.max(0, Math.min(1, obj.confidence)) : undefined;
	const rationale = typeof obj.rationale === "string" ? obj.rationale : undefined;
	return { perCriterion, confidence, rationale };
}

function parseRawVerdict(raw: string): RawVerdict | undefined {
	return coerceVerdict(extractJsonObject(raw));
}

/**
 * Parse a verdict from `codex exec` output (plans/cross-lineage-review/ concern 05). codex may emit
 * a JSONL EVENT STREAM (one `{type,payload}` object per line, our verdict embedded in an
 * `agent_message`/`item` text field), NOT one clean JSON object — so we go LINE-BY-LINE and take the
 * last line that yields a usable verdict, and only fall back to a whole-blob `extractJsonObject` when
 * no line matched (the plain-stdout case). We deliberately never `extractJsonObject` the whole stream
 * first: its outermost-`{`-to-last-`}` slice spans multiple events on a JSONL stream and throws.
 */
export function parseCodexVerdict(raw: string): RawVerdict | undefined {
	let found: RawVerdict | undefined;
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
		// (a) the verdict object emitted directly as a line
		const direct = coerceVerdict(obj);
		if (direct) { found = direct; continue; }
		// (b) a codex event whose text/message field carries the verdict JSON
		const text = pickCodexText(obj);
		if (text) {
			const embedded = coerceVerdict(extractJsonObject(text));
			if (embedded) found = embedded;
		}
	}
	// (c) plain single-object stdout (no event framing)
	return found ?? parseRawVerdict(raw);
}

/** Best-effort dig for the assistant text in a codex event object (`agent_message`/`item` shapes seen
 *  in src/ingest/codex.ts). Returns undefined if none — the caller then tries other lines. */
function pickCodexText(obj: Record<string, unknown>): string | undefined {
	const payload = (obj.payload ?? {}) as Record<string, unknown>;
	const item = (obj.item ?? {}) as Record<string, unknown>;
	for (const v of [payload.message, payload.text, obj.message, obj.text, item.text]) {
		if (typeof v === "string" && v.includes("{")) return v;
	}
	return undefined;
}

/** The criteria+diff+proof prompt body shared by every judge harness. Oversized diff/proof text is
 *  budgeted (diff-aware for the diff, head+tail for the proof tail) rather than head-truncated
 *  (concern 03) — the full text is persisted durably, and `gateLogPaths` collects the pointer(s) so
 *  the caller can stamp them onto the `ValidationRecord` for post-hoc forensics. */
async function judgeUserPrompt(criteria: FeatureCriterion[], diff: string, proof?: Proof, agentId?: string): Promise<{ text: string; gateLogPaths: string[] }> {
	const criteriaText = criteria.map((c) => `- [${c.id}] ${c.text}`).join("\n");
	const diffX = await budgetedExcerpt(diff, 12000, { kind: "diff", agentId });
	const proofX = proof?.detail ? await budgetedExcerpt(proof.detail, 2000, { kind: "log", agentId }) : undefined;
	const proofTail = proofX ? `\n\nProof output (tail):\n${proofX.text}` : "";
	const gateLogPaths = [diffX.path, proofX?.path].filter((p): p is string => !!p);
	return { text: `Declared acceptance criteria:\n${criteriaText}\n\nDiff:\n${diffX.text}${proofTail}`, gateLogPaths };
}

/** omp judge: an independent one-shot `omp -p --model <lineage>` call. `Bun.which("omp")` missing,
 *  a timeout, or unparseable output all degrade to `undefined` via `decideTyped`'s fallback — never throws. */
function ompJudge(): Judge {
	return async ({ criteria, diff, proof, agentId }) => {
		const { text, gateLogPaths } = await judgeUserPrompt(criteria, diff, proof, agentId);
		const raw = await decideTyped<RawVerdict | undefined>({
			args: ["-p", "--model", validatorModel(), "--system-prompt", SYSTEM_PROMPT, text],
			parse: parseRawVerdict,
			fallback: undefined,
			timeoutMs: envInt("OMP_SQUAD_VALIDATOR_TIMEOUT_MS", 120_000),
		});
		return raw && gateLogPaths.length ? { ...raw, gateLogPaths } : raw;
	};
}

/**
 * codex judge (plans/cross-lineage-review/ concern 05) — a GENUINELY different-vendor (OpenAI) reviewer
 * via `codex exec`. codex has no `--system-prompt`, so the system prompt is folded into the user text;
 * output is parsed stream-tolerantly (see `parseCodexVerdict`). A codex miss/timeout/unparseable run
 * degrades to `undefined` → an honest OpenAI-lineage `abstain` (fail-open), never a fabricated pass.
 * OFF until its live-verify test proves codex emits parseable verdicts on real diffs.
 */
function codexJudge(): Judge {
	return async ({ criteria, diff, proof, agentId }) => {
		const { text, gateLogPaths } = await judgeUserPrompt(criteria, diff, proof, agentId);
		const raw = await decideTyped<RawVerdict | undefined>({
			bin: "codex",
			args: ["exec", "-s", "read-only", `${SYSTEM_PROMPT}\n\n${text}`],
			parse: parseCodexVerdict,
			fallback: undefined,
			timeoutMs: envInt("OMP_SQUAD_VALIDATOR_CODEX_TIMEOUT_MS", 90_000),
		});
		return raw && gateLogPaths.length ? { ...raw, gateLogPaths } : raw;
	};
}

/** Selects the judge harness, kept in lockstep with `activeReviewer()` so the running reviewer and the
 *  stamped reviewer lineage never disagree. */
function defaultJudge(): Judge {
	return activeReviewer().harness === "codex" ? codexJudge() : ompJudge();
}

// ── Perspective-diversified review: out-of-criteria lens judges ───────────────────────────────────
// (plans/perspective-diversified-review/ concern 02). A SECOND review axis, orthogonal to the
// cross-lineage (vendor) axis above: each lens is a focused, separately-prompted judge that hunts ONE
// class of problem the criteria judge is structurally told to ignore (it grades only DECLARED criteria).
// Advisory only, default-off (concern 06 gates it), fail-open by construction: any throw/timeout/garbage
// degrades to `undefined` (no signal), never a fabricated verdict and never a throw that could reach a land.

/** Per-lens system prompt — single-concern framing, explicitly NOT re-checking the declared criteria. */
const LENS_SYSTEM_PROMPTS: Record<LensId, string> = {
	regression:
		"You are an INDEPENDENT reviewer. You are NOT checking whether declared acceptance criteria are met — " +
		"assume another reviewer already did that, and do not repeat it. Your ONLY job: does this diff introduce a " +
		"problem the acceptance criteria would NOT have named — a security regression, a scope violation, data loss, " +
		"a broken or silently-swallowed failure path, or a resource/performance cliff? Inspect the diff directly and " +
		"distrust any author description. Respond with EXACTLY one JSON object and nothing else: " +
		'{"disposition":"accept"|"object","severity":"low"|"high","claim":"<one-line reason; empty string if accept>"}.',
};

/** Injected lens-judge seam (tests pass a fake). Never throws by contract — a throw/timeout/unparseable
 *  run is treated identically to `undefined` (no advisory signal). */
export type LensJudge = (input: { lens: LensId; diff: string; proof?: Proof; agentId?: string }) => Promise<LensVerdict | undefined>;

function lensTimeoutMs(): number {
	return envInt("OMP_SQUAD_LENS_TIMEOUT_MS", 60_000);
}

/** The diff (+proof tail) a lens inspects — same excerpt budget as the criteria judge (concern 03: a
 *  lens re-excerpting the same oversized diff writes its OWN gate-log file — see gate-logs.ts's module
 *  doc on why paths are per-write, not deduped). No criteria: a lens deliberately does not see the
 *  declared criteria, so it cannot just re-grade them. */
async function lensUserPrompt(diff: string, proof?: Proof, agentId?: string): Promise<string> {
	const diffX = await budgetedExcerpt(diff, 12000, { kind: "diff", agentId });
	const proofX = proof?.detail ? await budgetedExcerpt(proof.detail, 2000, { kind: "log", agentId }) : undefined;
	const proofTail = proofX ? `\n\nProof output (tail):\n${proofX.text}` : "";
	return `Diff:\n${diffX.text}${proofTail}`;
}

/** Coerce a parsed object into a LensVerdict, or undefined if it lacks a usable `disposition`. */
function coerceLensVerdict(lens: LensId, obj: Record<string, unknown> | undefined): LensVerdict | undefined {
	if (!obj) return undefined;
	const disposition = obj.disposition === "object" ? "object" : obj.disposition === "accept" ? "accept" : undefined;
	if (!disposition) return undefined;
	const severity = obj.severity === "high" ? "high" : "low";
	const claim = typeof obj.claim === "string" ? truncate(obj.claim, RATIONALE_MAX) : "";
	return { lens, disposition, severity, claim };
}

/**
 * GUARDED lens parser (concern 02). `decideTyped` does NOT wrap `parse()` in try/catch, so a throwing
 * parser would escape and fail-CLOSE a land — this must never throw. Stream-tolerant like
 * `parseCodexVerdict`: try each line (codex JSONL), then the whole blob (plain omp stdout). Any failure
 * anywhere resolves to `undefined` (no signal).
 */
export function parseLensVerdict(lens: LensId): (raw: string) => LensVerdict | undefined {
	return (raw: string) => {
		try {
			let found: LensVerdict | undefined;
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
				const direct = coerceLensVerdict(lens, obj);
				if (direct) {
					found = direct;
					continue;
				}
				const text = obj ? pickCodexText(obj) : undefined;
				if (text) {
					const embedded = coerceLensVerdict(lens, extractJsonObject(text));
					if (embedded) found = embedded;
				}
			}
			return found ?? coerceLensVerdict(lens, extractJsonObject(raw));
		} catch {
			return undefined;
		}
	};
}

/**
 * A lens judge on the SAME one-shot machinery as the criteria judge — `omp -p` (or `codex exec` when
 * `activeReviewer()` selects the cross-vendor harness), same truncation, same never-throws contract.
 * Cross-vendor-capable: an operator can run the lens on codex while the criteria judge stays on omp,
 * multiplying the two independence axes at lens granularity.
 */
export function ompLensJudge(lens: LensId): LensJudge {
	return async ({ diff, proof, agentId }) => {
		try {
			const reviewer = activeReviewer();
			const system = LENS_SYSTEM_PROMPTS[lens];
			const user = await lensUserPrompt(diff, proof, agentId);
			const codex = reviewer.harness === "codex";
			return await decideTyped<LensVerdict | undefined>({
				bin: codex ? "codex" : undefined,
				args: codex ? ["exec", "-s", "read-only", `${system}\n\n${user}`] : ["-p", "--model", reviewer.model, "--system-prompt", system, user],
				parse: parseLensVerdict(lens),
				fallback: undefined,
				timeoutMs: lensTimeoutMs(),
			});
		} catch {
			return undefined;
		}
	};
}

/**
 * Score `diff` against DECLARED `criteria`. Never throws.
 *  - empty `criteria` ⇒ `"skipped"` (DESIGN §4 — never invents criteria to grade against).
 *  - judge unreachable/unparseable/throws ⇒ `"abstain"` (fail-open, DESIGN §3).
 *  - otherwise every input criterion gets a `perCriterion` entry (one the judge didn't mention
 *    defaults to `satisfied:false`); `"veto"` iff any is unsatisfied, else `"pass"`.
 */
export async function scoreAgainstCriteria(
	criteria: FeatureCriterion[],
	diff: string,
	proof?: Proof,
	judge: Judge = defaultJudge(),
	authorModel?: string,
	authorHarness?: string,
	agentId?: string,
): Promise<ValidationRecord> {
	const ranAt = Date.now();
	const reviewer = activeReviewer();
	const lineage = lineageFields(reviewer.lineage, authorModel, authorHarness);
	if (criteria.length === 0) {
		return { verdict: "skipped", agreement: 1, confidence: 0, perCriterion: [], rationale: "no declared criteria", ranAt };
	}
	// An empty diff means there is nothing to inspect — declared criteria cannot be judged against no
	// change. Abstain (fail-open) rather than fabricating a veto for a change the judge never saw. This
	// covers the in-place (worktree === repo) case where the base collapses to HEAD, plus any no-op land.
	if (!diff.trim()) {
		return { verdict: "abstain", agreement: 0, confidence: 0, perCriterion: [], rationale: "empty diff — nothing to validate (in-place or no-op land); not scored", model: reviewer.model, ...lineage, ranAt };
	}
	let raw: RawVerdict | undefined;
	try {
		raw = await judge({ criteria, diff, proof, agentId });
	} catch {
		raw = undefined;
	}
	if (!raw || raw.perCriterion.length === 0) {
		return {
			verdict: "abstain",
			agreement: 0,
			confidence: 0,
			perCriterion: [],
			rationale: "judge unavailable or returned no verdict",
			model: reviewer.model,
			...lineage,
			...(raw?.gateLogPaths?.length ? { gateLogPaths: raw.gateLogPaths } : {}),
			ranAt,
		};
	}
	const byId = new Map(raw.perCriterion.map((p) => [p.id, p] as const));
	const perCriterion = criteria.map((c) => {
		const p = byId.get(c.id);
		return { id: c.id, satisfied: p?.satisfied === true, note: p?.note };
	});
	const satisfiedCount = perCriterion.filter((p) => p.satisfied).length;
	const agreement = perCriterion.length > 0 ? satisfiedCount / perCriterion.length : 1;
	const verdict = perCriterion.some((p) => !p.satisfied) ? "veto" : "pass";
	return {
		verdict,
		agreement,
		confidence: raw.confidence ?? 0,
		perCriterion,
		...(raw.gateLogPaths?.length ? { gateLogPaths: raw.gateLogPaths } : {}),
		rationale: truncate(raw.rationale ?? "", RATIONALE_MAX),
		model: reviewer.model,
		...lineage,
		ranAt,
	};
}

// ── Land-gate wiring (leaf 02) ───────────────────────────────────────────────────────────────────

export interface ValidatorGateOpts {
	criteria: FeatureCriterion[];
	repo: string;
	worktree: string;
	branch?: string;
	proof?: Proof;
	/** Injected judge override — undefined ⇒ `scoreAgainstCriteria`'s own default judge. */
	judge?: Judge;
	/** The change author's executor model + harness (from the unit DTO at the land site), for the
	 *  cross-lineage stamp. Absent ⇒ author lineage resolves `unknown` (an honest non-assertion). */
	authorModel?: string;
	authorHarness?: string;
	/** The unit's agentId — threaded through to `budgetedExcerpt` (concern 03) so an oversized
	 *  diff/proof gate-log lands under that agent's own `gate-logs/<agentId>/` directory. Absent ⇒
	 *  offloaded files fall under a shared "unknown" bucket rather than being dropped. */
	agentId?: string;
	/** Injected lens-judge factory (concern 03) — tests pass a fake; production uses `ompLensJudge`.
	 *  Only consulted when the master flag is on and the criteria judge returned a clean `pass`. */
	lensJudge?: (lens: LensId) => LensJudge;
	/** Injected re-check factory (concern 05); production uses `ompLensVerifyJudge`. Reached only after a
	 *  panel objection, under both the master flag and the VERIFY sub-flag. */
	lensVerifyJudge?: () => LensVerifyJudge;
}

export interface ValidatorGateResult {
	record: ValidationRecord;
	/** Human-readable veto reason — set ONLY when `record.verdict === "veto"`. */
	veto?: string;
}

/** On by default; OMP_SQUAD_VALIDATOR=0 disables the gate entirely (verdict "skipped"), mirroring
 *  OMP_SQUAD_STALE_GATE/staleGateEnabled() in src/land.ts — lets the fleet run with the validator off
 *  during rollout. */
function validatorEnabled(): boolean {
	return envBool("OMP_SQUAD_VALIDATOR", true);
}

/** Verdict cache keyed by `${proof.commit}:${proof.tree}:${criteriaHash}` so repeated land attempts on
 *  the same tree (a retry after an unrelated block, a re-land after fixing something else) reuse the
 *  judge's verdict instead of re-firing an LLM call — but a change to the declared criteria (a genuine
 *  input to the verdict) busts the entry rather than reusing a stale one. Mirrors `proofRoot`-style
 *  module state in proof.ts. */
const gateCache = new Map<string, ValidationRecord>();

/** Force standard `a/`…`b/` diff header prefixes regardless of the operator's git config, so the lens
 *  selector's header parser (`changedFilesFromDiff`) never silently under-covers under diff.noprefix /
 *  diff.mnemonicPrefix. `-c` overrides must precede the `diff` subcommand. */
const DIFF_PREFIX_ARGS = ["-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false"];

async function gitOut(args: string[], cwd: string): Promise<string> {
	const proc = Bun.spawn(["git", ...GIT_HARDEN_ARGS, ...args], { cwd, env: { ...process.env, ...GIT_HARDEN_ENV }, stdout: "pipe", stderr: "ignore" });
	const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	return out.trim();
}

/** The diff a land would merge: `<base>...HEAD` inside the worktree. `base` prefers the proof's
 *  recorded target-repo HEAD (the exact base the proof ran against); absent a proof, falls back to
 *  the repo's current HEAD. Never throws — an unreadable worktree yields an empty diff, which
 *  `scoreAgainstCriteria` treats as an abstain (never a veto), not a crash. */
async function computeLandDiff(repo: string, worktree: string, baseCommit?: string): Promise<string> {
	try {
		const base = baseCommit || (await gitOut(["rev-parse", "HEAD"], repo));
		if (!base) return "";
		// `--no-ext-diff` is load-bearing: GIT_HARDEN_ARGS sets `-c diff.external=` (empty), which makes
		// git try to exec "" as an external differ and die with EMPTY output for every diff. `--no-ext-diff`
		// forces the builtin diff (and still ignores any malicious repo-level diff.external — the harden intent).
		// `DIFF_PREFIX_ARGS` pins the standard `a/`…`b/` header prefixes so the lens selector's file parser
		// (changedFilesFromDiff) is reliable even under an operator's diff.noprefix/mnemonicPrefix git config.
		let diff = await gitOut([...DIFF_PREFIX_ARGS, "diff", "--no-ext-diff", `${base}...HEAD`], worktree);
		// In-place (worktree === repo) the base collapses to HEAD, so `base...HEAD` is empty even though
		// the unit made real commits. Recover the true change set via the merge-base with the tracked
		// upstream / default branch when one is resolvable; otherwise leave it empty (→ honest abstain).
		if (!diff && worktree === repo) {
			const upstream =
				(await gitOut(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], repo)) ||
				(await gitOut(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo));
			if (upstream) {
				const mergeBase = await gitOut(["merge-base", upstream, "HEAD"], repo);
				if (mergeBase && mergeBase !== base) diff = await gitOut([...DIFF_PREFIX_ARGS, "diff", "--no-ext-diff", `${mergeBase}...HEAD`], worktree);
			}
		}
		return diff;
	} catch {
		return "";
	}
}

// ── Lens panel wiring (concern 03) ────────────────────────────────────────────────────────────────
// The advisory panel runs SEQUENTIALLY, AFTER the authoritative criteria judge has resolved — never
// concurrent with it. Co-locating lens spawns at the criteria judge's moment of need risks a
// provider-rate-limit/resource timeout on the AUTHORITATIVE call (→ fail-open abstain → a would-be-veto
// lands). The advisory feature must never be able to degrade the authority, so we pay sum-latency, not
// max-latency. Lenses run only on a clean `pass` (a veto is already blocked; an abstain/skipped had no
// validated diff to add an opinion to) and only on a criteria-cache MISS — a re-land reuses the stored
// record (which already carries its lensAdvisory), so the criteria-scoped gateCache subsumes any
// separate lens cache.

/** OFF by default — the master flag; concern 06 owns the full flag surface + a default-off contract test. */
function lensReviewEnabled(): boolean {
	return envBool("OMP_SQUAD_LENS_REVIEW", false);
}

/** How many lenses may fire (v1 default 1). `0` disables the panel even with the master flag on. */
function lensMax(): number {
	return envInt("OMP_SQUAD_LENS_MAX", 1);
}

/** Optional CSV allowlist (`OMP_SQUAD_LENS_SET`) intersected with the known lenses; unset ⇒ no restriction. */
function lensAllow(): LensId[] | undefined {
	const raw = process.env.OMP_SQUAD_LENS_SET;
	if (!raw) return undefined;
	const known: LensId[] = ["regression"];
	const set = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
	return known.filter((l) => set.has(l));
}

/** The resolved lens-review config — the single readable surface for the flags (concern 06). Everything
 *  defaults OFF/minimal: `review:false` (master), `verify:false`, `max:1`. A default-off contract test
 *  pins this; callers can also read it for observability. */
export function lensConfig(): { review: boolean; max: number; allow?: LensId[]; verify: boolean; timeoutMs: number } {
	return { review: lensReviewEnabled(), max: lensMax(), allow: lensAllow(), verify: lensVerifyEnabled(), timeoutMs: lensTimeoutMs() };
}

/** Run a single lens, guarded — an injected fake or a real judge that throws resolves to `undefined`
 *  (no signal), never propagating out of the panel. */
async function runOneLens(lens: LensId, make: (l: LensId) => LensJudge, diff: string, proof?: Proof, agentId?: string): Promise<LensVerdict | undefined> {
	try {
		return await make(lens)({ lens, diff, proof, agentId });
	} catch {
		return undefined;
	}
}

/**
 * Fire the selected lenses over the already-computed diff and collect their advisory verdicts.
 * `Promise.allSettled` + per-lens guard means no single lens failure can reject the batch or reach the
 * land. Returns `[]` when nothing fired (docs-only, capped to 0, or all lenses gave no signal).
 */
export async function runLensPanel(diff: string, proof: Proof | undefined, criteriaText: string, make: (l: LensId) => LensJudge, agentId?: string): Promise<LensVerdict[]> {
	const lenses = selectLenses(diff, { criteriaText, max: lensMax(), allow: lensAllow() });
	if (lenses.length === 0) return [];
	const settled = await Promise.allSettled(lenses.map((lens) => runOneLens(lens, make, diff, proof, agentId)));
	const verdicts: LensVerdict[] = [];
	for (const r of settled) if (r.status === "fulfilled" && r.value) verdicts.push(r.value);
	return verdicts;
}

// ── VERIFY re-check (concern 05) — the ACCEPT/REJECT/VERIFY middle branch ──────────────────────────
// A high-severity objection is neither blindly trusted nor ignored: one narrow re-check, scoped to
// exactly that claim, decides whether it holds. Structurally nested under the master flag (only reachable
// from inside validatorGate's enabled+pass+panel-ran block) plus its own sub-flag. Fail-open: an
// unreachable/undetermined re-check resolves to `confirmed:false` — it never escalates on a failure, and
// a `confirmed:true` still only maxes the confidence penalty (concern 04); it NEVER vetoes.

/** Injected re-check seam. `true` = confirmed, `false` = refuted, `undefined` = couldn't determine
 *  (treated as NOT confirmed — an unreachable re-check must never escalate). */
export type LensVerifyJudge = (input: { lens: LensId; claim: string; diff: string; proof?: Proof; agentId?: string }) => Promise<boolean | undefined>;

/** Its own sub-flag; only meaningful WITHIN an already-enabled panel (checked after a panel objection). */
function lensVerifyEnabled(): boolean {
	return envBool("OMP_SQUAD_LENS_VERIFY", false);
}

const LENS_VERIFY_SYSTEM =
	"You are re-checking ONE specific concern another reviewer raised about a code diff. Decide only whether that " +
	'concern is substantiated by the diff itself. Respond with EXACTLY one JSON object: {"verdict":"confirmed"|"refuted"|"inconclusive"}.';

/** Guarded parser — confirmed ⇒ true, refuted/inconclusive ⇒ false (do not escalate on doubt), else undefined. */
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

/** The re-check judge, on the same one-shot machinery (omp/codex) as the lens judge. Never throws. */
export function ompLensVerifyJudge(): LensVerifyJudge {
	return async ({ claim, diff, proof, agentId }) => {
		try {
			const reviewer = activeReviewer();
			const user = `A reviewer flagged this specific concern about the diff:\n${truncate(claim, RATIONALE_MAX)}\n\n${await lensUserPrompt(diff, proof, agentId)}`;
			const codex = reviewer.harness === "codex";
			return await decideTyped<boolean | undefined>({
				bin: codex ? "codex" : undefined,
				args: codex ? ["exec", "-s", "read-only", `${LENS_VERIFY_SYSTEM}\n\n${user}`] : ["-p", "--model", reviewer.model, "--system-prompt", LENS_VERIFY_SYSTEM, user],
				parse: parseVerifyConfirmed,
				fallback: undefined,
				timeoutMs: lensTimeoutMs(),
			});
		} catch {
			return undefined;
		}
	};
}

/**
 * Re-check the FIRST high-severity objection (concern 05). Returns undefined when there is none — the
 * caller only invokes this after the sub-flag check, so a `low` objection or an all-accept panel never
 * spends the extra call. A failed/undetermined re-check ⇒ `confirmed:false` (fail-open).
 */
export async function runLensVerify(verdicts: LensVerdict[], diff: string, proof: Proof | undefined, make: () => LensVerifyJudge, agentId?: string): Promise<{ lens: LensId; claim: string; confirmed: boolean } | undefined> {
	const target = verdicts.find((v) => v.disposition === "object" && v.severity === "high");
	if (!target) return undefined;
	let confirmed = false;
	try {
		confirmed = (await make()({ lens: target.lens, claim: target.claim, diff, proof, agentId })) === true;
	} catch {
		confirmed = false;
	}
	return { lens: target.lens, claim: target.claim, confirmed };
}

/**
 * The land-gate seam `SquadManager.landBranch` calls before dispatching to `landAgent`/`landAgentPr`
 * (DESIGN §1) — runs regardless of `requireProof`, so a forced land is still validated. Fail-open on
 * an unreachable judge, fail-closed on a real veto (DESIGN §3); a veto is bypassable ONLY by an
 * explicit `validator-override` (leaf 03) at the caller, never by this function itself.
 */
export async function validatorGate(opts: ValidatorGateOpts): Promise<ValidatorGateResult> {
	if (!validatorEnabled()) {
		return { record: { verdict: "skipped", agreement: 1, confidence: 0, perCriterion: [], rationale: "validator disabled (OMP_SQUAD_VALIDATOR=0)", ranAt: Date.now() } };
	}
	const criteriaSig = opts.criteria.map((c) => `${c.id}=${c.text}`).join("|");
	const cacheKey = opts.proof?.commit && opts.proof?.tree ? `${opts.proof.commit}:${opts.proof.tree}:${Bun.hash(criteriaSig)}` : undefined;
	const cached = cacheKey ? gateCache.get(cacheKey) : undefined;
	let record: ValidationRecord;
	if (cached) {
		record = cached;
	} else {
		const diff = await computeLandDiff(opts.repo, opts.worktree, opts.proof?.baseCommit);
		record = await scoreAgainstCriteria(opts.criteria, diff, opts.proof, opts.judge, opts.authorModel, opts.authorHarness, opts.agentId);
		// Advisory lenses: only on a clean pass, only when enabled, strictly after the criteria judge.
		// Build a NEW record (never mutate the one about to be cached-by-reference).
		if (record.verdict === "pass" && lensReviewEnabled()) {
			// Defensive outer catch: the panel is fail-open by construction (every judge call is guarded),
			// but this is the trust-critical land path — an outer catch guarantees that even a future throw
			// in selectLenses/runLensPanel (OUTSIDE runOneLens's per-lens guard) can never fail-CLOSE a land.
			try {
				const lensAdvisory = await runLensPanel(diff, opts.proof, criteriaSig, opts.lensJudge ?? ompLensJudge, opts.agentId);
				if (lensAdvisory.length > 0) {
					record = { ...record, lensAdvisory };
					// VERIFY re-check: structurally nested here (master flag already gated above) + its own sub-flag.
					if (lensVerifyEnabled()) {
						const lensVerify = await runLensVerify(lensAdvisory, diff, opts.proof, opts.lensVerifyJudge ?? ompLensVerifyJudge, opts.agentId);
						if (lensVerify) record = { ...record, lensVerify };
					}
				}
			} catch {
				// advisory only — a lens failure never touches the record's verdict or the land decision
			}
		}
		if (cacheKey) gateCache.set(cacheKey, record);
	}
	if (record.verdict !== "veto") return { record };
	const unmet = record.perCriterion.filter((p) => !p.satisfied).map((p) => p.id);
	return { record, veto: `validator veto: declared criteria unmet (${unmet.join(", ") || "unknown"})${record.rationale ? ` — ${record.rationale}` : ""}` };
}

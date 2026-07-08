/**
 * Smart spawn — turn one free-text line into a ready-to-run agent.
 *
 * Instead of filling out repo/name/model/approval/thinking, the user just types
 * what they want done. A fast model (omp --smol) reads the task plus the list of
 * candidate repos and returns a spawn plan: which repo to target, a short agent
 * name, and sensible model/approval/thinking. If the model is unreachable or
 * replies with junk, deterministic heuristics fill every field — the spawn never
 * fails just because inference did.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { envBool } from "./config.ts";
import type { ApprovalMode, CreateAgentOptions, ThinkingLevel } from "./types.ts";
import { decideTyped, extractJsonObject } from "./omp-call.ts";
import { DEFAULT_MODEL_FAMILY, tierOf, type ComplexityTier } from "./model-outcomes.ts";
import { DEFAULT_PROVIDER, modelLineage, type ModelLineage } from "./model-lineage.ts";
import type { ModelScore, Scoreboard } from "./attribution-scoreboard.ts";

const INFER_TIMEOUT_MS = 20_000;

/** A cold/unseen candidate is not eligible to WIN the shift — but is never starved below the
 *  baseline heuristic's traffic either; the shift only ADDS a preference toward a proven winner. */
export const MIN_SAMPLES = 8;
/** The eligible candidate must beat the incumbent default's landed-rate by at least this much
 *  before the shift fires — otherwise the default heuristic stands unchanged. */
export const MIN_EDGE = 0.15;
/**
 * Cost tie-break margin (research-sirvir/04), same 0..1 land-rate scale as `MIN_EDGE` — deliberately
 * much smaller. `MIN_EDGE` answers "is this candidate meaningfully BETTER at the task" (a quality
 * gate that alone decides whether a shift happens at all); `COST_TIE_EPSILON` answers a narrower
 * question — "are these two candidates close enough on land-rate that $/landed-change should be the
 * decider" — and ONLY applies among candidates that are otherwise a wash on quality. Cost never
 * competes with a genuine `MIN_EDGE` quality win (that would re-introduce the vetoed-escalation bug
 * the red-team caught); it only breaks a tie that land-rate alone couldn't call.
 */
export const COST_TIE_EPSILON = 0.05;

/** The two FAMILIES the current spawn heuristic picks between (SYSTEM_PROMPT's "opus for hard work,
 *  omit otherwise" — "omit" maps to `DEFAULT_MODEL_FAMILY`, the REAL family `model-outcomes.ts`
 *  resolves an undefined `model` to, not the old phantom `"default"` string that could never equal
 *  a recorded key). Not a capability classifier — a fixed, small candidate set for an outcome
 *  comparison, expressed in the SAME `modelFamily` namespace both record and read use
 *  (research-sirvir/02) so a candidate lookup can actually hit. */
const SHIFT_CANDIDATES = ["opus", DEFAULT_MODEL_FAMILY] as const;

/**
 * Cross-provider leak guard (research-sirvir/02, red-team MINOR 5): restrict a candidate list to
 * families compatible with the spawn's subscription provider — never let a well-landing family
 * from a DIFFERENT vendor's subscription (e.g. `openai`, if a future/wider candidate set ever
 * included one) become the chosen model for an Anthropic-subscription omp unit. `provider` defaults
 * to `DEFAULT_PROVIDER` (the fleet's dominant subscription vendor for omp spawns, same default
 * `rate-limit.ts` folds an unclassifiable unit into); a harness-pinned caller could override it.
 * Pure and exported so the guard is directly testable independent of today's (accidentally
 * same-vendor) `SHIFT_CANDIDATES` contents.
 */
export function eligibleCandidates(candidates: readonly string[], provider: ModelLineage = DEFAULT_PROVIDER): string[] {
	return candidates.filter((c) => modelLineage(c) === provider);
}

function landedRate(landed: number, rejected: number): number {
	const total = landed + rejected;
	return total > 0 ? landed / total : 0;
}

/** One model's row in the scoreboard, or `undefined` if it has no record at all (cold). */
function scoreFor(scoreboard: Scoreboard, model: string): ModelScore | undefined {
	return scoreboard.models.find((m) => m.model === model);
}

/** `{landed, rejected}` for one `(model, tier)` cell of a scoreboard row — `{0,0}` when the model
 *  has no row, or the row has no attempts recorded for this particular tier yet. */
function tierCounts(score: ModelScore | undefined, tier: ComplexityTier): { landed: number; rejected: number } {
	const row = score?.byTier.find((t) => t.tier === tier);
	return { landed: row?.landed ?? 0, rejected: row?.rejected ?? 0 };
}

/**
 * Boost-only, floored, never-overriding default shift (DESIGN.md's outcome-driven model default;
 * cost-weighted per research-sirvir/04):
 *  1. An explicit model already set (the LLM planner returned one) is NEVER overridden.
 *  2. Off unless `OMP_SQUAD_MODEL_OUTCOMES=1` AND a `scoreboard` is injected.
 *  3. Exploration floor is SYMMETRIC — it protects BOTH sides of the comparison from a small sample:
 *     - a WINNER candidate with fewer than `MIN_SAMPLES` total outcomes is not eligible to win;
 *     - the INCUMBENT (`DEFAULT_MODEL_FAMILY`, the REAL family an omitted model resolves to — never
 *       the old phantom `"default"` string, which could never equal a recorded key) must ALSO clear
 *       `MIN_SAMPLES` before its rate is trusted. An unmeasured incumbent is `{0,0}` → `landedRate` 0,
 *       which would otherwise read as "0% land rate" and let a thin/mediocre winner flip the default
 *       purely because the incumbent was never measured — starving the cold incumbent, the
 *       never-penalize rule inverted. So a cold incumbent means NO shift (the base heuristic
 *       stands), never a free win for the challenger.
 *  4. Candidates are further restricted to the spawn's provider (`eligibleCandidates`) — a
 *     cross-provider family (e.g. `openai`) is never eligible to win an Anthropic-subscription omp
 *     unit's shift, even if it would otherwise land the comparison (research-sirvir/02 MINOR 5).
 *  5. TWO-STAGE win condition, never a single blended sum (a blended `land-rate − λ·costRatio` was the
 *     red-team-CONFIRMED-broken draft: an unbounded cost ratio could veto every escalation, and a null
 *     incumbent cost divided-by-zero into `-Infinity`, both fixed by NOT dividing at all):
 *       a. QUALITY WIN — a candidate beats the incumbent's (trusted) land-rate by at least `MIN_EDGE`.
 *          This is checked and satisfied independent of cost — cost can never veto a real quality win,
 *          which is the whole point of the existing "escalate to opus for hard work" behavior.
 *       b. COST TIE-BREAK — ONLY for a candidate that does NOT already clear (a): if its land-rate is
 *          within `COST_TIE_EPSILON` of the incumbent's (i.e. quality-equivalent, not just "close"),
 *          AND both the candidate's and incumbent's `costPerLandedChange` are known (non-null; cost
 *          data is per-model, land-rate is per-`(model, tier)` — an acknowledged scope mismatch, see
 *          the module doc), AND the candidate is cheaper, it wins at equal quality. If either cost is
 *          null the comparison is skipped entirely (falls through to "no shift" for that candidate) —
 *          never a division, never an unbounded ratio, never `-Infinity`.
 *     Among multiple qualifying candidates the highest land-rate wins; a land-rate tie prefers the
 *     cheaper (known) cost.
 * Returns the (possibly) shifted model + an optional reason suffix; never mutates its input.
 */
function shiftedModel(currentModel: string | undefined, tier: ComplexityTier, scoreboard: Scoreboard | undefined): { model?: string; reasonSuffix?: string } {
	if (currentModel !== undefined) return {}; // never override an explicit choice
	if (!envBool("OMP_SQUAD_MODEL_OUTCOMES", false) || !scoreboard) return {};
	const incumbentScore = scoreFor(scoreboard, DEFAULT_MODEL_FAMILY);
	const incumbent = tierCounts(incumbentScore, tier);
	// Cold incumbent ⇒ no basis for comparison ⇒ no shift. Trusting an unmeasured incumbent's 0%
	// rate would penalize it exactly the way the winner-side floor forbids for a cold challenger.
	if (incumbent.landed + incumbent.rejected < MIN_SAMPLES) return {};
	const incumbentRate = landedRate(incumbent.landed, incumbent.rejected);
	const incumbentCost = incumbentScore?.costPerLandedChange ?? null;

	let best: { model: string; rate: number; cost: number | null; qualityWin: boolean } | undefined;
	for (const model of eligibleCandidates(SHIFT_CANDIDATES)) {
		if (model === DEFAULT_MODEL_FAMILY) continue; // the incumbent is never "the shift"
		const score = scoreFor(scoreboard, model);
		const o = tierCounts(score, tier);
		if (o.landed + o.rejected < MIN_SAMPLES) continue; // cold — not eligible to win, never starved either
		const rate = landedRate(o.landed, o.rejected);
		const cost = score?.costPerLandedChange ?? null;
		const qualityWin = rate - incumbentRate >= MIN_EDGE;
		const costTieWin = !qualityWin && Math.abs(rate - incumbentRate) <= COST_TIE_EPSILON && incumbentCost != null && cost != null && cost < incumbentCost;
		if (!qualityWin && !costTieWin) continue;
		if (!best || rate > best.rate || (rate === best.rate && (cost ?? Infinity) < (best.cost ?? Infinity))) best = { model, rate, cost, qualityWin };
	}
	if (!best) return {};
	const costNote = best.qualityWin ? "" : `, cheaper at equal quality ($${(best.cost ?? 0).toFixed(2)} vs $${(incumbentCost ?? 0).toFixed(2)}/landed)`;
	return { model: best.model, reasonSuffix: `model shifted to ${best.model} (${best.rate.toFixed(2)} land-rate, ${tier} tier${costNote})` };
}

export interface SpawnPlan extends CreateAgentOptions {
	/** One-line rationale for the chosen repo/name, surfaced in the UI. */
	reason?: string;
}

/** The raw, untrusted fields a model may return. */
export interface RawPlan {
	repo?: string;
	name?: string;
	model?: string;
	approval?: string;
	thinking?: string;
	reason?: string;
	requires?: string[];
	owns?: string[];
	produces?: string[];
	scopeSource?: "inferred" | "operator";
}

function isGitRepo(p: string): boolean {
	try {
		return fs.existsSync(path.join(p, ".git"));
	} catch {
		return false;
	}
}

/** Candidate repos the planner may target: cwd, repos squad already tracks, and a shallow scan of common roots. */
export function discoverRepos(cwd: string, tracked: string[]): string[] {
	const out = new Set<string>();
	if (isGitRepo(cwd)) out.add(path.resolve(cwd));
	for (const r of tracked) {
		if (r.length > 0 && isGitRepo(r)) out.add(path.resolve(r));
	}
	const home = process.env.HOME ?? "";
	const rootsEnv = process.env.OMP_SQUAD_REPO_ROOTS ?? [path.dirname(cwd), `${home}/sui`, `${home}/src`, `${home}/code`].join(",");
	for (const root of rootsEnv.split(",")) {
		const dir = root.trim();
		if (dir.length === 0) continue;
		let entries: string[];
		try {
			entries = fs.readdirSync(dir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry);
			if (isGitRepo(full)) out.add(path.resolve(full));
		}
	}
	return [...out];
}

/** A short, filesystem-safe agent name from arbitrary text. */
export function slug(text: string): string {
	const parts = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.split("-")
		.filter((p) => p.length > 0)
		.slice(0, 4);
	return parts.length > 0 ? parts.join("-") : "agent";
}

export function asApproval(v: string | undefined): ApprovalMode | undefined {
	return v === "always-ask" || v === "write" || v === "yolo" ? v : undefined;
}

export function asThinking(v: string | undefined): ThinkingLevel | undefined {
	return v === "minimal" || v === "low" || v === "medium" || v === "high" || v === "xhigh" ? v : undefined;
}

/** Pick the candidate whose name the task mentions, else the cwd, else the first candidate. */
export function pickRepoHeuristic(prompt: string, candidates: string[], cwd: string): string {
	const low = prompt.toLowerCase();
	let best: string | undefined;
	let bestLen = 0;
	for (const c of candidates) {
		const base = path.basename(c).toLowerCase();
		if (base.length > bestLen && low.includes(base)) {
			best = c;
			bestLen = base.length;
		}
	}
	if (best !== undefined) return best;
	const resolvedCwd = path.resolve(cwd);
	if (candidates.includes(resolvedCwd)) return resolvedCwd;
	return candidates[0] ?? resolvedCwd;
}

function stringArray(v: unknown): string[] | undefined {
	return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim()) : undefined;
}

/** Extract a single JSON object from model output and coerce its fields to strings. */
export function parsePlanJson(text: string): RawPlan | undefined {
	const r = extractJsonObject(text);
	if (!r) return undefined;
	const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined);
	const scopeSource = r.scopeSource === "operator" || r.scopeSource === "inferred" ? r.scopeSource : undefined;
	return { repo: str(r.repo), name: str(r.name), model: str(r.model), approval: str(r.approval), thinking: str(r.thinking), reason: str(r.reason), requires: stringArray(r.requires), owns: stringArray(r.owns), produces: stringArray(r.produces), scopeSource };
}

const SYSTEM_PROMPT =
	"You convert a developer's free-text task into a JSON spawn plan for a coding agent. " +
	"Reply with ONLY one JSON object, no prose, no code fences, no tools. Keys: " +
	'"repo" (absolute path; MUST be exactly one of the candidate paths — pick the best fit for the task, else the first), ' +
	'"name" (short kebab-case, 2-4 words, describing the task), ' +
	'"model" (optional: "opus" for hard/architectural work, omit otherwise), ' +
	'"approval" ("yolo" by default — squad agents run in isolated git worktrees, so auto-approve; use "write" or "always-ask" only if the task is risky and explicitly wants confirmation), ' +
	'"thinking" ("low" default; "high" for complex reasoning; "minimal" for trivial), ' +
	'"requires" (optional array of repo-relative path prefixes the task must read before producing work, e.g. ["src/api"]), ' +
	'"owns" (optional legacy array of repo-relative path prefixes the task will edit, e.g. ["src/web"] — used to keep parallel agents from touching the same files; omit if unsure), ' +
	'"produces" (optional array of repo-relative path prefixes the task will write/create; defaults to owns when omitted), ' +
	'"scopeSource" ("inferred" when you infer requires/owns/produces from the task; never use "operator" in this planner), ' +
	'"reason" (<=12 words explaining the repo+name choice).';

async function infer(prompt: string, candidates: string[]): Promise<RawPlan | undefined> {
	const user = `Candidate repos:\n${candidates.map((c) => `- ${c}`).join("\n")}\n\nTask: ${prompt}\n\nJSON:`;
	return decideTyped<RawPlan | undefined>({
		args: ["-p", "--smol", "--system-prompt", SYSTEM_PROMPT, user],
		timeoutMs: INFER_TIMEOUT_MS,
		parse: parsePlanJson,
		fallback: undefined,
	});
}

/**
 * Pure assembly: turn the model's raw (possibly absent/junk) plan into a complete, valid
 * `SpawnPlan`, then apply the outcome-driven default shift (concern 07). Factored out of
 * `planSpawn` so it's unit-testable without a live `omp` binary — `infer()`'s LLM call has no
 * injection seam of its own, but the assembly + shift logic (the part concern 07 actually adds)
 * is fully deterministic given `raw`, so it doesn't need one.
 */
export function assemblePlan(prompt: string, candidates: string[], cwd: string, raw: RawPlan | undefined, opts: { scoreboard?: Scoreboard } = {}): SpawnPlan {
	const claimed = raw?.repo === undefined ? undefined : path.resolve(raw.repo);
	const repo = claimed !== undefined && candidates.includes(claimed) ? claimed : pickRepoHeuristic(prompt, candidates, cwd);

	const plan: SpawnPlan = { repo, name: raw?.name ? slug(raw.name) : slug(prompt), task: prompt };
	if (raw?.model !== undefined) plan.model = raw.model;
	// Default to yolo: squad agents work in isolated worktrees and are reviewed via diff before Land, so prompting for every tool just gets in the way.
	plan.approvalMode = asApproval(raw?.approval) ?? "yolo";
	const thinking = asThinking(raw?.thinking);
	if (thinking !== undefined) plan.thinking = thinking;
	if (raw?.reason !== undefined) plan.reason = raw.reason;
	if (raw?.requires?.length) plan.requires = raw.requires;
	if (raw?.owns?.length) plan.owns = raw.owns;
	if (raw?.produces?.length) plan.produces = raw.produces;
	if (raw?.requires?.length || raw?.owns?.length || raw?.produces?.length) plan.scopeSource = "inferred";

	// Outcome-driven, cost-weighted model default (Epic 6 concern 07; research-sirvir/04) — never
	// overrides an explicit `plan.model` (checked first thing inside `shiftedModel`); off unless
	// OMP_SQUAD_MODEL_OUTCOMES=1 AND a `scoreboard` was injected.
	//
	// NO HYSTERESIS — reviewed and accepted (PR #114 cross-lineage review), a decision, not an
	// oversight: the shift is recomputed statelessly per spawn, so two near-equal candidates whose
	// measured rates/costs straddle a threshold can alternate across consecutive spawns as new
	// outcomes land. Accepted because the blast radius is bounded — the shift only fires past the
	// MIN_EDGE / COST_TIE_EPSILON gates, never overrides an explicit model, and the whole feature
	// sits behind a default-off flag. If flapping ever matters in practice, the fix is a sticky
	// margin (require the previous winner to be beaten by an extra epsilon), not per-spawn memory.
	const shift = shiftedModel(plan.model, tierOf(thinking), opts.scoreboard);
	if (shift.model !== undefined) {
		plan.model = shift.model;
		plan.reason = [plan.reason, shift.reasonSuffix].filter((s): s is string => !!s).join(" + ");
	}
	return plan;
}

/** Resolve a free-text task into a complete, valid spawn plan. Never throws; always returns a usable plan. */
export async function planSpawn(prompt: string, opts: { cwd: string; candidates: string[]; scoreboard?: Scoreboard }): Promise<SpawnPlan> {
	const candidates = opts.candidates.length > 0 ? opts.candidates : [path.resolve(opts.cwd)];
	const raw = await infer(prompt, candidates);
	return assemblePlan(prompt, candidates, opts.cwd, raw, { scoreboard: opts.scoreboard });
}

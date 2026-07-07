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

import { envInt } from "./config.ts";
import { GIT_HARDEN_ARGS, GIT_HARDEN_ENV } from "./git-harden.ts";
import { decideTyped, extractJsonObject } from "./omp-call.ts";
import type { Proof } from "./proof.ts";
import type { FeatureCriterion, ValidationRecord } from "./types.ts";

/** Raw per-criterion verdict shape the judge is asked to emit (before coercion into `perCriterion`). */
export interface RawVerdict {
	perCriterion: { id: string; satisfied: boolean; note?: string }[];
	confidence?: number;
	rationale?: string;
}

/** Injected judge seam — the default is a one-shot `omp -p` call; tests pass a fake. Never throws
 *  by contract (a throw is treated the same as `undefined` — abstain, fail-open). */
export type Judge = (input: { criteria: FeatureCriterion[]; diff: string; proof?: Proof }) => Promise<RawVerdict | undefined>;

const RATIONALE_MAX = 600;

function truncate(s: string, n: number): string {
	return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/** Independent of the executor's model default (sonnet) — see DESIGN §2. */
function validatorModel(): string {
	return process.env.OMP_SQUAD_VALIDATOR_MODEL ?? "opus";
}

const SYSTEM_PROMPT =
	"You are an INDEPENDENT validator judging whether a code change satisfies a list of DECLARED acceptance criteria. " +
	"You did not write this code and must not trust the author's own claims — inspect the diff (and proof output, if given) " +
	'directly. For EACH criterion, decide satisfied:true only if the diff visibly implements it. Respond with EXACTLY one JSON ' +
	'object and nothing else: {"perCriterion":[{"id":"<criterion id>","satisfied":true|false,"note":"<short reason>"}],' +
	'"confidence":0..1,"rationale":"<short overall rationale>"}.';

function parseRawVerdict(raw: string): RawVerdict | undefined {
	const obj = extractJsonObject(raw);
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

/** Default judge: an independent one-shot `omp -p --model <lineage>` call. `Bun.which("omp")` missing,
 *  a timeout, or unparseable output all degrade to `undefined` via `decideTyped`'s fallback — never throws. */
function defaultJudge(): Judge {
	return ({ criteria, diff, proof }) => {
		const criteriaText = criteria.map((c) => `- [${c.id}] ${c.text}`).join("\n");
		const proofTail = proof?.detail ? `\n\nProof output (tail):\n${truncate(proof.detail, 2000)}` : "";
		const user = `Declared acceptance criteria:\n${criteriaText}\n\nDiff:\n${truncate(diff, 12000)}${proofTail}`;
		return decideTyped<RawVerdict | undefined>({
			args: ["-p", "--model", validatorModel(), "--system-prompt", SYSTEM_PROMPT, user],
			parse: parseRawVerdict,
			fallback: undefined,
			timeoutMs: envInt("OMP_SQUAD_VALIDATOR_TIMEOUT_MS", 120_000),
		});
	};
}

/**
 * Score `diff` against DECLARED `criteria`. Never throws.
 *  - empty `criteria` ⇒ `"skipped"` (DESIGN §4 — never invents criteria to grade against).
 *  - judge unreachable/unparseable/throws ⇒ `"abstain"` (fail-open, DESIGN §3).
 *  - otherwise every input criterion gets a `perCriterion` entry (one the judge didn't mention
 *    defaults to `satisfied:false`); `"veto"` iff any is unsatisfied, else `"pass"`.
 */
export async function scoreAgainstCriteria(criteria: FeatureCriterion[], diff: string, proof?: Proof, judge: Judge = defaultJudge()): Promise<ValidationRecord> {
	const ranAt = Date.now();
	if (criteria.length === 0) {
		return { verdict: "skipped", agreement: 1, confidence: 0, perCriterion: [], rationale: "no declared criteria", ranAt };
	}
	// An empty diff means there is nothing to inspect — declared criteria cannot be judged against no
	// change. Abstain (fail-open) rather than fabricating a veto for a change the judge never saw. This
	// covers the in-place (worktree === repo) case where the base collapses to HEAD, plus any no-op land.
	if (!diff.trim()) {
		return { verdict: "abstain", agreement: 0, confidence: 0, perCriterion: [], rationale: "empty diff — nothing to validate (in-place or no-op land); not scored", model: validatorModel(), ranAt };
	}
	let raw: RawVerdict | undefined;
	try {
		raw = await judge({ criteria, diff, proof });
	} catch {
		raw = undefined;
	}
	if (!raw || raw.perCriterion.length === 0) {
		return { verdict: "abstain", agreement: 0, confidence: 0, perCriterion: [], rationale: "judge unavailable or returned no verdict", model: validatorModel(), ranAt };
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
		rationale: truncate(raw.rationale ?? "", RATIONALE_MAX),
		model: validatorModel(),
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
	return process.env.OMP_SQUAD_VALIDATOR !== "0";
}

/** Verdict cache keyed by `${proof.commit}:${proof.tree}:${criteriaHash}` so repeated land attempts on
 *  the same tree (a retry after an unrelated block, a re-land after fixing something else) reuse the
 *  judge's verdict instead of re-firing an LLM call — but a change to the declared criteria (a genuine
 *  input to the verdict) busts the entry rather than reusing a stale one. Mirrors `proofRoot`-style
 *  module state in proof.ts. */
const gateCache = new Map<string, ValidationRecord>();

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
		let diff = await gitOut(["diff", "--no-ext-diff", `${base}...HEAD`], worktree);
		// In-place (worktree === repo) the base collapses to HEAD, so `base...HEAD` is empty even though
		// the unit made real commits. Recover the true change set via the merge-base with the tracked
		// upstream / default branch when one is resolvable; otherwise leave it empty (→ honest abstain).
		if (!diff && worktree === repo) {
			const upstream =
				(await gitOut(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], repo)) ||
				(await gitOut(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo));
			if (upstream) {
				const mergeBase = await gitOut(["merge-base", upstream, "HEAD"], repo);
				if (mergeBase && mergeBase !== base) diff = await gitOut(["diff", "--no-ext-diff", `${mergeBase}...HEAD`], worktree);
			}
		}
		return diff;
	} catch {
		return "";
	}
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
	const record = cached ?? (await scoreAgainstCriteria(opts.criteria, await computeLandDiff(opts.repo, opts.worktree, opts.proof?.baseCommit), opts.proof, opts.judge));
	if (cacheKey && !cached) gateCache.set(cacheKey, record);
	if (record.verdict !== "veto") return { record };
	const unmet = record.perCriterion.filter((p) => !p.satisfied).map((p) => p.id);
	return { record, veto: `validator veto: declared criteria unmet (${unmet.join(", ") || "unknown"})${record.rationale ? ` — ${record.rationale}` : ""}` };
}

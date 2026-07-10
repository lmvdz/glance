/**
 * Resident planner core — the decision-heavy heart of the autonomous planner loop.
 * Zero filesystem/daemon I/O so it is fully unit-testable: this module only builds a
 * prompt, decodes the model's JSON answer into a validated `ConcernDraft[]`, and
 * orchestrates one decompose call through an injected `classify` fn (mirrors
 * `routeIntake`'s injected-`Classify` pattern in intake.ts). The writer (plan-writer.ts)
 * and the loop (resident-planner.ts) are the only things that touch disk or `omp`.
 *
 * This is the INVERSE of plan-sync.ts: plan-sync reconciles STATUS downward off Plane
 * state; this module is the pure decision core that lets the resident planner build the
 * frontier upward from an objective. It never emits STATUS values other than the
 * implicit "open" (STATUS is always written `open` by the writer) and never emits a
 * `PLANE:` pointer — filing to Plane is an existing, separate pipeline.
 */

import { VERDICT_FIRST_BLOCK } from "./agent-profiles.ts";
import type { PlanConcern } from "./features.ts";

/** One concern the model wants planned. Field names map 1:1 onto the frontmatter
 *  `parsePlanConcerns` (features.ts:360) reads back — see plan-writer.ts. */
export interface ConcernDraft {
	/** NN ordering / filename prefix, dense 1..N within one decompose call. */
	num: number;
	/** kebab-case filename stem, e.g. "resident-loop". */
	slug: string;
	/** "# " heading. */
	title: string;
	priority: "p0" | "p1" | "p2" | "p3";
	complexity: "mechanical" | "architectural" | "research";
	/** TOUCHES: line — file paths this concern is expected to touch. */
	touches: string[];
	/**
	 * IN-BATCH sibling concern numbers (in this same decompose call's dense 1..N space) this
	 * concern is blocked by. These FOLLOW every renumbering — parseConcernDrafts's dense
	 * renumbering AND the writer's reserved-collision remap — because they name other drafts.
	 * Kept numerically SEPARATE from `blockedByExternal` on purpose: once both are flattened to
	 * plain numbers they become indistinguishable, and the writer can no longer tell a sibling
	 * edge that must be remapped from an external edge that must stay fixed (the SIG-1 bug).
	 */
	blockedBy: number[];
	/**
	 * EXTERNAL blocker refs: numbers pointing at concerns that already exist on disk (a verified /
	 * existing concern the decompose prompt named by its real number). These are FIXED — never
	 * touched by any draft renumbering, because they don't name a draft. The DAG gate
	 * (validatePlanConcerns) is the backstop for a hallucinated external ref that resolves to
	 * nothing.
	 */
	blockedByExternal: number[];
	/** "## Goal" prose. */
	goal: string;
	/** "## Approach" prose. */
	approach: string;
	/** "## Acceptance Criteria" bullets. */
	acceptance: string[];
}

/** A structurally-valid draft straight off the model, BEFORE the in-batch/external split and the
 *  dense topological renumber. `blockedBy` here is the raw, un-split model number list. */
interface RawDraft {
	num: number;
	slug: string;
	title: string;
	priority: ConcernDraft["priority"];
	complexity: ConcernDraft["complexity"];
	touches: string[];
	blockedBy: number[];
	goal: string;
	approach: string;
	acceptance: string[];
}

/** A concern already known to be verified-done (terminal STATUS, or a recorded DoneProof
 *  against its `planeId`) — passed into the prompt as "already complete, do not re-emit". */
export interface VerifiedConcern {
	num?: number;
	title: string;
	planeId?: string;
}

export interface DecomposeDeps {
	objective: string;
	verified: VerifiedConcern[];
	existing: PlanConcern[];
	/** One-shot LLM call (e.g. `ompClassify(bin)`); injected so tests are hermetic. */
	classify: (prompt: string) => Promise<string>;
}

/**
 * Suggested `classify` timeout budget for a real decompose call — a full multi-concern JSON plan
 * with goal/approach/acceptance prose per concern is a substantive generation task, not the ~1s
 * classification prompts `ompClassify`'s own default budget is tuned for (intake.ts/scout.ts).
 * Matches the order of magnitude of this codebase's other substantive one-shot calls (e.g.
 * supervisor.ts's 60s `DECIDE_TIMEOUT_MS`). Callers wiring the real `omp` classify (squad-manager.ts,
 * index.ts's plan-decompose CLI) should pass this to `ompClassify(bin, timeoutMs)`.
 */
export const DECOMPOSE_TIMEOUT_MS = 60_000;

const PRIORITIES = new Set(["p0", "p1", "p2", "p3"]);
const COMPLEXITIES = new Set(["mechanical", "architectural", "research"]);

/** Assemble the LLM prompt for one decompose call. Lists verified-done concerns as
 *  already-complete (do not re-emit) and existing open concerns as already-planned
 *  (refine / keep their numbers), then demands a strict JSON array response. */
export function buildDecomposePrompt(objective: string, verified: VerifiedConcern[], existing: PlanConcern[]): string {
	const verifiedBlock = verified.length
		? verified.map((v) => `- ${v.num != null ? `#${v.num} ` : ""}${v.title}${v.planeId ? ` (${v.planeId})` : ""} — already complete, do NOT re-emit`).join("\n")
		: "(none yet)";
	const existingBlock = existing.length
		? existing.map((c) => `- ${c.title} [${c.status}] — already planned; refine it or keep it as-is`).join("\n")
		: "(none yet)";
	return `You are the resident planner for an autonomous engineering fleet. Decompose the objective below into a concern-DAG: small, independently landable units of work.

OBJECTIVE:
${objective}

VERIFIED-DONE CONCERNS (already complete — do NOT re-emit these; they stay off the plan):
${verifiedBlock}

EXISTING OPEN CONCERNS (already planned — refine and keep, add new ones as needed):
${existingBlock}

Plan ONLY the remaining frontier: the work still needed to reach the objective, given what is already verified-done. Do not re-emit a verified-done concern under a new number.

Respond with ONLY a strict JSON array (no prose, no markdown code fence) of concern objects, each shaped exactly like:
{"num": <int>, "slug": "<kebab-case-file-stem>", "title": "<string>", "priority": "p0"|"p1"|"p2"|"p3", "complexity": "mechanical"|"architectural"|"research", "touches": ["<file path>", ...], "blockedBy": [<concern num>, ...], "goal": "<prose>", "approach": "<prose>", "acceptance": ["<criterion>", ...]}

Respond with a JSON array only.

${VERDICT_FIRST_BLOCK}`;
}

/** Extract the outermost `[...]` JSON array from noisy model output (fences/prose tolerant). */
function extractJsonArray(raw: string): unknown[] | undefined {
	const start = raw.indexOf("[");
	const end = raw.lastIndexOf("]");
	if (start < 0 || end <= start) return undefined;
	try {
		const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
		return Array.isArray(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function slugify(s: string): string {
	const slug = s
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "concern";
}

function stringArray(v: unknown): string[] | undefined {
	if (!Array.isArray(v)) return undefined;
	if (!v.every((x) => typeof x === "string")) return undefined;
	return v.map((x) => (x as string).trim()).filter((x) => x.length > 0);
}

function numberArray(v: unknown): number[] | undefined {
	if (!Array.isArray(v)) return undefined;
	if (!v.every((x) => typeof x === "number" && Number.isFinite(x))) return undefined;
	return v as number[];
}

/** Structurally validate + normalize one raw JSON item into a `RawDraft` (num not yet renumbered,
 *  blockedBy not yet split into in-batch vs external). */
function normalizeDraft(raw: unknown): RawDraft | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as Record<string, unknown>;

	const num = typeof r.num === "number" && Number.isFinite(r.num) ? r.num : undefined;
	const title = typeof r.title === "string" && r.title.trim() ? r.title.trim() : undefined;
	const goal = typeof r.goal === "string" ? r.goal.trim() : undefined;
	const approach = typeof r.approach === "string" ? r.approach.trim() : "";
	const priorityRaw = typeof r.priority === "string" ? r.priority.toLowerCase().trim() : "";
	const priority = PRIORITIES.has(priorityRaw) ? (priorityRaw as ConcernDraft["priority"]) : undefined;
	const complexityRaw = typeof r.complexity === "string" ? r.complexity.toLowerCase().trim() : "";
	const complexity = COMPLEXITIES.has(complexityRaw) ? (complexityRaw as ConcernDraft["complexity"]) : undefined;
	const touches = stringArray(r.touches);
	const blockedBy = r.blockedBy === undefined ? [] : numberArray(r.blockedBy);
	const acceptance = stringArray(r.acceptance);
	const slug = typeof r.slug === "string" && r.slug.trim() ? slugify(r.slug) : title ? slugify(title) : undefined;

	if (num === undefined || title === undefined || goal === undefined || priority === undefined || complexity === undefined || touches === undefined || blockedBy === undefined || acceptance === undefined || slug === undefined) {
		return undefined;
	}
	return { num, slug, title, priority, complexity, touches, blockedBy, goal, approach, acceptance };
}

/** Kahn's algorithm restricted to edges within `nums` (external blockedBy refs are ignored here —
 *  they point at concerns outside this batch, e.g. an already-numbered existing/verified concern,
 *  and are left untouched by renumbering). Returns a topological order, or `undefined` on a cycle. */
function topoOrder(nums: number[], blockedByOf: Map<number, number[]>): number[] | undefined {
	const inBatch = new Set(nums);
	const indegree = new Map<number, number>();
	const dependents = new Map<number, number[]>();
	for (const n of nums) indegree.set(n, 0);
	for (const n of nums) {
		for (const b of blockedByOf.get(n) ?? []) {
			if (!inBatch.has(b)) continue; // external ref — not part of this batch's graph
			indegree.set(n, (indegree.get(n) ?? 0) + 1);
			const deps = dependents.get(b) ?? [];
			deps.push(n);
			dependents.set(b, deps);
		}
	}
	const queue = nums.filter((n) => (indegree.get(n) ?? 0) === 0);
	const order: number[] = [];
	while (queue.length > 0) {
		const n = queue.shift()!;
		order.push(n);
		for (const dep of dependents.get(n) ?? []) {
			const next = (indegree.get(dep) ?? 0) - 1;
			indegree.set(dep, next);
			if (next === 0) queue.push(dep);
		}
	}
	return order.length === nums.length ? order : undefined; // fewer than N ⇒ a cycle remains
}

/**
 * Pure decode of the model's JSON output: extracts the array (tolerating fences/prose),
 * validates + normalizes every field, rejects an obviously-cyclic draft set (self-reference
 * or a multi-node cycle within the batch — the writer's DAG gate is the second line of
 * defense for anything this pure check can't see, e.g. refs to concerns outside the batch),
 * and renumbers to a dense 1..N in topological order. Returns `undefined` on any structural
 * violation so callers fall back rather than crash or write garbage.
 */
export function parseConcernDrafts(raw: string): ConcernDraft[] | undefined {
	const arr = extractJsonArray(raw);
	if (!arr) return undefined;

	const drafts: RawDraft[] = [];
	for (const item of arr) {
		const d = normalizeDraft(item);
		if (!d) return undefined;
		drafts.push(d);
	}
	if (drafts.length === 0) return [];

	const nums = drafts.map((d) => d.num);
	if (new Set(nums).size !== nums.length) return undefined; // duplicate num ⇒ ambiguous
	for (const d of drafts) {
		if (d.blockedBy.includes(d.num)) return undefined; // self-reference
	}

	const blockedByOf = new Map(drafts.map((d) => [d.num, d.blockedBy] as const));
	const order = topoOrder(nums, blockedByOf);
	if (!order) return undefined; // multi-node cycle within the batch

	const renumber = new Map(order.map((oldNum, i) => [oldNum, i + 1] as const));
	const inBatch = new Set(nums);
	const byOldNum = new Map(drafts.map((d) => [d.num, d] as const));
	return order.map((oldNum) => {
		const d = byOldNum.get(oldNum)!;
		// Partition every blocker at the ONE place we can still tell the two apart: refs to another
		// draft in this batch (in-batch — remap to its new dense number) vs refs to a concern that
		// already exists on disk (external — the model named its real number; keep it verbatim).
		// Carrying this split forward is what stops the writer from having to numerically guess.
		const inBatchRefs = uniqueNums(d.blockedBy.filter((b) => inBatch.has(b)).map((b) => renumber.get(b)!));
		const externalRefs = uniqueNums(d.blockedBy.filter((b) => !inBatch.has(b)));
		return {
			num: renumber.get(oldNum)!,
			slug: d.slug,
			title: d.title,
			priority: d.priority,
			complexity: d.complexity,
			touches: d.touches,
			blockedBy: inBatchRefs,
			blockedByExternal: externalRefs,
			goal: d.goal,
			approach: d.approach,
			acceptance: d.acceptance,
		};
	});
}

function uniqueNums(nums: number[]): number[] {
	return [...new Set(nums)].sort((a, b) => a - b);
}

/**
 * Orchestrate one decomposition: build the prompt, call the injected `classify`, parse the
 * result. Never throws — any failure (LLM error, malformed JSON, structural violation) folds
 * to `[]` so a resident-planner tick treats it as "nothing to plan this round", not a crash.
 */
export async function decompose(deps: DecomposeDeps): Promise<ConcernDraft[]> {
	try {
		const prompt = buildDecomposePrompt(deps.objective, deps.verified, deps.existing);
		const raw = await deps.classify(prompt);
		return parseConcernDrafts(raw) ?? [];
	} catch {
		return [];
	}
}

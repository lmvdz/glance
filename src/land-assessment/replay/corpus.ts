/**
 * Replay corpus reconstruction (concern 05, `plans/land-assessment/05-replay-corpus.md`) — the four
 * evaluation sources BRIEF §10.4 names, made concrete: (B, M, C) triples + outcome labels recovered
 * from glance's own land history, from THREE independent git/GitHub sources (the fourth source,
 * synthetic pairs, is `synthesize.ts`).
 *
 * Every triple is `AnalyzerContext`-shaped (`{repo, baseCommit, mainCommit, candidateCommit}`) so a
 * later replay CLI (concern 06) can feed it straight into `runAnalyzers` without translation, plus
 * `source`/`branch`/`prNumber`/`landedAt` metadata and a joined `outcome` label for confidence slicing.
 *
 * Three reconstruction sources, each a pure(ish) function over one already-local git checkout — no
 * mutation, no network by default:
 *
 *   merge-commit    `git log --merges --first-parent <mainRef>` — for each merge commit its own two
 *                   parents ARE (M, C); `merge-base(M, C)` is B. Zero network, always available.
 *   pr-merge        Caller-supplied `gh pr list --state merged --json number,headRefOid,baseRefOid,
 *                   mergeCommit,mergedAt` rows (this module never shells to `gh` itself — the network
 *                   dependency is the CALLER's to own, per the concern's "documented, never fabricated"
 *                   requirement). C = headRefOid, M = mergeCommit.oid's own first parent (the main tip
 *                   the squash/rebase ACTUALLY composed against, capturing sibling-train drift — see
 *                   `incident-manifest.json`'s ratchet-train entries), B = a LOCALLY computed
 *                   `merge-base(C, M)` — deliberately not `baseRefOid` taken at face value, since that
 *                   GitHub field is a live pointer into the base branch's current tip, not a frozen
 *                   historical fact; a locally computed merge-base is honest about what it actually
 *                   proves. Any SHA not present in the local object store (never fetched) degrades that
 *                   one PR to a coverage gap — never fabricated, never silently fetched by this module.
 *   ff-local-land   The one source invisible to the other two: a `git merge --ff-only` land leaves NO
 *                   merge commit and no GitHub PR trail, so C is recoverable only from the DoneProof
 *                   ledger's `byBranch[branch].commit` (`mode: "local"`, `baseRef: "HEAD"` — the local-FF
 *                   marker `squad-manager.ts` stamps). A genuine fast-forward is a git-theoretic
 *                   invariant: B == M (there is no divergence to speak of — the very definition of "the
 *                   candidate already contains main's tip as an ancestor"), so the only unknown is WHICH
 *                   commit that shared tip was. That is recoverable, while it lasts, from the target
 *                   ref's OWN reflog (`git log -g --format=%H <mainRef>`): the entry immediately BEFORE
 *                   the one matching C is exactly the pre-land main tip. A DoneProof entry whose `commit`
 *                   was actually landed via a real merge commit (land.ts's `--no-ff` fallback) is excluded
 *                   here, not gapped — it is recovered instead by the merge-commit source above, and
 *                   double-reconstructing it under two sources would be a false-precision trap. Reflog
 *                   expiry, a non-local clone, or an ambiguous multi-match all degrade to a documented gap.
 *
 * Outcome labels join `done-proofs.json` / `land-failures.json` / `land-forced.json` /
 * `land-validator-override.json` by EXACT commit or branch equality — never substring (a partial-string
 * match on a branch/commit id is exactly the kind of false-positive join that would poison the corpus's
 * evaluability). `splitCorpusAt` is the pure temporal-holdout filter over the reconstructed corpus.
 */

import { createHash } from "node:crypto";
import { readDoneProofLedger, type DoneProof } from "../../done-proof.ts";
import { readForcedLands, readLandLedger, readValidatorOverrides } from "../../land-ledger.ts";
import { computeRepositoryId } from "../id.ts";
import { git, type AnalyzerContext } from "../analyzers/plugin.ts";

// ── shapes ───────────────────────────────────────────────────────────────────────────────────────────

export type ReplaySource = "merge-commit" | "pr-merge" | "ff-local-land";

export type ReplayVerified = "green" | "red-baseline" | "unverified" | "unknown";

/** Joined from the four land ledgers, EXACT-equality only (never substring) — see the module doc. */
export interface ReplayOutcomeLabel {
	verified: ReplayVerified;
	forced: boolean;
	validatorOverridden: boolean;
	/** `land-failures.json`'s consecutive-failure streak observed for the joined branch; 0 when no
	 *  entry/branch was joinable — NOT necessarily "zero failures ever" (see `ReplayTriple.branch`). */
	failureStreakAtOutcome: number;
}

/** `AnalyzerContext`-shaped by construction so a replay CLI (concern 06) can pass a `ReplayTriple`
 *  straight into `runAnalyzers` with no translation step. */
export interface ReplayTriple extends AnalyzerContext {
	id: string;
	source: ReplaySource;
	branch?: string;
	prNumber?: number;
	/** ISO 8601 — the historical moment this attempt actually landed/composed. Absent when the source
	 *  could not recover a timestamp (never fabricated as "now"). `splitCorpusAt` treats an absent
	 *  `landedAt` as a THIRD bucket, never silently training/holdout-classified. */
	landedAt?: string;
	outcome: ReplayOutcomeLabel;
}

export interface CorpusGap {
	reason: string;
	branch?: string;
	prNumber?: number;
	commit?: string;
}

export interface CorpusCoverage {
	source: ReplaySource;
	/** How many candidate attempts this source's raw input offered (merge commits found, PR rows
	 *  supplied, done-proof entries matching this source's marker) — the denominator `recovered` is
	 *  measured against, so "0 recovered" is legible as "0 attempted" vs "N attempted, all gapped". */
	attempted: number;
	recovered: number;
	gaps: CorpusGap[];
}

export interface ReplayCorpus {
	repositoryId: string;
	triples: ReplayTriple[];
	coverage: CorpusCoverage[];
	generatedAt: string;
}

function stableId(...parts: string[]): string {
	return createHash("sha1").update(parts.join("\0")).digest("hex").slice(0, 20);
}

function nowIso(): string {
	return new Date().toISOString();
}

// ── outcome-label join (shared by all three sources) ───────────────────────────────────────────────

interface LedgerIndices {
	doneProofsByBranch: Map<string, DoneProof>;
	doneProofsByCommit: Map<string, DoneProof>; // keyed by BOTH .commit and .mergeCommit, when present
	landFailuresByBranch: Map<string, number>;
	forcedBranches: Set<string>;
	overriddenBranches: Set<string>;
}

function buildLedgerIndices(stateDir: string): LedgerIndices {
	const ledger = readDoneProofLedger(stateDir);
	const doneProofsByBranch = new Map<string, DoneProof>(Object.entries(ledger.byBranch));
	const doneProofsByCommit = new Map<string, DoneProof>();
	for (const proof of Object.values(ledger.byBranch)) {
		if (proof.commit) doneProofsByCommit.set(proof.commit, proof);
		if (proof.mergeCommit) doneProofsByCommit.set(proof.mergeCommit, proof);
	}
	const landFailures = readLandLedger(stateDir);
	const landFailuresByBranch = new Map<string, number>(Object.entries(landFailures).map(([branch, f]) => [branch, f.fails]));
	const forcedBranches = new Set(readForcedLands(stateDir).map((f) => f.branch));
	const overriddenBranches = new Set(readValidatorOverrides(stateDir).map((o) => o.branch));
	return { doneProofsByBranch, doneProofsByCommit, landFailuresByBranch, forcedBranches, overriddenBranches };
}

/**
 * Resolve one triple's outcome label. Commit-exact join takes priority (it can never be fooled by a
 * reused branch name landing twice under different outcomes); branch-exact join is the fallback ONLY
 * when no commit in `candidateCommits` matched anything in the ledger. Both comparisons are `===` —
 * SCHEMA-independent of this module, but the concern's own explicit "never substring" requirement.
 */
function joinOutcome(indices: LedgerIndices, branch: string | undefined, candidateCommits: readonly string[]): ReplayOutcomeLabel {
	let matched: DoneProof | undefined;
	for (const c of candidateCommits) {
		const hit = indices.doneProofsByCommit.get(c);
		if (hit) {
			matched = hit;
			break;
		}
	}
	if (!matched && branch) matched = indices.doneProofsByBranch.get(branch);
	const resolvedBranch = matched?.branch ?? branch;
	const verified: ReplayVerified = matched ? matched.verified : "unknown";
	const forced = resolvedBranch ? indices.forcedBranches.has(resolvedBranch) : false;
	const validatorOverridden = resolvedBranch ? indices.overriddenBranches.has(resolvedBranch) : false;
	const failureStreakAtOutcome = resolvedBranch ? (indices.landFailuresByBranch.get(resolvedBranch) ?? 0) : 0;
	return { verified, forced, validatorOverridden, failureStreakAtOutcome };
}

// ── source 1: merge commits ─────────────────────────────────────────────────────────────────────────

const MERGE_BRANCH_PATTERNS: RegExp[] = [
	/^Merge (\S+):/, // land.ts's own message: `Merge ${branch}: ${message}`
	/^Merge pull request #\d+ from [^/\s]+\/(\S+)/, // GitHub's default merge-commit subject
];

function extractBranchFromMergeSubject(subject: string): string | undefined {
	for (const re of MERGE_BRANCH_PATTERNS) {
		const m = re.exec(subject);
		if (m) return m[1];
	}
	return undefined;
}

/**
 * Source 1: `git log --merges --first-parent <mainRef>` — one triple per merge commit, no network, no
 * ledger dependency for RECOVERY (the ledger only feeds the outcome-label join). An octopus merge
 * (>2 parents) has no single (M, C) pair to assign and is reported as a gap, never guessed at.
 */
export async function reconstructMergeCommitTriples(repo: string, mainRef: string, stateDir: string): Promise<{ triples: ReplayTriple[]; coverage: CorpusCoverage }> {
	const resolvedRepo = computeRepositoryId(repo);
	const indices = buildLedgerIndices(stateDir);
	const gaps: CorpusGap[] = [];
	const log = await git(["log", "--merges", "--first-parent", "--format=%H", mainRef], resolvedRepo);
	if (log.code !== 0) {
		return { triples: [], coverage: { source: "merge-commit", attempted: 0, recovered: 0, gaps: [{ reason: `git log --merges probe failed: ${log.stderr || log.stdout || "no output"}` }] } };
	}
	const mergeShas = log.stdout.split("\n").filter(Boolean);
	const triples: ReplayTriple[] = [];
	for (const sha of mergeShas) {
		const parents = await git(["rev-list", "--parents", "-n", "1", sha], resolvedRepo);
		if (parents.code !== 0 || !parents.stdout) {
			gaps.push({ reason: `could not resolve parents of merge commit ${sha}: ${parents.stderr || "no output"}`, commit: sha });
			continue;
		}
		const shas = parents.stdout.split(/\s+/).filter(Boolean);
		const [, p1, p2, ...rest] = shas; // shas[0] === sha itself
		if (!p1 || !p2 || rest.length > 0) {
			gaps.push({ reason: `merge commit ${sha} has ${shas.length - 1} parent(s), not exactly 2 (octopus merge or malformed history) — no single (M, C) pair to assign`, commit: sha });
			continue;
		}
		const mb = await git(["merge-base", p1, p2], resolvedRepo);
		if (mb.code !== 0 || !mb.stdout) {
			gaps.push({ reason: `merge-base(${p1}, ${p2}) failed for merge commit ${sha}: ${mb.stderr || "no output"}`, commit: sha });
			continue;
		}
		const subjectRun = await git(["log", "-1", "--format=%s", sha], resolvedRepo);
		const branch = subjectRun.code === 0 ? extractBranchFromMergeSubject(subjectRun.stdout) : undefined;
		const dateRun = await git(["log", "-1", "--format=%cI", sha], resolvedRepo);
		const landedAt = dateRun.code === 0 && dateRun.stdout ? dateRun.stdout : undefined;
		const outcome = joinOutcome(indices, branch, [p2, sha]);
		triples.push({
			id: stableId("merge-commit", resolvedRepo, sha),
			source: "merge-commit",
			repo: resolvedRepo,
			baseCommit: mb.stdout,
			mainCommit: p1,
			candidateCommit: p2,
			branch,
			landedAt,
			outcome,
		});
	}
	triples.sort((a, b) => a.id.localeCompare(b.id));
	return { triples, coverage: { source: "merge-commit", attempted: mergeShas.length, recovered: triples.length, gaps } };
}

// ── source 2: PR merges (squash/rebase/ff via gh) ───────────────────────────────────────────────────

/** `gh pr list --state merged --json number,headRefOid,baseRefOid,mergeCommit,mergedAt` row shape —
 *  this module never shells to `gh` itself (the network dependency is documented as the caller's to
 *  own); tests inject rows directly, a live caller fetches them via `ghJson` (`src/gh.ts`) first. */
export interface MergedPrRow {
	number: number;
	headRefOid: string;
	baseRefOid?: string;
	mergeCommit?: { oid: string } | null;
	mergedAt: string;
}

/**
 * Source 2: reconstruct one triple per merged PR row. Every SHA must ALREADY be present in `repo`'s
 * local object store — this function never fetches. A row whose head/merge commit is not locally
 * resolvable degrades to a gap (the concern's explicit "replay degrades per-PR to a coverage gap
 * offline, never fabricates").
 */
export async function reconstructPrMergeTriples(repo: string, rows: readonly MergedPrRow[], stateDir: string): Promise<{ triples: ReplayTriple[]; coverage: CorpusCoverage }> {
	const resolvedRepo = computeRepositoryId(repo);
	const indices = buildLedgerIndices(stateDir);
	const gaps: CorpusGap[] = [];
	const triples: ReplayTriple[] = [];
	for (const row of rows) {
		if (!row.headRefOid) {
			gaps.push({ reason: `PR #${row.number} has no headRefOid`, prNumber: row.number });
			continue;
		}
		const headResolved = await git(["cat-file", "-e", `${row.headRefOid}^{commit}`], resolvedRepo);
		if (headResolved.code !== 0) {
			gaps.push({ reason: `PR #${row.number}'s headRefOid ${row.headRefOid} is not present locally — needs \`git fetch origin ${row.headRefOid}\``, prNumber: row.number, commit: row.headRefOid });
			continue;
		}
		const mergeOid = row.mergeCommit?.oid;
		if (!mergeOid) {
			gaps.push({ reason: `PR #${row.number} reports no mergeCommit oid — cannot recover the main tip it actually composed against`, prNumber: row.number, commit: row.headRefOid });
			continue;
		}
		const mainCommitRun = await git(["rev-parse", `${mergeOid}^1`], resolvedRepo);
		if (mainCommitRun.code !== 0 || !mainCommitRun.stdout) {
			gaps.push({ reason: `PR #${row.number}'s mergeCommit ${mergeOid} is not present locally (or has no parent) — needs \`git fetch origin ${mergeOid}\``, prNumber: row.number, commit: mergeOid });
			continue;
		}
		const mainCommit = mainCommitRun.stdout;
		const mb = await git(["merge-base", row.headRefOid, mainCommit], resolvedRepo);
		if (mb.code !== 0 || !mb.stdout) {
			gaps.push({ reason: `merge-base(${row.headRefOid}, ${mainCommit}) failed for PR #${row.number}: ${mb.stderr || "no output"}`, prNumber: row.number, commit: row.headRefOid });
			continue;
		}
		const outcome = joinOutcome(indices, undefined, [row.headRefOid, mergeOid]);
		const branch = indices.doneProofsByCommit.get(row.headRefOid)?.branch ?? indices.doneProofsByCommit.get(mergeOid)?.branch;
		triples.push({
			id: stableId("pr-merge", resolvedRepo, String(row.number), row.headRefOid),
			source: "pr-merge",
			repo: resolvedRepo,
			baseCommit: mb.stdout,
			mainCommit,
			candidateCommit: row.headRefOid,
			branch,
			prNumber: row.number,
			landedAt: row.mergedAt || undefined,
			outcome,
		});
	}
	triples.sort((a, b) => a.id.localeCompare(b.id));
	return { triples, coverage: { source: "pr-merge", attempted: rows.length, recovered: triples.length, gaps } };
}

// ── source 3: FF local-mode lands (via reflog + done-proof ledger) ─────────────────────────────────

/** `git log -g --format=%H <ref>` — one full sha per reflog entry, NEWEST first (index 0 is the ref's
 *  current value). Adjacent entries `[i]`/`[i+1]` are the (after, before) pair of one ref update. */
async function reflogShas(repo: string, ref: string): Promise<string[] | undefined> {
	const r = await git(["log", "-g", "--format=%H", ref], repo);
	if (r.code !== 0) return undefined;
	return r.stdout.split("\n").filter(Boolean);
}

/**
 * Find the commit `ref` pointed to immediately BEFORE it was updated to `target` — the reflog "before"
 * half of the transition whose "after" half is `target`. Multiple matches that all agree on the same
 * "before" value are fine (unambiguous despite repetition); multiple matches that DISAGREE are
 * reported as ambiguous rather than guessed at.
 */
function findPreTransitionCommit(entries: readonly string[], target: string): { ok: true; commit: string } | { ok: false; reason: string } {
	const befores = new Set<string>();
	for (let i = 0; i < entries.length - 1; i++) {
		if (entries[i] === target) befores.add(entries[i + 1]!);
	}
	if (befores.size === 0) return { ok: false, reason: `reflog has no transition landing on ${target} (expired, non-local clone, or not fast-forwarded via a tracked ref update)` };
	if (befores.size > 1) return { ok: false, reason: `reflog has ${befores.size} DIFFERING transitions landing on ${target} — ambiguous, not guessed at` };
	return { ok: true, commit: [...befores][0]! };
}

/**
 * Source 3: `mode: "local"`, `baseRef: "HEAD"` DoneProof entries (`squad-manager.ts`'s local-FF
 * marker) whose `commit` is directly present on `mainRef`'s first-parent history (i.e. genuinely
 * fast-forwarded, not folded into a `--no-ff` merge commit — those are excluded here, recovered
 * instead by `reconstructMergeCommitTriples`). B == M by the fast-forward invariant; M itself comes
 * from `mainRef`'s own reflog, degrading to a gap once expired/unavailable.
 */
export async function reconstructFfLocalLandTriples(repo: string, mainRef: string, stateDir: string): Promise<{ triples: ReplayTriple[]; coverage: CorpusCoverage }> {
	const resolvedRepo = computeRepositoryId(repo);
	const indices = buildLedgerIndices(stateDir);
	const ledger = readDoneProofLedger(stateDir);
	const localEntries = Object.values(ledger.byBranch).filter((p) => p.mode === "local" && p.baseRef === "HEAD");
	const gaps: CorpusGap[] = [];
	if (localEntries.length === 0) return { triples: [], coverage: { source: "ff-local-land", attempted: 0, recovered: 0, gaps: [] } };

	const firstParentLog = await git(["log", "--first-parent", "--format=%H", mainRef], resolvedRepo);
	if (firstParentLog.code !== 0) {
		return {
			triples: [],
			coverage: { source: "ff-local-land", attempted: localEntries.length, recovered: 0, gaps: [{ reason: `git log --first-parent probe failed: ${firstParentLog.stderr || firstParentLog.stdout || "no output"}` }] },
		};
	}
	const firstParentSet = new Set(firstParentLog.stdout.split("\n").filter(Boolean));
	const reflog = await reflogShas(resolvedRepo, mainRef);

	const triples: ReplayTriple[] = [];
	for (const entry of localEntries) {
		if (!entry.commit) {
			gaps.push({ reason: `done-proof entry for ${entry.branch} has no commit recorded`, branch: entry.branch });
			continue;
		}
		if (!firstParentSet.has(entry.commit)) {
			gaps.push({ reason: `${entry.branch}'s landed commit ${entry.commit} is not on ${mainRef}'s first-parent history — recovered via merge-commit source instead (--no-ff land), or history was rewritten since`, branch: entry.branch, commit: entry.commit });
			continue;
		}
		if (!reflog) {
			gaps.push({ reason: `reflog unavailable for ${mainRef} — cannot reconstruct the pre-land main tip`, branch: entry.branch, commit: entry.commit });
			continue;
		}
		const pre = findPreTransitionCommit(reflog, entry.commit);
		if (!pre.ok) {
			gaps.push({ reason: pre.reason, branch: entry.branch, commit: entry.commit });
			continue;
		}
		const outcome = joinOutcome(indices, entry.branch, [entry.commit]);
		triples.push({
			id: stableId("ff-local-land", resolvedRepo, entry.branch, entry.commit),
			source: "ff-local-land",
			repo: resolvedRepo,
			baseCommit: pre.commit, // B == M by the fast-forward invariant
			mainCommit: pre.commit,
			candidateCommit: entry.commit,
			branch: entry.branch,
			landedAt: new Date(entry.provenAt).toISOString(),
			outcome,
		});
	}
	triples.sort((a, b) => a.id.localeCompare(b.id));
	return { triples, coverage: { source: "ff-local-land", attempted: localEntries.length, recovered: triples.length, gaps } };
}

// ── aggregate + temporal holdout ────────────────────────────────────────────────────────────────────

export interface BuildReplayCorpusOptions {
	repo: string;
	mainRef: string;
	stateDir: string;
	/** Merged-PR rows for source 2. Omit to skip that source entirely (reported as a zero-attempted
	 *  coverage entry, never a silent absence) — this module never calls `gh` itself. */
	mergedPrRows?: readonly MergedPrRow[];
}

/** Reconstruct all three real-history sources and merge them into one corpus. Each source's own
 *  coverage entry is preserved (never collapsed into one scalar) — SCHEMA-V0.md's multidimensional
 *  coverage discipline applied to corpus reconstruction itself. */
export async function buildReplayCorpus(opts: BuildReplayCorpusOptions): Promise<ReplayCorpus> {
	const resolvedRepo = computeRepositoryId(opts.repo);
	const [mergeCommit, prMerge, ffLocal] = await Promise.all([
		reconstructMergeCommitTriples(resolvedRepo, opts.mainRef, opts.stateDir),
		reconstructPrMergeTriples(resolvedRepo, opts.mergedPrRows ?? [], opts.stateDir),
		reconstructFfLocalLandTriples(resolvedRepo, opts.mainRef, opts.stateDir),
	]);
	const triples = [...mergeCommit.triples, ...prMerge.triples, ...ffLocal.triples].sort((a, b) => a.id.localeCompare(b.id));
	return {
		repositoryId: resolvedRepo,
		triples,
		coverage: [mergeCommit.coverage, prMerge.coverage, ffLocal.coverage],
		generatedAt: nowIso(),
	};
}

export interface TemporalSplit {
	training: ReplayTriple[];
	holdout: ReplayTriple[];
	/** Triples with no recoverable `landedAt` — never silently sorted into either bucket. */
	unknownTime: ReplayTriple[];
}

/** Pure `--split-at <date>` filter: `landedAt < splitAtIso` ⇒ training, `>= splitAtIso` ⇒ holdout,
 *  absent ⇒ `unknownTime`. String comparison is safe because every populated `landedAt` is ISO 8601
 *  (lexical order == chronological order). */
export function splitCorpusAt(corpus: ReplayCorpus, splitAtIso: string): TemporalSplit {
	const training: ReplayTriple[] = [];
	const holdout: ReplayTriple[] = [];
	const unknownTime: ReplayTriple[] = [];
	for (const t of corpus.triples) {
		if (!t.landedAt) unknownTime.push(t);
		else if (t.landedAt < splitAtIso) training.push(t);
		else holdout.push(t);
	}
	return { training, holdout, unknownTime };
}

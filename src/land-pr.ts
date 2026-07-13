/**
 * PR land path (concern 06) — the PR-mode counterpart of land.ts's `landAgent`.
 *
 * `landAgentPr` is called from squad-manager.ts's `landBranch` seam once land-mode.ts's
 * `resolveLandMode()` says a repo is in PR mode. It runs synchronously end-to-end, under the SAME
 * `withRepoLandLock` the local path already uses: ensure a PR exists (push + `gh pr create --draft`
 * if none), re-check proof against the branch's CURRENT tip, fetch, run a disposable
 * scratch-worktree merge+gate (acceptance + the concern-03 regression gate) against a freshly-
 * fetched `origin/<default>` — never touching the primary checkout — merge via `gh pr merge`, assert
 * reachability per merge method, and record a DoneProof. A scratch-merge conflict tries ONE clean
 * automerge-and-retry in the agent's own worktree before refusing with the exact conflict file list.
 *
 * Also home of the PendingPr ledger (mirrors done-proof.ts / land-ledger.ts's per-stateDir JSON
 * pattern): written at push+create time so an out-of-band GitHub-UI merge has something durable to
 * reconcile from (concern 07's backstop loop).
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { classifyProbeFailure } from "./classify-probe-failure.ts";
import { getStorageBackend } from "./dal/storage.ts";
import { hardenedGit } from "./git-harden.ts";
import { budgetedExcerpt } from "./gate-logs.ts";
import { gateExec, greenGateUnproven } from "./gate-runner.ts";
import { detectVerify, packageManifestError } from "./intake.ts";
import { proofGate } from "./proof.ts";
import { gh, ghJson } from "./gh.ts";
import { isAncestor, recordDoneProof } from "./done-proof.ts";
import { cherryCheck, orphanedShas } from "./orphan-audit.ts";
import { repoIdentity } from "./repo-identity.ts";
import { applyRegressionGate, staleBranchReason, withRepoLandLock, type LandOpts, type LandResult } from "./land.ts";
import { installNodeModules } from "./worktree.ts";
import type { AutomationRecorder } from "./automation-log.ts";

// ── git / gate helpers ───────────────────────────────────────────────────────────────────────────
// Deliberately duplicated (trimmed) copies of land.ts's own private `git()`/`runGate()` rather than
// exported from that module — land.ts's Approach section only asks for `applyRegressionGate` to be
// exported, keeping its private surface small. Same GIT_HARDEN_ARGS/ENV constants either way.

interface GitRun {
	code: number;
	stdout: string;
	stderr: string;
}

async function git(args: string[], cwd: string): Promise<GitRun> {
	const r = await hardenedGit(args, { cwd });
	return { code: r.code, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

async function runGate(cmd: string, cwd: string, timeoutMs = 600_000): Promise<{ code: number; output: string; degraded?: boolean }> {
	let plan: Awaited<ReturnType<typeof gateExec>>;
	try {
		plan = await gateExec(cmd, cwd);
	} catch (e) {
		return { code: 1, output: e instanceof Error ? e.message : String(e) };
	}
	const proc = Bun.spawn(plan.argv, { cwd, stdout: "pipe", stderr: "pipe", env: plan.env });
	const timer = setTimeout(() => proc.kill(), timeoutMs);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		// degraded (finding #9's context note): PR mode's own runGate used to drop `plan.degraded` on the
		// floor entirely (land.ts's private runGate captures it; this one didn't) — a scratch merge that
		// fell back to the bare sandbox image and happened to exit 0 anyway had no way to say so.
		return { code, output: `${stdout}${stderr}`.trim(), degraded: plan.degraded };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Lossless offload half (eap-borrows concern 07, applying concern 03's `budgetedExcerpt`/
 * `writeGateLog` to the PR land path): the scratch-merge acceptance gate's output used to be
 * plain-truncated to 600 chars on FAILURE and DISCARDED ENTIRELY on success — a green PR-mode
 * land recorded no gate evidence at all, and a red one lost everything past the cap. Full output is
 * now always durably persisted (small dumps — the common case — cost nothing extra); the returned
 * excerpt carries a `[N bytes omitted — full: <path>]` pointer whenever it had to cut anything, so
 * the pointer lands directly in the LandResult detail / DoneProof detail text.
 */
async function excerptForDetail(s: string, n: number, agentId?: string): Promise<string> {
	const { text } = await budgetedExcerpt(s, n, { kind: "log", agentId });
	return text;
}

// ── green-run classification (finding #9) ──────────────────────────────────────────────────────────
// `gate-runner.ts`'s `gateRunUnrunnable` is reds-only by design ("code === 0 ⇒ green is green") — a
// deliberate short-circuit so a real green run is never second-guessed. That leaves the PR acceptance
// path unable to tell "the gate ran and passed" from "the gate exited 0 without exercising anything"
// (a broken verify script, or a test glob that matched zero files). `greenGateUnproven` (code-review
// finding #3) now lives in gate-runner.ts beside `gateRunUnrunnable` and its ZERO_TESTS_RE/TESTS_RAN_RE
// twins — imported here rather than re-declared, and shared with the local land path (land.ts).

/**
 * Provision `node_modules` in the disposable scratch worktree before any gate runs.
 *
 * `mkScratchWorktree` is a bare `git worktree add` — it has NO node_modules, so an
 * acceptance/regression gate that shells out to a project-local binary (`tsc`,
 * `bun run check`, …) dies with `command not found` / exit 127 and BLOCKS an
 * otherwise-landable branch. `worktree.ts`'s `provisionWorktreeDeps` provisions a freshly-cut
 * UNIT worktree the same way at spawn time — this is the scratch-merge counterpart, thin
 * wrapper over the same `installNodeModules` primitive so both call sites share one
 * detect-package.json/bounded-install/truncated-error implementation.
 *
 * Runs on the host with the daemon's env (warm bun cache + network), so it is fast and
 * populates the bind-mounted dir the sandboxed gate later sees. Skipped for non-bun repos
 * (no package.json). Returns an error string the caller surfaces as a gate failure, or
 * null on success/skip — deps that can't install mean the gate can't be trusted.
 */
export async function installScratchDeps(scratch: string): Promise<string | null> {
	// Nested, non-workspace packages need their own install — `worktree.ts`'s `provisionWorktreeDeps`
	// already provisions `<dir>` AND `<dir>/webapp` for exactly this reason. This path used to install
	// only the root, which was invisible while the repo's gate (`bun run check && bun run test`) never
	// entered `webapp/`. The moment the gate started typechecking and testing the webapp, a PR-mode
	// scratch merge would fail on missing `webapp/node_modules` (react-markdown, recharts, …) and return
	// a NON-retryable acceptance failure — parking an otherwise-green branch. Found by cross-lineage
	// review (gpt-5.6-sol) of the gate-coverage change; the two provisioners must stay in step.
	//
	// Fail CLOSED and concurrently, unlike `provisionWorktreeDeps`: deps that can't install here mean the
	// gate about to run cannot be trusted, and the caller surfaces this string as a gate failure.
	const pkgDirs = [scratch, path.join(scratch, "webapp")].filter((d) => existsSync(path.join(d, "package.json")));
	const errs = (await Promise.all(pkgDirs.map(async (d) => ({ dir: d, err: await installNodeModules(d) })))).filter((r) => r.err);
	if (errs.length === 0) return null;
	return `scratch dep install failed: ${errs.map((e) => `${e.dir}: ${e.err}`).join("; ")}`;
}

/** "owner/repo" from repoIdentity()'s "host/owner/repo" key — gh must be addressed by slug, not host
 *  (see land-mode.ts's probe() for why: a host-aliased origin normalizes to a non-github.com host). */
function slugOf(repo: string): string {
	return repoIdentity(repo).split("/").slice(-2).join("/");
}

/** On by default; OMP_SQUAD_PR_DRAFT=0 opens PRs ready for review instead of as drafts. */
function draftEnabled(): boolean {
	return process.env.OMP_SQUAD_PR_DRAFT !== "0";
}

export type MergeMethod = "merge" | "squash" | "rebase";

/** OMP_SQUAD_PR_MERGE_METHOD=merge|squash|rebase; default `merge` (preserves ancestry). */
export function mergeMethod(): MergeMethod {
	const m = process.env.OMP_SQUAD_PR_MERGE_METHOD;
	return m === "squash" || m === "rebase" ? m : "merge";
}

/** On by default; set OMP_SQUAD_STALE_GATE=0 to allow stale branches to merge unchecked (mirrors
 *  land.ts's own private `staleGateEnabled` — small env-check helper, deliberately duplicated here
 *  same as `git`/`runGate` above rather than exported from land.ts's private surface). */
function staleGateEnabled(): boolean {
	return process.env.OMP_SQUAD_STALE_GATE !== "0";
}

// ── PendingPr ledger — mirrors done-proof.ts's per-stateDir JSON pattern exactly ────────────────

export interface PendingPr {
	branch: string;
	repo: string; // repoIdentity() key
	prNumber: number;
	prUrl: string;
	issueId?: string;
	issueIdentifier?: string;
	/** Plane project id the tracked issue belongs to — needed by `transitionTo` to route a close call.
	 *  Persisted here (not just on the live agent's `dto.issue`) so an ORPHANED entry (agent removed
	 *  from the roster) can still confirm its Plane close via the reconciler's fallback `IssueRef`. */
	issueProjectId?: string;
	agentId?: string;
	createdAt: number;
	state: "open" | "merged" | "closed";
	mergedAt?: number;
	proofAt?: number;
	issueClosedAt?: number; // the three trailing fields are concern 07's reconciler idempotency keys
}

interface PendingPrLedger {
	byBranch: Record<string, PendingPr>;
}

function pendingPrPath(stateDir: string): string {
	return path.join(stateDir, "pending-prs.json");
}

export function readPendingPrLedger(stateDir: string): PendingPrLedger {
	try {
		const p = pendingPrPath(stateDir);
		const b = getStorageBackend();
		if (!b.exists(p)) return { byBranch: {} };
		const raw0 = b.readTextSync(p);
		if (raw0 === undefined) return { byBranch: {} };
		const raw = JSON.parse(raw0) as unknown;
		if (!raw || typeof raw !== "object") return { byBranch: {} };
		const r = raw as Partial<PendingPrLedger>;
		return { byBranch: r.byBranch && typeof r.byBranch === "object" ? r.byBranch : {} };
	} catch {
		return { byBranch: {} }; // corrupt/unreadable ⇒ start fresh
	}
}

function writePendingPrLedger(stateDir: string, ledger: PendingPrLedger): void {
	try {
		getStorageBackend().writeDurableSync(pendingPrPath(stateDir), JSON.stringify(ledger));
	} catch {
		/* best-effort: a disk failure must never break the land it records */
	}
}

/** Record (or overwrite) one PendingPr entry, keyed by branch. */
export function recordPendingPr(stateDir: string, entry: PendingPr): void {
	const ledger = readPendingPrLedger(stateDir);
	ledger.byBranch[entry.branch] = entry;
	writePendingPrLedger(stateDir, ledger);
}

export function getPendingPr(stateDir: string, branch: string): PendingPr | undefined {
	return readPendingPrLedger(stateDir).byBranch[branch];
}

/** Read-modify-write patch of an existing entry. No-op if the branch has no entry (nothing to patch). */
export function updatePendingPr(stateDir: string, branch: string, patch: Partial<PendingPr>): void {
	const ledger = readPendingPrLedger(stateDir);
	const existing = ledger.byBranch[branch];
	if (!existing) return;
	ledger.byBranch[branch] = { ...existing, ...patch };
	writePendingPrLedger(stateDir, ledger);
}

/** Every recorded PendingPr entry — concern 07's reconciler iterates this each tick. */
export function listPendingPrs(stateDir: string): PendingPr[] {
	return Object.values(readPendingPrLedger(stateDir).byBranch);
}

/** Retire one entry from the ledger. No-op if the branch has no entry. Used only for entries the
 *  reconciler has determined are fully confirmed (see `isFullyConfirmedPendingPr`) — keeping them
 *  forever would grow the ledger file unboundedly AND make every repo that ever landed a PR an
 *  ff-heal candidate on every tick, indefinitely. */
export function deletePendingPr(stateDir: string, branch: string): void {
	const ledger = readPendingPrLedger(stateDir);
	if (!(branch in ledger.byBranch)) return;
	delete ledger.byBranch[branch];
	writePendingPrLedger(stateDir, ledger);
}

/** A "merged" entry is fully confirmed — nothing a later tick could still use it for — once its
 *  DoneProof is written (`mergedAt`+`proofAt`) and, when it tracked a Plane issue, that issue's close
 *  is confirmed too (`issueClosedAt`); an entry with no `issueId` never gates on a close at all.
 *  CLOSED-unmerged entries are deliberately excluded from retirement — they carry surfaced state (a
 *  human closed the PR without merging) worth keeping visible in the ledger, per the design's ruling. */
export function isFullyConfirmedPendingPr(e: PendingPr): boolean {
	return e.state === "merged" && !!e.mergedAt && !!e.proofAt && (!e.issueId || !!e.issueClosedAt);
}

// ── ensurePr — idempotent PR-ensure ─────────────────────────────────────────────────────────────

export interface EnsurePrInput {
	repo: string;
	branch: string;
	defaultBranch: string;
	title: string;
	body?: string;
	stateDir: string;
	issueId?: string;
	issueIdentifier?: string;
	issueProjectId?: string;
	agentId?: string;
}

export interface EnsurePrResult {
	ok: boolean;
	prNumber?: number;
	prUrl?: string;
	/** The PR's actual draft/ready state at return time — never assume "draft"; an adopted PR may
	 *  already be ready-for-review, and OMP_SQUAD_PR_DRAFT=0 creates non-draft PRs. Undefined only
	 *  when gh didn't report it (adopt path on a `gh` that omitted `isDraft`). */
	prState?: "draft" | "open";
	detail?: string;
}

/**
 * Idempotent PR-ensure: adopt an existing PR on this branch (open ⇒ reuse as-is; closed/merged ⇒
 * force-with-lease push, since the daemon owns deterministic `squad/*` branch names and a re-dispatch
 * reuses them), else push + `gh pr create --draft`. Every `gh`/`git` failure degrades to a returned
 * `{ ok: false, detail }` — never a thrown/crashing daemon.
 */
export async function ensurePr(input: EnsurePrInput): Promise<EnsurePrResult> {
	const repoSlug = slugOf(input.repo);

	// `gh pr list --head` with --state all in one call: OPEN ⇒ adopt (no push, no create); anything
	// else present ⇒ the branch name was used by a prior (closed/merged) PR, so the next push must be
	// force-with-lease, not a plain push (which would fail non-fast-forward against that stale ref).
	const list = await ghJson<{ number: number; url: string; state: string; headRefOid?: string; isDraft?: boolean }[]>(
		["pr", "list", "--head", input.branch, "--repo", repoSlug, "--state", "all", "--json", "number,url,state,headRefOid,isDraft"],
		input.repo,
	);
	if (list === undefined) return { ok: false, detail: `gh pr list --head ${input.branch} failed` };

	const openPr = list.find((p) => p.state === "OPEN");
	if (openPr) {
		// CRITICAL: the downstream scratch gate always re-checks proof/merges against the LOCAL branch
		// tip, but `gh pr merge` merges the PR's REMOTE head. If a prior attempt pushed tip-1 (gate
		// FAILED) and the agent then committed a fix as tip-2 WITHOUT pushing, adopting this PR as-is
		// would let `gh pr merge` land tip-1 — the exact code that failed the gate — un-gated. Sync the
		// remote head to the local tip BEFORE returning ok, so the gate that runs next and the merge
		// that runs after it always see the same ref.
		const localTip = (await git(["rev-parse", input.branch], input.repo)).stdout.trim();
		if (localTip && openPr.headRefOid && localTip !== openPr.headRefOid) {
			await git(["fetch", "origin", input.branch], input.repo).catch(() => {});
			const ff = await git(["merge-base", "--is-ancestor", openPr.headRefOid, input.branch], input.repo);
			const sync = await git(ff.code === 0 ? ["push", "origin", input.branch] : ["push", "--force-with-lease", "origin", input.branch], input.repo);
			if (sync.code !== 0) {
				return { ok: false, detail: `git push failed to sync PR #${openPr.number}'s stale remote head (${openPr.headRefOid}) to local tip (${localTip}) for ${input.branch}: ${sync.stderr || sync.stdout}` };
			}
		}
		// Record a fresh entry unless one ALREADY tracks this EXACT PR — never skip just because SOME
		// entry exists for the branch: a stale entry left over from a prior (closed/merged) PR on this
		// same branch name still carries that PR's OLD prNumber, and skipping the record here would let
		// the eventual merge patch `state: "merged"` onto the WRONG PR number (and its stale issue-routing
		// fields) forever. Overwrite with a clean entry — `recordPendingPr` replaces the whole record, so
		// the old mergedAt/proofAt/issueClosedAt never leak forward onto this PR's lifecycle.
		const existing = getPendingPr(input.stateDir, input.branch);
		if (!existing || existing.prNumber !== openPr.number) {
			recordPendingPr(input.stateDir, {
				branch: input.branch,
				repo: repoIdentity(input.repo),
				prNumber: openPr.number,
				prUrl: openPr.url,
				issueId: input.issueId,
				issueIdentifier: input.issueIdentifier,
				issueProjectId: input.issueProjectId,
				agentId: input.agentId,
				createdAt: Date.now(),
				state: "open",
			});
		}
		return { ok: true, prNumber: openPr.number, prUrl: openPr.url, prState: openPr.isDraft === undefined ? undefined : openPr.isDraft ? "draft" : "open" };
	}

	const priorClosed = list.some((p) => p.state !== "OPEN");
	if (priorClosed) {
		// `--force-with-lease` (no explicit expected value) refuses as "stale info" unless our LOCAL
		// remote-tracking ref for this branch matches the remote's CURRENT state — a long-lived primary
		// checkout that hasn't fetched this exact branch since the prior PR closed would otherwise fail
		// the lease spuriously. Best-effort: a missing/deleted remote ref is a no-op fetch, not a failure.
		await git(["fetch", "origin", input.branch], input.repo).catch(() => {});
	}
	const push = await git(priorClosed ? ["push", "--force-with-lease", "origin", input.branch] : ["push", "origin", input.branch], input.repo);
	if (push.code !== 0) return { ok: false, detail: `git push failed for ${input.branch}: ${push.stderr || push.stdout}` };

	const createArgs = ["pr", "create", "--repo", repoSlug, "--base", input.defaultBranch, "--head", input.branch, "--title", input.title, "--body", input.body ?? ""];
	if (draftEnabled()) createArgs.push("--draft");
	const create = await gh(createArgs, input.repo);
	if (create.code !== 0) return { ok: false, detail: `gh pr create failed for ${input.branch}: ${create.stderr || create.stdout}` };
	const url = create.stdout.split("\n").map((s) => s.trim()).filter(Boolean).pop() ?? "";
	const prNumber = Number(url.match(/\/pull\/(\d+)/)?.[1]);
	if (!url || !Number.isFinite(prNumber)) return { ok: false, detail: `gh pr create returned no PR URL for ${input.branch}: ${create.stdout}` };

	recordPendingPr(input.stateDir, {
		branch: input.branch,
		repo: repoIdentity(input.repo),
		prNumber,
		prUrl: url,
		issueId: input.issueId,
		issueIdentifier: input.issueIdentifier,
		issueProjectId: input.issueProjectId,
		agentId: input.agentId,
		createdAt: Date.now(),
		state: "open",
	});
	return { ok: true, prNumber, prUrl: url, prState: draftEnabled() ? "draft" : "open" };
}

// ── scratch worktree — disposable, never the primary checkout ──────────────────────────────────

async function mkScratchWorktree(repo: string, defaultBranch: string): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "omp-squad-scratch-"));
	const add = await git(["worktree", "add", "--detach", dir, `origin/${defaultBranch}`], repo);
	if (add.code !== 0) {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
		throw new Error(`git worktree add --detach failed: ${add.stderr || add.stdout}`);
	}
	return dir;
}

async function removeScratchWorktree(repo: string, scratch: string): Promise<void> {
	await git(["worktree", "remove", "--force", scratch], repo).catch(() => {});
	await rm(scratch, { recursive: true, force: true }).catch(() => {});
	await git(["worktree", "prune"], repo).catch(() => {});
}

// ── per-method reachability assertion ───────────────────────────────────────────────────────────

export interface AssertMergedResult {
	ok: boolean;
	detail?: string;
	commit?: string;
	mergeCommit?: string;
}

/**
 * `method === "merge"`: a real merge preserves ancestry, so `isAncestor(branchTip, origin/<default>)`
 * is sufficient. `squash`/`rebase` rewrite history, so ancestry alone can't prove IT WAS THIS branch's
 * work that landed — consult `gh pr view` for the authoritative state/head/merge-commit instead:
 * MERGED, the PR's recorded head matches the branch tip we actually landed (not a later force-push
 * nobody reviewed), and the reported merge commit is reachable from fetched `origin/<default>`.
 */
export async function assertMerged(input: { repo: string; defaultBranch: string; branchTipSha: string; prNumber: number }, method: MergeMethod): Promise<AssertMergedResult> {
	const base = `origin/${input.defaultBranch}`;
	if (method === "merge") {
		const ok = await isAncestor(input.branchTipSha, base, input.repo);
		if (!ok) return { ok: false, detail: `${input.branchTipSha} is not an ancestor of ${base} after gh pr merge --merge — merge did not land as expected` };
		return { ok: true, commit: input.branchTipSha, mergeCommit: input.branchTipSha };
	}
	const view = await ghJson<{ state: string; headRefOid: string; mergeCommit?: { oid: string } }>(
		["pr", "view", String(input.prNumber), "--repo", slugOf(input.repo), "--json", "state,headRefOid,mergeCommit"],
		input.repo,
	);
	if (!view) return { ok: false, detail: `gh pr view ${input.prNumber} failed` };
	if (view.state !== "MERGED") return { ok: false, detail: `gh pr view ${input.prNumber} reports state=${view.state}, expected MERGED` };
	if (view.headRefOid !== input.branchTipSha) return { ok: false, detail: `PR #${input.prNumber}'s recorded head ${view.headRefOid} != branch tip ${input.branchTipSha} — a later force-push landed without re-review` };
	const mergeCommit = view.mergeCommit?.oid;
	if (!mergeCommit) return { ok: false, detail: `gh pr view ${input.prNumber} reports MERGED but no mergeCommit oid` };
	const reachable = await isAncestor(mergeCommit, base, input.repo);
	if (!reachable) return { ok: false, detail: `merge commit ${mergeCommit} for PR #${input.prNumber} is not reachable from ${base}` };
	return { ok: true, commit: input.branchTipSha, mergeCommit };
}

/**
 * Post-merge orphan assertion (the guard behind FIVE manual-audit incidents — see MEMORY.md "omp-squad
 * orphaned merged-PR audit"): runs AFTER `assertMerged` already passed, using the complementary check
 * `scripts/orphan-audit.ts` sweeps the whole repo with (`git cherry`, src/orphan-audit.ts) —
 * `assertMerged` only proves the branch TIP is reachable, which can hold even though individual
 * commits' patches never actually landed (the `origin/<branch>` ref this daemon just pushed is shared
 * with humans/other tooling, so "the tip is an ancestor" and "every commit this branch ever carried is
 * in the default branch" are not the same claim). A finding here MUST NOT fail the land — the merge
 * already happened, `gh pr merge` already returned success, and the DoneProof this is called before
 * recording is otherwise sound. It only gets LOUD: one automation-log entry at `level: "error"` so the
 * Observer/operator sees it, mirroring this module's own degrade-to-return-value error pattern (never
 * throws — a `cherryCheck` failure here is itself reported, not swallowed, since "couldn't check" is a
 * distinct, also-worth-surfacing outcome from "checked, clean").
 *
 * `method !== "merge"` (squash/rebase) is a KNOWN false-positive source: those methods rewrite history
 * into commit(s) with no matching original patch-id, so `git cherry` routinely flags every original
 * commit as `+` even though the (rewritten) content landed — `assertMerged` already proved reachability
 * for those methods via `gh pr view`'s reported merge commit, which is the authoritative check. The
 * entry is still recorded (never silently dropped — a real stacked-branch orphan looks identical to a
 * squash false-positive from here), but tagged so a reader doesn't over-index on it.
 */
export async function assertNoOrphanedCommits(input: { repo: string; defaultBranch: string; branch: string; prNumber: number; prUrl: string; method: MergeMethod }, record?: AutomationRecorder): Promise<void> {
	if (!record) return; // no recorder wired (e.g. a caller that doesn't care) ⇒ nothing to do
	const upstream = `origin/${input.defaultBranch}`;
	const head = `origin/${input.branch}`;
	// Refresh the BRANCH's remote-tracking ref, not just the default's (the land path already fetched
	// that): the incident this guards includes someone/something pushing MORE commits to the branch
	// around the merge — invisible in the stale ref this daemon last pushed. Best-effort: a failed
	// fetch leaves the last-known ref auditable, and cherryCheck reports its own ref errors.
	await git(["fetch", "origin", input.branch], input.repo).catch(() => {});
	const check = await cherryCheck(upstream, head, input.repo);
	if (!check.ok) {
		record({ level: "error", detail: `orphan check FAILED for merged PR #${input.prNumber} (${input.branch}): git cherry ${upstream} ${head} errored: ${check.error} — could not confirm content reached ${upstream}` });
		return;
	}
	const orphans = orphanedShas(check.entries);
	if (orphans.length === 0) return;
	const caveat = input.method !== "merge" ? ` (method=${input.method} — squash/rebase commonly false-positives here; assertMerged's gh-pr-view reachability check is authoritative, cross-check scripts/orphan-audit.ts before treating this as a real orphan)` : "";
	record({
		level: "error",
		detail: `PR #${input.prNumber} (${input.branch}, ${input.prUrl}) reports MERGED but git cherry ${upstream} ${head} still marks ${orphans.length} commit(s) as unreached: ${orphans.map((s) => s.slice(0, 12)).join(", ")}${caveat}`,
	});
}

// ── landAgentPr — synchronous end-to-end ────────────────────────────────────────────────────────

/** Bound the clean-automerge-and-retry loop to exactly ONE retry (guards against an infinite loop). */
const MAX_CLEAN_AUTOMERGE_RETRIES = 1;

/**
 * PR-mode counterpart of land.ts's `landAgent`. `stateDir` is passed as a second argument rather than
 * folded into `LandOpts` — `land.ts` has no `stateDir` concept at all, and every other `LandOpts`
 * consumer (local mode) has no use for it, so keeping it out of the shared type is the less invasive
 * choice. `onOrphan` (third, optional) is the post-merge orphan assertion's automation-log sink —
 * see `assertNoOrphanedCommits`; undefined ⇒ the check still runs (cheap, local git only) but has
 * nowhere to report a finding, so it becomes a silent no-op (mirrors every other best-effort
 * degrade in this file rather than requiring every test/caller to wire a recorder).
 */
export async function landAgentPr(opts: LandOpts & { defaultBranch: string }, stateDir: string, onOrphan?: AutomationRecorder): Promise<LandResult> {
	return withRepoLandLock(opts.repo, () => landAgentPrLocked(opts, stateDir, onOrphan));
}

/**
 * Force-land audit seam (mirrors land.ts's `landAgentLocked`, which PR mode used to bypass entirely):
 * a FORCED land (requireProof === false) that ends up actually landing (merged, or — mirroring local
 * mode's in-place-commit case — committed) without a passing proof gate is unproven trust. Not
 * blocked (force is intentional), but made LEGIBLE: the gate is evaluated once, non-blockingly,
 * BEFORE the real attempt, and only stamped onto the result if it actually landed something. A forced
 * land that happened to carry a fresh proof anyway is not flagged — no crying wolf, same as local.
 */
async function landAgentPrLocked(opts: LandOpts & { defaultBranch: string }, stateDir: string, onOrphan?: AutomationRecorder): Promise<LandResult> {
	const forced = opts.requireProof === false;
	const unproven = forced ? (await proofGate(opts.repo, opts.worktree, opts.branch, opts.verify)) !== undefined : false;
	const result = await landAgentPrOnce(opts, stateDir, 0, onOrphan);
	if (forced && unproven && result.ok && (result.merged || result.committed)) {
		result.forcedWithoutProof = true;
		result.detail = result.detail ? `${result.detail}; landed WITHOUT a passing proof gate (FORCED)` : "landed WITHOUT a passing proof gate (FORCED)";
	}
	return result;
}

/**
 * Refuse to publish commits the operator never asked us to publish.
 *
 * A unit branch normally forks from `origin/<default>`, so everything in `origin/<default>..<branch>`
 * is the agent's own work. But `resolveWorktree` REUSES an existing branch ref verbatim and ignores
 * the caller's start point (`worktree.ts`'s `exists ? ["worktree","add",dir,branch] : …startPoint`),
 * so a `squad/*` branch created back when the daemon forked from the operator's local HEAD still
 * carries that operator's commits. Local mode used to merge such a branch back into the same checkout
 * it came from — a no-op for those commits. PR mode pushes the whole branch and merges it into the
 * REMOTE default, which would publish the operator's private, unpushed work as a side effect of
 * landing an unrelated unit.
 *
 * Guard: any commit this PR would publish that is also reachable from a local branch OUTSIDE
 * `refs/heads/squad/` is a transplant. Stacked `squad/*` branches are deliberately allowed (a unit
 * forked from another unit is still fleet work). A GENUINE finding is NOT retryable — retrying cannot
 * fix lineage, and a silent retry loop is exactly how the dirty-main interlock stayed invisible for
 * 1,381 attempts. Found by cross-lineage review (gpt-5.6-sol + grok-4.5) of the probe-4 removal.
 *
 * A second cross-lineage pass (grok-4.5, eap-borrows) on THIS fix found the polarity re-introduced one
 * probe over: a probe FAILURE (offline daemon, pruned `origin/<default>`) is not a lineage finding —
 * see `TransplantFinding`/`transplantedCommitsReason` below for the retryable split.
 */
/** git's own wording when a REF doesn't exist at all — distinct from a genuine probe failure (a
 *  nonexistent branch has nothing to publish, full stop; that's not the same claim as "couldn't tell
 *  whether it's safe to publish"). Matched narrowly so an actual tool/repo failure still blocks. */
const UNKNOWN_REVISION_RE = /unknown revision|bad revision|bad object|not a valid object name/i;

/**
 * Why `branch` is blocked from publishing to `origin/<default>`, and whether that's a genuine lineage
 * FINDING or a PROBE that couldn't run — mirrors `StaleBranchFinding` (land.ts) exactly, and for the
 * same reason (cross-lineage review, eap-borrows): a real transplanted-commit finding means retrying
 * cannot help (the lineage doesn't change on its own), so `retryable: false` there is correct and was
 * always correct. But a git PROBE FAILURE (offline daemon, `origin/<default>` pruned by a transient
 * fetch, a corrupted `.git/objects`) proves NOTHING about lineage either way — hardcoding
 * `retryable: false` for THAT case turned a transient hiccup into a PERMANENT park (`SquadManager.land`
 * never re-tries a non-retryable refusal and never bumps the auto-land fail streak back down), exactly
 * the interlock pathology this repo is named after, just re-introduced one probe over. Both cases still
 * BLOCK — only the retry polarity differs.
 */
export interface TransplantFinding {
	reason: string;
	retryable: boolean;
}

export async function transplantedCommitsReason(repo: string, branch: string, defaultBranch: string): Promise<TransplantFinding | undefined> {
	const probeFailed = (step: string, r: GitRun): TransplantFinding => {
		const { reason } = classifyProbeFailure({ kind: "spawn-error", detail: `${step} failed: ${r.stderr || r.stdout || "no output"}` });
		return { reason: `transplant gate ${reason} — could not prove ${branch}'s lineage; refusing to publish it`, retryable: true };
	};
	// Finding #4 (eap-borrows wave 2): the ORIGINAL checks collapsed "probe failed (nonzero git exit)"
	// and "probe succeeded, legitimately nothing to compare" into the SAME `undefined` — a transient git
	// error during either rev-list silently ALLOWED a land that could publish an operator's private
	// commits, exactly the hazard this gate exists to catch. A probe failure can prove neither lineage
	// claim, so it now blocks (never allows) with a distinct reason — retrying cannot fix a GENUINE
	// lineage claim, but a probe failure is its own, retryable, category (see `probeFailed` above). A
	// branch that doesn't exist AT ALL is a separate, legitimate case (nothing to publish), not a probe
	// failure — a false-block here is as bad as the false-allow this finding fixes (see this file's
	// negative-case tests).
	const publishing = await git(["rev-list", `origin/${defaultBranch}..${branch}`], repo);
	if (publishing.code !== 0) {
		// Finding #1 (code-review fixlist): `git rev-list a..b` emits BYTE-IDENTICAL "unknown revision"
		// text whether `a` (origin/<default>, pruned/absent) or `b` (the branch) is the missing ref —
		// UNKNOWN_REVISION_RE alone can't tell which. The carve-out below is only sound for the branch
		// case ("nothing to publish"); an absent origin/<default> must never take it (that's offline /
		// stale-fetch, not "nothing to compare"). Anchor on the branch specifically before trusting the
		// error text — this was fail-open: offline + pruned origin ref allowed publishing transplanted
		// commits.
		if (UNKNOWN_REVISION_RE.test(publishing.stderr)) {
			const branchRef = await git(["rev-parse", "--verify", "--quiet", branch], repo);
			if (branchRef.code !== 0) return undefined; // confirmed: the branch itself doesn't exist — nothing to publish
		}
		return probeFailed(`git rev-list origin/${defaultBranch}..${branch}`, publishing);
	}
	if (!publishing.stdout) return undefined; // nothing ahead of origin/<default> ⇒ nothing to publish
	// `--exclude` patterns are interpreted the way the FOLLOWING ref option interprets its own pattern:
	// for `--branches` that means relative to `refs/heads/`, so a fully-qualified `refs/heads/squad/*`
	// silently matches nothing and every branch — including this one — counts as foreign. (Caught by a
	// negative test: the gate flagged the agent's own commit.)
	const foreign = await git(["rev-list", "--exclude=squad/*", `--exclude=${branch}`, "--branches", "--not", `origin/${defaultBranch}`], repo);
	if (foreign.code !== 0) return probeFailed(`git rev-list --branches --not origin/${defaultBranch}`, foreign);
	if (!foreign.stdout) return undefined; // no local non-fleet branches to compare against
	const foreignShas = new Set(foreign.stdout.split("\n").filter(Boolean));
	const stolen = publishing.stdout.split("\n").filter((s) => s && foreignShas.has(s));
	if (stolen.length === 0) return undefined;
	const shown = await Promise.all(
		stolen.slice(0, 3).map(async (sha) => {
			const subj = await git(["log", "-1", "--format=%h %s", sha], repo);
			return subj.code === 0 ? subj.stdout : sha.slice(0, 8);
		}),
	);
	const more = stolen.length > 3 ? ` (+${stolen.length - 3} more)` : "";
	return {
		reason:
			`transplant gate blocked ${branch}: it would publish ${stolen.length} commit(s) to origin/${defaultBranch} that belong to a ` +
			`local non-fleet branch, not to this unit — ${shown.join("; ")}${more}. This branch was forked from an operator branch ` +
			`(pre-PR-mode units forked from the local checkout's HEAD). Rebase it onto origin/${defaultBranch} and re-verify, or delete it.`,
		retryable: false,
	};
}

async function landAgentPrOnce(opts: LandOpts & { defaultBranch: string }, stateDir: string, retry: number, onOrphan?: AutomationRecorder): Promise<LandResult> {
	const { repo, worktree, branch, message } = opts;

	// In-place agent (no branch, or worktree === repo): nothing to merge, mirrors landAgentImpl.
	if (!branch || worktree === repo) {
		return { ok: true, committed: false, merged: false, message, mode: "pr", detail: "no changes to commit (no branch to land in PR mode)" };
	}

	// Sweep uncommitted edits into a commit BEFORE ensurePr/push — mirrors land.ts:332's local path
	// exactly (same exclusion of `.omp/`, same message shape). Without this, an idle agent's last
	// uncommitted edits were silently stranded in the worktree forever: PR mode pushed/merged only the
	// committed history and recorded a green DoneProof over the incomplete result.
	let committed = false;
	if (opts.commitWip) {
		const status = await git(["status", "--porcelain", "--", ".", ":(exclude).omp"], worktree);
		if (status.code === 0 && status.stdout.length > 0) {
			const add = await git(["add", "-A", "--", ".", ":(exclude).omp"], worktree);
			if (add.code !== 0) return { ok: false, committed: false, merged: false, message, mode: "pr", detail: `git add failed: ${add.stderr}` };
			const commit = await git(["commit", "-m", message], worktree);
			if (commit.code !== 0) return { ok: false, committed: false, merged: false, message, mode: "pr", detail: `git commit failed: ${commit.stderr || commit.stdout}` };
			committed = true;
		}
	}

	// Confirm there is actually something to land BEFORE calling ensurePr: without this, a branch with
	// nothing ahead of a freshly-fetched origin/<default> (even after the commitWip sweep above) surfaces
	// deep inside ensurePr as a raw, confusing `gh pr create` error ("No commits between main and
	// squad/x") instead of a clear land-level refusal.
	await git(["fetch", "origin", opts.defaultBranch], repo).catch(() => undefined);
	const aheadOfDefault = await git(["rev-list", "--count", `origin/${opts.defaultBranch}..${branch}`], repo);
	if (aheadOfDefault.code === 0 && aheadOfDefault.stdout === "0") {
		return {
			ok: false,
			committed,
			merged: false,
			message,
			mode: "pr",
			detail: committed
				? `committed WIP but ${branch} still has no commits ahead of origin/${opts.defaultBranch} — nothing to land`
				: `no changes to land (${branch} has no commits ahead of origin/${opts.defaultBranch}, and nothing to commit)`,
		};
	}

	// Lineage gate — BEFORE the first push. Everything below this line is remote-visible.
	// Cross-lineage review (grok-4.5, eap-borrows): `transplant.retryable` threads a genuine finding
	// (retrying can't fix lineage) apart from a probe failure (offline fetch / pruned origin ref — an
	// environmental hiccup, not a branch defect) so the latter never permanently parks a healthy branch.
	const transplant = await transplantedCommitsReason(repo, branch, opts.defaultBranch);
	if (transplant) return { ok: false, retryable: transplant.retryable, committed, merged: false, message, mode: "pr", detail: transplant.reason };

	const ensure = await ensurePr({
		repo,
		branch,
		defaultBranch: opts.defaultBranch,
		title: message,
		issueId: opts.issueId,
		issueIdentifier: opts.issueIdentifier,
		issueProjectId: opts.issueProjectId,
		agentId: opts.agentId,
		stateDir,
	});
	if (!ensure.ok || ensure.prNumber === undefined || ensure.prUrl === undefined) {
		return { ok: false, committed, merged: false, message, mode: "pr", detail: ensure.detail ?? "ensurePr failed" };
	}

	// Re-check proof against the CURRENT branch tip — a stale proof from before new commits landed on
	// the branch must not authorize a merge of commits it never saw.
	if (opts.requireProof) {
		const reason = await proofGate(repo, worktree, branch, opts.verify);
		if (reason) return { ok: false, committed, merged: false, message, mode: "pr", pushed: true, prUrl: ensure.prUrl, prNumber: ensure.prNumber, prState: ensure.prState ?? "draft", detail: reason };
	}

	await git(["fetch", "origin", opts.defaultBranch], repo);

	let scratch: string;
	try {
		scratch = await mkScratchWorktree(repo, opts.defaultBranch);
	} catch (e) {
		return { ok: false, committed, merged: false, message, mode: "pr", pushed: true, prUrl: ensure.prUrl, prNumber: ensure.prNumber, detail: `scratch worktree setup failed: ${e instanceof Error ? e.message : String(e)}` };
	}
	// Carries the acceptance gate's excerpt (full text always persisted — see excerptForDetail) past the
	// scratch-worktree try/finally so a GREEN land's DoneProof records it too, not just a refusal's detail.
	let acceptanceGateExcerpt: string | undefined;
	try {
		// Scratch-merge gate: disposable detached worktree of freshly-fetched origin/<default>, merge
		// the branch into it, run acceptance + the (default-ON, concern 03) regression gate THERE —
		// never touching the primary checkout. Conflict here is NOT a failure yet — retry path below.
		const merge = await git(["merge", "--no-ff", branch], scratch);
		if (merge.code !== 0) {
			const files = (await git(["diff", "--name-only", "--diff-filter=U"], scratch)).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
			await git(["merge", "--abort"], scratch).catch(() => {});
			if (retry >= MAX_CLEAN_AUTOMERGE_RETRIES) {
				return { ok: false, committed, merged: false, retryable: false, message, mode: "pr", pushed: true, prUrl: ensure.prUrl, prNumber: ensure.prNumber, detail: `conflict in ${files.join(", ") || "unknown files"}` };
			}
			return attemptCleanAutomergeAndRetry(opts, stateDir, retry, ensure, onOrphan);
		}

		// Stale-branch gate (visual-plan-blocks incident, ported to PR mode via the SAME
		// `staleBranchReason` primitive land.ts's local path uses — now generalized with a `baseRef`
		// param), ENFORCED HERE — only on this textually-clean merge — mirroring land.ts's own ordering
		// exactly: a branch whose fork point is behind origin/<default> AND edits the same file(s) origin
		// has since changed can silently revert newer origin work when it merges CLEANLY; a genuinely
		// CONFLICTING overlap already surfaced above as a real conflict (refused or retried), which is a
		// visible signal either way — re-flagging it as "stale" too would just recolor the same refusal.
		// Force-land (staleGate:false) skips this, same as local mode; OMP_SQUAD_STALE_GATE=0 disables it
		// globally.
		if (opts.staleGate !== false && staleGateEnabled()) {
			const staleReason = await staleBranchReason(repo, branch, `origin/${opts.defaultBranch}`);
			if (staleReason) {
				return { ok: false, committed, merged: false, retryable: staleReason.retryable, message, mode: "pr", pushed: true, prUrl: ensure.prUrl, prNumber: ensure.prNumber, detail: staleReason.reason };
			}
		}

		// Provision deps in the merged scratch tree so the acceptance + regression gates below can
		// invoke project-local tools (tsc, `bun run <script>`). Without this a bun repo's gate fails
		// with `command not found` (exit 127) and blocks a landable branch. After the merge so the
		// branch's own dependency changes are what gets installed.
		const installErr = await installScratchDeps(scratch);
		if (installErr) return { ok: false, committed, merged: false, message, mode: "pr", pushed: true, prUrl: ensure.prUrl, prNumber: ensure.prNumber, detail: `acceptance failed on scratch merge: ${installErr}` };

		const verify = opts.verify ?? (await detectVerify(repo));
		// Finding #10 (eap-borrows wave 2): detectVerify(repo) collapses "genuinely no toolchain" and
		// "package.json exists but is unreadable/malformed" into the same undefined — only intervene when
		// the caller didn't already make an explicit choice (opts.verify undefined ⇒ auto-detect was
		// actually consulted). Never blocks a repo for lacking package.json.
		if (opts.verify === undefined && !verify) {
			const manifestError = await packageManifestError(repo);
			if (manifestError) {
				return {
					ok: false,
					committed,
					merged: false,
					retryable: true,
					message,
					mode: "pr",
					pushed: true,
					prUrl: ensure.prUrl,
					prNumber: ensure.prNumber,
					detail: `could not detect ${repo}'s verification command (${manifestError}) — refusing to land ${branch} without a gate rather than silently skipping acceptance; fix package.json or pass an explicit verify command`,
				};
			}
		}
		if (verify) {
			const gateResult = await runGate(verify, scratch);
			// Offload half (eap-borrows concern 07 / concern 03's budgetedExcerpt+writeGateLog): the full
			// gate output is now durably persisted on BOTH outcomes, not just truncated-and-dropped on
			// failure and silently discarded entirely on success (the ORIGINAL gap — a green PR-mode land
			// recorded zero gate evidence). Computed once, reused for the failure detail below AND (via
			// `acceptanceGateExcerpt`) the eventual green DoneProof.
			acceptanceGateExcerpt = await excerptForDetail(gateResult.output, 600, opts.agentId);
			if (gateResult.code !== 0) return { ok: false, committed, merged: false, message, mode: "pr", pushed: true, prUrl: ensure.prUrl, prNumber: ensure.prNumber, detail: `acceptance failed on scratch merge: ${acceptanceGateExcerpt}` };
			// Finding #9 (eap-borrows wave 2): a GREEN exit code alone was never classified — a broken
			// verify script that exits 0 without running anything, or a zero-matched test glob, landed
			// exactly like a real pass. Refuse (retryable — the environment/script is the problem, not
			// necessarily the branch) rather than merge on an unproven "pass".
			const unproven = greenGateUnproven(gateResult, verify);
			if (unproven) {
				return {
					ok: false,
					committed,
					merged: false,
					retryable: true,
					message,
					mode: "pr",
					pushed: true,
					prUrl: ensure.prUrl,
					prNumber: ensure.prNumber,
					detail: `acceptance gate could not be trusted (${unproven}): ${verify} — refusing to merge on an unproven pass`,
				};
			}
		}

		const head0 = (await git(["rev-parse", `origin/${opts.defaultBranch}`], repo)).stdout;
		const regressionBlock = await applyRegressionGate({
			repo: scratch,
			head0,
			committed: true,
			message,
			branch,
			reMerge: () => git(["merge", "--no-ff", branch], scratch),
		});
		if (regressionBlock) return { ...regressionBlock, mode: "pr", pushed: true, prUrl: ensure.prUrl, prNumber: ensure.prNumber };
	} finally {
		await removeScratchWorktree(repo, scratch);
	}

	// Green — merge via gh, not git. `--repo` is required on every gh invocation here (not just
	// pr list/view/create): on a host-aliased origin gh can't infer the repo from cwd remotes, so
	// without it these two calls would fail even though probe/list/view/create succeeded, making PR
	// mode resolve as usable and then permanently fail every merge.
	const method = mergeMethod();
	const repoSlug = slugOf(repo);
	const wasDraft = ensure.prState === "draft";
	const ready = await gh(["pr", "ready", String(ensure.prNumber), "--repo", repoSlug], repo); // draft→ready; harmless if already ready
	if (ready.code !== 0 && wasDraft) {
		return { ok: false, committed, merged: false, retryable: true, message, mode: "pr", pushed: true, prUrl: ensure.prUrl, prNumber: ensure.prNumber, prState: "draft", detail: `gh pr ready failed: ${ready.stderr || ready.stdout}` };
	}
	const merged = await gh(["pr", "merge", String(ensure.prNumber), `--${method}`, "--delete-branch=false", "--repo", repoSlug], repo);
	if (merged.code !== 0) return { ok: false, committed, merged: false, retryable: true, message, mode: "pr", pushed: true, prUrl: ensure.prUrl, prNumber: ensure.prNumber, prState: "open", detail: `gh pr merge failed: ${merged.stderr || merged.stdout}` };

	await git(["fetch", "origin", opts.defaultBranch], repo);
	const branchTip = (await git(["rev-parse", branch], repo)).stdout;
	const assertion = await assertMerged({ repo, defaultBranch: opts.defaultBranch, branchTipSha: branchTip, prNumber: ensure.prNumber }, method);
	if (!assertion.ok) return { ok: false, committed, merged: false, message, mode: "pr", pushed: true, prUrl: ensure.prUrl, prNumber: ensure.prNumber, detail: assertion.detail };

	// Orphan assertion (concern: post-merge guard) — additional to the reachability check just above,
	// never blocking (the merge already happened): see `assertNoOrphanedCommits`'s doc comment.
	await assertNoOrphanedCommits({ repo, defaultBranch: opts.defaultBranch, branch, prNumber: ensure.prNumber, prUrl: ensure.prUrl, method }, onOrphan);

	recordDoneProof(stateDir, {
		branch,
		repo: repoIdentity(repo),
		issueId: opts.issueId,
		issueIdentifier: opts.issueIdentifier,
		mode: "pr",
		method,
		commit: assertion.commit ?? branchTip,
		mergeCommit: assertion.mergeCommit,
		baseRef: `origin/${opts.defaultBranch}`,
		verified: "green",
		// Offload half (eap-borrows concern 07): the acceptance gate's excerpt (full text always
		// persisted — see excerptForDetail) rides along on the DoneProof detail too, not just a refusal's.
		// Undefined only when there was no acceptance command to run at all (opts.verify === "" or no
		// toolchain detected — an honest "nothing to show").
		detail: acceptanceGateExcerpt ? `PR merged, scratch gate green\n${acceptanceGateExcerpt}` : "PR merged, scratch gate green",
		provenAt: Date.now(),
		prNumber: ensure.prNumber,
		prUrl: ensure.prUrl,
	});
	updatePendingPr(stateDir, branch, { state: "merged", mergedAt: Date.now(), proofAt: Date.now() });

	return { ok: true, committed: true, merged: true, message, mode: "pr", pushed: true, prUrl: ensure.prUrl, prNumber: ensure.prNumber, prState: "merged" };
}

/**
 * Conflict handling: attempt a CLEAN automerge of `origin/<default>` into the AGENT's OWN worktree
 * (not the scratch copy) — a clean resolve means the branch was simply trailing main, the common
 * case. Clean ⇒ push the result and retry `landAgentPrOnce` exactly ONCE (the `retry` counter guards
 * against a second attempt). Still conflicted ⇒ abort and refuse with the exact conflict file list —
 * the LLM `attemptAutoResolve` port to an origin-base scratch merge is explicitly CUT from this wave
 * (documented regression, DESIGN.md Risk #4); never silently drop the PR.
 */
async function attemptCleanAutomergeAndRetry(opts: LandOpts & { defaultBranch: string }, stateDir: string, retry: number, ensure: EnsurePrResult, onOrphan?: AutomationRecorder): Promise<LandResult> {
	const { worktree, branch, message } = opts;
	const merge = await git(["merge", `origin/${opts.defaultBranch}`], worktree);
	if (merge.code === 0) {
		const push = await git(["push", "origin", branch as string], worktree);
		if (push.code !== 0) {
			return { ok: false, committed: false, merged: false, message, mode: "pr", pushed: true, prUrl: ensure.prUrl, prNumber: ensure.prNumber, detail: `clean automerge of origin/${opts.defaultBranch} into ${branch} succeeded but push failed: ${push.stderr || push.stdout}` };
		}
		return landAgentPrOnce(opts, stateDir, retry + 1, onOrphan);
	}
	const files = (await git(["diff", "--name-only", "--diff-filter=U"], worktree)).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
	await git(["merge", "--abort"], worktree).catch(() => {});
	return { ok: false, committed: false, merged: false, retryable: false, message, mode: "pr", pushed: true, prUrl: ensure.prUrl, prNumber: ensure.prNumber, detail: `conflict in ${files.join(", ") || "unknown files"}` };
}

# Done-write gating

STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts, src/plan-sync.ts, src/features.ts, ~/.claude/skills/claim-and-implement/SKILL.md, tests/close-landed-issue-proof.test.ts (new), tests/plan-sync-proof.test.ts (new)

## Goal

Every *daemon-automated* Done write consults the DoneProof ledger (concern 01) before it happens; a terminal-without-proof case is skipped/suppressed and surfaced, never silently written. Human/operator writes (`setConcernStatus` via the webapp flow-diagram editor) stay proofless — gating them would break the legitimate human-override lane — but gain an audit record instead of being invisible. This is the concern that turns "Done" from an assertion into a checked claim, everywhere except where a human explicitly asserted it.

**Imports consumed from concern 01** (`src/done-proof.ts`): `hasProof(stateDir, issueIdentifier)`, `getDoneProofByIssue`, `getDoneProofByBranch`.

## Approach

### 1. `closeLandedIssue` gains proof context

Verified current body, `src/squad-manager.ts:2849-2854`:

```ts
async closeLandedIssue(issue: IssueRef | undefined): Promise<void> {
	if (!this.closeOnDone || !issue || this.closedIssues.has(issue.id)) return;
	this.log("info", `closing ${issue.identifier ?? issue.id} (branch landed)`);
	if (await closePlaneIssue(issue)) this.closedIssues.add(issue.id);
	else this.log("warn", `could not close ${issue.identifier ?? issue.id} (branch landed)`);
}
```

This function is called from exactly two sites: `land()` at `squad-manager.ts:1689` (`if (result.merged) await this.closeLandedIssue(dto.issue);`) and `landFeature` at `squad-manager.ts:1616` (`if (res.merged) void this.closeLandedIssue(rec?.dto.issue);`). At both call sites, concern 01 has ALREADY written the DoneProof for this branch (in `land()`'s case, immediately before this same call, per concern 01 §4; `landFeature`'s per-member proof write is concern 06's responsibility once it reroutes `landFeature` through the same seam — until concern 06 lands, `landFeature`'s branch has no DoneProof yet, so its `closeLandedIssue` calls will simply find no proof and log-suppress; this is acceptable and non-regressive since `landFeature` already merged for real via `landAgent` — the missing-proof-suppression risk here is temporary and closes itself once concern 06 lands `landFeature` through the reroute).

Change the signature to accept the identifying context it needs to look up the ledger, rather than re-deriving it internally (both call sites already have `dto`/`rec` in scope):

```ts
async closeLandedIssue(issue: IssueRef | undefined, ctx?: { branch?: string; repo?: string }): Promise<void> {
	if (!this.closeOnDone || !issue || this.closedIssues.has(issue.id)) return;
	const identifier = issue.identifier ?? issue.id;
	const proof = issue.identifier ? getDoneProofByIssue(this.stateDir, issue.identifier) : ctx?.branch ? getDoneProofByBranch(this.stateDir, ctx.branch) : undefined;
	if (!proof) {
		this.log("warn", `NOT closing ${identifier} (branch landed) — no DoneProof on record; skipping close, surfacing for review`);
		void this.recordAudit(LOCAL_ACTOR, "close.suppressed-unproven", identifier, "error", `land reported merged but no DoneProof exists for ${ctx?.branch ?? "(no branch)"}`);
		return;
	}
	this.log("info", `closing ${identifier} (branch landed, proof ${proof.verified})`);
	if (await closePlaneIssue(issue)) this.closedIssues.add(issue.id);
	else this.log("warn", `could not close ${identifier} (branch landed)`);
}
```

Update both call sites to pass `ctx`:

- `squad-manager.ts:1689`: `await this.closeLandedIssue(dto.issue, { branch: dto.branch, repo: dto.repo });`
- `squad-manager.ts:1616`: `void this.closeLandedIssue(rec?.dto.issue, { branch: w.branch, repo: pf.repo });` (note: `w.branch`/`pf.repo` are already in scope at that line from the surrounding `landOrder(wts)` loop — verified `w` is the loop variable and `pf` is the feature record fetched earlier in `landFeature`).

This is the ONLY behavior change to `closeLandedIssue` in this concern — do not touch the `closeOnDone`/`closedIssues` idempotency guards, which stay exactly as verified.

### 2. `issueAlreadyDone` — SPLIT (skip-dispatch stays proofless, close-write requires proof)

Verified full current body, `src/squad-manager.ts:694-720`:

```ts
async issueAlreadyDone(repo: string, issue: IssueRef): Promise<boolean> {
	let closedRef: string | undefined;
	for (const ref of planDocRefs(issue.name)) {
		const status = await concernDocStatus(repo, ref);
		if (status && isClosedConcernStatus(status)) {
			closedRef = `${ref} (STATUS: ${status})`;
			break;
		}
	}
	if (!closedRef && issue.identifier) {
		outer: for (const planDir of await listPlanDirs(repo).catch(() => [])) {
			for (const concern of await parsePlanConcerns(repo, planDir.dir).catch(() => [])) {
				if (concern.planeId === issue.identifier && !concern.open) {
					closedRef = `${concern.path} (STATUS: ${concern.status})`;
					break outer;
				}
			}
		}
	}
	if (!closedRef) return false;
	this.log("warn", `stale issue ${issue.identifier ?? issue.id}: ${closedRef} is already closed — skipping dispatch${this.closeOnDone ? ", closing the issue" : ""}`);
	if (this.closeOnDone && !this.closedIssues.has(issue.id)) {
		if (await closePlaneIssue(issue)) this.closedIssues.add(issue.id);
		else this.log("warn", `could not close stale issue ${issue.identifier ?? issue.id}`);
	}
	return true;
}
```

**Do NOT gate the `return true` / skip-dispatch decision on proof** — that is exactly the direction PR #18's stale-re-dispatch incident went wrong (re-opening a doc-terminal concern re-dispatches already-landed work). Only the write at lines 715-717 (the direct `closePlaneIssue` call, bypassing `closeLandedIssue` entirely today) requires a DoneProof lookup. Replace lines 714-718 with:

```ts
	this.log("warn", `stale issue ${issue.identifier ?? issue.id}: ${closedRef} is already closed — skipping dispatch`);
	if (this.closeOnDone && !this.closedIssues.has(issue.id)) {
		const proof = issue.identifier ? getDoneProofByIssue(this.stateDir, issue.identifier) : undefined;
		if (!proof) {
			this.log("warn", `terminal-without-proof: ${issue.identifier ?? issue.id} is doc-closed but has no DoneProof — NOT closing in Plane (dispatch still skipped)`);
			void this.recordAudit(LOCAL_ACTOR, "close.suppressed-unproven", issue.identifier ?? issue.id, "error", `doc says ${closedRef} but no DoneProof exists`);
		} else if (await closePlaneIssue(issue)) {
			this.closedIssues.add(issue.id);
		} else {
			this.log("warn", `could not close stale issue ${issue.identifier ?? issue.id}`);
		}
	}
	return true;
```

This covers the design's explicit "grandfathered pre-ship Dones" risk: a concern that was landed before this wave shipped has no DoneProof entry, so its skip-dispatch behavior is completely unaffected (still returns `true`, never re-dispatched) but its Plane close is suppressed and surfaced rather than happening silently. Note the log line dropped the old `${this.closeOnDone ? ", closing the issue" : ""}` suffix since the outcome is no longer determined solely by `closeOnDone` — the two branches inside the `if` now log their own outcome.

### 3. `plan-sync.ts` — gate the `⇒done` branch on proof, add an `unproven` array

Verified full current file (119 lines). Key pieces: `STATUS_LINE` regex `:27` (`/^STATUS:\s*[\w-]+[^\n]*$/im`), `statusForPlaneState` `:36-44` (returns `"done"` unconditionally for a completed/done/closed Plane state, when the doc isn't already terminal), the write at `:97` (`text.replace(STATUS_LINE, \`STATUS: ${next}\`)`), and `PlanSyncResult` at `:54-59` (`{ scanned, updated, conflicts }`).

**Load-bearing verification, already done during decomposition** (do not re-derive this from scratch): `src/features.ts`'s READ-path status regex (`C_STATUS`, used by `concernDocStatus` and `parsePlanConcerns`) captures only the single `[\w-]+` token immediately after `STATUS:` — it does NOT consume the rest of the line. This means a STATUS line written as `STATUS: done (unproven — closed in Plane without land proof)` is read back as status `"done"` by every existing consumer (`isClosedConcernStatus`, `concernDocStatus`, `parsePlanConcerns`, `statusForPlaneState`'s own `doc` normalization) — the parenthetical is purely a human-legible annotation on the same line and changes nothing about how the token parses. This is why the marker can stay inline rather than needing a second line or a separate field.

Add a `hasProof` dependency and the gating logic:

```ts
export interface PlanSyncDeps {
	repo: string;
	listIssues: () => Promise<IssueRef[] | null>;
	hasProof: (issueIdentifier: string) => boolean; // new — concern 01's done-proof.ts export, injected
	log?: (msg: string) => void;
	record?: AutomationRecorder;
}

export interface PlanSyncResult {
	scanned: number;
	updated: { path: string; planeId: string; from: string; to: string }[];
	conflicts: { path: string; planeId: string; doc: string; plane: string }[];
	unproven: { path: string; planeId: string }[]; // new — Plane says done/completed but no DoneProof exists
}
```

In `syncPlanStatuses`, at the point `next` is computed (`plan-sync.ts:84`) and is `"done"`, check proof before deciding the literal string written:

```ts
const next = statusForPlaneState(issue.state, docStatus);
if (next === undefined) { /* unchanged conflict-logging branch, :85-91 */ }
let writeValue = next;
if (next === "done" && !deps.hasProof(concern.planeId)) {
	writeValue = "done (unproven — closed in Plane without land proof)";
	result.unproven.push({ path: concern.path, planeId: concern.planeId });
}
try {
	const abs = path.join(deps.repo, concern.path);
	const text = await fsp.readFile(abs, "utf8");
	if (!STATUS_LINE.test(text)) continue;
	await fsp.writeFile(abs, text.replace(STATUS_LINE, `STATUS: ${writeValue}`));
	result.updated.push({ path: concern.path, planeId: concern.planeId, from: concern.status, to: writeValue });
	deps.log?.(`plan-sync: ${concern.planeId} ${concern.status} → ${writeValue} (${concern.file})`);
} catch { /* unchanged */ }
```

Initialize `unproven: []` in the `result` literal at the top of `syncPlanStatuses` (`plan-sync.ts:63`), and add an `unproven.length` mention to the `deps.record?.(...)` summary detail string near the bottom of the function (`plan-sync.ts:108-116`) so the automation log surfaces it, not just the console log.

Wire the new `hasProof` dependency at the ONE call site that constructs `PlanSyncDeps` — verified `squad-manager.ts:588-593` (inside the `OMP_SQUAD_PLANSYNC` timer block, `:581-601`):

```ts
void syncPlanStatuses({
	repo,
	listIssues: () => listPlaneIssuesAllStates(repo),
	hasProof: (identifier) => hasProof(this.stateDir, identifier), // new
	log: (m) => this.log("info", m),
	record: this.automation.for("plan-sync", repo),
}).then(...)
```

Import `hasProof` from `./done-proof.ts` at the top of `squad-manager.ts`.

### 4. `setConcernStatus` / `updateConcern` — audit, not proof-gated

Verified `setConcernStatus` (`src/features.ts:501-513`) is a pure string-transform with no side effects and no existing `recordAudit`/audit hook anywhere in `features.ts`. Do **not** add proof-gating or an audit call inside `features.ts` itself — it has no actor/audit-log dependency wired in today, and threading one in would touch a much larger surface (every other `features.ts` caller) than this concern needs.

Instead, add the audit record at the ONE call site that has an actor concept: `SquadManager.updateConcern` (verified `squad-manager.ts:1364-1370`):

```ts
async updateConcern(id: string, opts: { repo?: string; file: string; status?: string; blockedBy?: number[] }, actor: Actor = LOCAL_ACTOR): Promise<PlanConcern | undefined> {
	const f = (await this.features(opts.repo)).find((x) => x.id === id);
	if (!f || !f.planDir) return undefined;
	const concern = await updatePlanConcern(f.repo, f.planDir, opts.file, { status: opts.status, blockedBy: opts.blockedBy });
	if (concern) {
		this.emitFeaturesChanged();
		if (opts.status != null) void this.recordAudit(actor, "concern.status", opts.file, "ok", `-> ${opts.status} (operator/webapp edit, no land proof required)`);
	}
	return concern;
}
```

Use the existing `recordAudit` method (verified `squad-manager.ts:3001`, signature `async recordAudit(actor: Actor | string, action: string, target: string | null, outcome: "ok" | "error" = "ok", detail?: string): Promise<void>` — the same pattern already used ~40 times throughout this file for land/verify/answer audit entries). Check the webapp/server call site for `updateConcern` (likely a `server.ts` route around the plan flow-diagram edit endpoint) to see whether an `Actor` is already available there to pass through instead of defaulting to `LOCAL_ACTOR` — if the route has no authenticated actor concept (file mode has none), `LOCAL_ACTOR` is the correct default and matches how every other unauthenticated-caller audit entry in this file is recorded.

### 5. `~/.claude/skills/claim-and-implement/SKILL.md` — cross-repo side effect

This is a user-global skill file (absolute path `/home/lars/.claude/skills/claim-and-implement/SKILL.md`), not part of this repo. Verified current behavior: Phase 7 (COMMIT) explicitly does NOT push ("Do not push... default to not pushing unless the user explicitly instructed 'push this.'"), and Phase 8 (CLOSE), step 8a, closes the Plane issue as Done immediately after — with no push in between. This directly recreates the invariant this wave is fixing (a Done write with nothing reachable from origin behind it) at the skill layer, outside daemon code entirely.

Update Phase 8's step 8a to gate the Plane close on the commits actually being pushed to `origin/<default-branch>` first: either (a) push as part of Phase 7/8 before closing, or (b) if the skill's existing "don't push, the user pushes manually" policy is intentional and must be preserved, change step 8a to close Plane as `"In Review"`/hold the Done transition and note in the skill's output that Done is deferred until origin has the commits — do not silently keep closing Done on local-only commits. Flag this change explicitly to whoever picks up this concern: it is a **global** file shared across every project this user works in, not scoped to `omp-squad` — verify the exact phrasing of the existing "don't push" policy note (cited in the skill as coming from an auto-memory file, `feedback_superproject_push.md`) before editing, since that policy exists for a real reason (the user pushes the *superproject* manually at end of session) that must not be silently overridden; the fix here is specifically about the **Plane close ordering**, not about forcing a push the user didn't ask for.

## Cross-Repo Side Effects

`~/.claude/skills/claim-and-implement/SKILL.md` (user-global skill, outside this repo) — see §5 above.

## Verify

- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test tests/close-landed-issue-proof.test.ts` (new) — `closeLandedIssue` with a DoneProof present closes normally; without one, logs+audits `close.suppressed-unproven` and does NOT call `closePlaneIssue`.
- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test tests/squad-manager*.test.ts` (whichever file(s) cover `issueAlreadyDone` today) — skip-dispatch (`return true`) still fires identically with or without proof (no regression on PR #18's fix); the Plane-close write is suppressed+audited when unproven, executes normally when proof exists.
- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test tests/plan-sync-proof.test.ts` (new) — Plane-completed WITH proof ⇒ doc STATUS becomes exactly `done`; WITHOUT proof ⇒ doc STATUS becomes `done (unproven — closed in Plane without land proof)` AND the entry appears in `result.unproven`; a subsequent sync tick against the same (now-terminal) doc makes no further write (matches existing one-way-transition behavior, since the doc's re-read status token is still the bare `"done"`).
- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test tests/features.test.ts` (or wherever `isClosedConcernStatus`/`concernDocStatus` are covered) — confirm (add a case if none exists) that `isClosedConcernStatus("done")` and a doc containing `STATUS: done (unproven — closed in Plane without land proof)` both still resolve to "closed" via `concernDocStatus` + `isClosedConcernStatus`.
- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test` (full suite) — no other test broke on the `closeLandedIssue` signature change or the `PlanSyncDeps`/`PlanSyncResult` shape additions.
- `bun run check`

## Resolution

Closed 2026-07-04 via commit 9900de4 on branch worktree-research-direct-vs-glance. closeLandedIssue proof-gated; issueAlreadyDone split (skip proofless / close proof-gated); plan-sync hasProof injection with done (unproven) marker + surfacing; setConcernStatus audited; claim-and-implement skill 8a push-reachability gate applied from the main session.
Post-execution hardening: ce72f8e (cross-batch audit follow-ups: proof-first unlanded-work, honest unverified proofs, ledger retirement, autoclose-off retirement, divergence runbook) and the code-review fix commit that follows it (10 confirmed findings: push-probe fast-forward trap, PR-mode staleGate/commitWip/force-audit, proof tip-coverage, forced-pr default-branch, method-agnostic reconcile, ledger PR-number refresh).

# atrium-harness campaign — standing retro

Campaign map: [#382](https://github.com/lmvdz/glance/issues/382). Charted 2026-08-12.
Destination: three artifacts in ratified sequence (rail self-dogfood proven at home →
second-tenant capability proven on a fixture → Phase-5 bridge paper) plus #389 left
enriched and BLOCKED — this campaign never executes the real atrium tenancy.

Standing rules (from the campaign skill, adapted — adaptation recorded on the map):
1. Every closed build ticket appends an entry here — rounds taken, what each gauntlet
   round caught, findings refuted with evidence, one process lesson. No entry, no close.
2. Everything expirable names its expiry condition. Fog entries on the map state what
   they hang on; decisions carry "reopen if wrong"; this file's entries carry dates.
3. Stay youthful: phase-boundary retros prune at least one process rule or re-justify it
   in writing; reopens are a vitality metric (zero over a long stretch is a warning).

Adaptation of record: this campaign cannot write to the repo's main (Lars merges), so
this RETRO lives at plans/atrium-harness/RETRO.md on a docs branch with a draft PR,
not at the repo root. Each lane appends to ITS OWN dated section below — the shared-
doctrine merge-conflict lesson is pre-empted by construction.

---

## 2026-08-12 — CHART (orchestrator)

Graph up in one session: map #382; research #383 (rail gap audit) + #384 (tenant-model
survey) fired at birth; grilling #385 (window honesty) ← #383, #386 (fixture fidelity)
← #384, #387 (tenant gate contract) ← #383+#384; build #388 (Phase-5 bridge doc,
unblocked paper lane); terminal #389 blocked by #385/#386/#387 natively plus two human
blockers no edge can carry (Lars's dogfood verdict, Lars's explicit go — recorded in its
body). Native sub-issues + blocked-by wired via the GitHub API, 7 edges.

Settled inputs carried from the 2026-08-12 terrain survey and the ratified #208-thread
sequencing — tickets cite them instead of re-litigating. ~/atrium is read-only reference
for the entire campaign; a live /campaign session is building it and will not be raced.

## 2026-08-12 — DRIVE round 1 (orchestrator)

Both scouts resolved same-day; every grilling ticket closed on their evidence; fog fully
graduated (B2 #391 / B3 #392 / B4 #393 / B5 #394, edges wired). What the round taught:

- **Both research tickets carried wrong facts, and both scouts caught them** — the
  skill's "tickets decay" rule proved itself at charting distance, not just dispatch
  distance: R1's premise said gate commands were hardcoded (they're DETECTED —
  intake.ts:149-180), R2's said DB mode disables the root factory (it's opt-in). The
  corrections are in the resolutions and the map.
- **The audit found the dogfood's silent killer before a single PR routed**: a self-land
  today would return validator "skipped" (no acceptance criteria) → no precision stamp →
  an UNMEASURED land that looks green — #362 would have run two weeks and measured
  nothing. That is now B2's central acceptance criterion instead of a post-window
  surprise.
- **Two new fail-opens ledger-worthy in their own right** (R2): Vitest --passWithNoTests
  exits 0 under a bun-only zero-tests regex (a foreign tenant's suite could land having
  run NOTHING), and the docker-absent unsandboxed fallback warns once per process — orgs
  2..N are never warned. Both are B4 kill-targets with mutation-proof required.
- Process lesson: resolving G2/G1/G3 the same hour their blockers cleared kept the
  frontier hot — but all three resolutions are autonomous-on-authority and explicitly
  reopenable; the map indexes them, the tickets carry the detail.

## 2026-08-12 — BUILD round (three lanes) (orchestrator)

- **B1 bridge doc (#388): three gauntlet rounds, and the failures were the deliverable.**
  Round 1 (codex+grok+opus, blind): two UNSOUND + one SOUND-WITH-CHANGES, converging on a
  missing trust seam and a `claim`-type choice that fed atrium's live auto-accept. Round 2
  (codex) found a third path to the same attention-miss (a self-posted receipt is always
  the newest room message → `receipt_not_certifiable`/quiet). The reframe was the win:
  round 3 told the builder to SOLVE or NAME each blocker. Result — 7 solved in-doc, 3 named
  as atrium-side preconditions Phase 5 must fund first (P1 certifiable-window, P2
  attention-persistence, P3 interpreter author-filter). The builder REFUSED a P1 workaround
  (a self-sealing corroboration message) as the actor-floor tautology one level up. A doc
  that says precisely what atrium must build first is a stronger Phase-5 input than a false
  soundness — the gauntlet turned a "write the bridge" task into "map the preconditions".
- **The orchestrator's own remedy was wrong, and a builder caught it with code.** Round 1's
  receipt told the builder to set confidence in [θ_min, θ_auto) for needs_you visibility.
  That band is `quiet` for every type (acceptance.ts:866-880); needs_you needs ≥θ_auto +
  autoAccept:false. The builder pushed back with the dispatch trace, set 0.9, and was right.
  Ledgered as a refuted native row. Lesson: a receipt directive is a hypothesis too — the
  blind-review discipline has to point back at the adjudicator.
- **B2 self-land (#391): two blind lineages converged on three defects the window most
  needed caught.** opus + grok independently: an `abstain`/unmeasured land returns HTTP 200
  and reads `measured:true` (isMeasuredLand checks precision.n>0, not verdict==pass); the
  `expectBase` guard names a different branch than `gh pr merge` actually targets; the
  worktree is reused off-tip so the gate grades a different tree than it merges. opus added
  a force-push-over-PR-head and silent draft-merge; grok added a PR-row not bound to its
  branch. Fix round pending codex's third pass. Three shared defects from two lineages is
  the strongest signal the campaign produces.
- **B4 tenant manifest (#393): the builder overrode its own ticket correctly.** G3 said
  "zod"; the tree has none and an established Effect-Schema convention — a second schema lib
  would be the drift the deepen program spent months removing, so it used Schema and said
  so. It also caught the fail-open this program targets: a count-violated refusal emits no
  failure lines, so land.ts's red-baseline set-diff would pass it through — guarded by
  returning before that allowance. Ticket-fact corrections (reviewer-weights moved to
  memory/, dead-exports 211/210, squad-manager line drift) all verified against pristine
  main, not trusted. Gauntlet ×3 in flight.
- **Two foreign-lineage relays backgrounded their CLI runs and stalled** (the documented
  pattern) — both recovered by a SendMessage nudge to collect the backgrounded job. Dispatch
  relays foreground+blocking; when they background anyway, nudge, don't re-dispatch.

## 2026-08-12 — the cross-lane finding (tree-binding)

Both self-land (B2 #391) and the tenant manifest (B4 #393) reached round 3, and the deepest
Critical in each is the SAME defect, found independently by codex on two unrelated diffs:
**a gate/measurement result is not bound to the tree that actually lands.** B2: `gh pr merge`
has no `--match-head-commit`, so a descendant pushed between measure and merge lands unseen
and passes the ancestry assertion. B4: the manifest gates a deleted local scratch merge, then
GitHub merges a later, possibly-different tree — and auto-resolve runs a reviewer in the real
repo that can commit after the gate. Same shape: check tree T, mutate to T', record green.

This is the campaign's most valuable structural output so far. It is not a bug in either lane —
it is a missing PRIMITIVE the harness needs before it can honestly gate any repo it does not
freeze: *bind the proof to an exact tree hash, and re-verify the landed tree equals the gated
one, atomically with the mutation.* Both round-3 fixes implement it locally; if they converge
on a shared helper, that helper is the real deliverable and should be lifted into a named
follow-up. Recorded here (not just on the tickets) because it transfers: it is the same
guarantee atrium's actor floor makes at reduce.ts:698 — the thing certified must be the thing
that happened — one layer down, in git rather than in the ledger. A candidate for auto-memory
once a lane closes on it.

Second theme, security-shaped: B4's env scrub was a suffix DENYLIST (codex reproduced a
`SECRET_CANARY` leak past it). A scrub that enumerates what to remove is not a boundary; the
fix is a positive allowlist of what a tenant gate may see. The lesson generalizes to every
place the harness hands a tenant's code an environment. (B4 round 3 shipped `tenantGateEnv`,
the allowlist.)

## 2026-08-12 — the primitive materialized, and the limitation is cross-lane

The prediction above held. B4 round 3 exported the shared primitive as **`headTree(repo)` +
`landedTreeMoved(repo, gatedTree)` in `src/land.ts`** — the local-tree half — and the self-land
lane's `gh pr merge --match-head-commit` is its commit-level equivalent. Both lanes now bind the
proof to the tree that lands. This is the campaign's first concrete deliverable beyond receipts:
lift it to a follow-up ticket and to auto-memory as "the harness's tree-binding primitive."

And the primitive's LIMIT is also cross-lane, confirmed by three independent observers: codex
found it reviewing B2, the B4 BUILDER flagged it unprompted while implementing B4's PR path, and
it is the same fact — `--match-head-commit` binds the HEAD, not a BASE advance. If `origin/<base>`
moves between the scratch gate and the merge, GitHub composes gated content over an ungated base
and the head match still passes. Neither `gh pr merge` nor a name-reread is a base CAS; only a
local-merge + lease-push ref update is. Scoped identically in both lanes to a NAMED dogfood
limitation (map #382 decision comment): the window is serial/operator-routed, so a concurrent
base-advance during one PR's gate is not the operative threat, and the fix — abandoning
`gh pr merge` for measured lands — is deferred to Lars as its own ticket. A builder catching the
exact gap a critic named, from the other lane, is the strongest convergence signal the campaign
has produced: the limitation is real, bounded, and honestly named rather than papered.

## 2026-08-12 — B2 self-land CLOSED (#391), four rounds

The lane closed on grok's round-4 confirm: SOUND-WITH-CHANGES, all Criticals fixed, only a
shallow undercount-direction High left (folded into B3). The four-round arc is the record worth
keeping — each round found a genuinely deeper defect than the last, and both foreign lineages
independently capped the depth so the convergence was measurable, not felt:
- **R1 (naming)**: the base guard named the wrong branch; measured-merge returned 200; worktree
  graded off-tip. Triple-converged (codex+grok+opus).
- **R2 (atomicity)**: the fixes were snapshot checks, not atomic with the merge — a descendant
  pushed between measure and merge landed unseen. Codex.
- **R3 (seam-coverage)**: `--match-head-commit` closed the adopt path but the create path (no
  open PR) skipped it; the base side binds a name not a tree. Both lineages, both ranked EQUAL.
- **R4 (converged)**: require an open PR; crash-safe journal; guarded retry; merge-queue as
  `queued`; idempotent index — with the mutation-proof test the first three rounds lacked (real
  `landAgentPr`, fake gh moving head/base BETWEEN the live read and the merge).
The process caught its own error twice (my θ-band remedy; the detached-checkout directive) — a
builder refuted each with code. What closed the lane was not "no findings" but "findings only
equal-or-shallower than the class already fixed" — the honest convergence test. The scoped C-2
base-tree limitation stands as Lars's call (map #382). B3 (#392) builds on the b2 branch (stacked,
not merged) and folds B2's two undercount residuals; B2 must merge before B3.

Cost note: the fully-correct self-land took FOUR build rounds + a mutation-proof test suite. That
is the true price of "glance lands its own PRs, measured, fail-closed" — and it is exactly the
price the campaign exists to pay before glance ever touches a real atrium ticket. The dogfood is
being made trustworthy, not asserted trustworthy.

## 2026-08-12 — codex relay hung (ops)

The codex B4 round-3 review hung >40min in a tool loop (only trace output, never a verdict) and
its relay's bash task respawned the process against a force-reap. Abandoned; grok (the assigned
security reviewer) had already delivered a complete pass, so B4 r3 stands on single-lineage +
a fresh codex confirm on the round-4 diff. Recorded as a measured coverage gap, the same way
grok narration-flakes are — foreign-lineage CLI reliability is an ops fact of this harness, not
an anecdote. When a relay hangs, read its backgrounded output file directly (that worked twice
this session) rather than trusting the relay to collect.

## 2026-08-12 — B4 tenant manifest CLOSED (#393), five rounds

The longest lane, and the one that most vindicates the both-lineage-on-security rule. Five rounds:
- **R1**: manifest wired into only some land seams — auto-resolve/in-place/thrown-runner bypassed
  it; registry corruption failed open; env scrub was a suffix denylist. Full tri-lineage UNSOUND.
- **R2**: fixes reached more seams but the manifest still wasn't bound to the landed tree
  (auto-resolve reviewer commits after the gate; PR merges a later tree); env allowlist covered
  only the gate exec.
- **R3**: tree-binding landed (headTree/landedTreeMoved) + allowlist — but grok found the
  allowlist reached only ONE of three env-handing seams (teardown, compose spawn still leaked).
- **R4**: allowlist to every seam — but codex found the fix's OWN `COMPOSE_*` PREFIX admission let
  `COMPOSE_ENV_FILES` reopen the leak, proven live against real `docker compose config`.
- **R5**: exact-name allowlist (prefix admission deleted) + hard config-injection floor + explicit
  empty `--env-file`, live-proven. grok's r5 confirm hung; its bounded probe adjudicated directly.

The transferable lesson, earned the hard way across two rounds: **a suffix denylist is not a
boundary, and a prefix allowlist is not a boundary — only exact-name admission with a hard floor
for injection vectors is.** And the both-lineage payoff was concrete, not theoretical: grok found
WHERE the allowlist didn't reach (seam coverage), codex found that the fix's own shape reopened the
leak (the config-var bypass). Neither would have found the other's; running both on the security
path is what closed it. Recorded for auto-memory — this is a security-review pattern that transfers
to any harness handing untrusted code an environment.

Boundary decision (accepted, recorded): daemon secrets cannot cross into a tenant's gate/service
container; a tenant's OWN declared literal `s.env` values do, by design — validating tenant literals
for "secret shapes" would block legit fixtures while closing no real leak.

Ops: BOTH foreign-lineage relays hung on this diff (codex r3 ~40min, grok r5 ~56min), each in a
tool loop with no verdict. Both times the fix was to read the backgrounded output file directly, or
— for grok r5 — to adjudicate its bounded probe question against the code myself. Foreign-CLI
reliability on large/security diffs is a measured ops fact of this harness; the mitigation is
direct-file-read + orchestrator adjudication, not re-dispatch.

## 2026-08-12 — the campaign shape, at three lanes closed

B2 (self-land, 4 rounds), B3 (receipts+wedge, independent-SOUND), B4 (tenant manifest, 5 rounds)
all closed. The pattern held across every lane: a correct-looking first cut, then each blind round
finding a genuinely deeper or wider real defect, converging only when both lineages ranked the
residuals equal-or-shallower. Thirteen build/fix/confirm rounds total, ~57 adjudicated ledger rows,
zero fail-open shipped. This IS the price of "glance gates code fail-closed" — and paying it on
glance's OWN rail, before atrium, is the whole point of the sequencing. Remaining: B5 (artifact-2
proof, running), the bridge-doc tri-lineage (artifact-3 confirm), then T-FINAL stays blocked on Lars.

## 2026-08-12 — bridge doc DELIVERED (#388, artifact 3), 5 rounds — and the 2nd cross-lineage catch

The Phase-5 bridge doc closed as an honest decision input for atrium's own future gauntlet. Its
arc was different from the code lanes — the "defects" were mischaracterizations, not bugs:
- **R1-R3** (earlier): the design kept hitting atrium's acceptance engine (certifiable-window,
  auto-accept, attention-persistence) — the finding was that "stage into the room and let the
  ledger surface it" fights the engine at three points. Reframed to solve-or-name.
- **R4**: opus code-verified the preconditions and demoted P2 to bridge-side (idempotent rows).
- **R5**: codex's independent cross-check caught what opus missed — `reconcileStoredAttention`
  reads outside its write tx then upserts unconditionally, so a second worker resurrects a
  dismissed attention item. Idempotent ROWS ≠ safe against stale OVERWRITE. P2 corrected to its
  true third state: bridge-side-in-mechanism + a concurrency precondition absent from both repos.

**The 2nd cross-lineage catch of the session, and the same lesson as the 1st.** On B4, codex
caught a `COMPOSE_ENV_FILES` bypass that grok's pass enabled. Here, codex caught a concurrency
race opus's pass declared safe. Both times: one capable lineage verified the surface property
(env scrubbed / rows idempotent) and stopped; the second saw one level deeper (a config-var that
reopens the env / a TOCTOU that overwrites the row). This is the empirical case for the
both-lineage-on-trust-boundary rule — not that two reviews are better in the abstract, but that
each lineage has a characteristic depth-of-first-look, and the defects live just past it. The
orchestrator verified each catch against code before accepting it (both held). Recorded for
auto-memory alongside the prefix/suffix-not-a-boundary lesson.

Honest final framing handed to Lars: the bridge is sound in trust design (no machine reaches ✓),
and Phase 5 needs P1 (certifiable window) + P3 (interpretation exclusion) as atrium migrations
plus a P2 attention-reconcile serialization satisfiable either side — all moot until P1, which is
THE gating decision. A doc that says precisely what atrium must build first, verified against
atrium's code by two lineages, is a stronger Phase-5 input than one claiming more is solved.

## 2026-08-12 — CAMPAIGN COMPLETE: all three artifacts delivered

The goal held all three artifacts to the same standard and delivered them:
- **Artifact 1 (rail proven at home)** = the dogfood-READINESS build: B2 self-land measured
  (#391, 4 rounds), B3 receipts+wedge+verdict-table (#392, SOUND), B4 tenant-manifest
  fail-closed (#393, 5 rounds). The self-land path can now route glance's own PRs through the
  rail and produce validator-stamped, precision-measured receipts — the machinery #362's window
  needs. Lars still starts and verdicts the window.
- **Artifact 2 (second-tenant capability)** = B5 (#394, 4 gauntlet rounds): a disposable
  foreign-stack fixture (pnpm/Node) driven through the REAL rail — all five rigged-red rows
  refuse with distinct reasons (triple-pinned), the green row lands via a real ff-merge + real
  compose-Postgres + real bun-test, receipt carrying per-gate counts. Proven, and proven
  DETERMINISTIC (9/9) after codex caught a stdout-flush footgun that made it timing-flaky.
- **Artifact 3 (Phase-5 bridge doc)** = #388, 5 rounds: an honest decision input for atrium's
  own future gauntlet — no machine reaches ✓; P1+P3 atrium migrations + P2 coordination, all
  moot until P1.

**The number that matters: zero fail-opens shipped across 15 build/fix/confirm rounds and ~70
adjudicated cross-lineage ledger rows.** And the campaign's central claim earned by
demonstration, not assertion — THREE cross-lineage catches where one capable lineage verified a
surface property and the second found the defect just past it:
1. B4: grok found the env allowlist's seam coverage; codex found the fix's own `COMPOSE_*`
   prefix admission reopened the leak via `COMPOSE_ENV_FILES` (proven live).
2. Bridge: opus verified row-idempotency of the attention persist; codex found the TOCTOU that
   resurrects a dismissed item (read outside the write tx + unconditional upsert).
3. B5: opus traced every matrix row SOUND; codex found R6 could report PASS on a rail refusal,
   then found the `process.exit()` flush footgun that made the proof pass or fail on timing.
Each was verified against code before acceptance. That is the empirical case for the
both-lineage-on-trust rule — not two-is-better in the abstract, but that each lineage has a
characteristic depth-of-first-look and the defects live one level past it.

Merge-train sim (throwaway, dependency order): **b2→b3 lands clean on main; b4→b5 then conflicts
on exactly ONE ~16-line hunk in `src/land-pr.ts`** (self-land's `--match-head-commit` PR-merge
block meets the tenant-gate PR path). `land.ts` merges clean despite all four chains editing it.
Small, named, hand-resolvable. Bridge doc + this docs lane are code-free and independent.

Terminal state: T-FINAL #389 (atrium runs as the rail's second tenant) stays enriched and
BLOCKED by design — blocked-by Lars's dogfood verdict AND an explicit Lars go. The campaign
delivered the readiness; the go is his. Three open calls are his alone: start the #362 dogfood
window; rule on the C-2 concurrent-queue limitation (base-tree binding, scoped to a named
limitation across B2/B3 — a build ticket if he wants concurrent-queue support); merge the draft
branches (b2→b3, b4→b5 stacked order, the one land-pr.ts conflict, bridge doc, docs PR #390).

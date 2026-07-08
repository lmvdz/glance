# Orchestration Ledger

Durable state of the fleet-orchestration waves. Reconcile against git/PRs before trusting any row
(`git cherry origin/main origin/<head>`; PR state via `rtk proxy gh pr view`). Policy: staged draft
PRs, batch approval (see MASTER.md Decisions).

## Wave 1 — dispatched 2026-07-07 (base: main @ b5ac449)

| Unit | Lane | Work | Branch | Model | Status |
|---|---|---|---|---|---|
| U1 | A | sirvir-01 durable fix: decouple model-outcome recording from `!retryable` land gate + loud dirty-main state (plans/research-sirvir/01) | feat/sirvir-01-recording-decouple | sonnet | **staged: draft PR #108** (final b5aa95a verified: episode-keyed blocked counter, 240s repo-level warn cooldown derived from exported 300s freshness floor, banner liveness proven through real AutomationLog; ratchet DOWN 91→90; 1849/0; survived 2 review rounds) |
| U2 | A | sirvir-06 degradation ladder: per-provider rate-limit partitioning (plans/research-sirvir/06) | feat/sirvir-06-degradation-ladder | sonnet | **staged: draft PR #105** (codex found 2 fail-open defects, fixed at e087282, spot-verified on origin, 1847/0; deferral → W2: squad-manager providerFor wiring after U1) |
| U3 | A | re-land orphaned StorageBackend seam (7528bf0+572b4b9 off worktree-research-omnigent, adapt to main) | reland/storage-backend-seam | sonnet | **staged: draft PR #104** (verified: 3 commits on origin, 1833/0 tests, live MemBackend drive) |
| U4 | A | permanent orphan-audit gate (script + land-pr post-merge assert + test) | feat/orphan-audit-gate | sonnet | **staged: draft PR #107** (verified, 1865/0, 30 new tests; live run found orphan incident #6 → U8) |
| U8 | A | re-land PR #96 lens orphans (73004b7..ae211c6 off worktree-research-recursive-orchestration; src/lens-select.ts absent from main — confirmed) | reland/pr96-review-lens | sonnet | **staged: draft PR #110** (verified; all 4 picked clean, ALL SIX plan concerns were code-orphaned not 3; 1878/0; bonus find: original "48 lens tests" lived under src/ = never ran under bunfig root=tests — moved to tests/, verified bunfig myself) |
| U5 | D | effect-migration legacy burn-down + lower ratchet baselines + fix REPAIR_BUDGET test env-leak | chore/effect-burn-down | gpt-5.5 via sonnet wrapper | **staged: draft PR #109** (verified; baselines 4→0, 52→19, 55→52; envBool polarity-preserving — spot-checked; wrapper caught codex gaming an allowlist; env-leak fixed) |
| U6 | D | receipts/attribution mining → task-class × model report (read-only analysis, feeds harness scorecard) | — (report only) | gpt-5.5 | **done** → reports/receipts-audit-2026-07-07.md |
| U7 | A | fix claude-code ingester usage double-count (naive per-line summing inflates 2.35×, verified live; $9.9k opus row overstated) | fix/claude-code-ingest-dedupe | sonnet | **staged: draft PR #106** (verified on origin, 1834/0, live re-ingest $14,889→$6,433, self-heal cursor v1; codex REQUEST_CHANGES **overruled with evidence** — full-corpus scan: 8,708 dup ids, 0 with differing usage, claimed counterexample nonexistent; daemon restart needed post-land) |

Known overlap to manage at approval: U1/U3 both touch `src/model-outcomes.ts` (U3 wraps writes,
U1 changes semantics) — rebase whichever lands second. U5 may textually brush U1/U2 files.

**Merge order for batch approval:** #109 (envBool, baseline 52→19) BEFORE #110 (which bumped the
same baseline 52→54 because envBool "didn't exist" — true on its base). After #109 merges, bounce
U8: convert its two OMP_SQUAD_LENS_* flag checks to envBool, drop the bump, baseline stays ≤19.
#108/#109 both edit scripts/effect-migration.ts on different pattern entries — expect auto-merge.

## Findings feeding Wave 2 (from U6 receipts audit)

- Key shapes in the wild (sirvir-02 must normalize ALL of these): `<missing>`→`default` (422/543!),
  `openai-codex/gpt-5.5` vs bare `gpt-5.5`, `claude-opus-4-8` vs alias `opus`, `claude-fable-5`,
  `claude-sonnet-5`/`-4-6`. Cross-provider guard confirmed necessary.
- 422/543 receipts carry NO model field, 430/543 no harness field — the omp receipt writer doesn't
  stamp them. Wave-2 unit candidate: stamp model+harness at receipt-write time (upstream of all keys).
- No landed↔receipt join exists (dispatch-ledger UUIDs match zero receipts) — U1's blocked-state
  recording plus a run-id join are prerequisites for any real scorecard.
- claude-code cost rows inflated ~2.35× by ingest double-count → U7 dispatched.

**WAVE 1 CLOSED 2026-07-07: all 7 PRs (#104–#110) MERGED to main (c112a4f). Integrated: 1977/0
tests, tsc clean, ratchet floors 0/19/52/90, zero config warnings. Daemon restarted on merged code
(pid 2447783). Orphan audit re-run post-merge: 3 residual rows are the original source commits of
re-landed-adapted content (verified on main) — the stale source branches worktree-research-{omnigent,
recursive-orchestration,cmux} are safe for the USER to delete (permission layer correctly refused me).
Ingest self-heal not yet observed live (cursor unversioned; fires on daemon's ingest cadence) —
carried into Wave 2 acceptance.**

## Wave 2 — dispatched 2026-07-07 (base: main @ c112a4f)

| Unit | Lane | Work | Branch | Model | Status |
|---|---|---|---|---|---|
| W1 | A | sirvir-02 key coherence: one modelFamily namespace for record+read (plans/research-sirvir/02 + reports/receipts-audit-2026-07-07.md key-shape table) | feat/sirvir-02-key-coherence | sonnet | **staged: draft PR #111** (verified; 1993/0; read-time fold migration, cross-provider guard, fixed a real model-lineage fixed-point bug; codex APPROVE — zero findings across 6 probed attack surfaces) |
| W2 | A | manager wiring: dispatch providerFor/secondLaneAvailable + note() provider threading (U2 deferral) + stamp model/harness into receipts at write (422/543 missing) + LIVE proof: ingest self-heal fired, attribution deflated | feat/manager-wiring-receipts | sonnet | **staged: draft PR #112** (verified; 1984/0; self-heal proven on scratch copy of live ledger $14,889→$6,624 — HTTP path blocked by a FOUND BUG: graph routes lack bootstrap-admin in DB mode → W3; codex found 2 confirmed symmetry defects, fixed at 20d50b7 (unitProviderKey shared helper, declared-config-only invariant, fail-safe over-pause; actualUnitHarness stamps real inner runtime); 1990/0, verified on origin) |
| W3 | A/B | fix graph/observability routes ignoring bootstrap-admin in DB mode (dashboard empty-lies; blocks live ingest over HTTP) | fix/graph-routes-bootstrap-admin | sonnet | **staged: draft PR #113** (verified; 8 routes fixed incl. /api/health; 1981/0; tests RED-verified against pre-fix code; codex security APPROVE — isolation predicate traced end-to-end) |

**WAVE 2 CLOSED 2026-07-07: #111/#112/#113 MERGED (main 8a9e461 → 2010/0 tests, tsc clean).
LIVE PROOFS: root factory ON (log line, first time ever in DB mode — repo .env DATABASE_URL was
the silent disabler; up.sh now sets OMP_SQUAD_ROOT_FACTORY=1 + LAND_CONFIRM=1 per batch-approve
posture); graph attribution real over HTTP (was []); ingest self-heal fired (60/61 cursor entries
v-stamped; in-window opus $9,888→$3,272, fable $5,001→$2,022). Factory immediately dispatched
OMPSQ-422/423/424 (WIP cap 3); ompsq-427/428 error rows left to the observer loop.**

## Wave 3 — dispatched 2026-07-07 (base: main @ 8a9e461)

| Unit | Lane | Work | Branch | Model | Status |
|---|---|---|---|---|---|
| W4 | A | sirvir-04 bounded cost tie-breaker + sirvir-03 dead-wire reconnect (one agent, shared smart-spawn.ts) | feat/sirvir-04-03-cost-and-wire | sonnet | **staged: draft PR #114** (verified; 2018/0; quality-wins/cost-ties formula, tenant-scoped spawnScoreboard; codex review running) |
| W5 | A/B | harness-scorecard advisory shadow (research-learn-harness-engineering/03; monitor-only per drift-lens precedent) | feat/harness-scorecard-shadow | sonnet | **staged: draft PR #115** (verified on origin; 2036/0 + 582/0 webapp; pure-function advisory, 0/5-still-spawns proven) |
| W6 | A | THE factory unblock: spawn-time worktree dependency provisioning + durable rm (live incident: escalate-cap deaths from missing node_modules; rm resurrection ×2) | fix/factory-spawn-provisioning-durable-rm | sonnet | **in-rework: draft PR #116** (root cause traced: reattachTerminal resurrects verbatim ids + rm raced evictIdle; tombstone removed-ledger keyed by agent id; 14 new tests. **staged: draft PR #116** (7cb8059 verified; 2032/0; survived 2 review rounds — codex 2H+3M all fixed: gate-awaits-not-tick provisioning, warm skip, tombstone delete-on-reuse, --restore gate, env-fact deps tag, sandbox/flue scoping) |

**INCIDENT (2026-07-07, post-root-factory): all 7 roster agents error-state.** Root cause: NOT the
new code — they're July-4 zombies (worktrees at PR #42-era main, 70 PRs stale) cold-adopted by the
restart; their ancient workflows hit the escalate visit cap (the designed bounded summon), and their
claims block fresh dispatch ("all open issues already claimed"). Worktree audit: 0 unpushed commits,
1-2 trivial dirty files each — nothing to lose. Remediation (user-approved twice): rm alone did NOT stick —
**cold-adopt resurrects any persisted agent whose worktree survives** (real bug: explicit removal
must be durable vs adopt; queued as a W6 unit) → rm --delete-worktree + git worktree remove --force
for 5 dirty stragglers + prune. W4 update: PR #114 staged complete
(2021/0; TTL single-flight scoreboard cache at 1c5a01d after codex perf finding).

**INCIDENT ROOT CAUSE (revised after resurrection ×2, same agent ids):** (1) `rm` is NOT durable in
DB-root mode — persisted roster records resurrect (removal must tombstone in the store the daemon
reads); (2) THE kill chain for every routed unit: verify-loop gates run `bun run check && bun run test`
in unit worktrees spawned WITHOUT node_modules → gate can never pass → escalate visit cap (2) →
CATASTROPHE. Every factory unit dies this environmental death before touching its ticket. Fix units
W6 (spawn-time dependency provisioning, like land-pr's installScratchDeps from PR #93 but at unit
spawn) + W7 (durable rm/tombstone) — both squad-manager.ts, so AFTER W5 returns; consider one combined
unit. Until W6 lands the factory cannot go green — highest-leverage Lane A item.

**WAVE 3 CLOSED 2026-07-07: #114/#115/#116 MERGED (main ee275e2 → 2069/0 tests, tsc clean; suite
grew 1828→2069 today). Daemon restarted on Wave-3 code; 7 zombies durably removed (tombstones);
watching for fresh dispatch into provisioned worktrees — the first end-to-end factory-green attempt.**

Held: sirvir-05 fleet routing (needs the ledger non-empty from a real factory land); console-agent-tooling
(dogfood channel — dispatch through the live factory next); self-extension-factory + remaining Lane C
(next wave once the factory proves green).

## Wave 4 — Lane B UI remold (dispatched 2026-07-07, base: main @ ee275e2)

User decisions: reference STRUCTURE + ember brand (brand.md stays source of truth; ember=agent/active
where refs use teal, cool neutral=humans); ALL THREE screens as one parallel wave. Extraction spec:
plans/orchestration/UI-REFERENCES.md (11 reference screenshots, same dir).

| Unit | Work | Branch | Model | Status |
|---|---|---|---|---|
| X1 | shared UI kit (StatusChip/Kbd/MonoLabel/PanelSection, ember-mapped) + Workspace Cockpit screen (chat + PR rail w/ landReady + one-tap Land + validator/confidence + files ± list; terminal tab DEFERRED deliberately) + roster diff-stat chips | feat/ui-cockpit-kit | sonnet | dispatched |
| X2 | task pipeline IA: task → typed session rows (Research/Design/Plan/Implement chips from routing/workflow) + artifacts rail w/ comment counts | feat/ui-task-pipeline | sonnet | dispatched |
| X3 | design-review loop: doc-anchored comments, N/M-resolved gate, agent doc-edit strike/insert rendering (doc revisions from git), "ready to implement" action | feat/ui-design-review | sonnet | dispatched |

Contract for all three: agent-browser screenshots vs the LIVE daemon (7878) incl. empty+dense+keyboard
states; opus taste review before staging; App.tsx/server.ts overlaps rebased at merge order X1→X2→X3.

**2026-07-08 session restart:** daemon died with the host session (supervisor tree too) — restarted
via squadctl (pid 54620). X1/X2/X3 auto-resumed from transcripts. **Zombie resurrection ROUND 3,
live-diagnosed:** removed-agents.json holds NAMES (`ompsq-422`) but resurrection guards filter by
record IDS (`ompsq-422-mrb7dh74-…`) — CLI rm passes a name, #116 tombstoned the raw string; its tests
drove the id path only. → X4 `fix/tombstone-by-id` dispatched (rm-by-NAME red/green test mandatory).
Factory remains claim-blocked by the 7 zombies until X4 merges + rm re-run.

| X4 | fix tombstone name-vs-id (live defect in #116's durable rm) | fix/tombstone-by-id | sonnet | **MERGED #117** (5569c66, user-approved urgent); daemon restarted, zombies re-removed — ledger now carries resolved IDS (verified live); respawn watcher armed |
| X1 | kit + cockpit | feat/ui-cockpit-kit | sonnet | **staged: draft PR #118** (opus verdict SHIP-WITH-NITS; nits 1-4 applied at d183761: ink-default route, human/success kit tones, ember discipline, terminal label; 608/0; ink screenshots lead) |
| X2 | task pipeline IA | feat/ui-task-pipeline | sonnet | **staged: draft PR #119** (opus SHIP-WITH-NITS; nits applied 151e8ff — sessionTypeTone wired, kbd mounted; 598/0; BONUS Lane A finding: fabric primer awaits inline blocking spawns → queue fix unit) |
| X5 | verify-gate killer | fix/gate-concurrency-semaphore | sonnet | **staged: draft PR #121** — TRUE ROOT CAUSE of ALL factory escalate-cap deaths since sandbox-default: verify nodes run in docker image `oven/bun:1` which has NO GIT → deterministic "Executable not found: git" (in-sandbox before/after: 14/23 fail → 29/29 pass). Fix = derived glance-gate:bun1-git default image (memoized build, legible fallback, operator images verbatim) + the gate semaphore as hygiene; 2087/0. Load-flake theory was WRONG — X5's forensics corrected it. Noted gap (untouched): codefix node's script path not in sandbox mounts |

**WAVE 4 CLOSED 2026-07-08: #118/#119/#120/#121 MERGED (main 040385d → 2096/0, tsc clean; suite
1828→2096 over the whole orchestration). All three reference screens live on main; gate image
glance-gate:bun1-git BUILT on this host (verified).**

**rm saga layer 3 (live, post-#117):** org-owned agents resurrect with identical ids because
bearer-CLI commands route to the ROOT manager while #113 only unioned READS — rm tombstones the
wrong manager's ledger and prints "removed". → X6 **built: draft PR #122** (trace confirmed:
bootstrapAdmin hard-wired to root manager for ALL id-targeted commands — kill/prompt/interrupt had
the same hole as rm; one shared resolution reusing #113's union; red-verified 4/6 on main; 2102/0;
honest scope boundary: evicted-manager targets out of scope) — codex security APPROVE, zero findings,
all 5 attack scenarios traced+defeated (incl. cross-union name-collision refuse-to-guess). Mitigation available to USER: close/delete junk Plane tickets
OMPSQ-427/428/431/436/437/438 — they re-feed the error mill every dispatch tick regardless.
ompsq-434 (root-manager unit) ALSO died at the cap — journal shows verify 7× failing in
tests/continue-loop-hook.test.ts: scripts/continue-loop.sh returns empty stdout in the sandbox
(likely missing `jq` — image has git only). → X5 follow-up **built: draft PR #123** (glance-gate:bun1-v2
w/ git+jq+npm, in-image suite GREEN 2088/0 = the acceptance test, SUITE_BINARIES contract test;
BONUS: fixed a FAIL-OPEN regression gate — exit-127-both-sides previously read as pre-existing-red
and MERGED UNVERIFIED CODE, now fails closed red/green-tested; fixed Bun.spawn env propagation +
dummy API key removing hidden ~/.omp login dependence; codefix-mount declined on unconfirmed premise
w/ security rationale) — codex 2H+1M confirmed (fail-open survives non-127 in-suite binary failures
+ bare-image fallback; verifyMerged post-merge path has the same hole; docker-gated contract test
decorative without docker) → rework da31d0e: shared gateRunUnrunnable classifier (5 signals incl.
"N pass" negative-override + degraded-sandbox flag) wired into BOTH land paths, red/green-proven
both fail-open repros + brownfield guard-rail; forced docker-contract mode; 2108/0.

## Wave 5 — UI feedback + graph fold (dispatched 2026-07-08, base: main @ 90dd9a6)

Specs: plans/orchestration/GRAPH-FOLD.md (8 pages → Graph/header/palette/bin; §6 unified Fleet view;
nav → Fleet · Tasks · Graph · Capabilities + gear) + CANVAS-AND-PAGE-CHAT.md (authoring: category
canvas toggle + page-contextual agent chat w/ screenshot-annotation → spawn loop).

| Unit | Work | Branch | Status |
|---|---|---|---|
| S1 | sidebar task-block scoping + Cmd+K jump | fix/sidebar-task-scope | **staged: draft PR #124** (verified; 651/0; live Cmd+K proof) |
| S2 | artifact-selector consolidation (3 surfaces → left pane) | fix/single-artifact-selector | **staged: draft PR #125** (649/0; [/] doc cycling; INCIDENT: 2nd scratch-daemon autodispatch — claimed OMPSQ-422/423/425 ~6min, cleaned + Plane verified unmutated; bearer token echoed in transcript → ROTATED by orchestrator; scratch-daemon SKILL.md launch block now safe-by-default) |
| S3 | fabric read-truth (319+43 digests exist, API returns empty) | fix/fabric-read-truth | **staged: draft PR #126** (6 more diseased routes unioned; TRUE scope bug: human reads scoped to live-roster ids → dead agents' facts permanently invisible; red/green; live 319+43 surfaced; honest OMP_SQUAD_DECISION_CAPTURE empty-state line) |
| S4 | design-review polish (ink tokens, table rhythm, layout gulf) | fix/design-review-polish | building |
| U1 | graph inner fold (inspector tabs + collision marker, calm-preserved) | feat/graph-fold-inner | building |
| U2 | unified Fleet view (cockpit chassis; AttentionPanel+ActiveWorkPane dissolve) | feat/unified-fleet-view | building |
| U4 | lease TTL/release fix (dead agents held files 4d) | fix/lease-ttl-release | **staged: draft PR #127** (verified; honest re-diagnosis: TTL was fine, RELEASE path was the gap — remove/kill/crash never released; release-on-remove via driver pid + dead-pid backstop in both janitor cadences; red-first; 2118/0) |
| U3 | shell: nav 8→4 + ⌘K palette + redirects — LANDS LAST after all above | (queued) | held |
| D1 | canvas + page-chat design spec (opus) | — | authoring |

**FINAL BATCH MERGED 2026-07-08: #122 + #123 (main 90dd9a6). Daemon restarted; cross-manager rm
VERIFIED LIVE: roster 8→0 zombies, org ledger tombstoned, honest not-found for gone agents.
Factory watching for its first fully-fixed dispatch cycle: tombstones + provisioning + git/jq/npm
gate image + serialized gates + fail-closed regression/acceptance classifier all live.**

**Factory diagnosis update (post-#117):** tombstones HOLD (fresh ids only); provisioning WORKS
(node_modules present in fresh org worktrees); remaining killer = concurrent full-suite verify
gates flaking under host load → X5. Also: factory is burning WIP slots on X3's stray probe
tickets (OMPSQ-431/436 — goal "reply DONE and stop immediately"); user should delete them.
| X3 | design-review loop | feat/ui-design-review | sonnet | **built: draft PR #120** (597/0 +15; heading anchor on PlanAnnotationTarget; N/M gate advisory; strike/ember-insert revision diff; live-driven on real sirvir doc; NOTE: stray empty Plane tickets OMPSQ-431/436 for user to delete) — opus taste review running |

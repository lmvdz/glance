# Boundary sync — one-directional per-turn patch-apply to the real checkout

STATUS: in-review
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/boundary-sync.ts (new), src/squad-manager.ts, src/types.ts (AttentionEvent source union), src/server.ts, webapp/src/components/ui/AttentionRow.tsx, webapp/src/lib/fleetRoster.ts, tests/boundary-sync.test.ts (new)
BLOCKED_BY: 02

## Goal

A `glance here` turn's edits show up in the operator's REAL checkout — the directory `here` was launched from, not the isolated worktree the agent actually runs in (OMPSQ-40, squad-manager.ts:4656, stays untouched by this concern) — without ever racing the operator or discarding their own uncommitted work. Each finished turn applies its own patch to the real tree if and only if the real tree provably has not moved since the turn started; on any divergence, or on any failure to even establish that precondition, the daemon holds the patch and raises a visible, one-click-resolvable attention item instead. Absence of proof that the tree is safe is always treated as proof it is unsafe.

## Approach

**Turn boundary hook.** `agent_end` (squad-manager.ts:6225, the same event `voicePushArmed` and checkpoint capture already key off) is "turn finished." A new `src/boundary-sync.ts` module exposes `captureRealTreeState(realDir)` and `applyTurnPatch(...)`, called from that case for `here`-class casual agents only (a new small marker on the agent record, e.g. `rec.options.realTreePath`, set at creation time in concern 02 to the operator's cwd — plain fleet units never carry it, so this never fires for them).

**Read-only tree-state fingerprint (fail-closed by construction).** Never mutate the real tree to fingerprint it — no `git add`, no `stash`, no index writes. Reuse exactly the read-only pattern `adopt()` already uses to snapshot a live tree without touching it (squad-manager.ts:4297-4310): `git rev-parse HEAD`, `git diff --no-ext-diff --no-textconv --binary HEAD` (tracked changes), and `git ls-files -z --others --exclude-standard` (untracked paths) run against the REAL directory. Hash the concatenation of all three (sha256) into one fingerprint. Any of the three git calls failing (non-zero exit, directory gone, not a repo anymore) makes fingerprint capture itself fail — which is a FAILURE, not an empty-string fingerprint; a failed capture can never compare equal to anything, so it can never authorize an apply. This is the concern's fail-closed core: hash-capture failure ⇒ no auto-apply, hold + attention, same code path as a genuine divergence.

**Per-turn patch.** Independently of the real-tree fingerprint, capture the AGENT'S OWN worktree state at turn start (same read-only technique, run against the worktree instead of the real dir) so the turn's patch is exactly what changed in THIS turn — not the worktree's entire history since it forked from origin/main (which `worktreeDiffSinceFork`, src/explore.ts:142, computes for the intervene diff view and is the wrong scope here: replaying that every turn would re-apply already-applied hunks and manufacture conflicts). This concern's own turn-start/turn-end worktree diff is intentionally narrower and self-contained — it does not depend on Epic E's general per-turn checkpoint-ref mechanism (plans/daily-turn-substrate/, sequenced after wave 1, not shipped yet).

**Apply, gated on the precondition.** At `agent_end`: recompute the real-tree fingerprint. If it matches the turn-start fingerprint captured for the real tree, apply the turn's patch to the real tree with `git apply` (tracked hunks) plus writing any new untracked files directly (matching how `adopt()` already replays a captured patch into a fresh worktree — same tool, applied to the real tree instead of a new one). If it does NOT match, or fingerprint capture failed at either end, do not touch the real tree at all — hold the patch (small JSONL append, one line per held patch, keyed by agent id + turn) and raise a new `AttentionEvent` (src/types.ts:111; widen the `source` union from `"notify" | "tool" | "harness"` to add `"boundary-sync"`) with a summary like "sync held: your tree moved during this turn" and an explicit `detail` pointing at the held patch. This is the ONLY new attention surface this concern needs — `AttentionEvent` is non-blocking and never flips agent status (types.ts:104-109), which is correct here: a held sync is not an error, the turn itself succeeded.

**Explicit apply affordance.** A new `POST /api/agents/:id/apply-held-sync` (server.ts) re-runs the SAME precondition check (fresh fingerprint, not a stale cached one — the real tree may have moved again since the item was raised) and either applies and clears the held patch, or reports it's still divergent. Webapp surface: `AttentionRow.tsx` (already renders `AttentionEvent`s in the roster) gets a one-click "apply now" button for `source: "boundary-sync"` rows; `fleetRoster.ts` needs no ranking change (this is a normal attention item, ranked like any other).

**Degradation, never regression.** With this concern OFF, disabled, or erroring at every fingerprint check, behavior is exactly today's: the real tree is simply never touched, edits are visible only via the existing diff/promote path. There is no code path in this design where a failure mode does anything to the real tree beyond "don't touch it, tell the operator" — the only git-write call this concern ever makes against the real directory is the single, precondition-gated `git apply`.

## Cross-Repo Side Effects

none

## Verify

- Unit (`tests/boundary-sync.test.ts`): fingerprint capture is deterministic for identical tree state and changes when tracked/untracked content changes; a turn patch applies cleanly when the real tree is unchanged; an intervening real-tree edit (simulate a concurrent `echo >> file` in the real dir between turn start and turn end) produces a held patch + attention event, NOT an apply, NOT a `git apply` conflict on the real tree.
- Fail-closed acceptance test (mandatory, per 00-meta.md's "four fail-open instances" note): force fingerprint capture to fail (e.g. real dir made briefly unreadable, or a git command mocked to exit non-zero) and assert the turn holds + raises attention rather than applying — this is the literal test the meta-plan names as a spec violation if missing.
- Live: `glance here`, make an edit in the operator's real terminal (a different file) WHILE a turn is running, let the turn finish, confirm the patch is held with a visible "sync held" item and an apply button that works once re-checked; then run a turn with the real tree untouched and confirm the edit lands in the real checkout files (not just the worktree).
- Cross-lineage review (codex AND grok) is MANDATORY before this concern ships — it is a git-write path against the operator's real checkout, the exact class DESIGN.md and 00-meta.md name for dual review. Do not land on a single reviewer's approval.

## Resolution

Implemented 2026-07-16 on the A03 lane of feat/daily-driver-w1 (branch worktree-wf_55eef634-d22-1;
recovers and completes a session-limit-interrupted prior attempt — the salvaged module survived
critical review largely intact and is credited in the commits).

**What shipped.**
- `src/boundary-sync.ts` (new): `captureRealTreeState` (sha256 over HEAD + `--binary` tracked diff +
  untracked paths + untracked CONTENT hashes — path-only hashing would let a mid-turn edit to an
  untracked file be clobbered by the apply's own writes), `captureWorktreeTree` (private temp
  GIT_INDEX_FILE `read-tree → add -A → write-tree`; the worktree's real index and files are never
  touched), `computeTurnPatch` (diff-tree start→end — deliberately NOT `worktreeDiffSinceFork`, per
  the Approach), `applyPatchToRealTree` (`git apply --check` then `git apply`, the concern's single
  real-tree git-write; new files ride the patch itself since the trees include untracked content),
  `syncTurnEnd` (the one auditable decision point — every branch that is not fingerprints-match ends
  in hold/uncapturable), durable `HeldSyncStore` (append-only JSONL + sibling patch bodies in
  `<stateDir>/boundary-sync/`, torn-tail tolerant, per-agent, apply-in-order), and `applyHeldNow`
  (fresh capture gate; first conflict stops the replay with everything after it still held).
- Wiring (src/squad-manager.ts): `boundaryTurnStart` at `agent_start`/`turn_start`,
  `boundaryTurnEnd` at `agent_end` (the voicePushArmed boundary, as specified); per-agent promise
  chain serializes capture→sync→explicit-apply; ONE boundary-sync attention row per agent (freshest
  state, never a stack); `reattachHeldSyncs` at boot re-raises rows for restored sessions (holds are
  durable, attention rows are not) and warns loudly for vanished agents; `applyHeldSync` clears the
  row on full success. The `here`-marker is `options.realTreePath` (types.ts, persisted; carried
  through orphan-adopt), set server-side in POST /api/console from the canonical registered root —
  never client-supplied separately; plain fleet units never carry it. A self-alias guard skips sync
  if the target IS the agent's worktree (would re-apply onto itself → spurious holds).
- `POST /api/agents/:id/apply-held-sync` (server.ts, operator tier like /land beside it): re-runs
  the precondition with a FRESH capture; "still divergent" is a 200 + ok:false report.
- Webapp: `AttentionEvent.source` widened with "boundary-sync" (dto.ts mirroring types.ts);
  insights.ts maps those rows to a one-click `Apply` action (`apply-sync`) using the event's own
  copy as the title; WorkspaceCockpit's onRowAction posts the apply and toasts applied/still-held
  distinctly. Renders through the existing RosterAgentRow/RowActionChip path (AttentionRow.tsx is
  generic over `item.action` and needed no change — TOUCHES anticipated the wrong render site).

**Fail-closed acceptance (mandatory per 00-meta.md) — tests, all against REAL git repos, no mocks:**
tests/boundary-sync.test.ts (27) + tests/boundary-sync-wiring.test.ts (6). Capture failure at turn
START and at turn END each ⇒ hold + attention, real tree byte-identical (asserted via full file
snapshot, not just fingerprint); non-repo/vanished/newline-path targets fail capture rather than
producing an empty fingerprint; a mid-turn operator edit to a DIFFERENT file (patch would apply
cleanly!) holds on the fingerprint; a held backlog blocks the next turn's auto-apply; explicit
apply with an unfingerprint-able target applies nothing; conflicting first patch stops the ordered
replay with later patches still held. Found-and-fixed during testing: `Bun.spawn` THROWS on a
vanished cwd (ENOENT) instead of returning non-zero — a local spawn-safe wrapper folds that into
the fail-closed result plumbing; without it the capture would have bypassed the hold path entirely.

**Still owed before this ships (gate work, not implementer work):**
- Live verify per ## Verify (scratch daemon + real `glance here` turn + concurrent real-tree edit +
  webapp Apply click) — Standing requirement #1.
- Cross-lineage review (codex AND grok) — mandatory for this git-write path; do not land on a
  single reviewer's approval.

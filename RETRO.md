# RETRO — landing-rail campaign (standing, not terminal)

Three standing rules (campaign doctrine):

1. **Every closed build ticket appends an entry here** — rounds taken, what each gauntlet
   round caught, findings refuted with evidence, one process lesson. No entry, no close.
2. **Everything expirable names its expiry condition.** Fog entries state what they hang on
   (graduation is mandatory when it clears); decisions carry "reopen if wrong"; briefs carry
   provenance headers. Staleness sweep: run at the START of every DRIVE session (idle
   tickets, unmerged branches, fog-with-cleared-blockers, missing retro entries, drifted
   metrics) — findings comment on the map. No OS cron is armed for this on purpose: a
   session-scoped cron that dies silently is the exact fake-a-routine failure the
   dogfood-drain post-mortem documented; the sweep rides the sessions that actually run.
3. **Stay youthful.** Phase-boundary retros prune at least one process rule (kill it or
   re-justify in writing), fund one cheap divergent pass at something that already "works",
   track reopens as a vitality metric, rotate one critic lens per phase.

## Entries

### 2026-08-04 — T1 #329 (LAND_CONFIRM truth) — closed after 1 gauntlet round
- Rounds: build + 1 fix round. Gauntlet round 1 (blind codex): caught the construction-cache vs
  per-request-read lifetime divergence the builder's own pin test structurally couldn't see (it
  set env before construction). Refuted 3 suspicions with per-input evidence — refutations are
  receipts too.
- Fix was categorical, not a patch: report the acting component's own value; never re-derive.
- Process lesson (cost 3 lane-stalls across the round): builders background the full suite to
  dodge the Bash tool's 2-minute default timeout, then stop and wait for a notification that
  never comes. Fix baked into the dispatch template: run suites FOREGROUND with the Bash call's
  own `timeout: 600000`, plus the "you will be resumed with no memory of waiting" phrasing.

### 2026-08-04 — T7-S1 #335 (rail extraction slice 1) — closed after 1 dual-lineage round
- Rounds: build + 1 fix round. Both foreign lineages independently CERTIFIED the pure move
  (grok: SHA-256 byte-identity after import-prefix reversal — adopt that as the standard
  pure-move proof) and independently found the same defect: the new boundary scanner was
  fail-open on import forms its regex didn't anticipate. The guard guarding the seam was the
  only defective thing in the slice — absence-as-evidence, again.
- Fix pattern worth keeping: a scanner is only trustworthy with flip-the-input fixtures — one
  fixture per bypass form asserting detection FIRES, plus a negative fixture. Ported as
  standing doctrine: any future allowlist/ratchet test ships with per-form fixtures.
- Builder caught a design estimate wrong (8 test files vs ~4) by grepping with .ts extensions
  — the verify-claims-against-the-tree dispatch line keeps earning its place.

### 2026-08-04 — T8 #336 (codex harness verify) — closed after 1 grok round + delta-verify
- Rounds: build (builder self-caught the ignored --model argv, added applyModelPin) + 1 grok fix
  round + 1 grok delta-verify. Single-lineage grok, deliberately: the builder is Claude/OpenAI-
  adjacent enabling an OpenAI harness — the xAI lineage is the only non-correlated reviewer for
  "does enabling codex lie about codex."
- Both HIGH findings were the SAME failure shape as T3/T4: absence rendered as a confident value
  (pin-fail → requested model recorded as if run; unverified usage → $0 as if free). That's now
  three independent tickets where "absence must read as unknown, never a fabricated zero/value"
  was the load-bearing catch. Promote to a standing critic-prompt line for every attribution/
  receipt diff: "find every place a missing measurement is coerced to a number."
- Delta-verify earned its keep: found the fix was scope-correct but the bug CLASS lived at four
  more sites (#348) — closing on "the findings are fixed" without it would have left codex
  looking free in half the surfaces.

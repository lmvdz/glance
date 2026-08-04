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

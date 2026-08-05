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

### 2026-08-05 — T6 #334 (the receipt surface) — CLOSED, the product face — dual-lineage gauntlet + 3 delta-verify rounds
- The deliverable the whole thesis rests on: a human approves a RECEIPT, not a diff. Live-verified
  it works (a real land → a human answers what/proved/reviewed/rollback/cost cold).
- **The T2 lesson recurred and cost a full round: agent-authored content must be escaped at EVERY
  output boundary.** The builder hardened the HTML boundary (esc) but not the markdown boundary —
  so the PR comment had a CRITICAL injection where an agent's test-title/branch forged a "✅ Landed"
  verdict + phishing link. Standing rule: for any surface rendering agent content, enumerate ALL
  output boundaries (HTML, markdown, the terminal, a log, a JSON field) and escape each; hardening
  one is not hardening the surface.
- **A receipt must attribute the RIGHT land — and "right" is subtle.** Three narrowing rounds:
  wrong-commit (local HEAD in PR mode) → branch-tip-not-merge-commit → branch-latest-tip-under-
  concurrency. The robust end state: bind to THIS PR's own mergeCommit.oid (gh pr view), never a
  proxy like "whatever's latest on the branch," and render "commit unavailable" before ever showing
  a wrong SHA. A product that says "trust the receipt" cannot show a commit a human can't find on main.
- Cross-lineage severity adjudication mattered: on the bare-URL autolink and the merge-commit-OID,
  grok under-rated (LOW / "nuance") what codex correctly called HIGH. Run both, then adjudicate
  against the code and the PRODUCT's purpose — a finding's severity depends on what the artifact is FOR.
- Operational: the original T6 builder's transcript was GC'd mid-campaign; a fresh opus agent picked
  up the branch via git fetch+checkout and finished cleanly. Long-running builds must be resumable
  from the BRANCH, not the agent — never leave state only in an agent's memory.

### 2026-08-05 — T5 #333 (in-code gauntlet) — PARKED after 2 gauntlet + 3 delta-verify rounds (tripwire fired)
- The daemon-spawns-its-own-blind-panel feature is sound in every part (spawn, blindness, group-kill,
  3-state verify, receipt field) EXCEPT its ledger projection lane, which reintroduced the same
  dirty-main self-land CRITICAL THREE times — each a narrower crash-window variant. Root cause both
  lineages converged on: it treats a working-tree write as durable when only a git COMMIT is.
- **The tripwire worked as designed.** I pre-committed: "if the projection sprouts a defect a 3rd
  time, STOP and escalate keep-vs-park to Lars, don't autonomously route round 4." It did; I did.
  Lars chose park. Lesson: for a build that reintroduces its own bug class, set the escalation
  tripwire BEFORE round N, not after — and honor it. Grinding a tier-2 automation while the
  destination waits is the drift the destination-gate exists to catch.
- **Park ≠ abandon.** #333 stays open-but-parked; both lineages' precise fix (HEAD-based durability,
  not WT-presence) is captured verbatim in #356; T6 rebased off T4 (not T5) so the product path
  proceeds and the panel field slots in when #356 lands. The manual cross-lineage gauntlet — which
  this whole campaign has run successfully by hand — remains the working substitute.
- Transactional-git-as-durability is genuinely subtle: 3 competent fix rounds, each closing the
  prior window and opening a narrower one. When a lane fools single passes repeatedly, that IS the
  signal it needs a different level of attention (a design rethink or a human call), not another patch.
- Process nit for the RETRO: a relay agent returned a meta-summary ("relayed verbatim above")
  instead of the verdict — but only an agent's FINAL message reaches the orchestrator, so the
  verdict was invisible until I re-asked. Relay dispatches must say "the verbatim output IS your
  final message; a summary loses it."

### 2026-08-04 — T2 #330 (conflict-marker gate) — closed after 2 CRITICALs, 2 gauntlet + 2 delta-verify rounds
- **The headline lesson of the whole campaign, stated sharpest here: a gate whose adversary is
  the agent cannot accept ANY agent-controllable exemption.** The false-positive fix (a path/token
  allowlist so legit fixture content wouldn't be blocked) opened a false-NEGATIVE against the exact
  adversary the gate exists to catch — the token literal even self-exempted the gate's own source
  file. Both foreign lineages found it independently. Resolution: no agent-settable exemption at
  all; the human force-land (already the stale-gate/land-risk authority) is the sole per-land
  exemption. Design any autonomous-agent gate this way from the start.
- Also a first-principles reminder: the FIRST gauntlet found the gate had a total PR-mode bypass
  (a whole production land path it never ran on). A merge-safety gate with an unguarded path is
  worse than no gate — it reads as protection that isn't there. Enumerate every land path before
  claiming a gate covers "the land."
- Close-by-severity again: CRITICAL bypasses fixed + proven; a delete-resolution false-positive
  (fails safe, force-land workaround) + an operator-env doc → follow-up #355. The env disable is
  operator-plane (not agent-reachable — spawn-env scrubs OMP_SQUAD_* from children), so it's not
  the bypass class; the overstated "sole human authority" claim narrowed to "sole per-land
  diff-influenceable exemption."

### 2026-08-04 — T12 #345 (state-lock double-owner) — closed after redesign + 3 gauntlet rounds
- The builder made a sound AUTONOMOUS design override: handed my adjudicated atomic-rename
  suggestion, it found atomic-rename had a residual 3-process gap and chose kernel flock instead
  — the better call, made with reasoning, not deference. Trust a builder's mechanism override
  when it comes with a constructed counterexample.
- The fix reintroduced its own bug class TWICE (a fence-able-but-hangable lock; then a
  timeout-steal that re-minted double-owners) — each caught by the next gauntlet/delta-verify.
  A concurrency fix must be re-verified as adversarially as the original; the "fix" is where the
  next bug hides.
- **Loop-stop discipline, applied by severity not by round count**: closed on the PROVEN core
  invariant (2-owners→1, bounded boot, refuted deadlock) with four NON-two-owner residuals
  (6ms soft-deadline overshoot, EINTR spin, libc-absent rm-advice, remount cache) split to a
  hygiene ticket (#354). The test: does the residual violate the ticket's actual invariant?
  If not, it's a follow-up, not a blocker. Don't spend a 4th round on microsecond timing edges.
- Documented the cross-host NFS limit as unsupportable-by-advisory-locks rather than chase an
  impossible in-process detection — an honest "won't fix, here's why + the operator contract"
  is a valid gauntlet outcome.

### 2026-08-04 — T4 #332 (measured reviewer precision) — MOAT LOOP CLOSED — 3 rounds + 3 delta-verifies
- The campaign's centerpiece: land verdicts now cite each lineage's MEASURED precision. Took the
  most review of any lane and earned it (live land path, the thesis rests on it).
- **Both foreign lineages independently found the round-1 ship-blocker** (cache froze the precision
  stamp → re-lands showed stale numbers) — the strongest confidence signal a finding can carry.
  Doctrine: when codex AND grok converge on the same defect with disjoint reasoning, treat it as
  confirmed and fix the APPROACH, not the line.
- **The delta-verify caught the fix round's OWN regression**: the fix for grok's near-dup finding
  over-collapsed the dedup key and silently dropped 7 real ledger rows (codex n 52→45). This is
  the single most important process lesson of the campaign: a fix round is a change like any
  other and must be verified against the SAME adversarial bar as the original — the verify pass,
  not the fix, is what kept a data-loss bug out of the moat. Never close on "the findings are
  fixed"; close on "the fixes were re-verified."
- **Absence-as-value, 4th instance** (after T3 $0-cost, T8 wrong-model, T8 free-usage): an absent
  reviewer lineage was silently bucketed as "native." This pattern is now the campaign's
  signature and a standing critic-prompt line: "find every place a missing measurement becomes a
  confident value." Four independent tickets, same root — that is a HARNESS-level lesson, not a
  per-ticket one.
- Deliberate loop-stop after round 3 (findings shrank each round to edge-config/theoretical
  input); budget redirected to T12, the other live path. State when you stop and why.

### 2026-08-04 — T3 #331 (receipt backfill) — closed after 3 rounds + delta-verify + round-4
- Rounds: 3 blind codex + a scoped delta-verify (5/7) + a 2-item round-4. The premise inverted
  under review: "stamp 430 rows" became "stamp 0, annotate reasons" once round 2 proved roster
  evidence is epoch-unsafe. The gauntlet didn't just harden the code — it corrected what the
  ticket was FOR. That only happened because critics got the invariant ("never fabricate
  attribution"), not the builder's goal ("attribute the rows").
- **Deliberate loop-stop, recorded as doctrine**: I stopped the gauntlet at round-4 rather than
  running a 5th pass, on judgment: blast radius (a dry-run-default script that refuses on a live
  daemon) × diminishing returns × a live-critical lane (T4) competing for the same verification
  budget. The gauntlet is a quality mechanism, not a scheduler; spend its passes where the risk
  is, and SAY when you stopped and why. A campaign that can't stop verifying a script can't
  afford to verify the merge path.
- Cost signal: T3 consumed the most subagent tokens of any lane (three 400k–600k fix rounds).
  A script that dry-runs is not worth more verification budget than the code that merges to main.

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

# Reality audit — plans/ STATUS × Plane × origin/main (2026-07-21)

Ground truth: `origin/main` @ `4f4ae9a`. Method: `.claude/skills/reality-audit` — inventory of 68
plan dirs / 336 concern files, six parallel per-plan code auditors, adversarial re-verification of
every loud flag, plus a PR-merge/orphan sweep (`git log --grep`, `git cherry`). Plane leg
effectively vacuous: only 16/336 concerns carry a `PLANE:` pointer; the one sampled ticket
(OMPSQ-348) sat in Backlog untouched since 2026-06-29 while its plan claimed 9/10 done. Plane is
not a live truth store for this repo.

## Headline

Done-claims are ~98% real: across ~35 audited plans and ~200 done/closed concerns, nearly every
"done" traced to real code on main. The dominant status lie is the OPPOSITE of over-claiming:
~30 concerns across 7 plans were fully shipped and merged but still marked open/in-review/blocked
(fixed by the chore/status-write-back PR that carries this file). Systemic cause: the pipeline
lands code without a closing write-back to STATUS lines.

## Proven-done (claimed done, code verified on main)

adw-factory-borrows 9/9 (PR #183, 3d7103b) · meta-autonomous-fleet 8/8 (PRs #64/65/66) ·
wave1-trust 8/8 (PR #29, 85c88d2) · agentic-learning-loop 5/5 · harness-agnostic-drivers 8+1 ·
agent-profiles 2/2 (PR #92) · daily-onramp 8/8 · daily-attention-w0 2/2 · daily-composer 2+2 ·
change-driven-loops 9+1 · voice-db-mode 8/8 (PR #172 DID merge, 64dc7a8 — the "stuck draft"
memory was stale) · voice-loop 5/5 (PRs #186/#188/#191) · webapp-voice-lane 8+1 (PR #163) ·
webapp-chat-astryx 12/12 (execution landed via PR #37, not #26) · comprehension 11/11 (PR #192) ·
skills-hardening 5/5 (PR #190) · noisegate-compaction 6+1 (PR #185) · eap-borrows 7+1 (PR #158;
05's "done" rests on a FakeDriver mock) · never-lose-work 5/5 · policy-and-cost-gates 4/4 ·
cross-lineage-review 4+1 (05 honestly blocked) · sentinel-drift-probe 2/2 ·
research-{learn-harness, mastra, tencentdb, cmux} closures real (cmux/02 exception below) ·
storage-provider-seam re-landed via PR #104 (97e6270) — the "ORPHANED" memory was stale.

## Stale-open (shipped but still marked open/in-review/blocked — flipped by this PR)

- daily-driver-w15: all 4 concerns merged via PR #198 (5803a1a)
- land-assessment: 10 of 11 merged via PRs #201 + #212 (even 08: src/land-assessment/hook.ts,
  0bf3389); only 09 (hitl) genuinely open
- fleet-first-ide: all 5 epics merged (bridge + glance-desktop #9–#26); meta-doc frozen at
  2026-07-14 iteration 4
- fleet-ide-bridge: #177 (f825a3f) / #178 / #179 all merged, branches patch-equivalent to main
- fleet-ide-cockpit: all 8 merged in glance-desktop (99c6eb7…e2918ca)
- perspective-diversified-review: all 6 re-landed via PR #110 (c112a4f)
- research-sirvir: 01/02/03/04/06 merged (PRs #105/#108/#111/#114); 05 fleet-routing genuinely
  unbuilt
- research-learn-harness-engineering/03: PR #115 merged (b395b89)

## Worst discrepancies (claimed done, evidence missing or unearned)

1. model-routing-control-loop/05 — TaskClassMatrixPanel.tsx did not exist anywhere on main: the
   reland of orphan-merged PR #71 (85aa218) silently dropped it; backend + /api/graph/task-class
   live with zero renderers. RESTORED by the surface-invisible-observability PR (#219).
2. daily-dogfood-engine/03 — frontmatter said done while its own Resolution requires Lars's first
   gate sign-off, which no ledger records. Flipped back to in-review by this PR.
3. research-cmux/02 — blocked-longest sort library real + tested, but every render site hardcoded
   severity; the operator toggle was unreachable. DELIVERED by PR #219.
4. eap-borrows/05 — "done" verified only against a FakeDriver mock; live scratch-daemon check
   never ran (its own text admits this). Left as-is; noted here.
5. comprehension 08/10 — done with no Resolution sections; code verified real.

## Unlanded work discovered en route

- PR #217 (fix/root-factory-host-reap) — the registry friendly-fire 143 fix, not on main.
- PR #215 (t3code R3 brief) — exists only on origin/worktree-research-t3code-chat.
- Memory-hygiene: "storage-provider-seam orphaned" and "land-assessment 08 deferred" notes were
  both stale — both re-landed.

## Systemic fix direction

The pipeline needs a post-merge STATUS write-back step (land → flip the concern's STATUS with the
PR evidence), not more auditing. /sync-plans covers Plane→STATUS but Plane itself is disconnected
(16/336 linkage).

# GOAL — the landing rail ("merge receipts, not code review")

You are executing glance's ratified one-thing: the neutral landing rail for agent-written
code. Every unit of work serves one sentence: **a human approves an evidence bundle — gates
green, cross-lineage reviewers with measured precision, rollback armed — instead of reading
the diff.** Full brief: plans/landing-rail/BRIEF.md; ground truth: main@350f367f audit.
DIRECTION.md wins over anything here.

## Standing constraints (every iteration)
- ONE landable unit per iteration. Worktree-isolated. Gates at baseline (diff failure sets
  against the known pre-existing set; a green targeted run proves nothing). Draft PR; Lars merges.
- **Dogfood-by-construction: land your own PR through the rail.** Every PR this loop produces
  goes through glance's landing pipeline with LAND_CONFIRM staging and produces a receipt.
  If the rail can't land its own change, that failure IS the next iteration's unit.
- Blind cross-lineage review (grok AND codex, zero framing) on anything touching land, merge,
  verify, git-write, or trust paths. Adjudicate against code; record every finding in the
  reviewer ledger — those rows are the product's moat, not ceremony.
- NO new room/webapp product work. Voice, feedback/payments, plan-votes: frozen (park, don't
  delete). presence/leases, attention ladder, plane loop, cost attribution: serve the rail, keep.
- Never write the adoption/pivot verdict anywhere durable — recommend in conversation only.

## Priority ladder (verify a tier is still open against the repo before selecting from it)
0. **Ratification gate (once):** draft PR amending DIRECTION.md to the landing-rail thesis
   (positioning line, park-list, falsifiers). Lars's merge = ratification. Do not block on it —
   tiers 1–2 are correct under any framing.
1. **Honesty debts (small, do first):** LAND_CONFIRM — manager defaults ON
   (squad-manager.ts:1152) while doctor/observability reports OFF (server.ts:1050); make the
   doctor tell the truth. Squad skill claims a conflict-marker grep the verify path lacks —
   implement the check in verify or correct the claim. Stamp the ~430 receipt rows missing
   harness/model (the omp receipt writer never set them).
2. **Close the moat loops:** wire reviewerPrecision() into the land path — every land receipt
   cites each reviewer's measured precision (86 ledger rows exist; zero consumers today).
   Then: in-code gauntlet — the multi-reviewer panel (cross-lineage, blind, receipts) moves
   from skills into src/, spawned by landBranch for risk-tiered diffs.
3. **The receipt is the product surface:** a self-contained HTML receipt per land (gates,
   reviewer verdicts + precision, failure-set diff, rollback point, cost line) written beside
   the land ledger + posted as a PR comment. No webapp. distill-quality, CSP-safe.
4. **Extraction:** pull the rail out of squad-manager.ts (13.4k LOC; 633 land lines) behind a
   small interface — one deepen-style slice per iteration, pure moves separated from behavior
   changes, boundary allowlist test, gates at baseline.
5. **Mixed-fleet completeness:** live-verify the codex harness (registry policy: live smoke
   only, reproduce-and-pin any failure). Then the GitHub App wedge spike: gate one external
   repo's agent PRs with a receipt comment, zero daemon adoption required.

## Each iteration
ORIENT (read plans/landing-rail/00-meta.md ledger + this ladder; verify tier still open) →
SELECT one unit → IMPLEMENT in a worktree → PROVE live (drive the real daemon/rail, not just
tests; a fix is done when the receipt shows it) → BLIND REVIEW per rule above → SHIP draft PR
**through the rail** → CLOSE (ledger row: unit, receipt link, reviewer-ledger rows added,
what was deliberately left) → pace the next wakeup.

## Stop conditions
- A falsifier fires (Copilot review becomes a *required* reviewer + GitHub ships native gated
  auto-land; Aviator ships agent-native autonomy; Cursor re-aims Graphite cross-harness):
  STOP, report, recommend — the pivot call is Lars's.
- Tier 5 is done and receipts have been generated for 2 weeks: STOP and request the gate
  review — with the receipts as the evidence. Never invent busywork to keep the loop alive.

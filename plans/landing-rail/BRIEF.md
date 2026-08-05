# BRIEF — merge receipts, not code review

Provenance: 2026-08-04, synthesized from (a) an Aug-2026 market scan (evidence-of-payment
weighted, 30+ sources) and (b) a ground-truth capability audit of main@350f367f (full suite:
4,958 pass; land core 88/88). Full visual brief: the 🧾 artifact
(claude.ai/code/artifact/0fa096ae-6c29-49fa-8419-b53538903366). Expiry: re-check falsifiers
before each phase-boundary retro.

## Thesis

glance's one thing is the **neutral landing rail for agent-written code**. Any agent, any
harness, writes in an isolated worktree; glance is the only path to main; a land is an
evidence bundle — verify gates green with unproven-green rejection, cross-lineage reviewers
with *measured* precision, failure-set-diff vs baseline, rollback armed. The human approves a
receipt, not a 400-line diff.

Positioning line: *"Your agents write the code. glance decides what's safe to land — and
shows its receipts."*

## Market (settled input — do not re-litigate; re-check falsifiers only)

- **Lane A (landing rail): EMPTY + PAID.** Every commercial agent product stops at
  human-approves-the-diff (Augment Jul-2026: "the boundary is merge"). Aviator ($12–20/seat,
  Meta/Notion/Figma logos) is human-in-loop, not fleet-native. Graphite sold to Cursor —
  neutrality gone. Only autonomous implementations are uncommercial OSS (Gas Town Refinery;
  its HN traction proves the persona). Pain measured: review time +91%, AI PRs wait 4.6×,
  broken-main scales ~16× with contributor count — a 3-person team running 30 agents has
  40-contributor merge dynamics with 3-person review capacity.
- **Lane B (fleet supervisor): GRAVEYARD.** GitHub Agent HQ is the free first-party neutral
  mission control; Terragon dead, Bloop dead, Conductor free with unshipped paid plans. Our
  own adoption counters agree (14 days of zero use; room interactions: zero, ever).
- **Lane C (standalone review): KNIFE FIGHT.** CodeRabbit $60M raise, bundled-free
  first-party review, cross-lineage adversarial review commoditizing as OSS + a public
  benchmark. The precision ledger is a feature inside the rail, not a standalone company.

## Ground truth (settled input)

REAL: land pipeline (deepest subsystem in the repo — commit-pinned incident replay manifest,
three refusal classes fired live, unproven-green rejection, failure-set-diff gate); harness
seam verified ×5 (live-smoke-only policy); cross-lineage validator wired into landBranch;
universal cost ingester (2.35× over-billing scar caught live).

OPEN LOOPS (the campaign's work): reviewerPrecision() has zero consumers (86 adjudicated
rows); the multi-reviewer gauntlet is skill-only; LAND_CONFIRM manager-default ON but doctor
reports OFF; squad skill claims a conflict-marker grep the verify path lacks; 430/734 cost
rows unstamped; the rail is ~15% of src/ partly tangled inside squad-manager.ts (13.4k LOC).

## Park / keep

PARK (frozen, not deleted): voice (+BYO-key surface), feedback+payments, room chat plumbing,
here.ts, plan-votes/vision, webapp-as-product. KEEP (they serve the rail): presence/leases,
attention ladder, plane loop, memory lane/DecisionLedger, cost attribution.

## Falsifiers (check at every phase-boundary retro)

1. Copilot review becomes a *required* reviewer + GitHub wires Agent HQ → merge queue into
   native gated auto-land with rollback.
2. Aviator ships an agent-fleet-native autonomous mode with harness integrations.
3. Cursor re-aims Graphite's queue at cross-harness agent diffs.
4. Gas City commercializes the Refinery first — or proves the segment won't pay.

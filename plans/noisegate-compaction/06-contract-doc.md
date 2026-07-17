# Output-compaction product contract
STATUS: done
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: docs/output-compaction-contract.md (new)
BLOCKED_BY: 01, 02, 03, 04, 05

## Goal
A checklist-shaped boundary doc (noisegate's product-contract pattern) that future changes must satisfy.

## Approach
Short checklist: (1) exactly four classes — adding one requires updating this doc first; (2) output ≤ budget always; fail-open lands on bounded headTail, never unbounded; (3) protected surfaces the reducer must NEVER be wired into: budgetedExcerpt judge-prompt call sites, diffs (kind:"diff" owns them), fenceUntrusted/KB/digest content, transcript tool payloads, voice truncateForVoice, answers.ts bodies, reflection.ts's own slice; (4) markers are forgeable by unit output — input marker lines are neutralized, pointer-following tools must validate paths under gateLogRoot; (5) redaction at persistence boundaries only (writeGateLog, checkpoint fields) — excerpt-side redaction requires its own reviewed change; (6) every non-fit decision logged to compaction.jsonl (bounded recent-history diagnostics, not an archive); (7) no LLM summarization, ever.

## Cross-Repo Side Effects
None.

## Verify
Doc exists, states each boundary above, references DESIGN.md and the BRIEF.

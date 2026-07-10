# Harness honesty tiers — additive matrix, gates untouched
STATUS: done
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/harness-registry.ts, src/server.ts, src/index.ts, tests/

## Goal
One authoritative, honest harness capability matrix: end-to-end verified / registered-unverified /
detected-unverified, plus a verified-binary-missing alert and a per-harness usage-verified bit —
without changing a byte of the four `verified` gate sites.

## Approach
- Pure `harnessTierInfo(d)` combining static `verified` with binary detection. Detection resolves
  the bin the way SPAWN resolves it (not bare Bun.which on the daemon PATH); when not resolvable,
  the alert reads "not found on daemon PATH" (omp lives in node_modules/.bin — daemon PATH lies).
  npx-shelled bins documented as a weak signal in the descriptor note.
- Computed at list-build time with a short cache (no per-render which(); no UI flap).
- `usageVerified?: boolean` on the descriptor: token/usage mapping live-verified for this harness
  (ACP parseUsage is unconfirmed — acp-agent-driver.ts:118). Concern 01's coverage gate is the
  enforcement; this bit is the honest label.
- Surface: harness-list API response field + a TUI/CLI listing column. Webapp picker column only
  if the picker already renders harness rows — do not build a new page for this.
- `verified: boolean` and all four consumer sites (harness-registry.ts:96,:115,
  squad-manager.ts:3812, agent-profiles.ts:115) byte-identical. Promotion stays manual per
  concern-08 policy.
- COORDINATION: grok/xai registration lives on feat/grok-harness — build on whichever merges
  first; a rebase must keep grok's row intact.

## Cross-Repo Side Effects
None.

## Verify
Tests: tier truth table (verified×detected 2×2 incl. the alert cell); cache staleness; gates
byte-identical (snapshot test on listHarnesses/create-gate behavior). CLI listing shows all
registered harnesses with tiers.

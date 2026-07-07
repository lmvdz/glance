# Cross-lineage adversarial review

## Outcome

The land gate stops being self-lineage-blind. Every validation record says which vendor lineage authored vs judged the change; a same-lineage (self-graded) review renders as a **weaker** trust signal in confidence and the UI. Separately, an opt-in `codex` judge gives the flagship lane a genuinely different-vendor reviewer. Raises how much can land hands-off without a human re-checking a self-graded merge.

## Work

| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 lineage normalizer | Turn a model string (prefixed / bare / missing) into a vendor lineage, reusing `modelFamily()` so the two never drift | mechanical | `src/model-lineage.ts` (new), `src/omp-graph/attribution.ts`, `src/model-lineage.test.ts` (new) |
| 02 record fields + scorer | Add `authorLineage`/`reviewerLineage`/`sameLineage` to `ValidationRecord`; compute them in the scorer | architectural | `src/types.ts`, `src/validator.ts` |
| 03 thread author lineage | Pass the author's model/harness from the land + convergence sites into the validator | architectural | `src/squad-manager.ts`, `src/convergence-run.ts` |
| 04 surface weaker trust | Same-lineage pass earns a smaller confidence bonus; UI tooltip shows the lineage pair | mechanical | `src/confidence.ts`, `webapp/src/lib/agent-badges.ts` |
| 05 opt-in disjoint judge | A real cross-vendor (codex/OpenAI) judge, off by default, gated on a live-verify test | research | `src/validator.ts`, `src/config.ts` (env), `src/validator.codex.test.ts` (new) |

## Order

| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01 | Standalone new module; everything else imports it. |
| 2 | 02 | Adds the fields + scorer logic; needs 01's `modelLineage()`. |
| 3 | 03, 04 | Consume the fields 02 added. Sequential on `src/squad-manager.ts` (both touch it) — 03 then 04, same worktree. |
| 4 | 05 | Disjoint judge; needs 01 (lineage) + 02 (fields). Touches `src/validator.ts` after 02's edits. |

## Dependency graph

| Concern | Blocked by | 30s check |
|---|---|---|
| 01 | — | — |
| 02 | 01 | `grep -q "export function modelLineage" src/model-lineage.ts` |
| 03 | 02 | `grep -q "authorLineage" src/validator.ts` (ValidatorGateOpts accepts it) |
| 04 | 02 | `grep -q "sameLineage" src/types.ts` |
| 05 | 01, 02 | both checks above pass |

## Notes

- **WIP snapshot at plan time:** proceeded over 85 plans-with-open-concerns (mostly `console-agent-tooling` scanner phantoms, incl. this dir before concerns existed); genuine backlog is `meta-plan-autonomous-fleet` (37 open). Proceeded per the research→plan pipeline greenlight ("#1 then #2+#3").
- **The real finding worth surfacing:** today's modal land is `sameLineage: true` (sonnet author, opus reviewer) and *readable* on the omp/pi path — the floor is not invisible.
- **05 is the risky half.** It stays OFF (`OMP_SQUAD_VALIDATOR_HARNESS` unset) until its live-verify test proves codex emits parseable, non-abstain verdicts on real diffs. If this env can't run codex, 05 ships off with the test documented as the enable-gate.
- Second plan (concepts #2 + #3: policy-as-data engine + pre-exec cost/risk gates) follows this one.

## Resolution (2026-07-07)

Shipped 01–04 (the always-on label-floor) + 05 built-but-off. Full backend suite **1689 pass / 0 fail**; backend + webapp `tsc` clean. Live-drive confirmed: the modal land (sonnet author, opus reviewer) now stamps `sameLineage: true`; codex-configured-but-absent honestly degrades to the omp reviewer (`reviewerLineage: anthropic`, no fake cross-vendor); a gpt-5 author reads `sameLineage: false`.

| Concern | Status | Note |
|---|---|---|
| 01 lineage normalizer | closed | `src/model-lineage.ts` + drift-guard test (6 pass) |
| 02 record fields + scorer | closed | 3 optional `ValidationRecord` fields; scorer stamps them |
| 03 thread author lineage | closed | `runValidatorGate` reads `rec.dto.model`/`.harness`; convergence path left honest-unknown (no edit needed) |
| 04 surface weaker trust | closed | same-lineage pass +0.05 (vs +0.1); badge tooltip |
| 05 opt-in disjoint judge | **blocked** | codex judge + stream parser built & unit-tested (6 pass), OFF by default. **Live-verify gate not run — codex not installed in this env.** Enable only after ≥5 real diffs yield parseable non-abstain verdicts. |

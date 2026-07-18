# Replay CLI, store reader, and report
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 03, 04, 05
TOUCHES: src/land-assessment/replay/run.ts, src/land-assessment/replay/report.ts, src/land-assessment/store-reader.ts, src/land-assessment/cli.ts, src/index.ts, src/land-assessment/replay/run.test.ts

## Goal
`glance land-assessment replay` — the offline driver that runs the analyzers over the corpus, scores against the manifest, and emits the honest JSON + Markdown report that decides the wedge's go/no-go.

## Approach
- `store-reader.ts`: strict-with-accounting reads (also used by Phase-2+ consumers): files iterated in LEXICAL filename order, lines by index; per-line CRC checked; malformed/torn lines skipped AND counted with file:line diagnostics. Any malformed count > 0 ⇒ the run is marked INCOMPLETE and the CLI exits non-zero (no flag to silence in v0). Attempt reconstruction per SCHEMA-V0's identity model: `LandAttemptEvent`s folded by `(attemptId, seq)` with `assessmentKey`/`previousAssessmentKey` links resolving snapshots; total order = (filename, line-index) — `createdAt` is never an ordering key. Terminal-less attempts classify as `incomplete` and are excluded from metric denominators.
- `run.ts`: for each corpus triple, run the registered analyzers directly (NOT through the Phase-2 hook), score findings against the manifest's expectedOutcome per taxonomy class, honoring `claimedBy` — an incident of an unclaimed class never counts against any analyzer.
- `report.ts`: JSON metrics + Markdown rendering. The report carries the observations, not just findings/risk conclusions (BRIEF §11.5 danger-sign #1): per-incident rows link both the derived finding AND its underlying `StructuralObservation`s, and the summary includes observation counts by predicate plus coverage broken out per dimension (syntax/resolution/type — never one scalar). Metrics per BRIEF §10.4 with the arbitrated honesty rules: every recall figure carries its per-class *n*; precision@budget uses the manifest-pinned K and reports the reviewed-negative sample size; synthetic-only recall is labeled `synthetic (circular-generation caveat)`; runtime p50/p95 per analyzer; extraction coverage; % findings with inspectable evidence — every per-incident row links the raw JSONL event(s) backing it.
- `cli.ts` + `src/index.ts`: one `case "land-assessment":` delegating to `cli.ts` (subcommands `replay`, `inspect <assessmentId|attemptId>`), mirroring how `doctor` is wired at src/index.ts:1300 (`case "doctor":` — anchor re-verified 2026-07-17).

## Cross-Repo Side Effects
None — CLI wiring only; zero land-path integration.

## Verify
`bun test .../run.test.ts` on fixtures (a manifest + scripted corpus where expected detections are known): metrics compute correctly, unclaimed-class incidents don't penalize, malformed store lines produce INCOMPLETE + non-zero exit. Manual live run: `bun src/index.ts land-assessment replay --from <date>` over the real repo completes and emits both report formats; verify one known incident row end-to-end.

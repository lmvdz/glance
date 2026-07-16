# TypeScript structural-delta analyzer (syntactic)
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 01
TOUCHES: src/land-assessment/analyzers/typescript-structural-delta.ts, src/land-assessment/analyzers/typescript-structural-delta.test.ts

## Goal
The first structural analysis module: per-file syntactic AST deltas for B→M and B→C, overlap/adjacency joins between the two sides — with honest claims (structural concurrency and contract risk, per BRIEF §10.1's claim list) and honest non-claims.

## Approach
Syntactic only — the arbitrated decision (see DESIGN.md decision 1; in-repo precedent `scripts/dead-exports.ts`):
- File content via `git show <commit>:<path>` (no checkouts, no node_modules, no tsconfig); parse with `ts.createSourceFile`. Changed-file list from `git diff --name-status -M <A> <B>` (the `-M` output IS the rename evidence; ambiguous/split renames → add+remove + a "possible rename, unresolved" evidence pointer, never a guess).
- Per-file extraction: exported symbols (name, kind, dotted export path), declared signatures (normalized text → `signatureHash`, plus `signatureKind: type-changed|arity-changed|optionality-changed|generic-changed|unresolvable`), import/export specifiers, extends/implements clauses.
- `moduleDependencyGraphDelta`: relative specifiers resolved by pure path arithmetic (case-normalized, extension-probed against the commit's tree listing); package specifiers kept as opaque nodes. `ts.resolveModuleName` is the documented escalation if replay shows real misses — not built now.
- Observations-first (BRIEF §11.2): per-file extraction emits normalized `StructuralObservation`s — `<module> EXPORTS <symbol>` added/removed, `<symbol> SIGNATURE_CHANGED {before,after}`, `<module> IMPORTS <module>` added/removed, `<class> EXTENDS/IMPLEMENTS <type>` changed — each pinned to `observedInCommit`, deterministic authority, with producer name/version. These are the durable temporal raw material; everything below derives from them.
- Joins (findings, with `derivedFromObservations` lineage): `concurrentEdits` = exact-key intersection of both sides' touched `QualifiedName` sets (**deterministic**); `adjacentDependencyChanges` = one side's touched symbols vs the other side's dependency edges incident to those files (**derived** — tag authority accordingly). Exact-match Map keys only; no regex, no substring (the provenance.ts lesson).
- Determinism is a hard requirement: sorted outputs everywhere (outputHash stability in 01 depends on it). Files that fail to parse, binary files, and non-TS files → per-file extractionCoverage gaps with reason codes; a repo with no TS files → the analysis key is ABSENT.
- Environment fingerprint + multidimensional coverage (SCHEMA-V0): every run stamps an `AnalysisEnvironmentFingerprint` (`mode: "syntax-only"` in v0, typescriptVersion, tsconfigHash/lockfileHash where present, configurationHash) and reports coverage per dimension — `syntax` (parsed?), `resolution` (import targets resolved by path arithmetic?), `type` (not-run in v0, reported as such, never as covered). One scalar percentage is forbidden.
- Exposes a `extractStateFacts(stateRef)` entry point (full-state extraction over all TS files at one commit) reused by concern 11's manifest/checkpoints — the delta path and the anchor path must share one extractor.
- Size cap (default 500 changed files) → `size-cap-exceeded` coverage gap, not a partial silent run.

## Cross-Repo Side Effects
None — pure library.

## Verify
`bun test`: fixture pairs per claimed class (export removed, signature changed, import graph changed, inheritance changed, same-symbol concurrent edit, adjacent-dependency edit) detect correctly; determinism test (two runs, byte-identical canonical output); rename fixtures (clean rename carries identity, ambiguous rename reports unresolved); non-TS and unparseable fixtures produce gaps, never findings.

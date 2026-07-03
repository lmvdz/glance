# Reflexion between fixups
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/reflection.ts, src/workflow/verify-workflow.ts, src/orchestrator.ts, src/fabric.ts, tests/reflection.test.ts

## Goal

Turn blind fixup retries into learning retries: before a fixup attempt, generate a short natural-language root-cause note from the *latest* failure output and inject it (fenced) into the fixup prompt. Highest-value concept in the plan.

## Approach

**New `src/reflection.ts` — a reusable, best-effort root-cause generator:**
- `reflect(input: { output: string, prior?: Reflection[] }, llm): Promise<Reflection | null>` where `Reflection = { rootCause: string, whatToDoDifferently: string, outputHash: string }`.
- Cheap model (haiku). **Never throws** — on timeout/error/parse-fail return `null` and let the caller proceed unblocked (an unhandled reject crashes the daemon tick, per `proof.ts` precedent).
- Export the root-cause fn generically so concern 05 can reuse it for observer/scout findings.

**Refutation, not accumulation:**
- Cap injected context to the **single most recent** reflection, never a growing stack.
- Compute `outputHash` of the failing command output. If it equals the previous attempt's hash, the last hypothesis did not change anything → **drop it** and tell the model "previous hypothesis X did not fix this" (refutation framing), rather than re-injecting the same guess.
- Reflect only from the **2nd fixup onward** — the first fixup with raw output is often enough, and this halves cost.

**Correct insertion point:**
- The graph is `verify → codefix → fixup` (`verify-workflow.ts`). Generate/inject at **fixup-entry**, reading the latest command output available to the workflow driver — NOT verify-time `proof.detail` (a 4000-char merged tail; codefix has already mutated the tree by then).
- Prepend the reflection to `FIXUP_PROMPT`, wrapped in `fenceUntrusted` (reuse 02's in-builder fence pattern; a `${reflection}` must never land raw in a prompt).

**Orchestrator retry path (keep `resolver.ts` pure):**
- `resolver.ts` stays a pure `routeFailure`. The reflection call lives in `src/orchestrator.ts` where the route is consumed: on a `red` "retry", attach the latest reflection to the re-spawn context. Wrap in the same never-throw discipline.
- Skip reflection when `attempts` is at the last retry (no point reflecting right before escalate).

**Persistence + scope:**
- Persist reflections **one file per worktree/agent** (hashed path, `proof.ts` pattern) — never a shared append-only JSONL (scout-seen corruption precedent).
- Source-tag each reflection `{agentId, runId, repo}` and, if surfaced via fabric later, filter through `scopeFor` like `loadScoutFacts`. Add a `reflection` doc type to the fabric snapshot only for scoped retrieval; the in-run fixup injection reads the local per-worktree file directly.
- Read tolerates a torn trailing line (parse per-line, skip unparseable).

Gate all of it behind `OMP_SQUAD_REFLEXION` (default off). Emit reflexion on/off metrics (concern 01) so fixups-to-green can be A/B compared.

## Cross-Repo Side Effects

None. New `reflection` fabric doc type is additive (concern 02 shape; append a scoped loader like `loadScoutFacts`, do not restructure the snapshot).

## Verify

- `bun test tests/reflection.test.ts` — reflect() returns null on llm error (never throws); unchanged output-hash triggers refutation-drop not re-inject; only fires from 2nd fixup; injected text is fenced; store is per-worktree and per-line-tolerant on read.
- `bun run check`
- Manual (flag on): force a verify failure, confirm fixup prompt contains a fenced root-cause note on the 2nd attempt and that an identical repeated failure is not re-stacked.

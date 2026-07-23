# Graceful degradation ladder — provider-scoped, per-unit, fail-safe (GOAL 2)

STATUS: done — merged (PR #114); verified on main, 2026-07-21 reality audit
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/rate-limit.ts, src/dispatch.ts, src/harness-registry.ts, src/model-lineage.ts
PR: feat/sirvir-06-degradation-ladder (draft)

## Resolution note (2026-07-07)
Shipped the full per-provider capability in the 4 listed files: `RateLimitGate` is now a
`Map<provider, cooldown>` (`note`/`paused`/`untilFor`/`reasonFor` all optionally take a
provider; the no-arg shape is preserved byte-for-byte as the legacy global OR), `dispatch.ts`
gates per-issue via new `providerFor`/`secondLaneAvailable` deps (falls back to the exact old
top-of-tick global check when either is absent — zero regression), `model-lineage.ts` gained
`resolveProvider()` (model-then-harness fallback, mirrors `validator.ts`'s private
`lineageFields`) and `DEFAULT_PROVIDER` (the fail-safe fold target for "unknown"), and
`harness-registry.ts` gained `hasSecondVerifiedProviderLane()` to detect the precondition and
log inertness honestly instead of faking differentiation.

**Divergence from the drafted approach:** `squad-manager.ts` (the wiring glue that
instantiates `RateLimitGate`, supplies `DispatchDeps`, and calls `note()` from
`auto_retry_start`) is explicitly out of scope for this concern (owned by a sibling unit /
deferred). So this PR builds and unit/integration-tests the full partitioning capability by
direct construction, but does NOT wire it into the live daemon — today's dispatcher still runs
the byte-for-byte legacy global-freeze path since `providerFor`/`secondLaneAvailable` are never
supplied by `squad-manager.ts`. That wiring (resolve `providerFor` from the repo's configured
harness/model, call `hasSecondVerifiedProviderLane()`, and thread a real provider into the
`auto_retry_start` `note()` call using harness-at-spawn, not the raced `dto.model` backfill) is
the necessary follow-up to make the payoff live. Named, not silently dropped.

Also confirmed empirically: `opencode` is `verified:true` today but is NOT vendor-pinned
(`harnessLineage("opencode")` reads `"unknown"` — it's a generic multi-model ACP runtime), so it
does not count as a differentiating second lane. The concern's "no second verified lane exists
today" premise still holds; only claude-code/gemini/codex are vendor-pinned and all three remain
`verified:false`.

## Goal
Stop a single provider's usage cap from freezing the WHOLE fleet: units that would run on a *different, un-capped* provider keep dispatching. Independent of the GOAL-1 chain (disjoint files) — can run in parallel.

## Evidence + why the naive version is a no-op (red-team CONFIRMED)
- `RateLimitGate` (`rate-limit.ts`) is a single global cooldown; `Dispatcher.tick()` (`dispatch.ts:162`) checks one global `deps.paused?.()` at the TOP of the tick, before the repo loop → spawns nothing → full freeze.
- Making the gate a `Map<lineage, until>` while leaving the dispatcher pre-check unchanged is a **behavioral no-op**: `paused()` no-arg ORs across buckets → still freezes everything. All value is in a per-unit check.
- `harnessLineage("omp"|"pi"|"opencode")` returns `"unknown"` by design (multi-model runtimes), and a default omp unit has no explicit model → `modelLineage("")` = `"unknown"`. So the ONLY verified harnesses all bucket to `"unknown"` — per-lineage gating on `"unknown"` gives zero differentiation AND can under-pause (a `claude-code` Anthropic cap wouldn't pause an omp Anthropic unit on the same subscription).

## Approach
- **Add a real provider/subscription signal, not just lineage.** `HarnessDescriptor` has no provider field; `harnessLineage` deliberately returns `"unknown"` for omp/pi. Derive the omp/pi lane's provider from its *configured default model* (the family/provider from concern 02's `modelFamily`/`model-lineage`), so a default omp unit resolves to `anthropic` (or whatever it's configured to) rather than `"unknown"`. Where a harness is genuinely multi-model with no configured default, keep `"unknown"`.
- **Gate shape:** `RateLimitGate` → `Map<provider, until>`. `note(provider, msg, delayMs)`; `paused(provider)` checks one; `paused()` no-arg ORs (safe fallback). At the record site (`auto_retry_start` handler), resolve the capped unit's provider from harness-at-spawn + configured model — NOT the raced `dto.model` backfill (which is often unset in the ≤2.5s pre-poll window).
- **Move the check into the dispatch loop, per-unit** (this is the real behavior, not a deferred phase): in `tick()`, replace the single top-of-tick `paused()` with a per-prospective-unit `paused(providerFor(repo/unit))`, skipping only units whose provider is capped. Keep the global fast-path only if EVERY candidate provider is capped.
- **`unknown` fails SAFE:** an unclassifiable cap freezes the fleet's dominant provider (Anthropic), never fails open into dispatching straight at a live cap.
- **Ship gated behind a real second lane:** the payoff only exists when ≥1 verified non-default-provider harness is enabled (today codex/gemini/claude-code are `verified:false`). Gate the per-unit behavior on that, and `log()` when it's inert so it isn't mistaken for working. If no second verified lane exists, this concern's honest deliverable is the provider-scoping + fail-safe correctness (so a codex 429 stops mislabeling/mis-freezing Anthropic), explicitly noting active multi-provider keep-running awaits a verified lane.
- Model-downshift and active re-route onto another harness are explicitly LATER rungs — downshift doesn't escape a subscription cap; re-route needs a verified target. Name them, don't build them.

## Cross-Repo Side Effects
`RateLimitGate` is in-memory — the `Map` is lost on daemon restart (pre-existing property; ≤ a handful of providers so no growth concern). Note it, don't fix it here.

## Verify
- Unit: a cap noted for provider A leaves `paused(B)` false and `paused(A)` true; `paused()` no-arg true while any is capped; `unknown` cap → dominant-provider paused.
- Integration: with two providers configured and provider A capped, `tick()` skips A-units and still spawns B-units (assert on which repos/units get `spawn()` called). With only the default provider present, assert the global freeze still holds (no regression) and the inert-log fires.

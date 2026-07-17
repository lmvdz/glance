# Mock-harness dispatch overhead ratchet

STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: scripts/orchestration-overhead-bench.ts (new), tests/orchestration-overhead.test.ts (new), src/spans.ts (read-only reuse), src/harness-registry.ts (test-only registration, not the default roster)

## Goal

The only overhead glance itself can regress is the daemon-controlled span between "dispatch a turn" and "first byte back from the driver" — worktree resolution, process/driver spawn, the omp-rpc/ACP handshake up to `ready`, and the manager's own event plumbing up to the first `agent_end`/`message_update`. Pin that span as a deterministic, committed-baseline ratchet so a future change to the dispatch path (SquadManager.create/prompt, src/rpc-agent.ts, src/acp-agent-driver.ts) cannot silently get slower without a failing test. This must never touch a model or the network — those live in 02, published, never gated.

## Approach

- New mock harness, registered ONLY from the bench/test code (never added to the default roster in `src/harness-registry.ts` — it must not appear in `listHarnesses()` or any create UI/CLI). Two acceptable shapes, author's call at implementation time:
  - An in-process `AgentDriver` fake (`EventEmitter` implementing `src/agent-driver.ts`'s interface), following the exact precedent already in `tests/console-prompt-spawn-failure.test.ts` (`UnstartableDriver`, `HealthyDriver`): emits `ready` promptly, then on `prompt()` emits a synthetic `agent_start` → `message_update` → `agent_end` frame sequence with no subprocess, no model call, no network egress. Fastest, least flaky, but skips real process-spawn cost.
  - A real but trivial child-process harness (a fixture script under `scripts/` or `tests/fixtures/` speaking just enough of the omp-rpc wire protocol to answer `ready` + `agent_end` immediately) registered as a throwaway `HarnessDescriptor`, exercising the REAL spawn path (`resolveWorktree` → spawn → handshake) with zero external calls.
  - Recommend the second shape if the goal is to catch spawn-path regressions (the `resolveWorktree`/worktree-creation cost is real dispatch overhead and a plausible regression surface); the first if in-process determinism is judged worth losing that coverage. Record whichever is chosen and why in this file's Reality-deltas section when built.
- `scripts/orchestration-overhead-bench.ts`: dispatches a unit against the mock harness N times (recommend median of 11, odd count so there's no tie in the middle element), timestamping dispatch-issued → first-driver-byte using **`src/spans.ts`**'s existing span kinds (`"spawn"`, `"run"`) rather than a second hand-rolled timer — reuse `SpanCollector`'s attach points at the same place the manager already instruments spawn/run today. Separately measure a "cold" run (fresh worktree, fresh process) and a "warm" run (already-alive driver, new turn only) — they are different regressions and should not be averaged together.
- `tests/orchestration-overhead.test.ts`: run the bench (or import its measurement function directly rather than shelling out to the script — cheaper and avoids a subprocess-in-a-subprocess wrapper), assert `median ≤ committedBaseline` for both cold and warm, following `scripts/defect-ratchet.ts`'s discipline — a committed numeric baseline living IN the pattern/config (not derived from an environment-dependent "current machine" number), test fails the moment a live measurement exceeds it, lowering the baseline is a separate PR that only ever ratchets down (raised only on an explicit operator commit, recorded in this file's ledger, e.g. "harness handshake grew a mandatory round-trip — baseline raised from Xms to Yms, see PR #NNN").
- Flakiness is the real risk in a *timing* ratchet (unlike `defect-ratchet.ts`'s exact string-count ratchet) — mitigate deliberately: mock harness eliminates model/network variance entirely; assert on the MEDIAN of N runs, not a single sample, so one scheduler-jitter outlier doesn't flip the gate; set the baseline with deliberate headroom over the observed number (document the observed number AND the committed ceiling separately, mirroring `defect-ratchet.ts`'s "Measured N (date): ..." comment convention) rather than a tight equality check.
- Runs under `bun test` like every other gate in this repo — no `.github/workflows` exist (per landscape), and `src/proof.ts` already runs the bun test suite as the land gate, so being IN the suite is what "gated" means here.

## Cross-Repo Side Effects

None. The mock harness, bench script, and test all live in omp-squad; glance-desktop (cockpit) does not consume dispatch-overhead numbers and is unaffected.

## Verify

Reproduce-first, both directions:
- Run `scripts/orchestration-overhead-bench.ts` standalone; confirm it prints cold/warm median numbers in a sane range (low milliseconds to low hundreds, not seconds) and that no outbound network call occurs during the run (no API key env var is consulted by the mock harness path — grep/trace to confirm).
- `bun test tests/orchestration-overhead.test.ts` passes at HEAD against the committed baseline.
- Prove the ratchet actually ratchets: temporarily inject an artificial delay into the dispatch path locally (e.g. a `setTimeout` in the mock driver's `ready` emission) and confirm the test goes red — a ratchet that only ever prints green never caught anything, and this repo has already been burned by exactly that shape of false confidence (composition-drift lesson, blind-review's absence-invariant lesson).

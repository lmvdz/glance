# Published live glance-vs-raw ratio

STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: docs/ (new doc or section — author's call), scripts/ (manual runner, new or thin)

## Goal

Publish the honest number t3code's builders discovered the hard way and complained about in public: how much slower a real task feels going through `glance here` (dispatch → real driver → real model turn) versus typing the raw harness CLI (`claude`, `omp`) directly, same model, same moment. This number must be visible in the repo, dated, re-measurable on demand — and it must NEVER be a gate, under any flag, in any test file, ever. Gating on live-model wall-clock is the one thing arbitration explicitly forbids here (§11): it combines model-latency variance, network variance, and dispatch overhead into a single non-deterministic signal, which is exactly the flaky-gate shape this repo has paid for before (verify-loop thrash; false-green composition drift).

## Approach

- **Dependency check (do first):** the brief for this concern names a `BLOCKED_BY: 01` on the claim that this reuses 01's mock-harness scaffolding. That does not hold: 01's deliverable is specifically a MODEL-FREE fake/trivial harness built to eliminate the exact variance this concern needs to *measure* (real model latency on a real task). The two share no code the way `BLOCKED_BY` implies. If, when 01 lands, it happens to factor out a generic "run N times, take median, report" timing helper that this script can import, treat that as an optional convenience reuse — not a blocker. This concern can be built and shipped independently of 01, in either order.
- Documented **manual, script-assisted** procedure, not an automated pipeline:
  1. Pick one representative real task (a fixed prompt/fixture, small enough to run 10 times in a sitting — e.g. a real bugfix or a scoped refactor from this repo's own backlog).
  2. Run it 5 times through `glance here` (or the console/casual lane, once Epic A ships it) end-to-end, real model, real driver.
  3. Run the SAME task 5 times through the raw harness CLI directly in a terminal (same model, same machine, run back-to-back with step 2 to control for provider-side load variance rather than days apart).
  4. Take the median of each set of 5; report the ratio (glance-median / raw-median).
- A small script (e.g. `scripts/live-ratio-bench.ts`) automates the repetitive parts — timestamp capture, wall-clock delta, median calculation, and a formatted report — but the loop itself is operator-invoked on demand. It is never imported by a test file, never referenced from `scripts/defect-ratchet.ts`-style gate code, never wired to `src/proof.ts`, and takes no part in `bun test`.
- Output: a published doc recording, per measurement run: date, model + version, task description, glance-median, raw-median, ratio, and the conditions (machine, network, daemon load at the time, and whether other units were running concurrently — fan-out load is a known confound per docs/operations.md's event-loop-saturation section). Author's call where it lives: a new `docs/orchestration-overhead.md`, or a section appended to an existing doc (`docs/operations.md` is the closest existing home — it already documents daemon runtime behavior under load). Whichever is chosen, the doc's own first line must state plainly: "measured on demand, not a gate — see plans/daily-overhead/02 for why."
- Re-measurement cadence: on demand — before a release, when 01's dispatch-overhead baseline moves materially, or when the number is challenged. Not scheduled, not automated.

## Cross-Repo Side Effects

None. glance-desktop (cockpit) has no dependency on this number; it is a documentation/measurement artifact local to omp-squad.

## Verify

Reproduce-first: actually run the procedure once end-to-end (5 `glance here` runs + 5 raw-CLI runs on one real task) and confirm the published doc reflects a genuine, dated measurement — not a placeholder or an estimate. Then confirm the negative: grep `tests/` and `scripts/defect-ratchet.ts`/`scripts/orchestration-overhead-bench.ts` for any reference to this script or doc and confirm there is none — proving the number really is unreachable from any gate.

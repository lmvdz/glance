# Change-driven Observer gate (the headline cost win)

STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts
PLANE: OMPSQ-342 — https://app.plane.so/inkwell-finance/browse/OMPSQ-342/

## Goal
Stop re-running the repo's full acceptance suite (`bun test`/`tsc`) every 60s on an
idle fleet. Gate `runMainGate` on a cheap fingerprint of the inputs it actually reads,
so the costly subprocess fires only when the working tree it tests has changed — and
emit a skip receipt (concern 01) when it doesn't.

## Approach
The gate is `runMainGate(repo)` (`src/squad-manager.ts:1841`):
`Bun.spawn(["bash","-lc", command], { cwd: repo })` where `command` is `detectVerify(repo)`
(`bun run typecheck && bun run test`). **Critical (red team A-C1, confirmed in code):**
the suite runs against the **live working tree** of `repo` (`cwd: repo`), NOT a
HEAD-pinned tree. So the fingerprint MUST capture working-tree state — `git rev-parse
HEAD` is blind to uncommitted edits, installs, and lockfile drift and would let a red
gate be skipped and reported healthy. The in-repo idiom `agentHasUnlandedWork`
(`:1759-1769`) checks `st.dirtyFiles.length > 0` *first* for exactly this reason.

1. **Add per-repo gate cache state** on the manager:
   ```ts
   private lastGateFp = new Map<string, string>();          // repo -> fingerprint
   private lastGateResult = new Map<string, { ok: boolean; firstFailure?: string }>();
   private gateTick = new Map<string, number>();            // repo -> tick count (force-run)
   ```
   In-memory only — process-private. A restart re-runs the gate once, which is the
   correct fresh baseline (do NOT persist this to a file; a torn cursor file would
   silently disable the gate — red team A-S2).

2. **Compute the fingerprint INSIDE the existing `withRepoLandLock`** (`runMainGate`
   already wraps its body in it, `:1842`). This is non-negotiable (red team A-M2): a
   land's mid-merge state must never be sampled as a half-written fingerprint — that's
   the OMPSQ-168 false-regression race the lock exists to prevent. Fingerprint inputs:
   ```ts
   const status = gitSync(repo, ["status","--porcelain","--untracked-files=all"]);  // never throws; check code
   const lock   = readIfExists(`${repo}/bun.lock`);    // bytes; tolerate absent
   const fp = sha256(`${status.stdout}\n${lock ?? ""}`);
   ```
   Do NOT include `git rev-parse HEAD` alone, and explicitly do NOT include open Plane
   issue ids (they churn every tick and the suite doesn't depend on them — red team
   A-M3). If the `git status` call fails (`code !== 0`, e.g. transient lock), treat the
   fingerprint as unknown → **run** (fail-safe to the costly path, never skip).

3. **Gate logic**, inside the lock, before the spawn:
   ```ts
   const tick = (this.gateTick.get(repo) ?? 0) + 1; this.gateTick.set(repo, tick);
   const forced = tick % FORCE_RUN_EVERY === 0;     // FORCE_RUN_EVERY = 10
   if (!forced && fp && this.lastGateFp.get(repo) === fp) {
     this.recordGateSkip(repo, "gate inputs unchanged");   // recordSkip via this.automation.for("observer", repo)
     return this.lastGateResult.get(repo) ?? { ok: true };
   }
   const result = await <existing spawn+parse body>;
   if (fp) { this.lastGateFp.set(repo, fp); this.lastGateResult.set(repo, result); }
   return result;
   ```
   The force-run-every-10th-tick valve bounds staleness to ≤10 ticks if the hash ever
   misses an out-of-tree input (toolchain/PATH); it matches the maintainer's own
   ponytail at `:1838` ("throttle — run every Nth tick").

4. **Emit the skip** through the per-repo Observer recorder so concern 02's digest
   sees it as healthy-idle, not a dead loop.

## Cross-Repo Side Effects
Depends on concern 01 (`recordSkip`/`skipReason`). Touches `src/squad-manager.ts`,
which concern 08 (#3 post-run audit) also touches — this concern lands first; 08 builds
on the same file afterward (see overview ordering).

## Verify
- `bun run typecheck` clean; `bun test` green.
- Manual: run the daemon on a clean repo with a live branched agent; confirm the
  automation log shows the gate running once, then "gate inputs unchanged" skips on
  subsequent ticks. Touch a tracked file in the repo working tree → next tick the gate
  RUNS (fingerprint changed). `rm`/edit `bun.lock` → gate runs.
- Regression guard: dirty the working tree with a deliberately failing change but do
  NOT commit → the gate must still RUN and go red (proves we fingerprint the working
  tree, not HEAD). This is the A-C1 acceptance check.
- Confirm every 10th tick runs even with an unchanged fingerprint.

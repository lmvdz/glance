# Skip-event foundation: skipReason on AutomationEvent + spool policy

STATUS: done
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/types.ts, src/automation-log.ts
PLANE: OMPSQ-339 — https://app.plane.so/inkwell-finance/browse/OMPSQ-339/

## Goal
Give the automation ledger the vocabulary for a "this loop ticked but did nothing,
and here's why" receipt — the foundation every other #2/#1 concern rides on. A
skipped tick becomes a first-class, persisted-on-transition event carrying a
`skipReason`, without flooding disk on a loop that idles every 60s for hours.

## Approach
1. **Add `skipReason?: string` to `AutomationEvent`** (`src/types.ts:763-789`). One
   optional field, documented: *"Set when a loop ticked but intentionally did no
   work; names the unchanged input or operational reason (e.g. 'gate inputs
   unchanged', 'no live reasoning', 'at WIP cap')."* Leave `surpriseCause` OUT — the
   design pass cut it as narration nothing consumes.

2. **Add a `recordSkip` helper + transition-spool policy in `src/automation-log.ts`.**
   Today `record()` (`:113-120`) pushes every event to the ring and spools only
   `isMeaningful(e)` events (`isMeaningful` at `:51-53` returns false for all-zero
   `info` events). Skips are all-zero `info` events, so by default they stay ring-only
   — which is what we want for liveness *within* a process. But a healthy-idle loop
   then leaves no disk trace across a restart. Fix with **transition spooling**:

   - Keep a per-key `lastSkipKey: Map<string, string>` on the log, keyed by
     `eventKey(e)` = `` `${e.loop}:${e.repo ?? ""}` `` (per-repo loops and fleet-wide
     loops never collide — see concern 03 for why the key matters).
   - In `record()`, after the existing `isMeaningful` branch, add:
     ```ts
     else if (e.skipReason) {
       const key = eventKey(e);
       const sig = `${key}|${e.skipReason}`;
       if (this.lastSkipKey.get(key) !== sig) {  // transition: first skip, or reason changed
         this.lastSkipKey.set(key, sig);
         void this.spool(e);                       // persist the transition only
       }
     }
     ```
   - A real (meaningful) event clears the key so the next skip re-spools the
     transition back into idle: in the `isMeaningful` branch, `this.lastSkipKey.delete(eventKey(e))`.

   Net: disk gets one "entered idle: <reason>" row per idle stretch (and one when it
   exits), not one per tick. The ring (cap 2000, `:35`) still holds every skip for
   live liveness.

3. **Expose `recordSkip(partial)`** as a thin wrapper that fills `level: "info"` and
   the zero counters, so loop code reads cleanly: `this.deps.recordSkip?.({ skipReason, repo })`.

## Cross-Repo Side Effects
None. `skipReason` is optional and additive; existing `record()` callers and the
JSONL hydrate path (`automation-log.ts:122-163`, per-line try/catch) tolerate the new
field unchanged.

## Verify
- `bun run typecheck` clean.
- Unit test in the automation-log test suite: record 100 identical skips for
  `observer:/repo-a` → assert `spool` called exactly once; record a meaningful event
  → record another skip → assert spool called again (transition re-fires).
- Assert two different repos (`observer:/repo-a`, `observer:/repo-b`) skipping do NOT
  share a `lastSkipKey` entry (no clobber).

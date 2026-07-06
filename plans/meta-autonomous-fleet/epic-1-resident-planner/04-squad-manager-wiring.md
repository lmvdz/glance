# Wire ResidentPlanner into SquadManager start()/stop()

STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/squad-manager.ts

## Goal (what is built)

Construct and tear down the `ResidentPlanner` (leaf 03) inside `SquadManager`,
behind `OMP_SQUAD_RESIDENT_PLANNER` — one instance per configured Plane repo,
exactly parallel to how the plan-sync and Opportunity loops are wired. When the
flag is unset, nothing is constructed and nothing changes.

## Approach (how — cite real file:symbol attach points)

- Add a private field alongside the existing loop holders: `private readonly
  residentPlanners: ResidentPlanner[] = [];` next to `this.opportunities`
  (squad-manager.ts:482).
- In `start()`, after the Opportunity block (squad-manager.ts:797–813), add a
  gated block mirroring it. It is opt-IN, so gate on `=== "1"` (NOT `!== "0"`):
  ```ts
  if (process.env.OMP_SQUAD_RESIDENT_PLANNER === "1" && observeRepos.length > 0) {
    for (const repo of observeRepos) {
      const planner = new ResidentPlanner({
        repo,
        stateDir: this.stateDir,
        classify: ompClassify(this.bin),
        hasProof: (id) => hasProof(this.stateDir, id),
        onChanged: () => this.emitFeaturesChanged(),
        log: (m) => this.log("info", `resident-planner[${repo}]: ${m}`),
        record: this.automation.for("resident-planner", repo),
      });
      planner.start();
      this.residentPlanners.push(planner);
    }
    this.log("info", `resident-planner on (decomposing objectives → ${observeRepos.join(", ")})`);
  }
  ```
  `ompClassify` is already imported (from intake.ts, used at squad-manager.ts:546,
  777); `hasProof` is already imported (used at :746); `this.automation.for(...)`,
  `this.stateDir` (:536), `this.bin` (:541), `emitFeaturesChanged` all exist.
- In `stop()`, next to `for (const o of this.opportunities) o.stop();`
  (squad-manager.ts:922), add `for (const p of this.residentPlanners) p.stop();`.
- Add `residentPlanner: this.residentPlanners.length > 0` to the automation-status
  payload next to `opportunity:` (squad-manager.ts:4559) for observability parity.

## Verify (concrete command + expected observable outcome)

- `bun run typecheck` (or the repo's `check` script) passes.
- `OMP_SQUAD_RESIDENT_PLANNER=1 <daemon start>` then inspect the daemon log: a
  `resident-planner on (decomposing objectives → <repo>)` line appears; without the
  env var, that line is absent (grep the log to confirm both directions). If a unit
  test harness for `SquadManager.start()` wiring exists (e.g. an existing
  `squad-manager*.test.ts` that asserts loop construction), extend it to assert a
  planner is constructed iff the flag is `"1"`.

## Scope boundary (what NOT to touch)

Wiring only. Do not modify `ResidentPlanner` (leaf 03), `planner.ts`, or
`plan-writer.ts`. Do not change the plan-sync/Opportunity/Scout blocks. Do not
change the default behavior — the flag defaults OFF, so an unconfigured daemon is
byte-for-byte unchanged at runtime.

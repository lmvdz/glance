# Validator veto → next-turn reprompt (flagged off, measured)
STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/orchestrator.ts, src/squad-manager.ts

## Goal
When an independent validator vetoes a land, feed the veto reason + unmet criteria back into
the SAME unit's next turn (once per veto cycle) so it can address them, instead of blind-retrying
against an unchanged diff and then holding for a human. **Off by default** behind an env flag,
with a recovery metric, because a vetoed unit today goes to operator-*held* (propose-only) and
there is no evidence yet that a reprompt recovers rather than burning a turn + a silent spend.

## Approach
1. **New optional dep** on `OrchestratorDeps` (`src/orchestrator.ts`):
   ```ts
   continueAgent?: (agentId: string, note: string) => Promise<void>;
   ```
   Defaults to a no-op like the other optional deps → back-compat by construction.
2. **Wire it** where the `Orchestrator` is constructed in `src/squad-manager.ts`:
   ```ts
   continueAgent: (id, note) => {
     const rec = this.agents.get(id);
     return rec ? this.promptConnected(rec, note) : Promise.resolve();
   },
   ```
   (Find the `new Orchestrator({...})` site — RT flagged its exact location as unverified.)
3. **Fire it** in `tryLand` (`src/orchestrator.ts:295-334`), falsy-outcome branch, gated on:
   - `process.env.OMP_SQUAD_VETO_REPROMPT === "1"` (default off), AND
   - `a.validation?.verdict === "veto"`, AND
   - first blocked tick of this cycle (`blocks === 1`) so it fires once, not every retry, AND
   - the unit is **not** under an armed Epic-7 convergence loop (RT2-A5 double-reinjection
     guard — check the convergence armed signal, e.g. `OMP_SQUAD_LOOP_ARMED`/the oracle identity).
   Compose from data already on `a.validation` (`rationale`, `perCriterion[]` of `{id,satisfied}`):
   ```ts
   const unmet = a.validation.perCriterion.filter(c => !c.satisfied).map(c => c.id).join(", ");
   const note = `Independent validator vetoed this land: ${a.validation.rationale}. ` +
                `Unmet criteria: ${unmet}. Address these, then the next verify/land will re-check.`;
   void this.deps.continueAgent?.(a.id, note).catch(() => {});  // RT1-F5: mandatory catch
   ```
   Never `await` inside the tick loop (the `ticking` re-entrancy guard bounds one tick; blocking
   on a full agent turn stalls verify/land for every other agent). The `LAND_RETRY_CAP`/autoland
   park ceiling is unchanged — this adds one real chance to react before the existing hold.
4. **Recovery metric**: record veto-reprompt → subsequent-verdict via the existing
   `learningMetrics`/`recordConfidenceOutcome` seam so the flag can be promoted only if
   reprompted units measurably re-pass.

## Tri-state mapping
`pass` → done (unchanged). `veto` → continue (the reprompt). `abstain`/`skipped` → already
fail-open (only a true veto blocks the gate) — no change. A genuine `waiting`-on-human state
already exists as the park/`markHalted` → attention-queue path; leave it untouched.

## Cross-Repo Side Effects
None.

## Verify
- Unit test with `OMP_SQUAD_VETO_REPROMPT=1`: a vetoed agent in `tryLand` triggers exactly one
  `continueAgent` call with the rationale + unmet criteria; with the flag unset, zero calls.
- Unit test: an armed-convergence unit gets zero reprompts even with the flag on.
- `bun test` green.
- Live (flag on): force a veto, confirm the unit receives the reason as its next prompt and the
  recovery metric records the follow-on verdict.

## Resolution
Shipped **off by default** (`OMP_SQUAD_VETO_REPROMPT`). Added optional `continueAgent?` to
`OrchestratorDeps`; fires in `tryLand`'s blocked branch gated on `blocks === 1` + the flag +
`a.validation?.verdict === "veto"`, composing `rationale` + unmet `perCriterion` ids into the note
(`void`, never awaited in the tick — RT concern about stalling other agents). Wired in
`buildOrchestrator` with a `.catch`, an `isArmed(this.stateDir)` guard so it can't double-inject over
an armed Epic-7 convergence loop (RT2-A5), and a `veto-reprompt` metric (new `MetricName`) whose
follow-on verdict is already correlatable on the existing land/confidence ledger. The
`LAND_RETRY_CAP` park ceiling is unchanged — this adds one real chance to react before the existing
hold. Tests: `tests/veto-reprompt.test.ts` (3 pass — fires once with reason+unmet on flag+veto; never
on flag-off; never without a veto verdict). Typecheck clean; full suite 1545 pass / 0 fail.
Follow-up (documented, not built): promote to default only if the metric shows reprompted units
measurably re-pass; reconcile with Epic-7's convergence oracle into one reinjection signal.

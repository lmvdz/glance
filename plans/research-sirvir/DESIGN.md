# Design: sirvir borrows into glance — attribution→routing + degradation ladder

**Status: the adversarial design pass (Designer → 2 Red Teams → Arbiter) demolished the research's "70% built, just reconnect a dead wire" framing with live evidence. Read this before implementing — the plan pivoted.**

## What the red teams proved (verified against live `~/.glance` + code)

| Finding | Severity | Verified how | Verdict |
|---|---|---|---|
| **`model-outcomes.json` is empirically ABSENT** after 372 receipts — recording at `squad-manager.ts:2494` has never produced data | critical | Both red teams + I checked `~/.glance` and `~/.glance/orgs/*/` — no file | **CONFIRMED.** GOAL 1 is unfueled; fixing the dead wire changes nothing observable. The TencentDB "empirically empty" pattern. |
| **The fleet has NO outcome-driven model routing at all** | critical | `create({autoRoute:true})` → `routeIntake` (`squad-manager.ts:3166`) selects **workflow/verify/thinking, NOT model**. `shiftedModel`/`planSpawn` is reached ONLY from the interactive `POST /api/spawn` (`server.ts:1376`). | **CONFIRMED.** GOAL 1 as scoped upgrades a human-only box; the autonomous fleet it was meant to help never runs the code. |
| Red Team B: "a richer fleet router (`model-route.ts` / `routeModelForTaskClass`) already exists" | — | I checked: **no such file, no such symbol.** `ls src/model-route.ts` → absent; grep of `squad-manager.ts` → nothing. | **REJECTED — fabricated.** The arbiter does not accept it. (B's *conclusion* — that the fleet doesn't use `shiftedModel` — is nonetheless true via `routeIntake`.) |
| Cost formula fails closed: unbounded ratio swamps 0..1 land-rate at λ=0.5 → a better-but-pricier model can never win (vetoes escalation, inverting `shiftedModel`'s purpose); null incumbent cost → `x/0` → `−Infinity` → never fires | critical | Design-level math on `costPerLandedChange` (`attribution-scoreboard.ts:117`, real $1–40 range) | **CONFIRMED.** If cost-weighting ships, the term must be bounded, null-safe, and a tie-breaker — not summed into the win condition. |
| Key mismatch: recording keys on `modelKey(dto.model)` (backfilled `provider/id`, e.g. `anthropic/claude-opus-4-8`); candidates/incumbent are the labels `"opus"`/`"default"` — which never appear in the ledger | critical | `squad-manager.ts:2494` records `dto.model`; `smart-spawn.ts:36` `SHIFT_CANDIDATES=["opus","default"]`; `applyState` backfill | **CONFIRMED.** The incumbent `"default"` row can't exist ⇒ `shiftedModel:64` early-returns by construction. |
| DB-mode stateDir trap: bare `resolveStateDir()` at the call site reads the wrong (empty) root ledger for any tenant org (manager is org-scoped, `manager-registry.ts:108`) | significant | Verified org dir `~/.glance/orgs/org_01KWJC.../` exists | **CONFIRMED.** Route through `manager.modelOutcomesReader()` closing over `this.stateDir` (mirrors `shadowCostCheck(this.stateDir,…)`). |
| GOAL 2 v1 (per-lineage gate, dispatcher check unchanged) is a **behavioral no-op** — `paused()` no-arg still ORs across buckets → still full-freeze | significant | `dispatch.ts:162` single global `deps.paused?.()` before the loop | **CONFIRMED.** All value is in the deferred per-repo slice. |
| GOAL 2 lineage mis-partitions: `harnessLineage("omp"\|"pi"\|"opencode")` = `"unknown"` by design (multi-model runtimes); a `claude-code` Anthropic cap would NOT pause an omp Anthropic unit on the same subscription | significant | `model-lineage.ts:64-72` | **CONFIRMED.** Per-lineage gating on `"unknown"` is arguably *less* safe than today's global freeze. Needs a real provider field + fail-safe unknown handling. |

## The arbitrated reality

- **The research premise was wrong where it mattered.** "Attribution→routing is 70% built, reconnect the dead wire" is false: (a) the ledger the router reads has never been written; (b) the router is wired only to a human entry point, not the fleet; (c) the cost formula as drafted fails closed. The dead wire is real but is the *least* important of three stacked reasons the feature is inert.
- **The genuinely high-leverage gap is upstream and different:** land-outcome recording does not work (three ledgers absent from the same land-confirm branch), and the autonomous fleet has no outcome-driven model selection to fuel even if it did. Fixing recording is the precondition for *any* of this to matter.
- **GOAL 2's honest v1 is bigger than "make the gate a map":** it needs a provider/subscription field on the harness descriptor, a dispatcher-level *per-unit* check (not a global pre-check), fail-safe `unknown` handling, and gating behind at least one verified second-provider lane — otherwise it's untestable theater on a fleet where every verified harness is lineage `"unknown"`.

## Recommended path (pivoted)

1. **Precondition — fix land-outcome recording (the unlock).** Diagnose why `model-outcomes.json` / `land-ledger.json` are absent after 372 receipts (older global daemon binary predating Epic 6? lands never reaching the record branch? the `land-failures.json` dirty-checkout/reviewer-reject rollbacks?). Prove a non-empty, correctly-keyed ledger on a live land. Nothing downstream is real until this is.
2. **Key coherence.** Normalize the recorded model identity to a stable *family* key that both record-time and read-time agree on (not a versioned `provider/id`, not the phantom `"default"`).
3. **Dead-wire fix (cheap, honest, interactive-only).** `server.ts:1376` → `manager.modelOutcomesReader()` (DB-safe) + a regression test on the live route. Label it: interactive spawn box, not the fleet.
4. **Cost-weighting done right.** Bounded, null-safe, tie-breaker-not-veto. Placement decided by (5).
5. **The real prize — give the FLEET outcome-driven, cost-aware model selection** (it has none): extend `routeIntake` to also route *model* from the now-populated ledger, or share a scorer onto the `create(autoRoute)` path.
6. **GOAL 2, honestly scoped.** Provider field on `HarnessDescriptor` + per-provider gate + dispatcher per-unit check + `unknown → freeze dominant provider (fail safe)` + ship only alongside ≥1 verified second-provider lane.

## Open decision (for the user — the premise shifted materially)
Whether to pursue the pivoted plan (recording-first, fleet-routing prize, honest GOAL 2), a minimal honest slice (dead-wire + bounded formula on the human box only, explicitly labeled), or bank this as intel. See the gate.

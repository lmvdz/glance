# Design: continuous in-session context durability (Mastra OM, reframed)

## Approach

Borrow Mastra Code's Observational Memory *intent* — a long-running unit shouldn't lose
its context — but reframe it for omp-squad's actual architecture. **Hard constraint:** each
unit is an `omp`/Claude-Code child process that owns its own context window and does its own
compaction. The daemon's `rec.transcript` is a display/digest mirror — the daemon **cannot**
reach into or shrink a child's live context. So this is not (and cannot be) an in-window
compaction replacement. It is a **turn-boundary / cross-process context-durability layer.**

The adversarial design pass (designer → 2 red teams → arbiter) collapsed an initial
3-pattern / 2-new-store proposal into **two low-risk concerns plus one deliberate drop**,
because most of the proposed infrastructure already exists on disk:

- `src/digest.ts` `buildDigest` already writes Goal / Summary (zero-token extractive
  `summarize()`) / Files touched / **Where we left off** — and `finalizeRun` rebuilds it on
  **every** `agent_end`, not just at unit death. That *is* the observation payload.
- `src/reflection.ts` is already the append-only, dated, per-worktree JSONL store.
- `src/fabric.ts` + `buildContextPrimer` already inject cross-agent context at spawn.
- The `restart()` path (`src/squad-manager.ts:3813-3817`) already surfaces the digest as a
  fenced **system transcript entry**, under a deliberate invariant: *"Surfacing only — never
  auto-prompt the live agent (no silent spend)."*

The real gap is narrow and specific: the **cold-adopt path does none of this.** A plain unit
whose host died is re-created via `adoptOrphanedAgents` → `create()` with **no `task`, no
`appendSystemPrompt`, and no digest surfacing** — it comes back with amnesia.

## Key decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Build a new observation-log store (#1)? | **No — drop it** | New `observation-log.ts` with cursor + JSONL + haiku condense | Both red teams: duplicates `digest.ts` (payload) + `reflection.ts` (per-worktree accumulation) + `fabric.ts` (injection); ~zero standalone value under the hard constraint; its cursor is a racy RMW with duplicate-spend + JSONL-corruption bugs. If cross-turn accumulation is ever wanted, extend `reflection.ts`. |
| How to resume a cold-adopted unit (#2)? | **Surface the existing digest** as a fenced system entry, mirroring `restart()`; restore dropped `appendSystemPrompt` | Auto-prompt the unit with a composed resume task, dirty-gated | Auto-prompting flips the unit off the safe `adopted` fast-land path into a documented false-negative pre-verify (RT1-F1), makes landing depend on a fragile boot-time model turn that strands work on failure (RT1-F2), and mis-classifies the clean-but-ahead crash case (RT1-F3). Surfacing-only changes no land semantics, respects no-silent-spend, and dissolves all three landmines. |
| New `PersistedAgent.checkpoint` field? | **No** | Add `checkpoint?:{updatedAt,note}` | Redundant: the digest + the dirty worktree are already durable per-turn. New info: none. |
| Validator veto → next-turn feedback (#3)? | **Ship behind an env flag, OFF by default, measured** | Ship on by default; or defer entirely | Data (`validation.rationale`) is already on the DTO, so composing is cheap. But a vetoed unit today goes to operator-*held* (propose-only), not blind-park, and there is **no evidence** a reprompt recovers vs. burns a turn + a silent-spend (RT2-A4). Off-by-default + a recovery metric on the existing confidence-outcome ledger lets us promote it only if it measurably works. |

## Risks

- **Digest freshness on cold-adopt.** The surfaced digest is the last completed run's — if the
  unit died mid-turn, the digest omits the in-flight turn. Accepted: it is strictly better than
  today's nothing, and the on-disk worktree state (the actual work) is intact regardless.
- **`appendSystemPrompt` double-compose.** Re-passing the persisted (already-composed) value
  through `create()` re-prepends `profile.memory`+toolGrants for *profiled* units. Cosmetic
  (idempotent content), only profiled units, no behavioral effect. Documented, not gated.
- **Veto-reprompt overrides the no-silent-spend invariant.** Deliberate, and only when the
  operator opts in via the env flag; bounded to once per veto cycle.

## Red team concerns addressed

| Concern | Severity | Resolution |
|---|---|---|
| #1 observer log duplicates digest/reflection/fabric; ~zero standalone value (RT2-A1) | critical | **Dropped** #1 entirely. |
| Auto-prompt resume flips unit off fast-land into false-negative pre-verify (RT1-F1) | significant | Resume is **surfacing-only**, not auto-prompt — no land-semantics change. |
| Auto-prompt resume strands work if the boot-time turn fails (RT1-F2) | significant | Same — no auto-prompt, so no boot-time turn to fail. |
| Dirty-gate mis-handles committed-partial-then-crashed (clean but ahead) (RT1-F3) | significant | Dirty-gate removed with the auto-prompt; surfacing fires for all adopted plain units. |
| Detached fire-and-forget rejection crashes the Bun daemon (RT1-F5) | significant | Every fire-and-forget into `promptConnected`/surfacing carries a mandatory `.catch`. |
| Overrides the documented "no silent spend" invariant (RT2-A2) | significant | Resume is surfacing-only (honors it). Veto-reprompt (#3) overrides it *only* behind an opt-in flag, and the plan says so explicitly. |
| Veto-reprompt recovery value unproven (RT2-A4) | significant | Ship OFF by default + recovery metric; promote only on measured re-pass. |
| #3 duplicates Epic 7 convergence reinjection (RT2-A5) | minor | Guard: veto-reprompt must not fire on a unit under an armed convergence loop. |
| `PersistedAgent.checkpoint` redundant (RT2-A3) | significant | Dropped. |

## Open questions

None blocking. Deferred (documented, not built): cross-turn progress accumulation (extend
`reflection.ts` if ever needed), and reconciling #3 with Epic 7's convergence oracle into one
reinjection signal.

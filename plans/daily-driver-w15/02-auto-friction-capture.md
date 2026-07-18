# 02 — Auto-friction capture: the daemon files its own gripes

STATUS: open
PRIORITY: p1
COMPLEXITY: architectural
TOUCHES: src/types.ts, src/friction-log.ts, src/squad-manager.ts, .claude/skills/dogfood-drain/SKILL.md, tests
BLOCKED_BY: —

## Goal

The friction ledger stops depending on Lars typing `grr`. The daemon auto-records the three friction classes it already detects — held boundary-syncs, ACP prompt timeouts, session loss on restart — as distinguishable, low-noise `FrictionEntry` rows the weekly drain buckets separately from human gripes.

## Verified anchors (2026-07-17 recon)

- `FrictionEntry` at `src/types.ts:57` — fields `id, ts, agentId?, repo, context?, gripe`. **No `source` field exists yet.**
- Single write funnel: `FrictionLog.record()` at `src/friction-log.ts:54` (mints id+ts, appends to `<stateDir>/friction.jsonl`, throws on empty gripe); input shape `FrictionCapture` at `:24`. Reached via `POST /api/friction` (`server.ts:1934`) and `SquadManager.recordFriction` (`squad-manager.ts:2769`).
- Hook sites:
  - Held boundary-sync: the attention-raise at `squad-manager.ts:5312` already discriminates `sync: "held"|"uncapturable"|"divergence"` — fire on `held` and `divergence` only (real friction); never on clean applies.
  - ACP prompt timeout: driver reject sites `acp-agent-driver.ts:617` (silence) and `:631` (hard cap); hook at the MANAGER's error-transition handling (`recordErrorTransition`, `squad-manager.ts:8156`), not in the driver — the driver stays transport-only.
  - Session loss: `recordNonResumableSkips` at `squad-manager.ts:2291` (populates `deadPlaceholders` from the boot snapshot).
- **Premise correction carried from recon:** the daily-onramp/07 "60s timer errors long quiet tool calls" bug is already fixed for compliant adapters (tool-call suspension via `outstandingToolCalls`/`trackToolCall`/`onToolCallChange`); the residual case is adapters emitting no `toolCallId` (`trackToolCall` no-ops at `:465`). Auto-capture of ACP timeouts is therefore expected to be RARE — which is correct; it should never fire on normal operation.

## Approach

- Add `source: "human" | "auto"` to `FrictionEntry` with a read-side migration default: entries missing the field are `"human"` (existing friction.jsonl rows must keep working — no rewrite). `FrictionCapture` gains optional `source`, defaulting `"human"`; the HTTP route never accepts `"auto"` from outside (server stamps human — auto is daemon-internal only).
- Auto entries: machine-built gripe text (one line, states the fact: e.g. `boundary sync held: checkout changed during turn (agent X, repo Y)`), `context` uses an `auto:` convention (`auto:boundary-sync-held`, `auto:acp-timeout`, `auto:session-loss`) so both the `source` field and the context convention discriminate (belt and suspenders per overview).
- Noise control: one auto entry per (agentId, cause) per triggering event — the held-sync re-raise on boot (`reattachHeldSyncs` `:5452`) must NOT re-record friction for a hold already captured; dedup on a stable key (e.g. the held patch id / placeholder id), not on time windows.
- Fail-open capture: a failed friction write must never affect the primary operation (the hold, the error transition, the boot) — log a visible warning, continue. Friction capture must not become friction.
- `.claude/skills/dogfood-drain/SKILL.md`: triage step buckets `source:"auto"` separately (they corroborate or contradict human gripes; they never count as human adoption signal).
- `glance grr --list` output distinguishes auto rows (a marker column/prefix, `--json` carries the field).

## Verify

- Unit tests per hook: simulate held sync / error transition with the ACP timeout signature / non-resumable snapshot → exactly one auto entry with correct source+context; boot re-raise of the same hold → zero new entries; clean turn / normal error → zero entries.
- Migration: a pre-existing friction.jsonl row without `source` reads back as human in `--list` and `/api/friction`.
- HTTP hardening: `POST /api/friction` with `source:"auto"` in the body still records `human`.
- Live (batch gauntlet): scratch daemon, force a held sync (concurrent operator edit mid-turn, the proven recipe from the wave-1 ledger), then `glance grr --list` shows the auto row.

## Scope boundary

No new friction classes beyond the three named. No changes to ACP driver timeout behavior (daily-onramp/07's residual no-toolCallId case is that plan's scope, not this one's). No webapp changes (04 renders what this writes).

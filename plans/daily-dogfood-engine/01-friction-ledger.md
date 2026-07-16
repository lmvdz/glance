# Friction ledger — `glance grr` + one-keystroke capture

STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/index.ts, src/friction-log.ts (new), src/types.ts, src/server.ts, src/squad-manager.ts, webapp/src/components/chat/Composer.tsx, src/tui.ts, tests/friction-log.test.ts (new)

## Goal

Capture a gripe — anything that made using glance as a daily driver annoying — in under five seconds, from wherever Lars is when it happens: a terminal (`glance grr "<gripe>"`), the webapp composer (one click + Enter), or the TUI (one keybind + Enter). Every capture appends `{ts, agentId?, repo, context, gripe}` to a durable, listable ledger. If capture costs more than a few seconds or requires leaving the flow he's in, it will not get used mid-annoyance and the whole epic loses its raw material — this is the design constraint that dominates every choice below.

## Approach

- **Ledger storage**: new `src/friction-log.ts` wrapping the existing generic `JsonlLog<T>` (`src/jsonl-log.ts:31`, already the precedent for `transitions.jsonl` — `src/squad-manager.ts:938`), NOT `src/automation-log.ts`. Reasoning recorded here so it isn't re-litigated: `automation-log.ts` is hard-typed to `AutomationEvent`'s heterogeneous-metrics schema and gates persistence through `isMeaningful()` (`src/automation-log.ts:51-53`), a heartbeat-vs-worth-persisting filter that doesn't apply — every gripe is meaningful by construction. `JsonlLog<T>` gives append/recent/hydrateAll/rotation for a fixed `FrictionEntry` shape with none of that baggage. Instantiate one `JsonlLog<FrictionEntry>` per manager (same lifecycle as `transitionLog`, `src/squad-manager.ts:938`), path `path.join(this.stateDir, "friction.jsonl")` — mirrors `automationPath()` (`src/automation-log.ts:37-39`) and `receiptPath()` (`src/receipts.ts:269-271`)'s state-dir convention. Add `FrictionEntry` to `src/types.ts`: `{id: string; ts: number; agentId?: string; repo: string; context?: string; gripe: string}`.
- **CLI verb**: add `case "grr":` to the `main()` switch (`src/index.ts:1022-1109`), in the `ask`/`automation` cluster (not next to the pre-existing duplicate `case "open"` at :1052/:1095 — unrelated bug, do not fix here, just don't compound it). `cmdGrr(args)` mirrors `cmdAsk`'s fire-and-forget POST shape (`src/index.ts:929-941`): `repo = flags.repo ? path.resolve(flags.repo) : process.cwd()`, `POST ${base(flags)}/api/friction` with `{...tokenHeader(), "content-type": "application/json"}` and body `{repo, context: flags.context, gripe: positional.join(" ")}`. No polling — print `"logged.\n"` and exit 0 on 2xx, mirroring `cmdAsk`'s no-daemon error message (`src/index.ts:943`) on failure. `glance grr --list [--repo <path>] [--json]` routes to `GET /api/friction`, rendered like `cmdAutomation` (`src/index.ts:880-918`) — human table by default, raw JSON with `--json`.
- **Server routes**: `POST /api/friction` and `GET /api/friction` in `src/server.ts`, tenant-scoped like `GET /api/projects` (`src/server.ts:1734` — reached after the per-tenant `!manager` gate), NOT the fleet-wide `handleObservability` pattern (`src/server.ts:866`) — the ledger lives in one manager's `stateDir`, same as the `transitionLog` it's modeled on, so cross-org roll-up is out of scope until DB mode needs it. Operator authz tier (same tier as `prompt`/`create`, `src/authz.ts:33-49`) — no new tier, since in practice the only writer is the operator dogfooding their own daemon. `POST` calls `manager.frictionLog.append({id: crypto.randomUUID(), ts: Date.now(), ...body})`; `GET` calls `.recent(limit)` (query param, default 100).
- **Webapp affordance**: clone the existing ghost toolbar-button pattern in `Composer.tsx` (`webapp/src/components/chat/Composer.tsx:742-750`, the "Attach image" button — same `h-8 w-8 rounded-full` sizing, same hover/dark treatment) as a new "Log friction" button next to it. Click opens a small anchored popover with one autofocused text input; Enter POSTs immediately using the composer's already-available `repo`/current agent id as `agentId`/`context`, then closes with a toast; Escape cancels with no request. No modal, no multi-field form — the whole point is that it costs one click and one Enter.
- **TUI keybind**: add a single-letter binding in `handleKey` (`src/tui.ts:549-560`), mirroring the existing `a` → jump-to-blocked case (`src/tui.ts:557`) — e.g. `g` when not already in a text-entry context — that opens a one-line prompt at the bottom of the screen; Enter submits via the same `POST /api/friction`, Escape cancels. Also add a `/grr <text>` slash verb in `runSlash` (`src/tui.ts:587-597`, alongside `stop`/`restart`) for anyone who'd rather type it than leave the text flow.
- Every capture path (CLI, webapp, TUI) goes through the same `POST /api/friction` — no path gets its own ledger-write logic.

## Cross-Repo Side Effects

None. This concern is entirely inside omp-squad (daemon + webapp + TUI); glance-desktop/cockpit is not touched — a cockpit affordance is out of scope until a cockpit consumer asks for one (consistent with 00-meta.md's "each consumer builds its own" discipline used elsewhere in this program).

## Verify

- Unit: `tests/friction-log.test.ts` — append/recent/hydrateAll round-trip (reuse `JsonlLog`'s own torn-line-tolerance tests as the pattern, don't re-test `JsonlLog` itself); `POST /api/friction` then `GET /api/friction` returns the entry via a scratch-daemon HTTP round-trip.
- CLI: `glance grr "test gripe" --repo .` against a scratch daemon (scratch-daemon skill), then `glance grr --list` shows it; confirm the no-daemon path prints the same style of error as `cmdAsk`.
- Live: one manual pass per surface — webapp (agent-browser: click button, type, Enter, confirm the entry appears via `--list`), TUI (keypress, type, Enter, confirm same), timed with a stopwatch to confirm the <5s claim isn't aspirational.

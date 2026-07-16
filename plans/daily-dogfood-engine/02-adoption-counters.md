# Adoption counters — casual sessions/prompts/push-taps per day

STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: src/adoption-counters.ts (new), src/doctor.ts, src/doctor-probe.ts, src/server.ts, src/push.ts, src/squad-manager.ts, webapp/src/main.tsx (or App.tsx — the app-boot module that reads location.hash), scripts/append-adoption-ledger.ts (new), tests/adoption-counters.test.ts (new)

## Goal

Three numbers, each computed from data the daemon already durably writes, so "is Lars actually using this daily" stops being a vibe and becomes something 03's gate review reads off a screen: **casual sessions/day**, **prompts/day**, **push-taps/day**. Surfaced via a `glance doctor` section and a small GET endpoint; appended weekly into `plans/daily-driver/00-meta.md`'s Ledger. Deliberately the smallest honest version of each metric, not an analytics platform.

## Approach

- **Casual sessions/day**: casual sessions are identifiable by `name`/kind — today the console lane creates them via `POST /api/console` → `manager.create({repo, name:"chat", ...})` (`src/console-prompt.ts`); once `plans/daily-onramp/02` ships `glance here`, those sessions get their own distinguishing name/kind too (no dependency edge needed — this concern reads `name`/kind generically, whichever casual-marking convention exists at count-time, per arbitration §RT2-4a: no hard dependency on the on-ramp epic). Source: `readAllReceipts(stateDir)` (`src/receipts.ts:304-317`) — `RunReceipt.startedAt` is already a durable, restart-surviving per-run timestamp (`src/receipts.ts:204 (snapshot(); private field :107)`). Filter receipts whose `name` matches the casual markers, group by UTC day.
- **Prompts/day**: `RunReceipt` is whole-run granularity, not per-turn (confirmed: `RunAccumulator` closes one `agent_start..agent_end` window, `src/receipts.ts:104`), so it cannot count individual prompts within a session. Use `transitions.jsonl` instead (lifecycle-truth's CLOSED substrate, `src/agent-lifecycle.ts`, persisted via `JsonlLog<TransitionEntry>` at `src/squad-manager.ts:938`) — count transitions INTO `working` FROM `idle`|`input` for casual-marked agents, grouped by day. Each such transition is a turn start, i.e. a prompt; this reuses data that's already written for every agent, no new instrumentation on the hot path.
- **Push-taps/day**: confirmed there is currently NO beacon-on-open anywhere in the webapp and NO route handling at all for the `#/agent/<id>` hash `push.ts` already targets (searched `webapp/src/` for `analytics`/`beacon`/`hashchange`/`#/agent/` — zero relevant hits). Build the smallest honest version:
  1. `src/push.ts`'s `escalationPayload`/`voiceDonePayload` (`src/push.ts:35-57`) append a `?push=1` marker to the existing `url: \`/#/agent/${a.id}\`` — this is what distinguishes "opened via a push tap" from "typed/clicked the URL manually," since both land on the same hash otherwise.
  2. On webapp boot (wherever the app reads `location.hash` first, e.g. `webapp/src/main.tsx`), if the hash matches `#/agent/<id>?push=1` AND a `sessionStorage` dedupe flag for that exact hash hasn't been set (avoid double-count on remount/HMR), fire one `POST /api/push-tap` (fire-and-forget, no await-blocking of render) and then `history.replaceState` to strip the marker — same "strip after use" precedent as the existing `?token=` handling in `webapp/src/lib/api.ts` the arbitration brief already cites.
  3. `POST /api/push-tap` appends `{ts, agentId}` to a new `JsonlLog<PushTapEntry>` (mirroring the friction-ledger's use of the same generic in `01-friction-ledger.md` — same infra, different file: `push-taps.jsonl`), instantiated per-manager alongside `transitionLog`/`frictionLog`.
- **New module** `src/adoption-counters.ts`: pure functions `casualSessionsByDay(receipts)`, `promptsByDay(transitions)`, `pushTapsByDay(entries)` (all take already-loaded arrays, no I/O — keeps them unit-testable without a scratch daemon) plus `computeAdoptionCounters(stateDir): Promise<AdoptionCounters>` that loads the three sources and calls them.
- **`glance doctor` section**: add an `attempt("adoption", ...)` entry to the probe array (`src/doctor.ts:291-346`), backed by a new `DoctorProbe.adoption(): Promise<AdoptionCounters>` on the interface (`src/doctor.ts:112-136`) implemented in `makeDoctorProbe` (`src/doctor-probe.ts:121`) — same shape as the existing `stateDir()` probe (`src/doctor.ts:299-311`) that already reads off the resolved state dir (`src/state-dir.ts:51-56`).
- **GET endpoint**: `GET /api/adoption` in `src/server.ts`, tenant-scoped (same reasoning as `01`'s `/api/friction` — the underlying data lives in one manager's `stateDir`), returns `computeAdoptionCounters(manager.stateDir)` as JSON. Viewer-tier read (counters are not sensitive, and the whole point is Lars can glance at them without ceremony).
- **Weekly ledger append**: `scripts/append-adoption-ledger.ts` (new, one-shot script following the `defect-ratchet.ts` script-under-`bun test`-PATH convention for how scripts/ are invoked in this repo) fetches `GET /api/adoption` and appends one formatted row to `plans/daily-driver/00-meta.md`'s `## Ledger` section. Author's call: the FETCH is scripted (a script is more likely to actually run every week than a copy-paste ritual), but invocation stays manual — no cron, no daemon-side automation — because a plan doc's Ledger is human-reviewed content and 03 (drain cadence) is the concern that decides *when* this script gets run, not this one.

## Cross-Repo Side Effects

None directly — omp-squad only. Note for whoever eventually builds cockpit consumers (glance-desktop): `GET /api/adoption` is a stable read-only surface they could subscribe to later, but no cockpit UI is built here (matches the "each consumer builds its own" discipline already used for the needs-you ladder charter).

## Verify

- Unit: `tests/adoption-counters.test.ts` — `casualSessionsByDay`/`promptsByDay`/`pushTapsByDay` against synthetic receipt/transition/tap arrays spanning day boundaries and UTC edge cases; `computeAdoptionCounters` against a scratch state dir with seeded `receipts/`, `transitions.jsonl`, and `push-taps.jsonl`.
- `glance doctor` (scratch-daemon skill): confirm the adoption section renders and reflects seeded data.
- Live: `agent-browser` load the webapp with `#/agent/<id>?push=1` in the URL, confirm exactly one `POST /api/push-tap` fires (check via `GET /api/adoption` before/after) and the marker is stripped from the visible URL; reload the same URL without the marker and confirm no second tap is recorded.
- `scripts/append-adoption-ledger.ts` run once against a scratch daemon, confirm it appends a well-formed row and does not corrupt the rest of `00-meta.md`.

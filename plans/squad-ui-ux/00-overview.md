# Overview — omp-squad UI/UX: see & interact better

Decomposition of the goal "make the omp-squad UI/UX better for the human to see and interact
if needed", driven by `plans/squad-ui-ux/BRIEF.md`. The brief's six abstracted concepts (A–F)
map to the six concerns below.

**Guiding principle (from BRIEF §5):** route attention, don't demand it. With N parallel agents
the bottleneck is the operator's attention, not the agents. The two biggest wins (attention queue,
push signals) are **client-only** — `pending[]`, `lastActivity`, and status transitions are
already on the wire (`AgentDTO` in `src/types.ts:139`; broadcast in `src/server.ts:53`).

**Repo mandate:** AGENTS.md ponytail ladder — borrow patterns, add **zero dependencies**. Web is
a single vanilla-JS SPA; TUI uses the already-present pi-tui. Notification API, terminal bell, and
OSC notify are native (rung 3). The command palette reuses the in-repo fuzzy matcher (rung 4).

---

## Scope table

| # | Concern | Concept | Complexity | TOUCHES |
|---|---|---|---|---|
| 01 | Web attention queue (supervise-by-exception inbox) | A | architectural | `src/web/index.html` |
| 02 | Web push signals (notifications + title/favicon badge) | B | architectural | `src/web/index.html` |
| 03 | Web command palette + keyboard nav | C | architectural | `src/web/index.html` |
| 04 | Web liveness & staleness cues | D | mechanical | `src/web/index.html` |
| 05 | Web in-app dialogs (replace native prompt/confirm) | E | mechanical | `src/web/index.html` |
| 06 | TUI parity: attention, push, liveness | A·B·D·F | architectural | `src/tui.ts`, `tests/tui.test.ts`* |

\* `tests/tui.test.ts` created/extended if not present; `buildBoard` is a pure renderer and is the
testable seam (README: "the pure board renderer" is covered).

---

## Dependency graph & shared-file analysis

**Critical shared file:** concerns 01–05 *all* edit the single file `src/web/index.html`. Per the
SAME-FILE rule these MUST NOT run as parallel agents — they would shred each other's hunks. There
are **no hard logical dependencies** between them; the only blocker is file contention.

| Concern | BLOCKED_BY | VERIFY_BLOCKER |
|---|---|---|
| 01 | — | — |
| 02 | 01 (shared file only) | `git log --oneline -1 src/web/index.html` shows 01 landed |
| 03 | 02 (shared file only) | same-file: 02 landed |
| 04 | 03 (shared file only) | same-file: 03 landed |
| 05 | 04 (shared file only) | same-file: 04 landed |
| 06 | — (different file) | — |

## Batch order

- **Batch 1 (parallel):** `06` (TUI, `src/tui.ts`) ‖ start of the **web track**.
- **Web track (single agent, sequential, priority order):** `01 → 02 → 03 → 04 → 05`.
  One agent owns `src/web/index.html` end-to-end; each step gets the prior step's diff as PRIOR
  CHANGES context. This is leaner than five agents fighting over one file (ponytail: shortest diff).
- **Total:** 2 tracks, ~5 sequential web steps + 1 parallel TUI step.

## Verification posture

UI logic is DOM-coupled; "one runnable check" lives where pure logic is extractable:
- TUI: `buildBoard` is pure → assert-based `tests/tui.test.ts` cases (waiting row, stall badge,
  spinner frame). `bun run check` for types.
- Web: pure helpers (stall heuristic, status-transition diff, fuzzy filter reuse) are verified by a
  manual smoke protocol — `omp-squad up --no-tui`, spawn 2–3 agents with `--approval always-ask`,
  drive one to a `needs-input` request, observe the queue/badge/notification fire. Each concern's
  Verify section states its exact protocol.

## Status

0/6 closed. Plan only — no concern executed.

## Plane tracking
- Project: omp-squad (`OMPSQ`)
- Module: [Squad UI/UX](https://app.plane.so/inkwell-finance/projects/1eb181ba-f324-4767-a6d5-98953d5df011/modules/6a33515d-e048-480a-9fe5-7d42d55f3445/)
- Issues:
  - [01-web-attention-queue](https://app.plane.so/inkwell-finance/browse/OMPSQ-3/) — OMPSQ-3 ✅ done
  - [02-web-push-signals](https://app.plane.so/inkwell-finance/browse/OMPSQ-4/) — OMPSQ-4 ✅ done
  - [03-web-command-palette](https://app.plane.so/inkwell-finance/browse/OMPSQ-6/) — OMPSQ-6 ✅ done
  - [04-web-liveness-staleness](https://app.plane.so/inkwell-finance/browse/OMPSQ-7/) — OMPSQ-7 (Backlog · high)
  - [05-web-dialogs](https://app.plane.so/inkwell-finance/browse/OMPSQ-2/) — OMPSQ-2 (Backlog · medium)
  - [06-tui-parity](https://app.plane.so/inkwell-finance/browse/OMPSQ-5/) — OMPSQ-5 (Todo · high)

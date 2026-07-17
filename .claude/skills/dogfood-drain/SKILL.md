---
name: dogfood-drain
description: Weekly dogfood drain for the daily-driver program — read the friction ledger (glance grr) and adoption counters (GET /api/adoption), draft a three-bucket triage for Lars's approval, append the week's counter snapshot and triage summary to plans/daily-driver/00-meta.md's Ledger, and flag repeat-pattern clusters. Use when the user says "run the drain", "weekly drain", "/dogfood-drain", "drain the friction ledger", or when a /loop 168h /dogfood-drain iteration fires. Never writes the adoption-gate verdict — that line is Lars's alone.
---

# dogfood-drain — the weekly friction→fixes ritual

Turns the friction ledger (B01, `glance grr`) and adoption counters (B02, `GET /api/adoption`)
into fixes and an honest ledger trail, once a week. Concern: `plans/daily-dogfood-engine/03-drain-cadence-and-criteria.md`.

## Cadence — how this gets fired (armed once, then hands-free)

So the weekly drain runs without Lars having to remember it, arm it once with the repo's loop
convention:

```
/loop 168h /dogfood-drain
```

`/loop` re-invokes this skill every 168h (one week); it is the arming surface because it is how
every other recurring routine in this repo is fired (`crypto-research`, `fleet-ide-loop`,
`make-it-work` are all `/loop <interval> /<skill>`). There is no separate cron/routine config
file to wire — the single `.claude/settings.json` Stop hook belongs to the convergence loop, not
to a general scheduler, so co-opting it would be wrong. If Lars wants the nudge to survive
session restarts (truly unattended, months-long), the durable equivalent is a scheduled **cloud
routine** via `/schedule` running `/dogfood-drain` weekly — same steps, same hitl contract, same
two fail-closed append scripts below.

Each firing is hitl by construction: it *drafts* the three-bucket triage for Lars to approve in
conversation and appends the week's evidence rows, but never merges a fix on its own and **never
writes the gate verdict** (see the hard boundary below). Automating the cadence automates the
evidence-gathering, not the judgment.

The counter snapshot (step 4) lands on **every** firing — that is the non-negotiable part of the
cadence: even a week with zero gripes still appends its B02 row, so the two-week gate always has
an unbroken weekly trail to read. A guessed or skipped week is exactly the false-green the gate
exists to catch.

*Daily counter tick — deferred, on purpose.* A lighter `/loop 24h` tick that appends just the
numbers was considered and left out: the B02 row already carries the rolling last-7d counts, so a
daily row adds no gate signal it doesn't already have, and seven counter rows a week would bury
the human-reviewed triage lines in the same `## Ledger`. If a between-drain trend is ever wanted,
route it to a *separate* file rather than clutter the gate ledger — revisit only if the weekly
granularity proves too coarse to make the call.

Invocation is never daemon-automated: the meta-plan's Ledger is human-reviewed content, and the
verdict on it is Lars's.

## The one hard boundary (MODE: hitl)

**This skill never writes a SUCCESS/KILL verdict. Anywhere. Ever.** The adoption-gate verdict
line in `plans/daily-driver/00-meta.md`'s Ledger is written only by Lars, only at the two-week
gate review, only in his own words, after re-reading the accumulated counter snapshots and
friction trail against the criteria quoted below.

- Drafting a recommendation for Lars to read *in conversation* ("counters look flat — here's the
  trail, my read is X") is fine and welcome.
- Writing that verdict — or any equivalent verdict language — *into the plan doc* is not. That is
  the entire reason concern 03 is MODE: hitl instead of an autonomous loop step.
- The append machinery enforces this mechanically: both scripts below route every Ledger write
  through `src/meta-ledger.ts`'s `insertLedgerRow`, which refuses rows containing verdict
  language (SUCCESS, KILL, verdict, adopted, no-go, shouted STOP) and exits 1 with the file
  untouched. Do not work around it by editing `00-meta.md` directly on Lars's behalf.
- Concern 03's STATUS does not move to `done` until Lars has made that sign-off at least once.

## The criteria (verbatim from plans/daily-driver/00-meta.md — carried, not reinterpreted)

> **Adoption gate.** After epics A–D ship: two weeks of real use, judged by the dogfood counters.
> Kill criterion: if sustained daily casual use hasn't emerged, STOP — re-diagnose with the
> friction ledger; epics E–G do not execute and charters H–I do not expand. (Gate sign-off is
> Lars's, MODE: hitl — `plans/daily-dogfood-engine/03-drain-cadence-and-criteria.md`.)

> The B02 counters (casual sessions/day, prompts/day, push taps/day) are appended to the ledger
> below weekly. Gate review after 2 weeks of A–D being live. This table is the plan's real
> success metric — epics shipping green while counters stay zero is the false-green pattern
> applied to product, and the kill criterion exists to catch exactly that.

And from the arbitration brief (§5, binding): "adopted = sustained daily casual use for 2 weeks;
if not after wave 1, STOP and re-diagnose; contingent epics do not start."

## Weekly procedure

### 1. Pull everything since the last drain

- Find the cutoff: the most recent `weekly drain (B03)` row in `00-meta.md`'s `## Ledger` (its
  date). First drain ever: no cutoff, take everything.
- Friction entries: `glance grr --list --json` reads the recent ring via `GET /api/friction`.
  For anything older than the ring holds, read the durable file directly:
  `<stateDir>/friction.jsonl` (plus its `.1` rotation sibling), stateDir per `src/state-dir.ts`
  resolution (env override → `~/.glance` → legacy `~/.omp/squad`). Keep entries with
  `ts` after the cutoff.
- Drop entries whose ids are already listed in `plans/daily-dogfood-engine/accepted-friction.md`
  — they were accepted in a previous drain and must not be re-triaged every week.
- **Split each entry into two buckets by provenance** (`source`, daily-driver-w15 concern 02):
  - `source:"auto"` — **what the daemon felt.** A friction event the daemon detected and recorded on
    its own; the machine-readable subtype rides in `context` as `auto:<subtype>` — today
    `auto:boundary-sync-held` (an operator turn that didn't land in their checkout),
    `auto:here-session-error` (an ACP turn that errored/timed out, or a gate that flaked, on a casual
    `here` session), `auto:here-session-lost` (a casual session a restart killed). These are already
    deduped at capture (one line per recurring condition per ~5-min window), so a cluster of them is a
    real recurrence, not a single event logged twice.
  - `source:"human"` (or the field absent — every row written before this field existed, and every
    typed gripe, reads as "human") — **what Lars felt.** The gripes typed via `glance grr` / TUI
    Ctrl-G / the composer / `here` /grr.
  Present them as two separate lists in the draft (human gripes first — they're the ground truth the
  experiment is measuring; auto second — corroborating machine signal). A single blended list hides
  which friction the operator actually noticed versus which the daemon inferred, and the gate cares
  about the former.
- Counters: `glance doctor` (the "Is glance getting daily use?" section) or
  `GET /api/adoption`. Zeros are a finding for the gate, not a machine fault; a *failed read* is
  unknown, never a fabricated zero — if the daemon is down, say so, don't invent numbers.

### 2. Triage — drafted for Lars's approval, never auto-applied

Sort each new entry into exactly one bucket and present the full draft to Lars before acting:

- **fix now** — small enough to just do. Cite the file:line you'd touch. After approval, fix it
  in the normal worktree/PR discipline (draft PRs, Lars merges — 00-meta.md merge policy).
- **file as a concern** — append an `NN-concern.md` to whichever `daily-*` sub-plan it belongs to
  (onramp / dogfood-engine / attention-w0 / composer / turn-substrate / preview-tool /
  overhead), or a new plan directory if it's out of scope of all of them.
- **accepted friction** — noted, not actioned. After approval, append one line per entry to
  `plans/daily-dogfood-engine/accepted-friction.md` (`- <id> — <YYYY-MM-DD> — <gripe, abridged>
  — <why accepted>`) so it isn't silently re-triaged next week.

Every entry lands in exactly one bucket; "skipped without a bucket" is not an outcome — that's
how gripes evaporate, which is the failure mode this whole epic exists to prevent.

### 3. Flag repeat-pattern clusters, not just raw entries

If the week's entries contain ≥3 gripes sharing a theme (e.g. three attention/push gripes),
call the cluster out explicitly in the draft — a flat list buries exactly this signal. The auto
bucket's `auto:<subtype>` tags cluster mechanically: three `auto:boundary-sync-held` lines across the
week means the checkout keeps refusing to auto-apply the operator's turns (a real recurring drag on
`glance here`), and a run of `auto:here-session-error` / `auto:here-session-lost` is the daemon-side
mirror of a session that keeps breaking under the operator. Cross-reference an auto cluster against
the human bucket — the strongest signal is the daemon and the operator flagging the same theme. An
attention/push cluster is specifically the expansion trigger for the needs-you-ladder charter
(`plans/daily-driver/01-charter-needs-you-ladder.md`): name it as such so Lars can decide
whether the charter unblocks. Clusters go in the `--clusters` note in step 5 (one line, no
verdict words — the machinery will refuse them).

### 4. Append the counter snapshot

```
bun scripts/append-adoption-ledger.ts [--port <N>] [--dry-run]
```

Fetches `GET /api/adoption` from the running daemon and appends one formatted row to
`00-meta.md`'s `## Ledger`. Fail-closed: unreachable daemon, wrong response shape, or missing
`## Ledger` section ⇒ exit 1, file untouched. Never appends a fabricated all-zero row.

### 5. Append the triage summary (counts only — a status line, not a verdict)

```
bun scripts/append-drain-summary.ts --fixed <N> --filed <N> --accepted <N> \
  [--clusters "<repeat-pattern note>"] [--dry-run]
```

All three counts are required (0 is fine, but say so explicitly — a guessed zero misstates the
week). Same fail-closed Ledger insertion; verdict language in `--clusters` is refused.

### 6. Post-run check

`git diff plans/daily-driver/00-meta.md` must show exactly the two appended lines inside
`## Ledger` and nothing else. Grep the diff for verdict tokens (`SUCCESS`, `KILL`, `verdict`) to
confirm the machinery held — verify, don't trust. Then commit the Ledger appends together with
any approved accepted-friction lines and filed concern docs.

## The two-week gate review

The review itself is a short synchronous conversation (Lars + whoever's driving), not a document
Lars reads alone. This skill's job is to make sure the numbers are ready and legible when that
conversation happens — accumulated weekly counter rows, the triage trail, and any clusters — not
to replace it. In that conversation you may summarize and recommend; the verdict line that ends
up in `00-meta.md` is typed by Lars, in his own words. After his first sign-off,
`plans/daily-dogfood-engine/03-drain-cadence-and-criteria.md` STATUS may move to `done`.

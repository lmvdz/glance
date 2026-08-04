---
name: dogfood-drain
description: Weekly dogfood drain for the daily-driver program — triage the friction ledger (glance grr) and adoption counters (GET /api/adoption) into a three-bucket draft for Lars's approval, then append the week's Ledger rows via the fail-closed scripts. Use when the user says "run the drain", "weekly drain", "/dogfood-drain", "drain the friction ledger", or when a /loop 168h /dogfood-drain iteration fires. Never writes the adoption-gate verdict — that line is Lars's alone (MODE: hitl).
---

# dogfood-drain — the weekly friction→fixes ritual

Turns the friction ledger (B01, `glance grr`) and adoption counters (B02, `GET /api/adoption`)
into fixes and an honest ledger trail, once a week. Concern: `plans/daily-dogfood-engine/03-drain-cadence-and-criteria.md`.
Invocation is manual — or self-reminded via `/loop 168h /dogfood-drain` — but never
daemon-automated: the meta-plan's Ledger is human-reviewed content.

## The one hard boundary (MODE: hitl)

The adoption-gate verdict line in `plans/daily-driver/00-meta.md`'s Ledger is written only by
Lars, only at the two-week gate review — a short synchronous conversation in which you may
summarize and recommend, but the verdict is typed by Lars in his own words. Drafting a
recommendation *in conversation* ("counters look flat — here's the trail, my read is X") is fine
and welcome; writing verdict language *into the plan doc* is not. The append machinery enforces
this mechanically: both scripts below route every Ledger write through `src/meta-ledger.ts`'s
`insertLedgerRow`, which refuses rows containing verdict language (SUCCESS, KILL, verdict,
adopted, no-go, shouted STOP) and exits 1 with the file untouched. Do not work around it by
editing `00-meta.md` directly on Lars's behalf. Concern 03's STATUS does not move to `done`
until Lars has made that sign-off at least once.

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
- **Split by `source` before triaging** (plans/daily-driver-w15 concern 02): every entry is
  `source:"human"` (typed by whoever's dogfooding — missing `source` on an old row reads the
  same way) or `source:"auto"` (the daemon's own hook sites — `auto:boundary-sync-held`,
  `auto:acp-timeout`, `auto:session-loss`). Present the two groups separately: auto rows
  corroborate or contradict the human rows (a human "sync keeps getting stuck" gripe backed by
  three auto `boundary-sync-held` rows the same week is a stronger signal than either alone),
  but an auto row is never itself counted as a human adoption/friction signal — it's the daemon
  reporting on itself, not the operator reporting on the daemon.
- Drop entries whose ids are already listed in `plans/daily-dogfood-engine/accepted-friction.md`
  — accepted in a previous drain, never re-triaged.
- Counters: `glance doctor` (the "Is glance getting daily use?" section) or
  `GET /api/adoption`. Zeros are a finding for the gate, not a machine fault; a *failed read* is
  unknown, never a fabricated zero — if the daemon is down, say so, don't invent numbers.

### 2. Triage — drafted for Lars's approval, never auto-applied

Sort each new entry into exactly one bucket and present the full draft to Lars before acting:

- **fix now** — small enough to just do. Cite the file:line you'd touch. After approval, fix it
  in the normal worktree/PR discipline (draft PRs, Lars merges — 00-meta.md merge policy).
- **file as a concern** — append an `NN-concern.md` to whichever `daily-*` sub-plan it belongs to,
  or a new plan directory if it's out of scope of all of them.
- **accepted friction** — noted, not actioned. After approval, append one line per entry to
  `plans/daily-dogfood-engine/accepted-friction.md` (`- <id> — <YYYY-MM-DD> — <gripe, abridged>
  — <why accepted>`).

Every entry lands in exactly one bucket; "skipped without a bucket" is not an outcome — that's
how gripes evaporate, which is the failure mode this whole epic exists to prevent.

### 3. Flag repeat-pattern clusters, not just raw entries

If the week's entries contain ≥3 gripes sharing a theme, call the cluster out explicitly in the
draft — a flat list buries exactly this signal. An attention/push cluster is specifically the
expansion trigger for the needs-you-ladder charter
(`plans/daily-driver/01-charter-needs-you-ladder.md`): name it as such so Lars can decide
whether the charter unblocks. Clusters go in the `--clusters` note in step 5.

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
week).

### 6. Post-run check

`git diff plans/daily-driver/00-meta.md` must show exactly the two appended lines inside
`## Ledger` and nothing else — verify, don't trust. Then commit the Ledger appends together with
any approved accepted-friction lines and filed concern docs.

## Scheduled operation

The drain does not run itself — arming it is a one-time human step. The daemon has no wall-clock
cron by design, and Claude Code's `CronCreate` was evaluated and rejected (session-scoped,
self-expiring — full recon in `00-meta.md`'s Ledger, 2026-07-17 row). The durable mechanism is
one OS crontab line, armed once by hand:

```
crontab -e
# add (point at the real checkout; keep off the :00/:05/:30 marks):
17 9 * * 5 cd /home/lars/sui/omp-squad && /home/lars/.local/bin/claude -p "/dogfood-drain" --allowedTools "Bash,Read,Edit,Write" >> ~/.glance/dogfood-drain.log 2>&1

# disarm:
crontab -l | grep -v dogfood-drain | crontab -
```

If the daemon is down at fire time, both scripts exit 1 and leave `00-meta.md` untouched — a
quiet week in `~/.glance/dogfood-drain.log` means the routine didn't fire or the daemon was
down, never that adoption was a fabricated zero. Check the log, don't infer from silence.
`/loop 168h /dogfood-drain` is the lighter fallback and dies with its session. As of 2026-08-04
the crontab line is NOT installed on this machine.

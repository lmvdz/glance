# Handoff — 2026-07-29

State of the long-horizon-agent-memory lane and the fleet-honesty work, written so another
agent can pick up without re-deriving anything. Delete this file once its open items are closed.

## The standing goal

The operator set it as: *"the goal is not complete until the software is being used by me, it is
your job to manage and orchestrate your team of software engineers and bring to my attention a
website I can go to and use, I will only say one of two things: not done yet, or its done."*

That goal was paused mid-session (a `/goal pause` hook). It is not withdrawn. The website is
**http://127.0.0.1:7878** — the operator's own daemon, DB mode with SSO.

## What landed this session

Two commits on local `main`, **neither pushed**. Local `main` is ~12 commits ahead of
`origin/main`; most of that predates this session (voice work).

**`4c38e04a` — the workbench nav strip made findable.** It already rendered, but at 28px with 11px
`#7A7A82` on the page's own `#0A0A0B`, and the operator reported it as absent twice. Now a real tab
bar: `#17171A` ground, `#26262B` bottom rule, uppercase with tracking, current surface an ember pill
with an underline. Verified in a real browser (9 items, measured), not by grepping a bundle — the
proxy check is what produced two false "verified" claims earlier in the session.

**`5f42ef18` — idle units no longer report as working.** The daemon showed seven units "working"
with no live process behind any of them, two days after they died. Three defects, all inventing work:
`roomStateOf`'s `default: "in-flight"` swallowing `idle`; `nodeFromAgent` hard-coding `state:
"working"` for legacy-migrated agents that carry no persisted status at all; and orphaned nodes being
unmovable once cold adoption mints a fresh agent id. Full reasoning is in the commit message.

## Gate status — read this before claiming green

- `bun run check` — clean.
- `webapp && bun test` — 2014 pass, 0 fail.
- **Root `bun test` has NOT had one clean full run since the blind-review fixes landed.** One run was
  OOM-killed (exit 137); the retry was interrupted. **Run it and diff against the baseline below
  before building anything on top of this.**

The root suite has **6 pre-existing failures in this checkout**, every one proved pre-existing by
re-running with all changes stashed:

| Test | Why it fails |
|---|---|
| `ratchet: json-parse-as-cast` / `error-message-idiom` / `dead exports` | fail at base too, in a clean worktree |
| `CSP connect-src widens to the voice provider origin…` | fails whenever the repo `.env` is present |
| `mutation proof (acp-agent-driver.ts) … never sees DATABASE_URL` | same — `.env` present |
| `bootstrap-admin bearer token: graph/observability routes…` | fails in THIS working tree regardless of the diff (passes in a clean worktree) |

Method that established this, worth reusing: build a worktree at the base SHA, **copy `.env` into
it** (its absence flips file/DB mode and silently changes which tests pass), and diff the failure
sets. Two of the six were initially misattributed to my own diff because the base worktree had no
`.env`.

## Live environment gotchas, all learned the hard way

- **The daemon dies on its own.** It was down twice this session with no supervisor process left.
  Restart with `setsid bash scripts/squad-supervisor.sh` from the repo root (it sources
  `~/.glance/up.sh`). Check with `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:7878/`.
- **Never `pkill -f`** to clean up — it has matched the session's own shell (exit 144). Kill by the
  PID recorded at boot.
- **A scratch daemon booted from this checkout goes DB mode** and shows a login page, because the
  checkout `.env` sets `DATABASE_URL` and pi-tui re-loads it with override. File mode only holds if
  the daemon's cwd has no `.env` — boot from an empty scratch cwd, point at the repo by absolute
  path, and probe `GET /api/auth/mode` expecting `{"mode":"file"}`.
- **File mode needs a token in the URL.** The daemon logs a `?token=…` sign-in link at boot; without
  it every surface renders "Not signed in", which reads exactly like a missing feature.
- **`grep` silently truncates on NUL-containing files** (`src/server.ts` is one). It produced two
  false conclusions this session. Use `ugrep` or a Read on those files.
- **Verify UI by driving a browser**, not by grepping the bundle. `agent-browser` with
  `AGENT_BROWSER_SOCKET_DIR` set to a short path; read computed styles off the rendered element.

## Open items

**Highest value, and the thing most likely to make the operator say "not done yet": the decision
ledger is empty.** `OMP_SQUAD_DECISION_CAPTURE=1` is confirmed live in the running process (read from
`/proc/<pid>/environ`, not from the launcher script), but capture only became possible on a recent
restart and the three features in the DB carry zero decisions between them. It fills as working units
record decisions. **Do not seed it with fabricated entries** to make the panel look populated.

Also open:

- Root suite needs one clean full run (above).
- Neither commit is pushed. `origin` is `git@github.com-personal:lmvdz/glance.git`.
- Memory lane blocked items, unchanged: C5's counter needs usage data; the live-runner family needs
  harness credentials in an isolated HOME (the operator's call); replay ablations are blocked because
  the corpus predates supersession.
- `plans/plan-distill/` concerns 02 (staleness honesty) and 03 (room surfacing, love-gated).
- `plans/agent-impact-metrics/` is untracked in the working tree — not mine, left alone.

## The memory lane itself

Canonical docs live in `plans/research-long-horizon-agent-memory/`: `POSITION.md` (the position
paper), `VALIDATION.md` (claims C1–C9 with pre-registered kill criteria), `HARNESS-SPEC.md`
(per-class detectors, scenario corpus G01–G12), `EXPERIMENTS.md`, `REDTEAM-2026-07-26.md`,
`RELATED-WORK.md`. The shareable visual twin is the self-contained
`artifact/agent-memory-ledger.html` (59 KB, no external deps, opens straight from disk).

## House practice that paid for itself

Every pre-merge blind adversarial pass (`grok`, zero framing) that found something found something
**real** — now six reviews running, zero false ship-blockers. On this session's two units it caught a
2.72:1 contrast failure on the only non-colour "you are here" cue, and six issues on the fleet-honesty
diff including two false claims in my own comments. Run it before landing, and adjudicate findings
against the code rather than accepting them — a reviewer's finding is a hypothesis, not a verdict.

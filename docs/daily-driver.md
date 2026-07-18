# The daily driver

glance isn't only a control plane for an autonomous fleet — it's also the thing you pick up
mid-thought. `glance here` in a terminal gives you the same brain as typing `claude`, plus what a
bare terminal can't: a phone buzz when a long turn finishes, edits that land in your real checkout
without racing it, and one ledger for every gripe. This page is the task-oriented manual for those
everyday, single-operator features. It's terminal-first; the webapp rides the same daemon, so
anything you start in one shows up in the other.

Everything here talks to a running daemon. Start one once with `glance up` (or `glance up --no-tui`
on a server); a `glance here` with no daemon running offers to start one for you.

## Start a casual session — `glance here`

```bash
cd ~/code/whatever        # any git repository
glance here
```

Opens a chat thread attached to the current directory, in this terminal, running on **your own
claude login and config** (the `claude-code` harness — never a less-configured brain than the
`claude` you'd have typed). Start typing immediately: session creation runs in the background, and
anything you type before it's ready is queued and flushed the moment it attaches, so the setup cost
hides behind your own typing.

```bash
glance here "why is this test failing?"   # a positional prompt is the opening turn
glance here --web                          # also open the session in your browser once it's up
glance here --model <id>                    # override the model (harness default otherwise)
glance here --harness <name>                # ride a different harness (default: claude-code)
```

The directory is registered as a project **only for the session's lifetime** and released when you
leave. To keep it around, add it in the webapp project switcher (**+ Add project…**) — that makes
the registration durable so it survives `/exit`.

A non-git directory is refused with a pointer at `git init`, never silently run in place: casual
sessions always run in a worktree cut from your repo, so a turn's edits can't collide with what
you're doing in the real tree.

**While chatting:**

| Command | Effect |
|---|---|
| `/stop` | interrupt the current turn (or press Ctrl-C once mid-reply) |
| `/grr <text>` | log a gripe to the friction ledger without leaving the chat |
| `/exit` | leave — the session stays live in the webapp (or Ctrl-C when idle) |
| `/help` | the in-chat command list |

Ctrl-C is a per-turn interrupt first and an exit second: the first press stops the turn in flight,
a second press leaves.

**If the daemon restarts under you:** the REPL notices the session didn't survive (the `claude-code`
harness is ACP — there's no detached host to cold-restore, and glance won't fake a resume it can't
do). It prints an honest ⟲ restart marker naming why, starts a *fresh* session through the same
path, and folds your prior conversation in as context that rides your **next** prompt — never
auto-sent. It's a new session labeled as one, not a seamless resume dressed up as continuity.

## Capture friction — `glance grr`

The five-second gripe log. Fire-and-forget by design: one line in, `logged.`, back to work —
anything slower would never get used mid-annoyance, and then the whole dogfood loop loses its raw
material.

```bash
glance grr "boundary sync held again and I had to go re-apply it by hand"
```

Read it back:

```bash
glance grr --list           # human-readable, newest first
glance grr --list --json    # raw entries — the shape the weekly drain reads
```

`--list` accepts `--repo <path>` to scope to one repo and `--limit <n>` to cap the count. A gripe
logged from a subdirectory (say `<repo>/webapp`) is still attributed to the repo root, so repo-scoped
reads find it.

Other capture surfaces, all writing to the same ledger: `/grr <text>` from inside a `glance here`
chat, and the grr popover in the webapp chat composer.

## The daemon files its own friction

New in wave 1.5: the ledger no longer sees only typed gripes. The daemon auto-captures real friction
at the moment it happens, writing it to the same ledger with `source:"auto"`:

| What happened | `context` on the row |
|---|---|
| a finished turn's patch was held because your checkout changed mid-turn | `auto:boundary-sync-held` |
| an ACP prompt timed out (a turn ran past the adapter's silence window) | `auto:acp-timeout` |
| a session was lost across a daemon restart | `auto:session-loss` |
| a held patch diverged when it was applied or replayed | `auto:boundary-sync-held` |

These rows are prefixed `auto ` in `glance grr --list` so you never mistake one for something you
typed; `--list --json` carries the raw `source` field. Auto-capture is low-noise by construction —
it's hooked only at the true origin of each event, never on normal operation, and it does not
re-raise anything on daemon boot. A client can't forge an auto row either: `POST /api/friction`
has no `source` field at all, so `auto` is stamped only by the daemon's own internal hooks.

The weekly drain buckets the two kinds separately (see below): an auto row can corroborate or
contradict a human gripe — three `auto:boundary-sync-held` rows behind a human "sync keeps getting
stuck" is a stronger signal than either alone — but an auto row is never itself counted as a human
adoption signal. It's the daemon reporting on itself, not you reporting on the daemon.

## Recover a held boundary sync

Each finished casual turn's patch applies to your real checkout **only if the real tree is unchanged
since the turn started**; otherwise the patch is *held* rather than clobbering your work. A held sync
surfaces as an attention row (`source:"boundary-sync"`, `sync:"held"`) on the agent, and in the
webapp's Intervene/attention surface with one-tap apply/discard.

The routes behind that surface, for a terminal recovery. Set up the base URL and token once (the
daemon prints a token'd URL on boot; the bearer token lives in your state dir):

```bash
GLANCE=http://127.0.0.1:7878
AUTH="Authorization: Bearer $(cat ~/.glance/access-token)"
```

Discover any held patches — by agent, repo, and patch file (`[]` when there are none):

```bash
curl -s "$GLANCE/api/boundary-sync/orphaned" -H "$AUTH"
```

Once your tree is back at the turn's fork point, apply or discard the held patch:

```bash
curl -s -XPOST "$GLANCE/api/agents/<agentId>/apply-held-sync"   -H "$AUTH"
curl -s -XPOST "$GLANCE/api/agents/<agentId>/discard-held-sync" -H "$AUTH"
```

`apply` re-checks the patch against the current tree before touching anything —
`{"ok":true,"applied":1,"remaining":0}` when it lands cleanly, or
`{"ok":false,"applied":0,"remaining":1,"reason":"...git apply --check failed..."}` when your own edit
still conflicts (revert it and retry). `discard` drops the held patch
(`{"ok":true,"discarded":1,"remaining":0}`).

Held syncs survive a daemon restart: a re-attached `glance here` session re-keys the hold onto its
successor, and the same routes recover it — the changes are never silently lost.

## Get a phone buzz when a long turn finishes

A casual session pushes a completion notification when its turn finishes — but only for turns worth
interrupting you over. Enable **Background notifications** in the webapp account menu (it installs as
a PWA and asks for the browser's notification permission), and a finished turn that ran longer than
the duration gate pushes to your phone.

The gate is `OMP_SQUAD_PUSH_MIN_TURN_MS` (a raw millisecond count, default `20000`): a chat's
five-second reply, watched live, isn't worth a buzz; a turn that ran for minutes while you walked
away is. Tapping the notification opens the session deep-linked with a `?push=1` marker, which
beacons `POST /api/push-tap` once and strips the marker — that tap is one of the adoption counters
below.

**Honest caveat:** on-device delivery can't be proven from a headless environment (no live receive
channel), so a green server-side push is not a guarantee the buzz reached the handset. Everything up
to the FCM handoff is verifiable; the last hop is the phone's.

## Read your adoption numbers

The dogfood loop's success metric is whether glance actually gets picked up daily — casual
sessions, prompts, and push taps per day. Those counters are **derived at read time** from data the
daemon already writes durably (`receipts/*.jsonl`, `transitions.jsonl`, `push-taps.jsonl`); there is
no counter state to reset, corrupt, or lose.

Quickest read — the doctor rolls it up:

```bash
glance doctor
# → Is glance getting daily use?   today N casual session(s) · N prompt(s) · N push tap(s);
#                                  last 7d N · N · N
```

The raw JSON, three `{ "YYYY-MM-DD": count }` maps (days with zero activity are simply absent, never
a fabricated zero):

```bash
curl -s "$GLANCE/api/adoption" -H "$AUTH"
# → {"casualSessionsByDay":{...},"promptsByDay":{...},"pushTapsByDay":{...}}
```

In the webapp, the **Daily** tab in the sidebar puts both signals on one panel: the three counters
as tiles (today, a trailing-7-day sum, and a sparkline) over the friction ledger itself (newest
first, auto rows visually distinct from human ones). It self-refreshes on a poll; a dead endpoint
shows an honest alert rather than blanking, and an empty ledger says "nothing filed" rather than
faking zeros.

## The weekly drain

Once a week the friction ledger and the adoption counters get turned into fixes and an honest paper
trail: the `/dogfood-drain` skill reads both, drafts a three-bucket triage (**fix now** / **file as
a concern** / **accepted friction**) for your approval, and appends the week's counter snapshot plus
a triage summary to `plans/daily-driver/00-meta.md`'s Ledger. Human and auto friction are bucketed
separately, and clusters of three or more gripes sharing a theme are flagged explicitly.

One line the drain will never write: the adoption-gate **verdict**. The append machinery routes every
Ledger write through a fail-closed check (`src/meta-ledger.ts`) that mechanically refuses rows
containing verdict language (SUCCESS, KILL, adopted, no-go, …) and exits without touching the file.
The SUCCESS/KILL call at the two-week gate review is Lars's alone, in his own words.

**Scheduling it.** The daemon has no wall-clock cron by design (its Ledger is human-reviewed
content, not an automation target), so the weekly cadence is armed once by hand as an OS-level
crontab line — not by glance, and not installed for you. The exact one-liner (and how to pause or
disarm it) lives in the skill: `.claude/skills/dogfood-drain/SKILL.md`, under **Scheduled
operation**. It runs `claude -p "/dogfood-drain"` headless against the real checkout; if the daemon
is down at fire time, the append scripts exit without writing rather than logging a fabricated zero.

For the daemon's other background loops (orchestrator, scout, observer, auto-dispatch) and the live
**Automation** panel that shows them working, see [`self-drive.md`](self-drive.md).

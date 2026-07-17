# The daily driver — operator guide

This is the feature set built so glance's own builder uses it as a daily driver instead of
`claude` in a bare terminal. It's also a running experiment: everything here exists to prove or
disprove that a control plane earns its keep in day-to-day use, and the sections below are
written to be honest about what's proven, what's a known gap, and what recovery looks like when
something doesn't apply cleanly. If a claim here and the CLI disagree, trust the CLI — file a
gripe (`glance grr` — see below) and treat this doc as stale until it's fixed.

Design and resolution detail lives in `plans/daily-onramp/` (the wave-1 on-ramp, PR #194) and
`plans/daily-dogfood-engine/` (the friction/adoption engine); the meta-plan and adoption-gate
ledger are in `plans/daily-driver/00-meta.md`.

## `glance here` — a chat thread on the current directory

```bash
cd ~/code/myproject
glance here                          # opens a REPL attached to this directory
glance here "why is this test failing" --web
```

This is the on-ramp: `cd` somewhere, type `glance here`, start talking — no `glance add`, no
task string required, no picking a harness. It's a thin HTTP client over the daemon's existing
console lane (`POST /api/console`, `POST /api/command`, and a delta poll of
`GET /api/agents/:id/transcript`), so it needs a daemon running — it will offer to start one in
the background if none answers on the configured port.

**It rides your own claude-code login, not the daemon's default harness.** A `here` session
always creates with `harness: "claude-code"` (override with `--harness`), which means it uses
*your* logged-in claude-code config, not `omp` or whatever `GLANCE_HARNESS` defaults the fleet
to. The point is that this should never be a worse brain than typing `claude` directly.

**Timing.** Session creation costs roughly **~2.6s on a warm daemon, ~4.9s for the first console
of a fresh daemon**, on top of an irreducible ~2.4s model first-token floor that no amount of
engineering removes (same brain as typing `claude`). To hide that behind your own typing,
`glance here` fires the session create in the background the instant it starts and queues
anything you type before it's ready — type immediately, it sends the moment the session is up.

**It refuses to run outside a git repository.** glance runs casual sessions in an isolated
worktree cut from your repo (see [boundary sync](#boundary-sync---edits-in-your-real-checkout)
below for why that's safe), so a bare directory has nothing to cut a worktree from:

```
✗ /home/you/scratch isn't inside a git repository.
  glance runs casual sessions in a worktree cut from your repo — no repo, no worktree.
  Fix: git init here, or cd into a repository.
```

Run `git init` and try again.

**Flags:**

| Flag | Effect |
|---|---|
| `--web` | also open this session in your browser once it's up (deep-links straight to the agent) |
| `--model <id>` | model to run on (harness default otherwise) |
| `--harness <name>` | harness to ride (default `claude-code` — your own login/config) |
| `--port <n>` | daemon port to reach (default 7878) |
| `-h`, `--help` | print usage and exit |

**In the REPL:**

| Command | Effect |
|---|---|
| `/stop` | interrupt the current turn (or Ctrl-C once, mid-reply) |
| `/grr <text>` | log a gripe to the friction ledger without leaving the chat |
| `/exit` (or `/quit`, or Ctrl-C when idle) | leave — the session **stays live** in the webapp |
| `/help` | this list, printed in-chat |

A first Ctrl-C interrupts the current turn; a second Ctrl-C (or one while idle) exits.

**The directory you launched from is registered as a project only for this session** —
"ephemeral" in the code. It auto-unregisters when you `/exit`, so casual one-off chats don't
clutter the project switcher. Two ways to make it stick:

- **Add it in the webapp project switcher** (`+ Add project…`) — makes the registration durable
  independent of any one session.
- **Promote the chat itself** (see [promote / adopt](#promote--adopt) below) — turns *this*
  thread into a gated work unit and durably registers its repo as a side effect, in the same
  server call. No new agent id, no lost history — the same thread just gains unit chrome.

## Boundary sync — edits in your real checkout

A `here` session's agent still runs in an isolated git worktree (that invariant, OMPSQ-40, is
never relaxed for casual sessions) — but you didn't `cd` into a worktree, you `cd`ed into your
real checkout, and you expect to see the edits there. Boundary sync is the one-directional bridge:
**each finished turn's patch applies to your real checkout if and only if your real tree
provably has not moved since the turn started.** If it moved — you edited a file in your editor
mid-turn, ran a command that touched the tree, anything — the patch is **held**, not silently
discarded and not force-applied over your changes.

You'll never see this on the happy path: edit nothing else while a turn runs, and the change just
shows up in your files when the turn finishes. The precondition check is read-only (fingerprints
your tree with `git diff`/`git status`-equivalent reads, never a `git add` or stash), and the only
write it ever makes to your real directory is the single `git apply` for a turn whose precondition
held.

**When it's held**, an attention item appears in the roster (webapp: a row under the agent, source
`boundary-sync`) with two actions:

- **Apply** — re-checks the precondition fresh (your tree may have moved again since the item was
  raised) and applies if it still holds, or reports it's still divergent.
- **Discard** — drops the held patch. Use this when the patch will never cleanly apply again (e.g.
  you made the same edit yourself) — a held backlog blocks later turns' auto-apply, so a stuck
  first patch would otherwise wedge every turn behind it.

A held backlog is ordered: turn 2's patch can depend on turn 1's hunks, so nothing later
auto-applies until everything earlier is resolved.

**The honest residual (read this before you trust a "clean" apply blindly).** There are three race
windows between "your tree is confirmed unchanged" and "the write actually happens"; two are
closed by design (re-checking right before the write), and the third is a window that cannot be
closed from outside the OS — an editor's file write and `git apply`'s own read-modify-write on the
same file are not the kind of thing this process can lock against each other. That window is now
**detected, not silent**: immediately before the write, every path the patch touches is snapshotted;
after `git apply` succeeds, the module replays the patch against that same pre-write snapshot in a
scratch directory and compares the result to what's actually on disk. If they don't match, something
else wrote into one of those exact paths inside the apply itself.

When that happens you get a **divergence** row, not a held row — the write already happened, so
there is nothing to Apply or Discard. The row offers a single **Acknowledge** action (dismisses the
notice; never Apply/Discard — an earlier webapp bug briefly conflated the two and let Discard drop
an unrelated held backlog on the same session, fixed before this reached anyone). Its copy tells you
exactly what to do:

> A concurrent edit to `<paths>` in `<realDir>` may have interleaved with this turn's write.
> Nothing was rolled back automatically. The pre-write copy is retained at `<captureDir>` —
> compare it against your current file(s) by hand before deciding whether to restore from it.

The pre-write capture at that named directory is retained specifically so a divergence is
hand-recoverable — it is never auto-restored, because your own concurrent edit might be the version
that should win. In measured practice this window is tens of milliseconds around a single `git
apply` spawn; it has never fired in a clean live run. If you see one, it means you (or something)
wrote into a file glance was applying at that literal instant.

## Friction capture — `glance grr` and the dogfood loop

**Why this exists.** The whole daily-driver program is an experiment: does having glance as a
daily driver actually reduce friction versus a bare terminal? The only way to answer that
honestly is to capture friction as it happens, not reconstruct it from memory a week later. `grr`
is the one-key escape valve — the moment something annoys you, say so, without breaking your flow
to file an issue.

**Log a gripe from anywhere:**

```bash
glance grr "the roster took 3 clicks to find the agent I wanted"
glance grr "clunky" --context "trying to steer a workflow node" --repo ~/code/myproject
glance grr --list                    # recent gripes, newest first
glance grr --list --json             # machine-readable
glance grr --list --repo <path> --limit 20
```

Every capture surface funnels into the same ledger (`<stateDir>/friction.jsonl`) through one
write path:

| Surface | How |
|---|---|
| CLI | `glance grr "<gripe>"` |
| TUI | Ctrl-G (toggles a capture prompt in either the list or agent view), or the `/grr` slash command |
| Webapp | the composer's gripe popover |
| `glance here` | `/grr <text>`, in-chat |

**Auto-friction capture.** As of wave 1.5, the ledger isn't only what you type. The daemon now
records real friction it detects on its own — `source: "auto"` rows, alongside your `source:
"human"` (or unmarked, which reads as human — every pre-existing row and every typed gripe stays
byte-identical) gripes. Three hooks fire it today, each deduped per (subtype, scope) within a
5-minute window so a recurring condition logs once, not once per tick:

- `auto:boundary-sync-held` — a turn's patch got held instead of landing in your checkout.
- `auto:here-session-error` — a `here`-class ACP turn errored or timed out.
- `auto:here-session-lost` — a `here` session didn't survive a daemon restart.

Ordinary fleet units and clean turns never generate auto-friction — only real friction on casual
sessions does. The point is that the weekly drain sees "what the daemon felt" alongside "what
Lars felt," and a cluster of the same `auto:<subtype>` across a week is a real recurring drag,
not noise.

**The weekly drain.** `.claude/skills/dogfood-drain` turns the week's friction (both buckets) and
adoption counters into a triage draft, once a week: sort each new gripe into *fix now*, *file as
a concern*, or *accepted* (noted, not actioned); flag any theme with ≥3 entries; append the
week's counter snapshot to `plans/daily-driver/00-meta.md`'s Ledger unconditionally (even a
zero-gripe week appends its row, so the two-week gate always has an unbroken trail); and append a
triage summary line. It never merges a fix or writes a verdict on its own — every triage bucket is
drafted for approval in conversation first.

**Arming it.** The drain doesn't fire itself unless you tell it to. Arm the weekly cadence once
with the repo's standard loop convention:

```
/loop 168h /dogfood-drain
```

(168h = one week; this is the same pattern every other recurring routine in this repo uses —
`crypto-research`, `fleet-ide-loop`, `make-it-work`.) There's no separate cron config to wire —
the loop *is* the schedule. If you want the cadence to survive session restarts unattended for
months, the durable alternative is a scheduled cloud routine via `/schedule` running
`/dogfood-drain` weekly; same contract, same two append scripts underneath.

## Completion phone push

A finished turn can buzz your phone so stepping away doesn't mean staring at a dead terminal
waiting.

**Subscribe once:** in the webapp, open the account menu → **Background notifications**. That's a
standard browser permission prompt (must be a user gesture — the button click) followed by a
`POST /api/push/subscribe` registering this device. Once granted the button reads "Background
notifications on" and stays disabled (no re-subscribe needed).

**Per-category defaults** — a completion push is not one setting, it's two, because a busy fleet
finishing routine work constantly would make the buzz worthless:

| Category | Flag | Default | Why |
|---|---|---|---|
| Casual (`glance here` / console chat) | `GLANCE_PUSH_CASUAL_DONE` (legacy `OMP_SQUAD_PUSH_CASUAL_DONE`) | **ON** | an idle chat finishing *is* the reason to come back after stepping away |
| Fleet (dispatched/workflow units, and any chat you've promoted) | `GLANCE_PUSH_FLEET_DONE` (legacy `OMP_SQUAD_PUSH_FLEET_DONE`) | **off** | a tracked unit finishing is routine; pushing on every one would be spam |

Toggle either via env, or persist a change server-side with `POST /api/settings/feature-flags`
(body `{"key": "OMP_SQUAD_PUSH_CASUAL_DONE", "enabled": false}` — the flag's registered key is the
legacy spelling internally; the `GLANCE_`/`OMP_SQUAD_` env mirroring above doesn't extend to this
API body) — there is no dedicated webapp toggle for these two yet, only the generic settings
endpoint (`GET /api/settings` lists every flag's current source: settings/env/default).
**Approval/needs-input escalations are a separate lane and always fire regardless of category** —
you're never left unaware that something needs you.

A casual/fleet completion push also only fires if the turn actually ran long enough to be worth a
buzz — the default floor is 20 seconds (`GLANCE_PUSH_MIN_TURN_MS`, legacy
`OMP_SQUAD_PUSH_MIN_TURN_MS`; `0` disables the gate). A 5-second reply you were watching live
isn't a reason to switch away. Voice dispatches are exempt from this gate entirely — an
away-from-screen call owes its "finished" ping no matter how short the call was.

**Tapping the notification** deep-links to `/#/agent/<id>?push=1`. The `?push=1` marker exists
purely so the webapp can tell "arrived via a push tap" apart from "arrived via a normal click" —
it beacons once to `POST /api/push-tap` (feeding the push-taps/day adoption counter) and then
strips the marker from the URL.

## Restart re-attach — honest survival across a daemon restart

Lars restarts the daemon roughly hourly, and `claude-code` (the harness `here` rides) is
ACP-protocol with no detached host to resume from — a `here` session genuinely **cannot** survive
a restart the way a fleet unit's detached host process can. Rather than pretend otherwise or hang
silently, the REPL detects it and says so:

```
⟲ the daemon restarted and this session didn't survive it — harness "claude-code" can't resume across a restart
  starting a fresh session with your prior conversation carried in as context…
● re-attached (fresh session chat-… · prior context rides your next message)
```

A fresh session starts through the exact same create path as any `here` session, and a tail of
the dead session's transcript is **folded into your very next prompt as context** — never sent on
its own, never presented as a seamless resume it isn't. The new session's transcript also carries
a visible system marker naming the seam. Ask it something that depended on the prior turn and it
will answer correctly, because the context genuinely rode along — but it is context, not restored
model state: nothing that was in the model's working memory beyond what made it into the
transcript survives.

**Known limits, stated plainly:**

- A **second restart before you've re-attached** loses the recovered tail — placeholders are
  in-memory only, not durable, because durability wasn't worth the write cost for an hourly
  window. You get the honest "no prior context was recoverable" variant, not a silent gap.
- A **mid-turn kill** loses the in-flight assistant reply (persistence happens at prompt-send and
  turn-end, not mid-stream) — your own prompt survives, the reply that was still generating
  doesn't.
- A REPL that was fully offline through the entire restart (laptop closed) re-attaches on its next
  poll tick once it wakes up — same mechanism, no push notification for this specific case today.

## Promote / adopt

**Promote** turns a casual chat into a gated, landable work unit without losing its history —
same agent id, same transcript, only its standing flips. Click **"make this a unit"** in the chat
meta bar (or the cockpit's Land rail) on any unpromoted console/`here` chat. On success the thread
gains unit chrome in place; as a side effect, if the chat's repo was only ephemerally registered
(see above), that registration becomes durable in the same call — no separate step.

**Adopt** is the inverse direction: a raw `claude`/`omp` CLI session running *outside* glance,
detected via presence, shows up as an "ad-hoc session detected" card (amber, non-blocking) in the
webapp. Clicking **"adopt into glance"** brings it into the roster as a gated unit with its
uncommitted diff replayed in. A refused adopt (stale claim, wrong cwd, already-adopted session)
surfaces the server's exact reason rather than a generic error.

## The adoption gate

This whole program is deliberately built to prove or kill itself. After the on-ramp (`glance
here`), boundary sync, restart re-attach, friction capture, and completion push all shipped
(wave 1 — draft PR #194): **two weeks of real daily use**, judged against the dogfood counters
— casual sessions/day, prompts/day, push taps/day — decide what happens next.

> **Kill criterion:** if sustained daily casual use hasn't emerged after two weeks, STOP —
> re-diagnose with the friction ledger. The follow-on epics (a fuller needs-you attention ladder,
> true in-place sessions, etc.) do not execute and do not expand.

**Where the numbers live:**

- `glance doctor` — the *"Is glance getting daily use?"* section reports today's and the trailing
  7-day casual-session/prompt/push-tap counts.
- `GET /api/adoption` — the same counters as JSON.
- **Webapp → Graph view (the FLEET PULSE instrument) → Adoption strip** — a three-tile band at the
  top: today's number + a 14-day sparkline for each metric, labeled "the dogfood success metric."
- **Webapp → Friction nav item** — browse the full friction ledger, newest first, filterable, with
  source labels (human vs. auto) and a local acknowledge/dismiss.
- `plans/daily-driver/00-meta.md`'s `## Ledger` — the weekly counter snapshot + triage summary
  trail the drain appends, the record the two-week review reads from.

**The verdict is Lars's, and only Lars's.** The drain skill, the loop, and both ledger-append
scripts route every write through `src/meta-ledger.ts`'s `insertLedgerRow`, which mechanically
*refuses* any row containing verdict language (`SUCCESS`, `KILL`, `verdict`, `adopted`, `no-go`,
shouted `STOP`) and exits non-zero with the file untouched. Automation gathers the evidence; it
never gets to render the judgment. Whatever this doc says about the program's prospects, the line
that actually decides it is typed by Lars, in his own words, at the two-week review — not written
here, not written by a loop.

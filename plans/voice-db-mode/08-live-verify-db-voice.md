# Live verification — two orgs, two keys, one daemon
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 01, 02, 03, 04, 05, 06, 07
TOUCHES: (no source — a verification run; findings land in this file's Resolution)
MODE: afk

## Goal
Prove the lane works end-to-end in DB mode against the real provider, with two orgs isolated from each other.
Every prior concern's tests can be green while the composed system is dead — that is exactly what happened on
2026-07-13, when a CSP header nobody tested killed every call *after* a successful mint, and four reviewers
missed it.

## Approach
Scratch daemon in **DB mode** (Postgres, `DATABASE_URL` set — the tenancy topology, not the file-mode one the
voice lane was first verified on), two orgs, each with its own OpenAI key configured through the real admin UI.
Drive the served webapp in a headless browser with a fake mic (the rig from the 2026-07-13 pass: Chrome
`--use-file-for-fake-audio-capture` + CDP attach; the capture file plays *once* at `getUserMedia`, so pad the
speech WAV with silence gaps).

The run, in order:
1. **Org A, no key** → no voice button (probe honestly `enabled:false`).
2. **Org A admin sets a key through the UI** → verification passes → button appears.
3. **Org A places a call** → speak → hear a reply. The end-to-end proof.
4. **Cross-tenant**: confirm at the provider that org A's session used A's key (the audit's provider session id
   cross-references the OpenAI dashboard) and that org B's key was never used by A.
5. **Kill switch**: admin flips `enabled:false` mid-session → the *next* mint refuses immediately; the live call
   drains (documented behavior, not a bug).
6. **Org switch**: user switches to org B mid-call → the call ends with a toast, no dispatch lands in B.
7. **Concurrency cap**: exceed N mints in the window → refusal, auditable; survives a daemon restart.
8. **The spawn scrub, live**: an agent spawned by a tenant runs `printenv` → no `DATABASE_URL`, no secrets.

## Cross-Repo Side Effects
None.

## Verify
Each numbered step above is its own pass/fail, recorded in this file's `## Resolution` with what was observed
(not what was expected). A step that cannot run states why, plainly. Anything found here that contradicts a
green unit test is the finding that matters most — write it down even if it is embarrassing, especially then.

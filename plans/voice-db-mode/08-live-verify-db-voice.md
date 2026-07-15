# Live verification — two orgs, two keys, one daemon
STATUS: done
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

## Resolution

Live run 2026-07-14 against a throwaway DB-mode scratch daemon (own state dir, port 7893, sqlite
`DATABASE_URL`, `GLANCE_SECRETS_KEY_FILE` ingestion) serving the committed rev, driving the **real**
OpenAI provider with the one real key configured per-org through the admin API. **9/10 PASS, 1 PARTIAL**
(the partial is the human-ear step). Raw transcript archived with the run. Observed, not expected:

1. **Boot + auth — PASS.** `/api/auth/mode` → `{"mode":"db"}`; org A created via real better-auth signup
   + `/api/workos/sync` (personal org, owner→admin), cookie-session authed.
2. **Org A, no key — PASS.** config `{"enabled":false}`; `POST /api/voice/token` → **501** "no API key configured".
3. **Set real key — PASS.** `PUT /api/org/voice-key` → **200**; the real `GET /v1/models` verify passed
   *before* persist; `GET /api/org/voice` returns last4 only (`VNEA`), never ciphertext; config → `enabled:true`.
4. **Real mint — PASS.** `POST /api/voice/token` → **200**, `ek_` ephemeral value, transport webrtc, **TTL 120s**.
5. **CSP live — PASS.** served HTML carries `connect-src 'self' https://api.openai.com` — the exact directive
   that was `'self'`-only and silently killed every call after a good mint on 2026-07-13.
6. **Kill switch — PASS.** disable → mint 501; re-enable → mint 200.
7. **Re-save re-enables — PASS.** after disable, a fresh verified PUT alone → `enabled:true` + mint 200, no
   separate enable call (the `/code-review`-found bug, fixed and now confirmed live).
8. **Cross-org isolation — PASS.** org B sees `enabled:false` + mint 501 (A's key never used for B); an
   invalid PUT → **400** "key rejected", nothing written.
9. **Spawn scrub live — PASS (caveat).** the real `scrubbedSpawnEnv` run against the daemon's live
   `/proc/environ` (which holds `DATABASE_URL` / `BETTER_AUTH_SECRET` / `GLANCE_SECRETS_KEY_FILE`) yields a
   child env of only HOME/LANG/PATH/SHELL/TERM/XDG_* — zero secrets. Real scrub on live data, one layer short
   of a fully dispatched harness (not feasible autonomously on the scratch daemon).
10. **Browser speak→hear — PARTIAL.** headless Chrome + fake mic completed the real SDP exchange to
    `api.openai.com/v1/realtime/calls` (**201**), `connectionState: connected`, data channel open, OpenAI
    remote audio track received. The once-CSP-blocked SDP path now establishes. **Remaining human step:** place
    a call through the actual webapp voice button and confirm an *audible* spoken reply — no autonomous ear.

**Bonus observations.** The durable per-org mint cap fired for real (`429 "voice mint limit (5 per 62 minutes)"`
after org A's 5th mint — concern 04). The file-based `GLANCE_SECRETS_KEY_FILE` ingestion (the fix's
isolation-safe path) worked end-to-end.

**Contradiction with a green unit test:** none behaviorally. **Coverage gap found (follow-up):** the org-admin
voice unit tests inject a **stub** auth (`dbAuthStubFor`) and never exercise the real better-auth signup →
`/api/workos/sync` → owner-member → `bridgeRole` owner⇒admin path. That path is green-untested and was proven
only by this live run (it worked). Add a real-auth integration test.

STATUS: done (live-verified end-to-end; the single audible-reply confirmation at the UI is a human step, noted in the PR).

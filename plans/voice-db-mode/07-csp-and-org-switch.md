# CSP arming in DB mode + end the call when the org changes
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
BLOCKED_BY: 03
TOUCHES: src/server.ts, src/voice-token.ts, webapp/src/context/VoiceCallContext.tsx, tests/ws-auth.test.ts, webapp/src/context/VoiceCallContext.test.ts
MODE: afk

## Goal
The browser can reach the provider in DB mode (or the lane is silently dead — the exact class found live on
2026-07-13), and a call can never narrate under org A's key while dispatching into org B's fleet.

## Approach
**CSP stays global and `securityHeaders()` stays nullary.** The draft's per-org widening was rejected: CSP names
an *origin*, and `https://api.openai.com` is identical for every org — only the key differs, and the key never
touches CSP. Per-org CSP would also require resolving the session inside the response-header path (which today
runs *after* the handler, with no org in scope), and it breaks on the SPA's own lifecycle: the document's CSP is
sent before any call is placed, and the active org can change with no reload.

So: widen `connect-src` to the provider origin when the lane is armed — in file mode that stays "flag + env key"
(byte-identical output, the existing pins must not move); in DB mode it is "flag on" (the org's *key* gates the
mint, not the header). An org without a key gets a slightly looser `connect-src` than it strictly needs and no
voice button; that is a legibility cost, accepted and documented, in exchange for not shipping a silent-dead-call
class.

**Org switch ends the call (client).** A voice call is bound to a chat session, but the tool dispatches
(`prompt_agent`, `spawn_agent`, …) resolve the fleet from the *current* session's active org. If the user
switches orgs mid-call, the call would keep narrating with org A's minted token while dispatching into org B's
fleet. `VoiceCallContext` pins `activeOrganizationId` at call start and **ends the call with a toast** if it
changes. (Server-side dispatch binding is deferred: the user is a legitimate member of both orgs, so this is
attribution confusion, not privilege escalation.)

## Cross-Repo Side Effects
None.

## Verify
- CSP: file-mode output byte-identical (the three pinned substrings in `ws-auth.test.ts` must still hold);
  DB-mode + flag on ⇒ `connect-src` includes the provider origin; flag off ⇒ tight `'self'` in both modes.
- **Live**: a DB-mode scratch daemon with an org key placed — the browser actually completes the SDP exchange
  (this is the check that would have caught the 2026-07-13 blocker; a unit test would not).
- Org switch: with a call live, changing `activeOrganizationId` ends the call and toasts; no tool dispatch occurs
  after the switch.

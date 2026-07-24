# Membership + per-channel fan-out enforcement — one landing unit
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/server.ts (fan-out filter layer), src/channels.ts (membership), db schema, webapp (channel create/join UI), tests
BLOCKED_BY: 01, 02
MODE: afk

## Goal
Non-public channels whose visibility the transport actually enforces. Membership semantics and
per-channel socket-filtering land as ONE unit with leak tests — never a membership table whose
rows the fan-out ignores (A-S1: broadcastTo is an org bucket; any per-channel entry would
otherwise hit every org socket).

## Approach
1. Channel visibility: org-public (default, wave-1 behavior preserved) | private (member-only).
   Membership rows keyed by userId (concern 02 identity); creator manages members; no
   absence-inference revocation — removal is a positive-evidence row through the front door
   (binding revocation verdict, PR #217 class).
2. Fan-out: a channel-scoped delivery layer above broadcastTo — resolve the member userIds'
   socket sets and deliver only there; org-public channels keep the org-bucket fast path.
   Standing constraint (federation provenance amendment, DESIGN.md 2026-07-23): the membership
   filter is the delivery PRIMITIVE and org-bucket broadcast is an optimization beneath it —
   never the reverse — so a future cross-org channel (Slack-Connect analog) extends membership
   instead of rewriting fan-out.
3. Leak tests are the unit's core: non-member in same org receives NO WS frame, NO HTTP read, NO
   search hit for a private channel; grep gate — no bare `broadcast(` in channel code paths.
4. Cross-lineage review mandatory (tenancy/trust path).

## Cross-Repo Side Effects
None.

## Verify
- Three users, one org: private channel between A+B — C's socket captures zero frames during
  traffic (wire-level assert), C's search/API reads 403/empty; revoking B stops delivery on next
  event; org-public channels unaffected.

## Resolution
Landed 2026-07-24 in the wave-4 train. Four rounds, because the first three each shipped something
that looked right and wasn't.

Round 1 (`bc20c22`) built the membership model and the fan-out filter. Round 2 (`9c8306e`,
`719c7ad`) closed nine defects found by adjudicating the implementation against the spec: the
fan-out dispatcher was dropping `removed`/`log`/`command-ack` outright, only some of the
`/api/agents/:id/*` routes were gated, and `ChannelStore`'s read APIs took an optional actor.

Round 3 (`cc215e6`) came out of the mandatory cross-lineage gate (approach step 4). Two independent
reviewers produced overlapping but distinct defect sets, and between them found four things the
in-house audit had missed or under-weighted:

- The round-2 `removed` fix was **unreachable**. Every removal path deletes the agent record before
  emitting the event, so the membership lookup found nothing and fell open to an org-wide broadcast.
  The member set is now resolved before deletion.
- Private-channel agents lost escalation and completion pushes entirely, and the push helpers took
  no member list — so the obvious fix would have pushed org-wide. Helpers now carry the scope.
- A missing channel row was fail-open on delivery and fail-closed on read. The two paths now agree.
- The per-socket revocation recheck fell back to the pre-fan-out member list when a lookup failed,
  which is the TOCTOU this concern exists to close. It now fails closed.

Round 3 also fixed a regression round 2 had introduced — `canReadAgent` considered only live agents,
so dead placeholders on **public** channels started returning 403 instead of their documented
dead-response — and a data-model gap: `AfterActionReport` did not retain `channelId`, so the
artifact outlived the only record that said who could read it.

Round 4 (`1ecf7ba`, `3d4e72d`, `3e3e5c3`) was tests only. Both reviewers had independently reached
the same verdict: deleting most of the enforcement would have left the suite green, because only
`channel-entry` fan-out was actually pinned. The suite went 46 → 56 on the four affected files and
now covers private push scoping, subscriptions with no bound user, non-member reads of
action-items/answers/after-actions *after reaping*, the dead-placeholder regression, creator access
surviving a failed membership write, search past the over-fetch cap, and DbStore parity (everything
before it was FileStore-only). The `command-ack` exemption is now proven against a command actually
issued in a private channel rather than passing incidentally.

Standing lesson, consistent with the PR #217 class and the blind-review record: every defect in
rounds 3 and 4 was an **absence** treated as an answer — a deleted record, a missing row, a failed
lookup, an untested path. The delivery primitive was right from round 1; what kept being wrong was
what the code concluded when it had nothing to go on.

### Verify status
The concern's four stated criteria are covered by `tests/channel-membership-fanout.test.ts`. Known
gaps deliberately left, neither a leak: `FileStore.putChannel`'s create lock is an in-process mutex
rather than a cross-process CAS (correct for the single-daemon deployment we run, not for two
daemons sharing a state dir), and authorize-then-read on channel entries and per-agent routes has no
shared snapshot, so a membership DELETE committing between the two calls lets that one read through.

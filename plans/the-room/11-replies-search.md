# Replies + channel search
STATUS: done
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/components/hub (thread view, search UI), src/server.ts (search endpoint), src/channels.ts (replyToId, query), tests
BLOCKED_BY: 01, 08
MODE: afk

## Goal
Flat threaded replies (replyToId on channel entries, distinct from clientTurnId — A-S2 overload
guard) with an inline thread view, and channel search over durable rows (buzz's "incident memory"
story: search months of room history).

## Approach
1. replyToId on the entry shape (already reserved in concern 01); composer reply affordance;
   thread view renders the reply chain inline (no nested-thread UI — flat chain).
2. Search: DB mode — SQL over channel_entries (LIKE/FTS per what the DB layer supports; follow the
   fabric BM25 precedent if trivial to reuse); file mode — ring/file scan, honest about bounds.
   Endpoint `GET /api/channels/search?q=` org-scoped; results deep-link via the hash router.
3. Redacted content is searched as stored (post-redaction) — no raw-secret index.

## Cross-Repo Side Effects
None.

## Verify
- Reply renders chained; search for a week-old message returns it and the link opens the channel
  at that entry (or its nearest loaded page). Cross-org search leak test: zero foreign rows.

## Resolution
Landed 2026-07-24 (PR #243): flat replies via replyToId, org-scoped search over redacted rows, router deep-links.

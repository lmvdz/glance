# Composer quality of life
STATUS: open
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/src/components/chat/Composer.tsx, webapp/src/components/hub/ChannelTimeline.tsx, src/server.ts, tests
MODE: afk

## Goal
The things a human expects from a chat app that claims to be an evolution of Slack — starting with
the one that is missing and obvious.

## Approach
1. **Image previews.** An uploaded image shows a thumbnail in the composer before send and renders
   inline in the timeline after. The attachment endpoint already exists
   (`/api/chat-attachments/:id`, `getChatAttachment`); this is presentation, not new plumbing.
2. Paste-to-upload and drag-to-drop, since both are how images actually arrive.
3. Failed upload states that say what went wrong and how to fix it — no silent drops.
4. Style to `brand.md` and match the migrated `ChannelRail.tsx` treatment.

Deliberately NOT in scope: reactions, rich text, link unfurling. Each is its own concern and none is
what the room is missing today.

## Cross-Repo Side Effects
None.

## Verify
- Attach → thumbnail before send → renders inline after; asserted DOM-free where possible.
- Paste and drop both produce the same attachment path as the file picker.
- An oversized or non-image file fails with a message naming the limit, and nothing is silently lost.

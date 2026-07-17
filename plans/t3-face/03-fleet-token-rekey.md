# Fleet token re-key — de-hardcode the 244 raw palette classes

STATUS: done
PRIORITY: p0
REPOS: glance-desktop
COMPLEXITY: mechanical
BLOCKED_BY: 01, 02
TOUCHES: all src/modules/fleet/*.tsx (RosterView, FleetPane, FleetStack, IntervenePane, WorkspaceOverlay, ConversationView, AdoptableSessions, and store-adjacent components)

## Goal

Every color/radius/spacing value in the fleet module resolves to a t3face token. After this concern a global theme switch repaints the fleet cockpit, and R1 ships a visually coherent whole app instead of a t3-skinned shell wrapped around a raw-gray fleet island.

## Approach

Verified scope: ~164 gray-family occurrences + emerald/amber/sky/red status accents across ~10 files; the module reuses zero shadcn `ui/` components. This is the single biggest-volume concern and it is fork-owned (no rebase risk) — but it is NOT a behavior no-op, so treat it as a deliberate visual re-key, not a mechanical find-replace.

Re-key rules (the gray pairs are asymmetric and alpha-composited — map by role, not by literal):
- surfaces `bg-white`/`bg-gray-50`/`dark:bg-gray-900` → `bg-background` / `bg-card` / `bg-muted` by role
- borders `border-gray-200`/`dark:border-gray-800` → `border-border` (hairline seams at `/60`–`/80` alphas per t3 idiom)
- text `text-gray-900`/`text-gray-500`/`text-gray-400` → `text-foreground` / `text-muted-foreground` (de-emphasis via `/60`–`/70` opacity steps, not a lighter gray)
- fills `bg-gray-100 dark:bg-gray-800/40` → `bg-accent/40` / `bg-muted/20`
- **status accents** (`text-emerald-*`, `bg-emerald-500`, `text-red-*`, `amber-*`, `sky-*`, `focus-visible:ring-emerald-500`) → the concern-01 status tokens (`text-success`, `bg-success`, `text-destructive`, `text-warning`, `text-info`). These convert here (not deferred to R2) so the same lines aren't touched twice — this is why the concern blocks on 02.
- radii → `rounded-md`/`rounded-lg` per t3 practice; interactive rows get `cursor-pointer select-none focus-visible:ring-1 ring-ring`.

Where a hand-rolled control maps cleanly to an existing `ui/` primitive (buttons, badges, tooltips, scroll-area), replace it — but keep this concern's diff reviewable: prefer token re-key + minimal primitive swaps here, and leave larger structural restructures (rows→spine, pre→pierre) to their own concerns (05, 08, 09, 10). Do not restructure navigation or data flow in this concern.

Icons stay HugeIcons.

## Cross-Repo Side Effects

None.

## Verify

- `grep -rInE '(bg|text|border|ring|from|to)-(gray|zinc|slate|neutral|emerald|red|amber|sky|green)-[0-9]' src/modules/fleet` returns **zero** (the concern-13 grep gate, run early here).
- `pnpm lint && pnpm check-types && pnpm vitest run && pnpm build` green.
- Screenshot-diff EVERY fleet surface (roster, intervene, overlay, adoptable) in BOTH light and dark against a pre-change capture — differences are intentional re-keys, reviewed by the taste lane, with no illegible text or invisible borders.
- Live: global theme switch (t3face ↔ dracula) now repaints the fleet cockpit.

## Resolution

Shipped as glance-desktop draft PR #30 (branch `t3face/03-fleet-rekey`, STACKED on #29 / `t3face/01-02-skin-substrate` for the tokens). Grep gate clean (zero raw palette classes in src/modules/fleet); gates green (515/515, lint/types/build). Role-based re-key across RosterView/IntervenePane/FleetPane/ConversationView/WorkspaceOverlay/AdoptableSessions; status accents → semantic tokens; redundant dark: variants dropped. Three taste calls approved (idle/stopped opacity split; Send CTA → primary not success; two text de-emphasis buckets) — flagged for concern 13's live both-modes/WebKitGTK check.

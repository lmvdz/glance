# Spine consumes the server ladder — delete the client ranking

STATUS: open
PRIORITY: p1
REPOS: glance-desktop
COMPLEXITY: architectural
BLOCKED_BY: 05, 06
TOUCHES: src/modules/fleet/spine/*, src/modules/fleet/lib/fleetAttention.ts, src/modules/command-palette/commands.ts

## Goal

The spine's attention pills, group roll-ups, and command-palette rows render the daemon-computed priority state from concern 06. Any client-side ranking (`fleetAttention.ts`'s local ordering) is deleted — the cockpit becomes a pure renderer of the one attention truth. Status pills use the t3 visual grammar (dot + `text-[10px]` label, `animate-status-pulse` on working/connecting, compact tooltip variant).

## Approach

1. Point the spine pill component (built in concern 05) at the concern-06 endpoint; `FleetClient` gains an attention fetch (through the Rust proxy like the rest).
2. Map each daemon priority tier → t3 status grammar: error→destructive, pending-approval→warning(amber), awaiting-input→info(indigo), working/connecting→info+pulse(sky), plan-ready→a violet/`--pending` token, completed-unseen→success(emerald), idle→muted. Colors resolve to the concern-01/02 tokens (so they repaint under other themes — t3's raw-palette choice is deliberately NOT copied here, per DESIGN decision).
3. **Delete client ranking**: remove `fleetAttention.ts`'s local priority computation; keep only presentation helpers. Grep confirms no cockpit code ranks units.
4. **Command palette rows**: add unit rows to the palette with leading status cluster + trailing timestamp (t3 puts the ladder in the palette — `components_CommandPaletteResults.tsx` idiom). One registration edit to `commands.ts`.
5. Roll-up group headers consume the daemon's per-group aggregation, not a client max.
6. `lastVisitedAt` writes go to the daemon (mark-seen on unit focus/open), replacing any local store.

## Cross-Repo Side Effects

Exercises concern 06's endpoint; a mismatch surfaces the seen-state divergence bug immediately.

## Verify

- `grep -rn 'priority\|rank\|PRIORITY' src/modules/fleet/lib/fleetAttention.ts` shows no ranking logic remains.
- Live: cockpit pills match `curl /api/attention`; marking a unit seen in the cockpit clears "unseen" for a second client after its next poll.
- Command palette shows unit rows with correct status clusters.
- Pulse animation runs only on working/connecting tiers; no restart-flicker on poll (concern 04 identity preservation holds).
- Taste-lane review on the pill/palette visuals.

# R3 glance surfaces — the 10x layer in t3's vocabulary

STATUS: open
PRIORITY: p2
REPOS: glance-desktop
COMPLEXITY: architectural
BLOCKED_BY: 05, 07
TOUCHES: src/modules/fleet/spine/* (badges), src/modules/fleet/IntervenePane.tsx (why-stopped/lease/gate surfaces), src/modules/fleet/detail/* (new gate/landing panels)

## Goal

The surfaces that have no t3code analog — the ones that are glance's actual moat — render in t3's visual language: gate/landing-state chips on unit rows and detail, and the lease overlay as a t3-style glass card. This is where "glance elevates it 10x" becomes visible: t3's UI showing a supervised fleet that gates and lands its own PRs, which neither t3code nor terax can display.

## Approach

These extend vocabulary already built in R2 (the row-badge idiom from concern 05/07, the glass-card treatment from concern 08's shell). No new design language — apply the established one to glance-specific data.

1. **Gate/landing chips**: unit rows and the detail header show gate state (verifying / gates-passed / gates-failed) and landing state (queued / landing / landed / land-failed) as small `text-[10px]` chips using the concern-01/02 status tokens (landing-failure already promotes to the error tier in the concern-06 ladder). Chips follow the PR-badge idiom from t3's `ThreadStatusIndicators` (icon `size-3` + tooltip).
2. **Lease overlay as glass card**: the existing `WorkspaceOverlay` ("who holds which file") becomes a t3-style card — `rounded-lg border border-border/80 bg-card/45 p-2.5`, uppercase `tracking-[0.12em]` header, file rows with holder + presence dot — extending the why-stopped banner treatment rather than a raw list.
3. **Why-stopped banner**: adopt the glass-card treatment, reasoning-first (leads with the agent's stated reason, diff one click away — matches how the daily-driver laws say a power user reviews).
4. Keep it strictly presentational over existing daemon data (gate/landing/lease state already flow through `FleetClient`); no new daemon endpoints.

Deferred (explicit, per DESIGN): cost roll-up ledgers and multi-daemon cost altitude — no t3 analog, needs original design; attention roll-ups already shipped in concern 05/07.

## Cross-Repo Side Effects

None.

## Verify

- Live (scratch daemon, a unit driven through gates→land): gate and landing chips reflect real state transitions; a land-failure shows the error tier in both row and detail.
- Lease overlay renders as a glass card with real presence data.
- Blind provenance test (concern 13): a reviewer shown cropped gate-chip / lease-card components alongside t3 components can't reliably tell which app is which (same design system).
- Taste-lane review; gates green.

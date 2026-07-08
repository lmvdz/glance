# Taste-review nits — evidence

Opus SHIP-WITH-NITS pass on the Category Canvas (`plans/orchestration/CANVAS-AND-PAGE-CHAT.md`
Feature 1). Four nits, all fixed on this branch.

## Nit 1 — dense-orbit collisions

- `03-dense-orbit-fixed-dark.png` / `05-dense-orbit-fixed-light.png` — the reported ~23-satellite
  scenario (Frontend category, 23 open plans), live via a scratch daemon. Satellites now split
  across two concentric rings (inner ring capped at 6, outer ring the rest), both radii bounded by
  `maxSafeSatelliteRadius()` (`lib/categoryCanvas.ts`) so neither ring's chip footprint — not just
  its center point, which is what the old cap actually bounded — can reach the receded perimeter
  category nodes (Other/MCP/Backend/Database/Devops, visible dimmed around the edges). No overlap
  in either theme.

## Nit 2 — needs-you signal (the real D8 evidence)

- `06-needsyou-ring-badge-light-D8.png` / `07-needsyou-ring-badge-dark-D8.png` — DevOps carries a
  small ember count badge ("3") clearly heavier than Backend's ("1"), answering "which category has
  the most blocked work" at a glance — the exact D8 acceptance test the original ship-with-nits
  review said this feature had to beat.
- **Honesty note on how this was seeded**: `feature.blocked` (and the `input` tag `isNeedsYou`
  reads) is derived ONLY from a live agent's real `status === "input"` (`src/features.ts:879`) —
  there is no on-disk/API field to set directly (confirmed by reading `FeaturePatchBodySchema`,
  `PersistedFeature`, and `PersistedAgent`; agent `status` is never persisted, always re-derived at
  runtime). Getting a genuine live "input" gate requires spawning a real agent that stalls on an
  approval prompt. One attempt was made in the scratch daemon (`POST /api/spawn` with a plain
  low-risk task and `approvalMode: "write"`) — it auto-routed into a full implement→verify workflow
  and force-set `approvalMode: "yolo"` regardless of the request, so it never stalled; it was killed
  and its worktree removed immediately, no side effects. Rather than keep escalating (spawning more
  agents/workflows to chase a stall works against "spend the least amount of infra to get one
  screenshot"), these two shots use the sanctioned "component-level SSR with real data" technique
  from `.claude/skills/scratch-daemon/SKILL.md` — the REAL, unmodified `CategoryCanvasView`
  component, fed a realistic `Task[]` fixture through the exact same `isNeedsYou(tags)` code path a
  live blocked feature produces (`tags: ["blocked"]` / `["input"]`), rendered via `renderToStaticMarkup`
  and screenshotted with the real built `index.css`. This is the fallback the task itself offered
  ("or state clearly in the PR you couldn't and why").

## Nit 3 — honest overflow → filtered list

- `04-overflow-chip-filtered-list.png` — live: clicking the dense category's "+12 more" chip
  switches to LIST mode with a visible, dismissible "Frontend ×" filter chip and only that
  category's 23 rows shown (was: silently landing on the full unfiltered 26-row list).

## Nit 4 — light-mode brand

- `01-idle-ring-light-default.png` (light, the app's default theme) vs `02-idle-ring-dark.png` —
  same idle ring, both themes. Per-category rim colors are now a light/dark CSS-variable pair
  (`--cc-rim-*`, `index.css`) instead of one flat hex: measuring contrast showed the ORIGINAL flat
  hexes (deep -700/-800 shades tuned for a light background) actually pass AA fine on white but
  drop to ~2.5:1 — below AA — against the dark canvas surface, the reverse of what "brand only
  lands in dark" suggested. Light keeps the original AA-passing hexes; dark gets a lighter shade of
  the same hue. The canvas frame/header/overflow-chip chrome was also moved off ad hoc Tailwind
  `gray-200/800` classes onto the app's real `--wf-surface`/`--wf-border`/`--wf-text-muted` tokens,
  so light mode's hairlines match the rest of the product instead of a generic, unrelated gray
  ramp. Full parity with dark's ink/ember atmosphere not attempted (lowest-priority nit; the ember
  accent — selection state, focus rings, the new needs-you badge — already reads clearly in light
  via `var(--wf-accent)`, which is real ember hex in both themes despite brand.md's stale note that
  it's still indigo).

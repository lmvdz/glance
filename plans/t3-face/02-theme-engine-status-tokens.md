# Theme engine carries the status token family

STATUS: done
PRIORITY: p1
REPOS: glance-desktop
COMPLEXITY: mechanical
TOUCHES: src/modules/theme/types.ts, src/modules/theme/applyTheme.ts, src/modules/theme/validateTheme.ts, scripts/upstream-drift.sh, UPSTREAM.md

## Goal

`warning`, `info`, `success`, `pending` (+ `-foreground` variants) are first-class theme-engine color keys, so a non-default theme (dracula, nord, custom user themes) can repaint status colors instead of clashing with t3face's defaults. Unset keys fall through to the stylesheet — the 14 other builtin themes need no edits.

## Approach

Red-team-verified facts: `ThemeColors` in `types.ts` is a closed Partial record (28 keys + `radius`); `applyTheme.ts`'s `COLOR_VAR` map and `clearTheme`'s `ALL_VARS` iterate only known keys; `validateTheme.ts` `parseColors` hard-rejects unknown keys. `types.ts` is already fork-diverged; `applyTheme.ts` and `validateTheme.ts` are pristine vs upstream — this concern makes them permanent conflict files, which is accepted and tracked.

1. Add the eight keys to `ThemeColors`, `COLOR_VAR` (→ `--warning` etc.), and `ALL_VARS`.
2. `validateTheme.ts`: accept the new keys (same color-string validation as existing keys).
3. Do NOT edit any `themes/*.ts` — fallthrough is the design: engine removes-then-writes only provided vars, so unset status keys resolve to t3face.css values. State this in a comment at the `ThemeColors` definition.
4. Add `applyTheme.ts` and `validateTheme.ts` to `REG_POINTS` in `scripts/upstream-drift.sh` (currently tracks 9 files) and note them in UPSTREAM.md's diverged-set section.

Token names must match concern 01's globals registration exactly: `--warning`, `--warning-foreground`, `--info`, `--info-foreground`, `--success`, `--success-foreground`, `--pending`, `--pending-foreground`.

## Cross-Repo Side Effects

None.

## Verify

- `pnpm check-types && pnpm vitest run` green (theme module has existing tests — extend `validateTheme` tests: a theme carrying `warning` validates; a bogus key still rejects).
- Live: activate a builtin theme → status-colored elements (post-concern-03) repaint or gracefully keep t3face values; deactivate → t3face values return.
- `scripts/upstream-drift.sh` lists both new files.

## Resolution

Shipped as glance-desktop draft PR #29 (with concern 01). The 8 status keys added to `ThemeColors`/`COLOR_VAR`/`ALL_VARS`/`validateTheme` COLOR_KEYS; no `themes/*.ts` touched (fallthrough by design); new `validateTheme.test.ts` (5 tests) pins accept/reject. `applyTheme.ts` + `validateTheme.ts` added to `upstream-drift.sh` REG_POINTS and UPSTREAM.md diverged-set. Token names match concern 01 exactly.

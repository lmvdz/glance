# Web in-app dialogs — replace native prompt/confirm
STATUS: done
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: mechanical
BLOCKED_BY: 04 (shared file src/web/index.html only — no logical dependency)
VERIFY_BLOCKER: `git log --oneline -1 -- src/web/index.html` shows concern 04 landed
TOUCHES: src/web/index.html
PLANE: OMPSQ-2 — https://app.plane.so/inkwell-finance/browse/OMPSQ-2/

## Goal
Replace the blocking, unstyled native `prompt()`/`confirm()` calls with the styled, cancelable
`<dialog>` pattern already in the file, for consistent affordance and escape (BRIEF §E). The
trust-boundary intent (a real confirm before a destructive action) is preserved — only the
presentation changes.

## Approach
1. **Inventory the native calls:**
   - `confirm("Kill this agent?")` — `index.html:768`
   - `prompt("New feature title:")` — `newFeature` `:486`
   - `prompt("Goal for the auto feature…")` — `newAutoFeature` `:464`
   - `confirm("Pull latest + restart…")` — upgrade `:986`
2. **Two reusable async helpers** modeled on the existing add-agent `<dialog>` (`:176-186`,
   `dlg.showModal()` `:964`):
   - `confirmModal({ title, body, danger }) → Promise<boolean>` — styled Yes/Cancel, Esc = cancel,
     `danger` styles the confirm button with `--err` (reuse `.danger`).
   - `promptModal({ title, label, placeholder }) → Promise<string|null>` — one text field, Submit
     /Cancel, Enter submits, Esc cancels.
   Build one shared `<dialog>` element reused by both (set content per call) — fewest nodes.
3. **Swap the call sites** to `await` the helpers; keep all downstream behavior identical
   (same `send`/`fetch`). Destructive "Kill" uses `danger: true`.
4. Reuse `.modal`, `.field`, `.actions` CSS (`:133-137`) — no new styles beyond a danger variant
   already present.

ponytail: native `<dialog>` is the platform feature (rung 3); the markup/CSS already exist —
this is a wrapper + four call-site swaps, the shortest diff that removes the jarring primitives.

## Cross-Repo Side Effects
None — client-only.

## Verify
- "Kill" → styled confirm with a red confirm button; Esc cancels (agent survives); confirming
  kills (same as before).
- "+ Feature" and "⚡ New (auto)" → styled prompt; Enter submits, Esc/Cancel aborts with no
  network call; submitting creates the feature exactly as before.
- "⤴ Upgrade" → styled confirm gates the restart as before.
- Grep confirms no remaining `prompt(`/`confirm(` native calls in `src/web/index.html`.

## Resolution

Closed 2026-06-21 via OMPSQ-2 (https://app.plane.so/inkwell-finance/browse/OMPSQ-2/).
Added async `confirmModal()` / `promptModal()` on one lazily-created shared `<dialog>` (reusing
`.modal/.field/.actions/.danger` CSS); OK is the submit (Enter), Cancel is a button, Esc resolves
false/null with no side effect. Swapped all four native call sites — newAutoFeature + newFeature
(prompt), kill (danger confirm), upgrade (confirm). Gate green; `node --check` OK; static grep
confirms zero native `prompt(`/`confirm(` calls remain.

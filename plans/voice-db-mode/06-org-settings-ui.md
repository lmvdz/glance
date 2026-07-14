# Voice card in Organization settings — paste, verify, disable, remove
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: mechanical
BLOCKED_BY: 05
TOUCHES: webapp/src/components/OrgSettings.tsx, webapp/src/lib/api.ts, webapp/src/components/OrgSettings.test.tsx (new)
MODE: afk

## Goal
An org admin sets up voice from the UI, in the place they already manage the org — and understands what enabling
it means before they do.

## Approach
A new admin-gated card in `OrgSettings.tsx` (operator decision 2026-07-14: inside the existing Organization
settings screen, alongside Members / Join policy — no new nav surface). Reuse that file's `card` class, the
`isAdmin = me?.role === 'admin'` gate, and the `{ok, error}` + red `role="alert"` banner idiom.

States the card must render honestly:
- **Not configured** — a masked key input (`type="password"`, `autoComplete="off"`) + Save. Mirror `FileSignIn`'s
  *verify-before-persist* UX (the server does the verifying) and its masked-input treatment — but **never**
  persist the key client-side: no localStorage, no logging. It goes to the server and nowhere else.
- **Configured** — `last4` (labeled as a rotation check, not an identifier), who set it, when; a **Disable**
  toggle (kill switch) and a **Remove** button, distinct from each other.
- **Non-admin member** — read-only status ("voice is configured by an org admin"), no key field.

**Copy that must be there, plainly:** enabling voice funds **every operator-tier member's** voice dispatches
(including spawning agents against the org's repos) on the org's own OpenAI key. And: glance can show you *who
minted*, never *what was spent* — audio never transits the daemon, so **no dollar figures anywhere in this UI**.

The existing voice call button needs no change — it's probe-driven and starts rendering once the server says
`enabled:true`.

## Cross-Repo Side Effects
None.

## Verify
- Renders all three states (unconfigured / configured / non-admin) — SSR-render assertions, this suite's
  convention (no jsdom).
- The key never reaches `localStorage` and never appears in a console log (assert on the module's calls).
- Save → verify → error path surfaces the server's message; a rejected key leaves the card in "not configured".
- Disable and Remove are visually and behaviorally distinct (a disable must not read as a delete).
- No dollar figure appears anywhere in the rendered output (grep the render).

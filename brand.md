# Brand — glance

The design system distilled from the login. Use this as the source of truth for color, type, voice, logo,
and component styling across all glance surfaces. When building any UI, match these tokens rather than
inventing new values.

> **Positioning.** glance is oversight for an autonomous engineering fleet — you *glance*, and you know.
> The brand is **cinematic, spare, and quietly powerful**: deep ink, a single warm ember of focus, and a
> knowing eye. Restraint over decoration. One accent, used sparingly, means more.

---

## Logo

The **glance mark** — a radiant eye (aperture) with an ember-star pupil. The eye + rays are `currentColor`
(so the mark inverts for light/dark automatically); the star is always ember.

- **Component:** `webapp/src/components/GlanceLogo.tsx` — `<GlanceLogo size={n} />`. Parametric SVG, crisp
  at any size. Set the mark color via the parent's text color (e.g. `text-gray-900 dark:text-gray-100`).
- **Lockup:** mark + `glance` wordmark (lowercase, geometric sans, `font-semibold tracking-tight`).
- **Favicon:** the ember 4-point star alone (the pupil) — the only element legible at 16px.
- **Hero key art:** the cinematic "digital monk / eye" renders live in `webapp/src/assets/` — for login,
  marketing, loading, OG. Never use the key art as a small logo (it dissolves below ~200px).
- **Don't:** recolor the star anything but ember · add effects/shadows to the mark · stretch the lockup ·
  place the white mark on a light background without switching it to the dark `currentColor`.

## Color

Ink-dark surfaces, a warm ember accent, a cool neutral text ramp. Hex is intentional on the pre-auth
"brand" surfaces (login); in-app, prefer the shared CSS variables (see note below).

### Surfaces (dark, brand-forward)
| Token | Hex | Use |
|---|---|---|
| `ink` | `#0A0A0B` | page backdrop |
| `panel` | `#0C0C0E` | card / panel |
| `surface` | `#151517` | inputs, raised fills |
| `surface-2` | `#0F0F11` | secondary buttons |
| `border` | `#1C1C20` | hairlines |
| `border-2` | `#2A2A2E` | input / control borders |

### Ember accent (the one warm signal)
| Token | Hex | Use |
|---|---|---|
| `ember` | `#F0A35A` | primary accent, focus rings, logo star, glow |
| `ember-link` | `#F0B478` | links, interactive text |
| `ember-hi` | `#FFF6EA` | white-hot highlight (star core) |
| `ember-glow` | `rgba(240,163,90,0.10)` | ambient glow, button underglow |

Use ember for **one** focal thing per view (the primary action, a link, a live signal). Never fill large
areas with it — it's a spark, not a wash.

### Text (cool neutral ramp, on ink)
| Token | Hex | Use |
|---|---|---|
| `text` | `#FFFFFF` / `#F4F4F5` | headings, wordmark |
| `text-body` | `#E7E7E9` | body |
| `text-label` | `#C7C7CC` | form labels |
| `text-muted` | `#8A8A90` | secondary / subcopy |
| `text-subtle` | `#5C5C62` | placeholders, footnotes |

### Semantic
`danger #F87171` · `success #4ADE80` · `warning #FBBF24`.

> **In-app tokens.** The dashboard uses the shared `--wf-*` CSS variables in `webapp/src/index.css` with a
> light default + dark mode. Its accent is currently **indigo** (`#4f46e5` / `#818cf8`) — a **follow-up** is
> to migrate that accent to **ember** so the whole product matches the login brand. Until then: login &
> pre-auth = ember (this guide); dashboard = `--wf-*` tokens.

## Typography

- **UI sans:** the system sans stack (`-apple-system, "Segoe UI", Roboto, …`). Headings `font-semibold
  tracking-tight`; body regular.
- **Mono:** `"JetBrains Mono", ui-monospace` for code, ids, counts, timestamps.
- **Wordmark:** `glance`, always lowercase, geometric, `font-semibold tracking-tight`.
- **Scale (login reference):** H1 ~26px/tight · label 13px/medium · body 13.5px · caption 11–12px.

## Voice & tone

Confident, spare, a touch cinematic. Address the operator directly; imply capability without hype.

- **Yes:** "Welcome back." · "Sign in to command your fleet." · "Request pending approval." ·
  "Protected by end-to-end encrypted sessions."
- **No:** exclamation marks, "Oops!", filler ("Please click here to…"), buzzwords. Prefer 3 words to 8.
- Sentence case everywhere except the wordmark (lowercase) and short all-caps labels ("OR").

## Motion

Subtle and purposeful; always `prefers-reduced-motion`-safe.

- Entrance: a 0.5s ease-out rise+fade (`login-rise`). Micro-interactions: `active:scale-[0.99]`, color/border
  transitions ~150ms. Ease `cubic-bezier(0.22, 1, 0.36, 1)`.
- Never animate `all`; never move essential content. No bouncy/springy easing.

## Texture

Two atmospheric touches, used at a whisper:
- **Ember glow:** a large, soft, low-opacity ember radial behind the focal area (`bg-ember/10 blur-[110px]`).
- **Film grain:** a faint inline-SVG `feTurbulence` overlay (`opacity ~0.035, mix-blend-overlay`) — CSP-safe,
  echoes the key art's grain. See `GRAIN` in `Login.tsx`.

## Components

- **Inputs:** `rounded-lg`, `bg-surface`, `border-border-2`, leading icon in `text-subtle`, focus →
  `border-ember/50 ring-2 ring-ember/20`. Always labeled, correct `type` + `autocomplete`.
- **Primary button:** white fill, black text, `rounded-lg`, warm ember **underglow** shadow, `active:scale`,
  ember focus ring. One per view.
- **Secondary / social button:** `bg-surface-2`, `border-border-2`, hover lifts the border; ember focus ring.
- **Links:** `ember-link`, medium weight, underline-offset on hover.
- **Focus:** every interactive element shows a visible ember focus-visible ring. Never remove focus rings.

## Non-negotiables

Real `<button>`/`<a>` (never `div onClick`) · visible focus rings · ≥44px hit targets · loading/empty/error
states · AA contrast · dark-mode correct · labels + `autocomplete` on forms · icons `aria-hidden` or labeled ·
one ember focal point per view.

# Push-based blocked-agent attention

## Outcome
When a unit blocks on a human, the operator's phone/desktop buzzes — unit name, reason, one-tap deep link — **even with the glance tab closed**. cmux's most-loved feature ("Notification Rings"), on glance's cross-device web form. v1 wires the React app to the VAPID/service-worker push stack that **already exists and works** (backend unchanged), plus a blocked-longest sort.

## Work
| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 — Wire background web-push into the React app | The full push backend + service worker + manifest/icons already ship (`src/push.ts`, `/api/push/*`, `src/web/sw.js`, `PUBLIC_ASSETS`), consumed only by the legacy UI. The React app has zero push wiring. | mechanical | `webapp/index.html`, `webapp/src/main.tsx`, `webapp/src/lib/push.ts` (new), `webapp/src/components/AccountMenu.tsx` |
| 02 — blocked-longest sort on the attention panel | Panel sorts freshest-first today; cmux rings are rankable by who's been blocked longest. Cheap real win on the existing gold-standard panel. | mechanical | `webapp/src/lib/insights.ts`, `webapp/src/components/AttentionPanel.tsx`, `webapp/src/lib/insights.test.ts` |
| 03 — (DEFERRED, v2) harness-agnostic `glance notify` + `AttentionEvent` | Agent-*declared* attention across non-omp harnesses. Corrected design captured after 2 red teams killed the draft's version. Not built in v1. | research | (documented only) |

## Order
| Batch | Concerns | Why together |
|---|---|---|
| 1 | 01, 02 | Disjoint files (push wiring vs insights/panel sort) — parallelizable. Backend untouched. |
| — | 03 | Deferred to a separate v2 plan/PR. |

## Dependency graph
| Concern | Blocked by | 30s check |
|---|---|---|
| 01 | none | `grep -rc 'serviceWorker' webapp/src` = 0 (no existing SW wiring) |
| 02 | none | `attentionItems(` in `webapp/src/lib/insights.ts` takes no sort param today |
| 03 | 01 (delivery must exist before agent-declared attention is worth pushing) | deferred |

## Status
- **v1 SHIPPED** (2026-07-06): concerns 01 + 02 closed. webapp typecheck/build clean, 555 webapp tests pass, zero backend changes. Push contract live-driven against a throwaway daemon (caught + fixed a bearer-auth bug the code-read missed). Concern 03 (`glance notify` harness-agnostic primitive) deferred to a v2 plan/PR with its corrected design captured.

## Notes
- **Backend push is unchanged.** `escalationPayload` (`src/server.ts:293`) already fires on `input`/`error` with the reason in the body, `/#/agent/<id>` deep link, `tag`-collapse, 3s/agent debounce. v1 is React-app wiring only.
- **Push is blocking-only** (high-signal, cmux-parity). Non-blocking attention stays a quiet panel row. Hard rule.
- **iOS caveat**: web-push needs the PWA added to the home screen; manifest+icons already exist as public assets, so the path exists. State it, don't hide it.
- WIP snapshot at plan time: 45 plans with open concerns (oldest `meta-autonomous-fleet`, 2026-07-05); proceeded per user's "do it" on this research→plan chain.
- Full rationale + red-team kills in `DESIGN.md`.

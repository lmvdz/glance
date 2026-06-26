# Embeddable screenshot widget

STATUS: closed
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/web/feedback-widget.js (new), src/server.ts, tests/feedback-widget.test.ts (new)
BLOCKED_BY: 02-public-campaign-intake-api.md

## Goal

Provide the smallest useful user-facing capture surface: an embeddable widget that submits screenshot + annotation + text to `/api/feedback/items`.

## Approach

### 1. Delivery
Serve `GET /feedback/widget.js` from `src/web/feedback-widget.js` when `OMP_SQUAD_FEEDBACK=1`.

Usage:

```html
<script src="https://<omp-squad-host>/feedback/widget.js"
        data-campaign="camp_..."
        data-token="public_campaign_token"></script>
```

The widget reads `data-campaign` and `data-token`, renders a small "Feedback" button, and POSTs to the configured host.

### 2. Capture
MVP path:

- user clicks button;
- browser calls `navigator.mediaDevices.getDisplayMedia({ video: true })`;
- attach stream to hidden video;
- draw one frame to canvas;
- stop tracks immediately;
- allow basic freehand/highlight drawing on canvas;
- collect title/description/kind;
- submit base64 PNG.

Fallback: if `getDisplayMedia` is unavailable or denied, submit text-only feedback with metadata.

### 3. Metadata
Include:

- `location.href`;
- `navigator.userAgent`;
- viewport size;
- optional app-provided user metadata from `window.FeedbackLoop.identify({...})`.

### 4. Constraints
No npm package, bundler, React, or dependency. One plain JS file. Ponytail: styling is minimal inline CSS; upgrade to package/SDK only after embed demand is proven.

## Cross-Repo Side Effects

The widget is public static JS. Do not embed operator tokens or admin API URLs. Public route uses campaign token only.

## Verify

- `tests/feedback-widget.test.ts`: static file contains no `OMP_SQUAD_TOKEN`, `PLANE_API_KEY`, or admin route strings except `/api/feedback/items`.
- Manual browser smoke: widget loads, denial fallback submits text-only, successful capture submits screenshot under size cap.

## Resolution

Implemented a dependency-free embeddable widget with campaign/token config, `FeedbackLoop.identify`, screenshot capture, canvas annotation, text fallback, public intake POST, and static safety tests.

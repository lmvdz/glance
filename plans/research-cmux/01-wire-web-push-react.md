# Wire background web-push into the React app
STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: mechanical
TOUCHES: webapp/index.html, webapp/src/main.tsx, webapp/src/lib/push.ts, webapp/src/components/AccountMenu.tsx

## Goal
The React `webapp/` subscribes to the **existing** VAPID web-push backend so a blocked unit fires a real background OS notification (app closed, laptop asleep, phone in pocket) with the unit name, the reason, and a one-tap deep link. Backend is unchanged — this is pure client wiring, reusing code already proven in the legacy `src/web/index.html`.

## Context (verified, do not re-derive)
- Service worker `src/web/sw.js` (handles `push` → `showNotification`, `notificationclick` → focus + deep-link) is served **tokenless at `/sw.js`** from `PUBLIC_ASSETS` (`src/server.ts:119`, served at `:624`). `/manifest.webmanifest`, `/icon.svg`, `/icon-192.png`, `/icon-512.png` are likewise public assets and all exist in `src/web/`. Same origin as the React app.
- `GET /api/push/key` → `{ publicKey }` and `POST /api/push/subscribe` (`src/server.ts:823-832`). **CORRECTED (verified live): these ARE bearer-gated in file mode** — a bare `fetch` returns 401. An outer `/api/*` auth gate runs before the handler. The React app must attach auth via `apiFetch` (`webapp/src/lib/api.ts`, sets `Authorization: Bearer <token>` from localStorage), exactly like every other React API call — NOT a raw `fetch`. (The legacy UI works because it fetches from a `?token=`-seeded session; the initial code-read and red-team both missed the gate.)
- Backend push already fires: `maybePushAlert` → `escalationPayload` (`src/server.ts:293-300`) on every transition into `input`/`error`; body = `a.pending[0]?.title` (the reason), `url = /#/agent/<id>`, `tag = a.id`. Nothing to change server-side.
- The React `webapp/` has **zero** `serviceWorker`/`Notification`/`/api/push` references today (verified).
- Reusable source to copy verbatim: `src/web/index.html:2473-2492` (`urlB64ToUint8Array`, `subscribePush`), and the guarded register at `:2509`.

## Approach
1. **`webapp/src/lib/push.ts` (new)** — port from the legacy inline script:
   ```ts
   function urlB64ToUint8Array(b64: string): Uint8Array {
     const padding = "=".repeat((4 - (b64.length % 4)) % 4);
     const base64 = (b64 + padding).replace(/-/g, "+").replace(/_/g, "/");
     const raw = atob(base64);
     return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
   }

   export async function subscribePush(): Promise<boolean> {
     if (!("serviceWorker" in navigator) || !("PushManager" in window)) return false;
     const reg = await navigator.serviceWorker.ready;
     const r = await fetch("/api/push/key");
     if (!r.ok) return false;
     const { publicKey } = await r.json();
     if (!publicKey) return false;
     let sub = await reg.pushManager.getSubscription();
     if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(publicKey) });
     const res = await fetch("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub) });
     return res.ok;
   }

   /** Call ONLY from a user gesture (browsers reject permission requests otherwise). */
   export async function enablePush(): Promise<"granted" | "denied" | "unsupported"> {
     if (typeof Notification === "undefined") return "unsupported";
     let perm = Notification.permission;
     if (perm === "default") perm = await Notification.requestPermission();
     if (perm !== "granted") return "denied";
     return (await subscribePush()) ? "granted" : "denied";
   }

   export function pushPermission(): NotificationPermission | "unsupported" {
     return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
   }
   ```
2. **`webapp/src/main.tsx`** — register the SW on load and *silently re-subscribe* if permission is already granted (endpoints rotate); never request permission here:
   ```ts
   if ("serviceWorker" in navigator) {
     navigator.serviceWorker.register("/sw.js")
       .then(() => { if (typeof Notification !== "undefined" && Notification.permission === "granted") void import("./lib/push").then((m) => m.subscribePush()); })
       .catch(() => {});
   }
   ```
   Match existing style; place after the React root render.
3. **`webapp/index.html`** — link the manifest so the PWA/home-screen install path (needed for iOS push) works:
   ```html
   <link rel="manifest" href="/manifest.webmanifest" />
   ```
   Add in `<head>` next to the existing meta tags.
4. **`webapp/src/components/AccountMenu.tsx`** — add a discoverable "Background notifications" toggle. Read `pushPermission()`; on click when not granted, call `enablePush()` and `showToast(...)` the result (`"Background push enabled"` / `"Notification permission denied"`), mirroring the legacy UX (`src/web/index.html:1063-1064`). Reuse the existing `useTaskContext().showToast`. If `pushPermission() === "unsupported"`, hide/disable the row. Keep it small — one row, matching the menu's existing item styling.

## Cross-Repo Side Effects
None. Backend, service worker, manifest, icons all already exist and are unchanged.

## Verify
- `cd webapp && bun run build` (or the project's typecheck) passes.
- Drive it end-to-end (see plan AUDIT): load the React app, toggle Background notifications on (grant permission), confirm `POST /api/push/subscribe` returns `{ok:true}` (network tab / server log). Then drive a unit into `input` (e.g. an approval gate) and confirm an OS notification appears titled `⛔ <unit> needs you` with the reason as body; clicking it focuses the app at `/#/agent/<id>`. With the tab closed, the SW still renders it.
- Confirm no notification permission is requested on plain page load (only on the toggle gesture).

## Resolution
Closed. Shipped `webapp/src/lib/push.ts` (subscribe via `apiFetch`), SW registration + silent re-subscribe in `main.tsx`, manifest link in `index.html`, and a "Background notifications" toggle in `AccountMenu.tsx` **plus** the always-visible `AttentionPanel` header (the latter added in review because `AccountMenu` is `null` in file mode, where the factory runs). Live-drove a throwaway daemon (port 7991): `/sw.js`, `/manifest.webmanifest`, `/icon-192.png` serve 200 tokenless; `/api/push/key` returns a real VAPID key **with a bearer token** (401 without — the `apiFetch` fix). webapp typecheck + build clean, 555 tests pass. Un-drivable headless: the live browser permission-grant → OS notification render (needs a real browser + push service); mechanism verified up to that boundary.

import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import {installPushTapBeacon} from './lib/push-tap';
import {bootstrapViewFromQuery} from './lib/viewAlias';

// D0 (glance-desktop dashboard embedding prerequisite): a `?view=<name>` URL param, if present,
// seeds the TaskContext view before the app ever renders — the desktop shell's iframe/webview
// picks the embedded screen this way, since it can't reach across origins into localStorage.
// Must run BEFORE createRoot().render below so TaskContext's lazy useState initializer sees the
// seeded localStorage value on its first read.
bootstrapViewFromQuery();

// Push-tap adoption beacon (daily-dogfood-engine 02): if this open arrived via a push-notification
// tap (`#/agent/<id>?push=1`), report it once and strip the marker — before render, so the app
// never sees the marker as route state. Fire-and-forget; never blocks or breaks boot.
installPushTapBeacon();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Register the (tokenless, same-origin) service worker for background push, and silently
// re-subscribe if permission was already granted — endpoints rotate, so this keeps the
// subscription fresh. Never request permission here; that only happens on a user gesture.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('/sw.js')
    .then(() => {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        void import('./lib/push').then((m) => m.subscribePush());
      }
    })
    .catch(() => {});
}

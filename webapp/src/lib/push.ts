/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Wires the React app into glance's existing VAPID web-push backend (unchanged, see src/server.ts).
// Behavior matches the legacy inline UI (src/web/index.html), but the /api/push/* endpoints are
// bearer-gated in file mode (verified live: bare fetch → 401), so route through apiFetch, which
// attaches the `Authorization: Bearer <token>` header the same way every other React API call does.

import { apiFetch } from './api';

function urlB64ToUint8Array(b64: string): Uint8Array {
  const padding = '=' .repeat((4 - (b64.length % 4)) % 4);
  const base64 = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export async function subscribePush(): Promise<boolean> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  const reg = await navigator.serviceWorker.ready;
  const r = await apiFetch('/api/push/key');
  if (!r.ok) return false;
  const { publicKey } = await r.json();
  if (!publicKey) return false;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8Array(publicKey) as BufferSource,
    });
  }
  const res = await apiFetch('/api/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub) });
  return res.ok;
}

/** Call ONLY from a user gesture (browsers reject permission requests otherwise). */
export async function enablePush(): Promise<'granted' | 'denied' | 'unsupported'> {
  if (typeof Notification === 'undefined') return 'unsupported';
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm !== 'granted') return 'denied';
  return (await subscribePush()) ? 'granted' : 'denied';
}

export function pushPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

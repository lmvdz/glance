/**
 * Push-tap beacon (plans/daily-dogfood-engine/02) — the smallest honest "did a push notification
 * actually get someone to open the app" signal.
 *
 * src/push.ts appends `?push=1` to every push payload's deep link (`/#/agent/<id>?push=1`); the
 * service worker preserves the full URL on navigate/openWindow. On arrival, this module fires ONE
 * fire-and-forget POST /api/push-tap and strips the marker from the visible URL — the same
 * "strip after use" precedent as `captureToken()`'s `?token=` handling in ./api.ts. A typed or
 * clicked URL never carries the marker, so it never counts.
 *
 * Dedupe: a sessionStorage flag keyed on the exact hash guards the StrictMode/HMR remount case;
 * the immediate strip guards everything else (once stripped, the marker can't re-fire). Two lanes
 * are covered: page boot (cold open via openWindow) and `hashchange` (the sw `navigate()`s an
 * ALREADY-OPEN window, which is a same-document hash change — no reload, so boot code alone would
 * miss exactly the focused-window tap).
 */

import { apiFetch, jsonInit } from './api';

const SEEN_PREFIX = 'ompsq_push_tap:';

export interface PushTapHash {
  agentId: string;
  /** The hash with the `push` marker removed (other params, if any ever appear, are kept). */
  strippedHash: string;
}

/** Pure parse of a `#/agent/<id>?push=1[&…]` hash. Anything else — no marker, no agent route,
 *  malformed — is `null`: this beacon must never misfire on ordinary navigation. */
export function parsePushTapHash(hash: string): PushTapHash | null {
  const m = /^#\/agent\/([^?]+)\?(.+)$/.exec(hash);
  if (!m) return null;
  const params = new URLSearchParams(m[2]);
  if (params.get('push') !== '1') return null;
  params.delete('push');
  const rest = params.toString();
  let agentId: string;
  try {
    agentId = decodeURIComponent(m[1]);
  } catch {
    return null; // malformed percent-encoding — not a URL we produced
  }
  if (!agentId) return null;
  return { agentId, strippedHash: `#/agent/${m[1]}${rest ? `?${rest}` : ''}` };
}

/** Read location.hash; if it carries the tap marker, beacon once (deduped) and strip it.
 *  Never throws and never blocks render — a broken beacon must not cost the app boot. */
export function reportPushTapFromLocation(): void {
  try {
    const parsed = parsePushTapHash(location.hash);
    if (!parsed) return;
    let seen = false;
    try {
      const key = SEEN_PREFIX + location.hash;
      seen = sessionStorage.getItem(key) === '1';
      if (!seen) sessionStorage.setItem(key, '1');
    } catch {
      // storage blocked (private mode) — the strip below still bounds this to once per arrival
    }
    if (!seen) {
      void apiFetch('/api/push-tap', jsonInit('POST', { agentId: parsed.agentId })).catch(() => {});
    }
    // Strip after use (replaceState fires no hashchange, so this can't re-enter itself).
    history.replaceState(null, '', location.pathname + location.search + parsed.strippedHash);
  } catch {
    // beacons are best-effort, always
  }
}

/** Install both lanes: check the boot-time hash now, and watch for tap-driven hash changes into
 *  an already-open window. Call once from main.tsx. */
export function installPushTapBeacon(): void {
  reportPushTapFromLocation();
  window.addEventListener('hashchange', reportPushTapFromLocation);
}

/**
 * Agent deep links — `#/agent/<id>`, the shape BOTH existing producers emit: push notification
 * payloads (src/push.ts, `url: "/#/agent/<id>"`) and the webapp URL `glance here` prints
 * (src/here-web.ts `hereWebUrl`). Until this parser existed the shape routed NOWHERE — the page
 * authenticated, landed on the Overview, and silently dropped the "which session" half of the
 * link. Consumed by TaskContext's agent-hash listener, which opens the agent's console chat.
 * DOM-free per this webapp's convention (see lib/plan-doc-review.ts's parseReviewHash twin).
 *
 * Query-string suffix: push.ts appends `?push=1` to its deep link
 * (`/#/agent/<id>?push=1`), and ./push-tap.ts's beacon strips that marker via
 * `history.replaceState` before this parser ever runs — in normal boot order the beacon always
 * wins the race. But that's install-order coupling, not a parser invariant: this function must
 * never depend on running after the beacon. So the id capture itself stops at the first raw `?`
 * (a query-string delimiter, never part of a legitimately encoded id — `encodeURIComponent`,
 * which both producers use, escapes `?` to `%3F`), and only the id portion is decoded. This is
 * defense in depth, not a replacement for the beacon's strip: the beacon still owns the
 * /api/push-tap report and the visible-URL cleanup.
 */

/** Parse `#/agent/<id>` into the agent id, or undefined when the hash isn't an agent deep link.
 *  Any `?...` suffix on the id (a push-tap marker or otherwise) is dropped, never included in
 *  the returned id. */
export function parseAgentHash(hash: string): string | undefined {
  const m = /^#\/agent\/(.+)$/.exec(hash);
  if (!m) return undefined;
  const id = decodeURIComponent(m[1].split('?')[0]);
  return id || undefined;
}

/**
 * Agent deep links — `#/agent/<id>`, the shape BOTH existing producers emit: push notification
 * payloads (src/push.ts, `url: "/#/agent/<id>"`) and the webapp URL `glance here` prints
 * (src/here-web.ts `hereWebUrl`). Until this parser existed the shape routed NOWHERE — the page
 * authenticated, landed on the Overview, and silently dropped the "which session" half of the
 * link. Consumed by TaskContext's agent-hash listener, which opens the agent's console chat.
 * DOM-free per this webapp's convention (see lib/plan-doc-review.ts's parseReviewHash twin).
 */

/** Parse `#/agent/<id>` into the agent id, or undefined when the hash isn't an agent deep link. */
export function parseAgentHash(hash: string): string | undefined {
  const m = /^#\/agent\/(.+)$/.exec(hash);
  if (!m) return undefined;
  const id = decodeURIComponent(m[1]);
  return id || undefined;
}

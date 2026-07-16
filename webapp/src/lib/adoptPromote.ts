/**
 * Promote/adopt bridge (plans/daily-onramp/06-promote-adopt-ui.md) — the client half of two
 * server calls that were fully built and had ZERO webapp callers:
 *
 *   - `POST /api/agents/:id/promote` — flip a console/`glance here` chat into a gated working
 *     unit IN PLACE (same agent id, same transcript; the server strips only the console prompt
 *     and stamps `promoted`). Idempotent server-side, so a retry is always safe.
 *   - `POST /api/agents/adopt` — wrap a presence-detected ad-hoc CLI session's uncommitted work
 *     in a fresh worktree + gated unit, leaving the developer's checkout untouched.
 *
 * Everything here is a pure/DI'd module (no React, fetcher injectable) so the visibility gates
 * and request/response handling are unit-testable without a DOM. The SERVER stays authoritative
 * on every gate: `isPromotableChat`/`adoptableSessions` only decide what to OFFER; a 409's
 * `reason` is returned verbatim for the surface to show, never rewritten.
 */
import { apiFetch, jsonInit } from './api';
import type { AgentDTO } from './dto';

/** Mirrors `src/presence.ts`'s PresenceEntry — the row shape `GET /api/presence` returns. */
export interface PresenceEntryDTO {
  /** Claim id. Harness-hook sessions (the adoptable kind) use the deterministic
   *  `harness-<hash>` shape; server-minted cockpit/squad rows do not. */
  id: string;
  /** Absolute repo root the session is working (harness hooks always claim the
   *  registered project root, so this doubles as adopt's `cwd`). */
  repo: string;
  repoName: string;
  operator: string;
  /** Display label — `<harness>:<sessionId>` for harness-hook rows. */
  agent: string;
  branch?: string;
  task?: string;
  source: 'squad' | 'omp' | 'other';
  startedAt?: number;
  heartbeat: number;
}

/** One offerable "ad-hoc session detected" card, derived from a presence row. */
export interface AdoptableSession {
  /** The presence claim id — stable per session, used as the React key + busy marker. */
  claimId: string;
  harness: string;
  sessionId: string;
  /** What `POST /api/agents/adopt` wants as `cwd` (the registered project root the hook claimed). */
  cwd: string;
  repoName: string;
  branch?: string;
  operator: string;
  heartbeat: number;
  startedAt?: number;
  /** Human-readable `<harness>:<sessionId>` for toasts/titles. */
  label: string;
}

/** `{ok:false, reason}` (409) or `{ok:true, agent}` (200) — the exact JSON both server routes
 *  answer with (`Response.json(result, {status})`, server.ts). */
export interface BridgeResult {
  ok: boolean;
  reason?: string;
  agent?: AgentDTO;
}

/** The wire-visible subset of the server's own promote gate (squad-manager.ts `promote()`):
 *  a plain `omp-operator` unit named "chat" with no role/workflow/lineage, not yet promoted.
 *  The one server-side input that never crosses the wire (`isConsolePrompt` over the private
 *  appendSystemPrompt) stays the server's job — if this offers a button the server refuses,
 *  the 409 `reason` is surfaced verbatim rather than second-guessed here. */
export function isPromotableChat(
  agent: Pick<AgentDTO, 'kind' | 'name' | 'promoted' | 'executionRole' | 'workflow' | 'parentId'> | null | undefined,
): boolean {
  if (!agent) return false;
  return agent.kind === 'omp-operator' && agent.name === 'chat' && !agent.promoted && !agent.executionRole && !agent.workflow && !agent.parentId;
}

/** Split a harness-hook presence label (`<harness>:<sessionId>`) at the FIRST colon — session
 *  ids may themselves contain colons; harness names never do (harness-hooks.ts builds the label
 *  as a plain template). Null when the label doesn't carry both halves. */
export function parseAdhocLabel(label: string): { harness: string; sessionId: string } | null {
  const at = label.indexOf(':');
  if (at <= 0 || at === label.length - 1) return null;
  return { harness: label.slice(0, at), sessionId: label.slice(at + 1) };
}

/** The deterministic claim-id prefix `claimIdForSession` (src/harness-hooks.ts) mints. Only rows
 *  with this prefix came through the harness-hook reporting path `adopt` validates against —
 *  a cockpit human-presence row (`glance-cockpit:s1`, server-minted id) or a squad agent's own
 *  claim would be a guaranteed-409 dead-end card, so they are never offered. */
const HARNESS_CLAIM_PREFIX = 'harness-';

/** Presence rows → offerable adopt cards. Fail-closed: anything that isn't a live harness-hook
 *  session with a parseable `<harness>:<sessionId>` label is dropped, not guessed at. */
export function adoptableSessions(entries: PresenceEntryDTO[]): AdoptableSession[] {
  const out: AdoptableSession[] = [];
  for (const entry of entries) {
    if (entry.source !== 'other' || !entry.id.startsWith(HARNESS_CLAIM_PREFIX)) continue;
    const parsed = parseAdhocLabel(entry.agent);
    if (!parsed || !entry.repo) continue;
    out.push({
      claimId: entry.id,
      harness: parsed.harness,
      sessionId: parsed.sessionId,
      cwd: entry.repo,
      repoName: entry.repoName,
      branch: entry.branch,
      operator: entry.operator,
      heartbeat: entry.heartbeat,
      startedAt: entry.startedAt,
      label: entry.agent,
    });
  }
  return out;
}

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

/** POST + decode the shared `{ok, reason?, agent?}` result shape. A non-JSON body (auth gate,
 *  proxy error page) is folded into an `ok:false` with the raw text as the reason — the caller
 *  always gets something honest to show, never a swallowed failure. */
async function postBridge(path: string, body: unknown, fetcher: Fetcher): Promise<BridgeResult> {
  const res = await fetcher(path, jsonInit('POST', body));
  const parsed = (await res.json().catch(() => null)) as BridgeResult | null;
  if (parsed && typeof parsed.ok === 'boolean') return parsed;
  return { ok: false, reason: `HTTP ${res.status}${res.statusText ? ` — ${res.statusText}` : ''}` };
}

/** `POST /api/agents/:id/promote`. v1 sends a bare promote (no synthesized task summary) — the
 *  server's idempotent re-steer makes promote-then-prompt-later explicitly safe (concern doc). */
export function promoteChat(agentId: string, task?: string, fetcher: Fetcher = apiFetch): Promise<BridgeResult> {
  return postBridge(`/api/agents/${encodeURIComponent(agentId)}/promote`, task?.trim() ? { task: task.trim() } : {}, fetcher);
}

/** `POST /api/agents/adopt` with exactly the fields the presence entry carries — the server
 *  re-validates everything (git root binding, live claim id, re-adopt refusal) and answers 409
 *  `{ok:false, reason}` shapes this returns untouched for verbatim display. */
export function adoptSession(session: Pick<AdoptableSession, 'harness' | 'sessionId' | 'cwd'>, fetcher: Fetcher = apiFetch): Promise<BridgeResult> {
  return postBridge('/api/agents/adopt', { harness: session.harness, sessionId: session.sessionId, cwd: session.cwd }, fetcher);
}

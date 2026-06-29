/**
 * Fleet activity — the narrative half of "what's going on?" that the live roster
 * can't tell you. The Active Work join answers the PRESENT ("what's being worked
 * on right now"); this answers the RECENT PAST ("what did the fleet actually do
 * while I was away — what landed, what it spawned, what broke"). Source is the
 * append-only audit log (GET /api/audit): every operator- and loop-initiated
 * mutation, including the one event that must never be silent — a `catastrophe`
 * (the orchestrator summoning a human).
 *
 * Pure + tested so the pane and the assistant digest narrate from one synthesis.
 */

import type { AuditEntry, AgentDTO } from './dto';

export type FleetActivityKind = 'good' | 'bad' | 'neutral';
export type FleetActivityVerdict = 'critical' | 'warn' | 'healthy';

/** One humanized line of the fleet narrative. */
export interface FleetActivityLine {
  id: number;
  at: number;
  actor: string;
  action: string;
  /** humanized verb, e.g. "landed", "spawned", "answered". */
  verb: string;
  /** readable handle for the work unit (resolved agent name, or trimmed target slug). */
  subject: string;
  outcome: 'ok' | 'error';
  detail?: string;
  /** good (land/create ok) · bad (catastrophe/error/kill) · neutral (answer/prompt/…). */
  kind: FleetActivityKind;
}

/** Rolled-up counts over the window — drives the stat row and the pane's verdict. */
export interface FleetActivityRollup {
  windowMs: number;
  total: number;
  landed: number;
  spawned: number;
  answered: number;
  removed: number;
  catastrophes: number;
  /** error-outcome events that are NOT catastrophes (those are counted on their own). */
  errors: number;
  verdict: FleetActivityVerdict;
  /** "landed 12 · spawned 5 · 1 catastrophe" — only the non-zero parts. */
  headline: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Past-tense verb for an audit action. */
function verbFor(action: string): string {
  switch (action) {
    case 'land': return 'landed';
    case 'create': return 'spawned';
    case 'answer': return 'answered';
    case 'plan-answer': return 'answered a plan question on';
    case 'remove': return 'removed';
    case 'kill': return 'stopped';
    case 'interrupt': return 'interrupted';
    case 'set-model': return 'switched model on';
    case 'prompt': return 'prompted';
    case 'catastrophe': return 'hit a catastrophe on';
    default: return action;
  }
}

function kindFor(action: string, outcome: 'ok' | 'error'): FleetActivityKind {
  if (action === 'catastrophe' || outcome === 'error') return 'bad';
  if (action === 'kill' || action === 'remove' || action === 'interrupt') return 'bad';
  if (action === 'land' || action === 'create') return 'good';
  return 'neutral';
}

/**
 * Compact readable handle for an audit target. Targets are agent ids like
 * "ompsq-391-mqyq717u-t-5c67c880" or "vpb-01-authoring-mqyi1tmy-5-f7dab73d" —
 * a slug followed by generated id/hash segments. Resolve a live agent first;
 * otherwise keep the leading human-readable slug, dropping the id tail.
 */
export function shortTarget(target: string | null | undefined, byId?: Map<string, AgentDTO>): string {
  if (!target) return 'the fleet';
  const live = byId?.get(target);
  if (live) return live.name;
  const segs = target.split('-');
  const out: string[] = [];
  for (const s of segs) {
    // Stop at the first generated-id chunk: an 8-hex hash, or 8+ alnum mixing letters and digits.
    if (/^[0-9a-f]{8}$/i.test(s)) break;
    if (s.length >= 8 && /\d/.test(s) && /[a-z]/i.test(s)) break;
    out.push(s);
  }
  return out.join('-') || segs[0] || target;
}

/** Newest-first narrative lines (the audit log is already newest-first; we humanize + cap). */
export function fleetActivityLines(audit: AuditEntry[] | null | undefined, agents?: AgentDTO[] | null, limit = 14): FleetActivityLine[] {
  const entries = audit ?? [];
  const byId = new Map((agents ?? []).map((a) => [a.id, a]));
  return entries.slice(0, limit).map((e) => {
    const outcome: 'ok' | 'error' = e.outcome === 'error' ? 'error' : 'ok';
    return {
      id: e.id,
      at: e.at,
      actor: e.actor,
      action: e.action,
      verb: verbFor(e.action),
      subject: shortTarget(e.target, byId),
      outcome,
      detail: e.detail,
      kind: kindFor(e.action, outcome),
    };
  });
}

/** Roll up the audit log over a trailing window (default 24h). */
export function fleetActivityRollup(audit: AuditEntry[] | null | undefined, now = Date.now(), windowMs = DAY_MS): FleetActivityRollup {
  const cutoff = now - windowMs;
  const recent = (audit ?? []).filter((e) => e.at >= cutoff);
  let landed = 0, spawned = 0, answered = 0, removed = 0, catastrophes = 0, errors = 0;
  for (const e of recent) {
    switch (e.action) {
      case 'land': landed++; break;
      case 'create': spawned++; break;
      case 'answer': case 'plan-answer': answered++; break;
      case 'remove': removed++; break;
      case 'catastrophe': catastrophes++; break;
    }
    if (e.outcome === 'error' && e.action !== 'catastrophe') errors++;
  }
  const verdict: FleetActivityVerdict = catastrophes > 0 ? 'critical' : errors > 0 ? 'warn' : 'healthy';
  const parts: string[] = [];
  if (landed) parts.push(`landed ${landed}`);
  if (spawned) parts.push(`spawned ${spawned}`);
  if (answered) parts.push(`answered ${answered}`);
  if (removed) parts.push(`removed ${removed}`);
  if (catastrophes) parts.push(`${catastrophes} catastrophe${catastrophes === 1 ? '' : 's'}`);
  if (errors) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
  return {
    windowMs,
    total: recent.length,
    landed, spawned, answered, removed, catastrophes, errors,
    verdict,
    headline: parts.length ? parts.join(' · ') : 'quiet — no fleet actions in the window',
  };
}

/**
 * Compact plain-text snapshot of recent fleet activity for the assistant's prompt,
 * so chat can answer "what happened while I was away?" from the same synthesis the
 * pane renders. Leads with the rollup, then the most recent lines.
 */
export function fleetActivityDigest(rollup: FleetActivityRollup, lines: FleetActivityLine[], limit = 6): string {
  if (rollup.total === 0 && lines.length === 0) return 'Fleet activity: quiet — no recent fleet actions on record.';
  const head = `Fleet activity (last ${Math.round(rollup.windowMs / (60 * 60 * 1000))}h): ${rollup.headline}.`;
  const body = lines.slice(0, limit).map((l) => {
    const bad = l.kind === 'bad' ? '⚠ ' : '';
    const detail = l.detail ? ` — ${l.detail.length > 80 ? `${l.detail.slice(0, 79)}…` : l.detail}` : '';
    return `- ${bad}${l.actor} ${l.verb} ${l.subject}${detail}`;
  });
  return `${head}\n${body.join('\n')}`;
}

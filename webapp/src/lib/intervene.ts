/**
 * Intervene — pure logic for the step-in surface (IntervenceView).
 *
 * The Intervene View is the moment the whole hands-off promise is cashed: a "Needs
 * you" push fires, you tap in, and this screen must answer — without a scroll or a
 * second click — what the agent is doing, why it stopped, what it has changed, whether
 * it's on track, and the ONE action that resolves it. All of that derivation lives here
 * (DOM-free, unit-tested per this webapp's convention); the component is just chrome.
 */

import type { AgentDTO, FeatureDecisionDTO } from './dto';
import { isValidatorHeld, isVetoed } from './agent-badges';

export type InterveneTone = 'critical' | 'warn' | 'info' | 'neutral' | 'success';

/**
 * The single most important line on the screen: why this agent needs you right now.
 * Ordered by urgency so the loudest true reason wins — a pending question outranks a
 * generic error, a veto outranks "ready to land". Returns a calm working/idle line when
 * nothing is actually wrong (the Intervene View is reachable for any agent, not only
 * blocked ones).
 */
export function whyStopped(agent: Pick<AgentDTO, 'status' | 'pending' | 'error' | 'blockedReason' | 'validation' | 'landReady' | 'activity'>): { label: string; tone: InterveneTone } {
  const pending = agent.pending?.[0];
  if (pending) return { label: `Waiting on you — ${pending.title}`, tone: 'critical' };
  if (agent.status === 'error') return { label: agent.error ? `Errored — ${firstLine(agent.error)}` : 'Errored', tone: 'critical' };
  if (agent.blockedReason) return { label: `Blocked — ${agent.blockedReason}`, tone: 'critical' };
  if (agent.status === 'input') return { label: 'Awaiting input', tone: 'warn' };
  if (isVetoed(agent)) return { label: 'Validator vetoed the last land — review the change', tone: 'warn' };
  if (agent.validation?.verdict === 'inconclusive') {
    return { label: 'Validator diff inconclusive (git fault) — retrying automatically', tone: 'warn' };
  }
  if (agent.landReady) return { label: 'Ready to land — needs your go', tone: 'success' };
  if (agent.status === 'working') return { label: agent.activity ? `Working — ${agent.activity}` : 'Working', tone: 'info' };
  if (agent.status === 'stopped') return { label: 'Stopped', tone: 'neutral' };
  return { label: agent.activity || 'Idle', tone: 'neutral' };
}

export type IntervenePrimaryAction = 'answer' | 'steer' | 'restart' | 'land' | 'none';

/**
 * The one action the "resolve it" button performs, derived from the same urgency order as
 * `whyStopped` so the button and the reason never disagree: answer a pending question,
 * restart a dead run, land a ready one, else steer a live one.
 */
export function intervenePrimaryAction(agent: Pick<AgentDTO, 'status' | 'pending' | 'validation' | 'landReady'>): IntervenePrimaryAction {
  if (agent.pending?.length) return 'answer';
  if (agent.status === 'error' || agent.status === 'stopped') return 'restart';
  if (agent.landReady && !isValidatorHeld(agent)) return 'land';
  if (agent.status === 'working' || agent.status === 'input' || agent.status === 'idle' || agent.status === 'starting') return 'steer';
  return 'none';
}

/**
 * The targeted-steer message a diff-line comment sends. This is the "correct without taking
 * over" tool: you annotate the exact line that's wrong and the agent re-does it, so you never
 * touch a keyboard in anger. The file + the verbatim changed line make the reference
 * unambiguous even without line numbers (which unified diffs don't carry per-line).
 */
export function diffLineSteerMessage(file: string, lineText: string, comment: string): string {
  const trimmedLine = lineText.replace(/\n+$/, '');
  const trimmedComment = comment.trim();
  return `Re \`${file}\`, this changed line:\n\n    ${trimmedLine}\n\n${trimmedComment}`;
}

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx';

/** Classify one unified-diff line for coloring + whether it's commentable (only real +/- edits are). */
export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (/^(diff |index |new file|deleted file|rename |similarity |old mode|new mode|Binary )/.test(line)) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

export interface DiffLine {
  /** stable index within the file's diff (used as a React key and a comment target) */
  i: number;
  kind: DiffLineKind;
  text: string;
}

/** Split a unified-diff blob into classified lines for rendering. Empty/undefined → []. */
export function splitDiffLines(diff: string | undefined): DiffLine[] {
  if (!diff) return [];
  const lines = diff.replace(/\n$/, '').split('\n');
  return lines.map((text, i) => ({ i, kind: classifyDiffLine(text), text }));
}

/** Only added/removed lines are worth commenting on — you correct an *edit*, not context. */
export function isCommentableLine(kind: DiffLineKind): boolean {
  return kind === 'add' || kind === 'del';
}

/** +N / -N added/removed counts for a file's diff, for the per-file stat chip. */
export function diffLineStats(diff: string | undefined): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const { kind } of splitDiffLines(diff)) {
    if (kind === 'add') added++;
    else if (kind === 'del') removed++;
  }
  return { added, removed };
}

function firstLine(s: string): string {
  return s.split('\n')[0].slice(0, 200);
}

// =================================================================================================
// Delta bullets (comprehension concern 08): the bound feature's `source:"model-delta"` decisions
// this UNIT itself recorded, rendered above the diff spine as the teaching moment. `FeatureDTO.decisions`
// is already fetched app-wide (GET /api/features, TaskContext's `features`) and already carries
// `evidence`/`sourceRef` on the wire (see dto.ts's `FeatureDecisionDTO` doc) — no new route needed.
// =================================================================================================

export const MAX_DELTA_BULLETS = 3;

export interface DeltaBullet {
  id: string;
  text: string;
  /** Evidence anchors this bullet was recorded with — always non-empty in practice (the backend's
   *  record-time validator rejects anchorless model-delta decisions, DESIGN.md's "Delta quality
   *  floor"), but this reads a stored/serialized value, so an empty array is handled, never assumed. */
  evidence: string[];
}

/**
 * This unit's own model-delta decisions from its bound feature, newest first, capped at
 * `MAX_DELTA_BULLETS`. Filtered to `source === 'model-delta' && sourceRef.agentId === agentId` — a
 * feature shared by two units must never render the OTHER unit's teaching under this diff (the same
 * discipline `prBodyFor` applies server-side for the PR body projection). No feature bound, no
 * agentId, or zero matching decisions all yield `[]` — the empty state renders nothing, no
 * placeholder nagging (DESIGN.md's "Delta bullets above the diff" row).
 */
export function deltaBullets(decisions: FeatureDecisionDTO[] | undefined, agentId: string | undefined): DeltaBullet[] {
  if (!decisions?.length || !agentId) return [];
  return decisions
    .filter((d) => d.source === 'model-delta' && d.sourceRef?.agentId === agentId)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .slice(0, MAX_DELTA_BULLETS)
    .map((d) => ({ id: d.id, text: d.text, evidence: d.evidence ?? [] }));
}

/** One evidence anchor parsed into its file (+ optional line range) — `"src/a.ts"` or
 *  `"src/a.ts:10-20"` (a bare `"src/a.ts:10"` is a single line, `lineEnd === lineStart`). Anything
 *  that doesn't end in a numeric suffix is treated as a bare file path — a colon-free path is by far
 *  the common case, and a path that happens to contain a colon but no trailing digits still falls
 *  back to "whole file" rather than mis-parsing. */
export function parseEvidenceAnchor(anchor: string): { file: string; lineStart?: number; lineEnd?: number } {
  const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(anchor);
  if (!m) return { file: anchor };
  const lineStart = Number(m[2]);
  return { file: m[1], lineStart, lineEnd: m[3] !== undefined ? Number(m[3]) : lineStart };
}

/** The surprise-tap chip's event target: the FIRST evidence anchor's file (DESIGN.md/concern-08:
 *  `reportAttention({kind:'surprise', repo, file: <first evidence file>, agentId})`). `undefined`
 *  for a bullet with no evidence — shouldn't happen (see `DeltaBullet.evidence`'s doc) but the caller
 *  must not fabricate a file to report attention against. */
export function firstEvidenceFile(evidence: string[]): string | undefined {
  const first = evidence[0];
  return first ? parseEvidenceAnchor(first).file : undefined;
}

import type { ChannelEntry } from '../../lib/dto';
import { buildUnitProofHash } from '../../lib/proof-route';
import type { ChannelCardTone, ChannelCardView } from '../../lib/channelTimeline';

export type LandCardKind = 'land-attempt' | 'land-assessment' | 'land-merge';

type LandCardFace = NonNullable<ChannelCardView['land']>;

type LandEventPayload = {
  refs?: Record<string, unknown>;
  face?: Record<string, unknown>;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
  }
  return undefined;
}

function shortSha(value: string | undefined): string | undefined {
  return value ? value.slice(0, 10) : undefined;
}

function titleCase(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/[-_]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function proofTier(face: Record<string, unknown>): string | undefined {
  return titleCase(text(face.doneProofVerified, face.verified, face.proofVerified));
}

function riskLabel(face: Record<string, unknown>): string | undefined {
  return titleCase(text(face.risk, face.riskTier, face.riskLevel, face.code));
}

function recommendation(face: Record<string, unknown>): string | undefined {
  return text(face.recommendation, face.recommendedAction, face.detail);
}

function baseLandFace(entry: ChannelEntry, payload: LandEventPayload): { refs: Record<string, unknown>; face: Record<string, unknown>; unitId?: string; unitName?: string; branch?: string; repo?: string } {
  const refs = record(payload.refs);
  const face = record(payload.face);
  return {
    refs,
    face,
    unitId: text(refs.unitId, face.unitId),
    unitName: text(face.unitName),
    branch: text(face.branch),
    repo: text(face.repo),
  };
}

export function landCardView(entry: ChannelEntry, payload: unknown, authorLabel: string): ChannelCardView | undefined {
  const eventKind = entry.event?.kind;
  if (eventKind !== 'land-attempt' && eventKind !== 'land-assessment' && eventKind !== 'land-merge') return undefined;
  const parts = baseLandFace(entry, record(payload) as LandEventPayload);
  const { face, refs, unitId, unitName, branch, repo } = parts;
  const sha = shortSha(text(face.sha, face.commit, face.candidateCommit, face.resultCommit));
  const target = text(face.target, face.targetRef, face.baseRef);
  const stage = titleCase(text(face.stage));
  const branchLabel = branch ?? 'changes';
  const unitLabel = unitName ?? unitId ?? 'unit';
  const pinned: Array<{ label: string; value: string }> = [];
  const push = (label: string, value: string | undefined) => { if (value) pinned.push({ label, value }); };
  let tone: ChannelCardTone = 'info';
  let title = '';
  let body = entry.text || 'Land update';
  let detail: string | undefined;
  let land: LandCardFace | undefined;
  let href: string | undefined;

  if (eventKind === 'land-attempt') {
    tone = text(face.stage) === 'threw' ? 'destructive' : text(face.ok) === 'no' ? 'warning' : 'info';
    title = `Land attempt ${stage ? stage.toLowerCase() : 'updated'}`;
    body = `${unitLabel} is landing ${branchLabel}${target ? ` into ${target}` : ''}.`;
    detail = text(face.detail, face.message, face.error);
    push('Branch', branch);
    push('SHA', sha);
    push('Target', target);
    push('Attempt', text(refs.landId));
    land = { kind: eventKind, branch, sha, target };
  } else if (eventKind === 'land-assessment') {
    const risk = riskLabel(face);
    const rec = recommendation(face);
    tone = text(face.stage) === 'rejected' || risk === 'High' ? 'warning' : 'info';
    title = risk ? `Land assessment · ${risk}` : `Land assessment ${stage ? stage.toLowerCase() : 'recorded'}`;
    body = rec ?? text(face.detail, face.title) ?? entry.text ?? 'Assessment pinned to this land attempt.';
    detail = rec ? text(face.detail) : undefined;
    push('Risk', risk);
    push('Recommendation', rec);
    push('Branch', branch);
    push('Attempt', text(refs.landId));
    land = { kind: eventKind, branch, risk, recommendation: rec };
  } else {
    const outcome = titleCase(text(face.outcome, face.prState)) ?? (text(face.merged) === 'yes' ? 'Merged' : 'Finalized');
    const prNumber = text(face.prNumber);
    const prUrl = text(face.prUrl);
    const verified = proofTier(face);
    tone = outcome.toLowerCase().includes('closed') || outcome.toLowerCase().includes('failed') ? 'warning' : 'success';
    title = `Land merge · ${outcome}`;
    body = `${unitLabel} landed ${branchLabel}${prNumber ? ` via PR #${prNumber}` : ''}.`;
    detail = text(face.detail);
    push('Outcome', outcome);
    push('PR', prNumber ? `#${prNumber}` : undefined);
    push('Proof', verified);
    push('Branch', branch);
    if (unitId) href = buildUnitProofHash(unitId);
    land = { kind: eventKind, outcome, prNumber, prUrl, doneProofVerified: verified };
  }

  return { id: entry.id, entry, kind: eventKind, tone, authorLabel, title, eyebrow: 'Land', body, detail, pinned, href, land };
}

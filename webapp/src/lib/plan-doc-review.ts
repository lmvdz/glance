/**
 * Plan-doc review — pure logic for the design-review screen (DesignReviewView / `/review/:taskId`).
 *
 * Reference: plans/orchestration/UI-REFERENCES.md system B ("collaborative design-review loop") —
 * a living design doc with a fixed-by-convention section skeleton (Summary / Current State / …),
 * a right comments rail, a top "Design Review N/M resolved" progress bar, and a terminal
 * "all comments resolved, ready to implement" gate. All DOM-free derivation lives here so it's
 * unit-tested without a browser, matching this webapp's convention (see lib/intervene.ts).
 */

import type { ArtifactCommentDTO } from './dto';

export interface DocHeading {
  /** The heading text, e.g. "Desired End State" — also the comment-anchor value. */
  heading: string;
  /** 1-based line number of the `## heading` line itself. */
  line: number;
  /** 1-based inclusive line range of this section's body (up to, not including, the next H2). */
  bodyStart: number;
  bodyEnd: number;
}

/** Split a markdown doc into its H2 ("## ") sections. The reference's skeleton (Summary · Current
 *  State · UI Mockup · Technical Design · Desired End State · What we are not doing) is a
 *  convention, not a schema — this renders whatever H2s the doc actually has, in document order. */
export function parseHeadings(markdown: string): DocHeading[] {
  const lines = markdown.split('\n');
  const headings: DocHeading[] = [];
  lines.forEach((line, idx) => {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (!m) return;
    headings.push({ heading: m[1].trim(), line: idx + 1, bodyStart: idx + 2, bodyEnd: lines.length });
  });
  for (let i = 0; i < headings.length - 1; i++) headings[i].bodyEnd = headings[i + 1].line - 1;
  return headings;
}

/** Only doc-anchored plan-annotation comments for one specific doc, oldest-first (thread order). */
export function commentsForDoc(comments: ArtifactCommentDTO[], docPath: string): ArtifactCommentDTO[] {
  return comments
    .filter((c) => c.kind === 'plan-annotation' && c.annotation?.planPath === docPath)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** N/M resolved — the top progress bar's whole reason for existing. */
export function reviewProgress(comments: ArtifactCommentDTO[], docPath: string): { resolved: number; total: number } {
  const forDoc = commentsForDoc(comments, docPath);
  return { resolved: forDoc.filter((c) => c.resolvedAt != null).length, total: forDoc.length };
}

/** True once every doc-anchored comment on this doc is resolved (and there's at least one) — the
 *  advisory gate condition ("All comments resolved — ready to implement!"). */
export function reviewGateOpen(comments: ArtifactCommentDTO[], docPath: string): boolean {
  const { resolved, total } = reviewProgress(comments, docPath);
  return total > 0 && resolved === total;
}

/** The narration line under the progress bar ("Agent rewrites the hotkey behavior…") — the most
 *  recent comment's own words, truncated. Empty string when there's nothing to narrate yet. */
export function reviewNarration(comments: ArtifactCommentDTO[], docPath: string): string {
  const forDoc = commentsForDoc(comments, docPath);
  if (!forDoc.length) return '';
  const latest = forDoc[forDoc.length - 1];
  const body = latest.body.trim().split('\n')[0];
  return body.length > 90 ? `${body.slice(0, 87)}...` : body;
}

/** Which heading a comment belongs to: an explicit `annotation.heading` wins; otherwise fall back
 *  to whichever section's line range contains `lineStart`. Undefined when neither resolves (a
 *  comment anchored to a rendered block, or with no line info at all). */
export function headingForComment(comment: ArtifactCommentDTO, headings: DocHeading[]): string | undefined {
  const a = comment.annotation;
  if (!a) return undefined;
  if (a.heading) return a.heading;
  if (a.lineStart == null) return undefined;
  return headings.find((h) => a.lineStart! >= h.bodyStart && a.lineStart! <= h.bodyEnd)?.heading;
}

/** Comments grouped by the heading they anchor to (insertion order of first appearance);
 *  comments with no resolvable heading collect under the empty-string key ("general"). */
export function groupCommentsByHeading(comments: ArtifactCommentDTO[], docPath: string, headings: DocHeading[]): Map<string, ArtifactCommentDTO[]> {
  const map = new Map<string, ArtifactCommentDTO[]>();
  for (const comment of commentsForDoc(comments, docPath)) {
    const key = headingForComment(comment, headings) ?? '';
    const bucket = map.get(key);
    if (bucket) bucket.push(comment);
    else map.set(key, [comment]);
  }
  return map;
}

// ── last-seen-revision tracking (the "changed since your last view" diff toggle) ────────────────

const LAST_SEEN_PREFIX = 'glance.review.lastSeen';

/** localStorage key for the last-seen git SHA of one (repo, doc) pair — one entry per doc, not
 *  per task, so the same plan doc reviewed from two tasks shares its "have I seen this" state. */
export function lastSeenKey(repo: string, docPath: string): string {
  return `${LAST_SEEN_PREFIX}.${repo}.${docPath}`;
}

// ── `/review/:taskId` hash-route (this SPA has no router; deep-linkable state lives in the hash) ──

export interface ReviewLocation {
  taskId: string;
  docPath?: string;
}

/** Parse `#/review/<taskId>` (optionally `?doc=<path>`) into a ReviewLocation, or undefined when
 *  the current hash isn't a review deep link. */
export function parseReviewHash(hash: string): ReviewLocation | undefined {
  const m = /^#\/review\/([^?]+)(?:\?(.*))?$/.exec(hash);
  if (!m) return undefined;
  const taskId = decodeURIComponent(m[1]);
  if (!taskId) return undefined;
  const params = new URLSearchParams(m[2] ?? '');
  const doc = params.get('doc');
  return { taskId, docPath: doc ? decodeURIComponent(doc) : undefined };
}

/** Build the deep-linkable hash for one review location — the inverse of parseReviewHash. */
export function buildReviewHash(location: ReviewLocation): string {
  const base = `#/review/${encodeURIComponent(location.taskId)}`;
  return location.docPath ? `${base}?doc=${encodeURIComponent(location.docPath)}` : base;
}

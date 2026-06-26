/**
 * Append-only review-comment log — the data layer for "review the plan, not the 2,000-line diff"
 * (HumanLayer Pattern 4). A comment targets a review **subject**: a planner task (its Plane issue
 * identifier, e.g. "OMPSQ-42") or a plan-dir file path. Resolve is an appended EVENT folded at read
 * — JSONL can't mutate a field in place without a rewrite that races concurrent appends. Mirrors
 * audit.ts (Bun/Node stdlib only, torn-trailing-line tolerant).
 *
 * ponytail: append-only JSONL under <stateDir>/comments.jsonl, full-file scan + fold per read, no
 * rotation. Ceiling: linear reads on a long-lived log. Upgrade path: the sqlite store if it grows.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface PlanAnnotationTarget {
  planPath: string;
  lineStart?: number;
  lineEnd?: number;
  quote?: string;
}

export interface ArtifactComment {
  id: string;
  repo: string;
  /** Review target: a task's Plane issue identifier, feature id, or plan-dir file path. */
  subject: string;
  body: string;
  author: string;
  urgent?: boolean;
  createdAt: number;
  kind?: "comment" | "plan-annotation";
  annotation?: PlanAnnotationTarget;
  /** Folded in from a later resolve event; absent ⇒ still open. */
  resolvedAt?: number;
}

type CommentEvent =
  | { type: "add"; id: string; repo: string; subject: string; body: string; author: string; urgent?: boolean; at: number; kind?: "comment" | "plan-annotation"; annotation?: PlanAnnotationTarget }
  | { type: "resolve"; id: string; at: number };

export function commentsPath(baseDir: string): string {
  return path.join(baseDir, "comments.jsonl");
}

// Monotonic id, strictly increasing per process even within one ms — the stable sort + resolve key.
let lastSeq = 0;
export function nextCommentId(now = Date.now()): string {
  lastSeq = now > lastSeq ? now : lastSeq + 1;
  return `c${lastSeq}`;
}

export async function appendCommentEvent(baseDir: string, ev: CommentEvent): Promise<void> {
  const file = commentsPath(baseDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(ev)}\n`);
}

export interface CommentQuery {
  repo: string;
  subject: string;
  /** When true, drop resolved comments. */
  unresolved?: boolean;
}

/** Read the log, fold add+resolve → current state, filter by repo+subject. Oldest-first (append order). */
export async function listComments(baseDir: string, q: CommentQuery): Promise<ArtifactComment[]> {
  let text: string;
  try {
    text = await fs.readFile(commentsPath(baseDir), "utf8");
  } catch {
    return [];
  }
  const byId = new Map<string, ArtifactComment>();
  const order: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let ev: CommentEvent;
    try {
      ev = JSON.parse(line) as CommentEvent;
    } catch {
      continue; // skip a torn/partial trailing line rather than throw
    }
    if (ev.type === "add") {
      if (!byId.has(ev.id)) order.push(ev.id);
      byId.set(ev.id, { id: ev.id, repo: ev.repo, subject: ev.subject, body: ev.body, author: ev.author, urgent: ev.urgent, createdAt: ev.at, kind: ev.kind, annotation: ev.annotation });
    } else {
      const c = byId.get(ev.id);
      if (c) c.resolvedAt = ev.at;
    }
  }
  const out: ArtifactComment[] = [];
  for (const id of order) {
    const c = byId.get(id);
    if (!c || c.repo !== q.repo || c.subject !== q.subject) continue;
    if (q.unresolved && c.resolvedAt !== undefined) continue;
    out.push(c);
  }
  return out;
}

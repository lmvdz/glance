/**
 * Pure diff-line counting for the kit's `DiffStat` chip. The existing `/api/agents/:id/diff`
 * endpoint (already fetched by AssistantChat for the changed-files review panel) returns a
 * unified-diff text per file but no pre-computed +/- counts, so the cockpit's PR rail and
 * roster rows count them client-side. Pure + exported so this is unit-tested without a live
 * daemon (bun:test, no jsdom — project convention).
 */

export interface DiffCounts {
  added: number;
  removed: number;
  files: number;
}

/** Counts added/removed content lines in a unified diff, skipping the `+++`/`---` file
 *  header lines (which also start with +/- but aren't content changes). */
export function countDiffLines(diffText: string | undefined): { added: number; removed: number } {
  if (!diffText) return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

/** Aggregates per-file diff counts (AgentFileDiff-shaped, but kept structurally typed here to
 *  avoid a dependency on the chat/ module) into one total for a roster row / PR rail summary. */
export function aggregateDiffCounts(diffs: { diff?: string }[]): DiffCounts {
  let added = 0;
  let removed = 0;
  for (const d of diffs) {
    const counts = countDiffLines(d.diff);
    added += counts.added;
    removed += counts.removed;
  }
  return { added, removed, files: diffs.length };
}

/** One agent's diff-fetch invalidation signal — a new turn (messageCount), a status flip
 *  (e.g. working -> idle, files just settled), or a land/PR-state change (branch just merged,
 *  the worktree diff vs main collapsed — live-drive-found: the Changes panel kept showing the
 *  pre-land diff after a successful one-tap Land) all mean "the diff may be stale, refetch".
 *
 *  `landReady` alone is never a "safe to land" signal here or anywhere else in the webapp (see
 *  agent-badges.ts's `isValidatorHeld`) — it is used ONLY as one ingredient of a cache key, never
 *  rendered. `validationVerdict` is threaded through for the same reason every other `landReady`
 *  consumer routes through the validator: a veto/inconclusive resolving (or a fresh one landing)
 *  is itself a land-relevant state transition — e.g. a rejected auto-resolve rolls main back and
 *  the worktree diff may change under it — so the cache key must not go stale across it either. */
export interface DiffSignalInput {
  id: string;
  messageCount?: number;
  status: string;
  landReady?: boolean;
  prState?: string;
  validationVerdict?: string;
}

export function diffSignal(agent: DiffSignalInput): string {
  return `${agent.messageCount ?? 0}:${agent.status}:${agent.landReady ? 1 : 0}:${agent.prState ?? ''}:${agent.validationVerdict ?? ''}`;
}

/** Pure selection of which agent ids need a fresh diff fetch, given the signals already seen.
 *  Extracted from the fetch effect itself so the invalidation rule is unit-testable without
 *  mounting a hook (this webapp has no jsdom/testing-library — components/hooks are tested
 *  DOM-free by pulling the decision logic out, project convention). */
export function idsNeedingDiffFetch(agents: DiffSignalInput[], seenSignals: ReadonlyMap<string, string>): string[] {
  return agents.filter((agent) => seenSignals.get(agent.id) !== diffSignal(agent)).map((agent) => agent.id);
}

/**
 * Stable string signature of a roster's diff-relevant state. The fetch effect keys on THIS,
 * never on the roster array's identity: the WS layer pushes a brand-new agents array on every
 * event, and an identity-keyed effect re-fires (and, with an abort flag, cancels its own
 * in-flight fetches) even when nothing diff-relevant changed — the live-drive-found failure
 * mode that left the cockpit's Changes panel permanently empty.
 */
export function rosterDiffSignature(agents: DiffSignalInput[]): string {
  return agents.map((agent) => `${agent.id}=${diffSignal(agent)}`).join('|');
}

import { useEffect, useRef, useState } from 'react';
import { apiJson } from '../lib/api';
import type { AgentFileDiff } from '../components/chat/DiffReviewPanel';
import { diffSignal, rosterDiffSignature, type DiffSignalInput } from '../lib/diff-stat';

/**
 * Per-agent file-diff cache keyed by agent id. Mirrors AssistantChat's existing single-agent
 * diff fetch (`GET /api/agents/:id/diff`), but serves MULTIPLE agents at once: the cockpit's
 * roster rail needs a diff-stat chip on every row, not just the one open console.
 *
 * Two live-drive-found rules shape this hook:
 *  - The effect keys on `rosterDiffSignature` (a string), NOT the array identity — the WS
 *    roster pushes a fresh array on every event, and an identity-keyed effect + abort flag
 *    cancelled in-flight fetches while still marking their signal "seen", so diffs never
 *    landed (found live: land rail said "No changed files" while /diff returned one).
 *  - A signal is recorded as seen only when its response ARRIVES, and a response is applied
 *    only if it still matches the agent's latest signal — so out-of-order responses for the
 *    same agent can't clobber newer data, and a failed fetch retries on the next pass.
 */
export function useAgentDiffs(agents: DiffSignalInput[]): Map<string, AgentFileDiff[]> {
  const [byId, setById] = useState<Map<string, AgentFileDiff[]>>(new Map());
  const seenSignals = useRef<Map<string, string>>(new Map());
  const inFlight = useRef<Set<string>>(new Set());
  const latest = useRef<DiffSignalInput[]>(agents);
  latest.current = agents;

  const signature = rosterDiffSignature(agents);

  useEffect(() => {
    for (const agent of latest.current) {
      const signal = diffSignal(agent);
      const flightKey = `${agent.id}:${signal}`;
      if (seenSignals.current.get(agent.id) === signal || inFlight.current.has(flightKey)) continue;
      inFlight.current.add(flightKey);
      void apiJson<AgentFileDiff[]>(`/api/agents/${encodeURIComponent(agent.id)}/diff`)
        .then((diffs) => {
          // Apply only if this is still the agent's current signal — a newer fetch may
          // already be in flight (or landed) for a fresher state of the worktree.
          const now = latest.current.find((a) => a.id === agent.id);
          if (now && diffSignal(now) !== signal) return;
          seenSignals.current.set(agent.id, signal);
          setById((prev) => {
            const next = new Map(prev);
            next.set(agent.id, diffs);
            return next;
          });
        })
        .catch(() => undefined) // not seen ⇒ retried on the next signature change
        .finally(() => {
          inFlight.current.delete(flightKey);
        });
    }
  }, [signature]);

  return byId;
}

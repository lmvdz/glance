import { useEffect, useState } from "react";
import type { IssueRef } from "../lib/dto";
import { apiFetch } from "../lib/ws";

export interface ProjectIssues {
  issues: IssueRef[];
  loading: boolean;
  /** false when the daemon returns 501 (Plane not configured) — the view degrades to features-only. */
  configured: boolean;
}

/**
 * Open Plane issues for a repo (the existing `/api/plane/issues` endpoint), refetched on repo
 * change and every 15s while mounted. Uses raw `apiFetch` (not `apiGet`) to detect the 501
 * "Plane not configured" case. ponytail: interval poll, not a WS subscription — the issue list
 * changes slowly; add a `tasks-changed` event if it ever needs to be live.
 */
export function useProjectIssues(repo: string | null): ProjectIssues {
  const [issues, setIssues] = useState<IssueRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [configured, setConfigured] = useState(true);

  useEffect(() => {
    if (!repo) {
      setIssues([]);
      return;
    }
    let alive = true;
    const load = async (): Promise<void> => {
      setLoading(true);
      const r = await apiFetch(`/api/plane/issues?project=${encodeURIComponent(repo)}`).catch(() => null);
      if (!alive) return;
      if (r && r.status === 501) {
        setConfigured(false);
        setIssues([]);
      } else if (r && r.ok) {
        setConfigured(true);
        setIssues(((await r.json().catch(() => [])) as IssueRef[]) ?? []);
      }
      setLoading(false);
    };
    void load();
    const t = setInterval(() => void load(), 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [repo]);

  return { issues, loading, configured };
}

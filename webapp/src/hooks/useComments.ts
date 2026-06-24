import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/ws";
import { apiPost } from "../lib/api";

export interface Comment {
  id: string;
  repo: string;
  subject: string;
  body: string;
  author: string;
  urgent?: boolean;
  createdAt: number;
  resolvedAt?: number;
}

/** Review comments for one subject (a task's Plane identifier). Reload after add/resolve. */
export function useComments(repo: string, subject: string) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const r = await apiFetch(`/api/comments?repo=${encodeURIComponent(repo)}&subject=${encodeURIComponent(subject)}`).catch(() => null);
    if (r && r.ok) setComments(((await r.json().catch(() => [])) as Comment[]) ?? []);
    setLoading(false);
  }, [repo, subject]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  const add = useCallback(
    async (body: string, urgent: boolean): Promise<boolean> => {
      const ok = (await apiPost("/api/comments", { repo, subject, body, urgent })) !== null;
      if (ok) await load();
      return ok;
    },
    [repo, subject, load],
  );

  const resolve = useCallback(
    async (id: string): Promise<boolean> => {
      const ok = (await apiPost(`/api/comments/${encodeURIComponent(id)}/resolve`, {})) !== null;
      if (ok) await load();
      return ok;
    },
    [load],
  );

  return { comments, loading, add, resolve };
}

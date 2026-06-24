import { useEffect, useState } from "react";
import type { FeaturePipeline } from "../lib/dto";
import { apiGet } from "../lib/api";

/**
 * The automation-loop data for one feature: plan concerns (the draft tasks), filed Plane issues,
 * and the agent ids working it — straight from GET /api/features/:id/pipeline. Refetched on the
 * same 15s cadence as the task list so a freshly-filed concern or spawned agent shows up.
 */
export function useFeaturePipeline(featureId: string | null, repo: string) {
  const [pipeline, setPipeline] = useState<FeaturePipeline | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!featureId) {
      setPipeline(null);
      return;
    }
    let alive = true;
    const load = async (): Promise<void> => {
      const p = await apiGet<FeaturePipeline>(`/api/features/${encodeURIComponent(featureId)}/pipeline?repo=${encodeURIComponent(repo)}`);
      if (!alive) return;
      setPipeline(p);
      setLoading(false);
    };
    setLoading(true);
    void load();
    const t = setInterval(() => void load(), 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [featureId, repo]);

  return { pipeline, loading };
}

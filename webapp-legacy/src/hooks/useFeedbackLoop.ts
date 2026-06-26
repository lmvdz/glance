import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  FeedbackCampaign,
  FeedbackItem,
  FeedbackItemsResponse,
  FeedbackReward,
  FeedbackStatus,
  FeedbackSummary,
  FeedbackValidationResponse,
  FeedbackValidationVote,
} from "../lib/dto";
import { apiFetch } from "../lib/ws";

export const FEEDBACK_FILTERS = ["new", "needs-validation", "accepted", "promoted", "rejected"] as const satisfies readonly FeedbackStatus[];
export type FeedbackFilter = (typeof FEEDBACK_FILTERS)[number];

export interface FeedbackActionState {
  canAccept: boolean;
  canReject: boolean;
  canPromote: boolean;
  canValidate: boolean;
  canApproveReward: boolean;
  canVoidReward: boolean;
  canMarkRewardPaid: boolean;
}

const EMPTY_ITEMS: FeedbackItemsResponse = { items: [], raw: [], validations: [], rewards: [] };

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await apiFetch(path, { ...init, headers });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export function filterFeedbackItems(items: FeedbackSummary[], filter: FeedbackFilter): FeedbackSummary[] {
  return items.filter((item) => item.status === filter);
}

export function feedbackActionState(item: FeedbackSummary | FeedbackItem | null, reward?: FeedbackReward): FeedbackActionState {
  const status = item?.status;
  const rewardStatus = reward?.status ?? item?.rewardStatus ?? "none";
  return {
    canAccept: !!status && status !== "accepted" && status !== "promoted" && status !== "rejected",
    canReject: !!status && status !== "promoted" && status !== "rejected",
    canPromote: !!item && (status === "accepted" || status === "needs-validation") && !item.planeIssue,
    canValidate: !!status && status !== "promoted" && status !== "rejected",
    canApproveReward: rewardStatus === "pending",
    canVoidReward: rewardStatus === "pending" || rewardStatus === "approved",
    canMarkRewardPaid: rewardStatus === "approved",
  };
}

export function useFeedbackLoop(selectedId: string | null) {
  const [campaigns, setCampaigns] = useState<FeedbackCampaign[]>([]);
  const [snapshot, setSnapshot] = useState<FeedbackItemsResponse>(EMPTY_ITEMS);
  const [selectedItem, setSelectedItem] = useState<FeedbackItem | null>(null);
  const [selectedValidations, setSelectedValidations] = useState<FeedbackValidationResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [nextCampaigns, nextItems] = await Promise.all([
        requestJson<FeedbackCampaign[]>("/api/feedback/campaigns"),
        requestJson<FeedbackItemsResponse>("/api/feedback/items"),
      ]);
      setCampaigns(nextCampaigns);
      setSnapshot({ ...EMPTY_ITEMS, ...nextItems });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let alive = true;
    if (!selectedId) {
      setSelectedItem(null);
      setSelectedValidations([]);
      setDetailLoading(false);
      setActionError(null);
      return;
    }
    setDetailLoading(true);
    setActionError(null);
    Promise.all([
      requestJson<FeedbackItem>(`/api/feedback/items/${encodeURIComponent(selectedId)}`),
      requestJson<FeedbackValidationResponse[]>(`/api/feedback/items/${encodeURIComponent(selectedId)}/validation`),
    ])
      .then(([item, validations]) => {
        if (!alive) return;
        setSelectedItem(item);
        setSelectedValidations(validations);
      })
      .catch((err) => {
        if (!alive) return;
        setSelectedItem(snapshot.raw.find((item) => item.id === selectedId) ?? null);
        setSelectedValidations(snapshot.validations.filter((item) => item.feedbackId === selectedId));
        setActionError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setDetailLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [selectedId, snapshot.raw, snapshot.validations]);

  const selected = selectedItem ?? (selectedId ? snapshot.raw.find((item) => item.id === selectedId) ?? null : null);
  const validations = selectedId ? selectedValidations.length ? selectedValidations : snapshot.validations.filter((item) => item.feedbackId === selectedId) : [];
  const selectedReward = selectedId ? snapshot.rewards.find((reward) => reward.feedbackId === selectedId) : undefined;

  const campaignById = useMemo(() => new Map(campaigns.map((campaign) => [campaign.id, campaign])), [campaigns]);

  const post = useCallback(
    async (id: string, action: string, body: unknown = {}): Promise<void> => {
      setBusyAction(`${id}:${action}`);
      setActionError(null);
      try {
        await requestJson<unknown>(`/api/feedback/items/${encodeURIComponent(id)}/${action}`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        await refresh();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyAction(null);
      }
    },
    [refresh],
  );

  return {
    campaigns,
    campaignById,
    summaries: snapshot.items,
    items: snapshot.raw,
    validations: snapshot.validations,
    rewards: snapshot.rewards,
    selected,
    selectedValidations: validations,
    selectedReward,
    loading,
    detailLoading,
    error,
    actionError,
    busyAction,
    refresh,
    accept: (id: string) => post(id, "accept"),
    reject: (id: string) => post(id, "reject"),
    promote: (id: string) => post(id, "promote"),
    addValidation: (id: string, vote: FeedbackValidationVote) => post(id, "validation", { respondent: "operator", vote }),
    approveReward: (id: string) => post(id, "reward/approve"),
    voidReward: (id: string) => post(id, "reward/void"),
    markRewardPaid: (id: string) => post(id, "reward/mark-paid", { provider: "manual" }),
  };
}

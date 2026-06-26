import { useMemo, useState } from "react";
import { CheckCircle2, CircleDollarSign, ExternalLink, Gift, RefreshCcw, ShieldQuestion, Ticket, XCircle } from "lucide-react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { SkeletonCard, SkeletonRow } from "@/components/ui/skeleton";
import { FEEDBACK_FILTERS, feedbackActionState, filterFeedbackItems, type FeedbackFilter, useFeedbackLoop } from "@/hooks/useFeedbackLoop";
import type { FeedbackItem, FeedbackReward, FeedbackStatus, FeedbackSummary, FeedbackValidationResponse } from "@/lib/dto";
import { cn } from "@/lib/cn";

const STATUS_TONE: Record<FeedbackStatus, NonNullable<BadgeProps["tone"]>> = {
  new: "accent",
  "needs-validation": "warning",
  accepted: "success",
  promoted: "success",
  rejected: "danger",
};

const REWARD_TONE: Record<string, NonNullable<BadgeProps["tone"]>> = {
  none: "neutral",
  pending: "warning",
  approved: "accent",
  paid: "success",
  void: "danger",
};

const FILTER_LABEL: Record<FeedbackFilter, string> = {
  new: "New",
  "needs-validation": "Needs validation",
  accepted: "Accepted",
  promoted: "Promoted",
  rejected: "Rejected",
};

const money = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });

function formatDate(ts: number): string {
  if (!Number.isFinite(ts)) return "unknown";
  return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function rewardLabel(reward?: FeedbackReward, fallback?: FeedbackSummary | FeedbackItem): string {
  if (!reward) return fallback?.rewardStatus === "none" ? "No reward" : fallback?.rewardStatus ?? "No reward";
  const amount = reward.currency === "USD" ? money.format(reward.amount / 100) : `${reward.amount} ${reward.currency}`;
  return `${amount} · ${reward.status}`;
}

function MetadataList({ item }: { item: FeedbackItem }) {
  const entries = Object.entries(item.metadata ?? {});
  return (
    <dl className="grid gap-2 text-[length:var(--text-13)] sm:grid-cols-2">
      <div>
        <dt className="text-text-muted">Reporter</dt>
        <dd className="break-words text-text-primary">{item.userEmail ?? item.userId ?? "Anonymous"}</dd>
      </div>
      <div>
        <dt className="text-text-muted">Repo</dt>
        <dd className="break-words text-text-primary">{item.repo}</dd>
      </div>
      {item.url ? (
        <div className="sm:col-span-2">
          <dt className="text-text-muted">URL</dt>
          <dd>
            <a className="inline-flex min-h-10 items-center gap-1 break-all text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={item.url} target="_blank" rel="noreferrer">
              {item.url}
              <ExternalLink className="size-3" aria-hidden="true" />
            </a>
          </dd>
        </div>
      ) : null}
      <div>
        <dt className="text-text-muted">Browser</dt>
        <dd className="break-words text-text-primary">{item.browser ?? "Not captured"}</dd>
      </div>
      <div>
        <dt className="text-text-muted">Viewport</dt>
        <dd className="break-words text-text-primary">{item.viewport ?? "Not captured"}</dd>
      </div>
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt className="break-words text-text-muted">{key}</dt>
          <dd className="break-words text-text-primary">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ValidationList({ validations }: { validations: FeedbackValidationResponse[] }) {
  if (validations.length === 0) {
    return <EmptyState title="No validation yet" className="m-0">Use the validation buttons to record whether this feedback is reproducible and worth building.</EmptyState>;
  }
  return (
    <div className="space-y-2">
      {validations.map((validation) => (
        <div key={validation.id} className="rounded-[var(--radius-sm)] border border-border bg-surface-raised/45 p-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={validation.vote === "valid" ? "success" : validation.vote === "invalid" ? "danger" : "neutral"}>{validation.vote}</Badge>
            <span className="text-text-secondary">{validation.respondent}</span>
            {typeof validation.pain === "number" ? <span className="text-text-muted">pain {validation.pain}/5</span> : null}
            <span className="ml-auto text-text-muted">{formatDate(validation.createdAt)}</span>
          </div>
          {validation.note ? <p className="mt-2 whitespace-pre-wrap text-text-secondary">{validation.note}</p> : null}
        </div>
      ))}
    </div>
  );
}

function RewardPanel({ item, reward }: { item: FeedbackItem; reward?: FeedbackReward }) {
  return (
    <div className="space-y-2 rounded-[var(--radius-md)] border border-warning/30 bg-warning-subtle/50 p-3 text-[length:var(--text-13)]">
      <div className="flex flex-wrap items-center gap-2">
        <Gift className="size-4 text-warning" aria-hidden="true" />
        <span className="font-semibold text-text-primary">Manual reward</span>
        <Badge tone={REWARD_TONE[reward?.status ?? item.rewardStatus] ?? "neutral"}>{reward?.status ?? item.rewardStatus}</Badge>
      </div>
      <p className="text-text-secondary">Rewards are manual and pending review. These controls update tracking state only; they do not trigger an automatic payout.</p>
      <dl className="grid gap-2 sm:grid-cols-2">
        <div>
          <dt className="text-text-muted">Amount</dt>
          <dd className="text-text-primary">{rewardLabel(reward, item)}</dd>
        </div>
        <div>
          <dt className="text-text-muted">Provider</dt>
          <dd className="text-text-primary">{reward?.provider ?? "Manual / unset"}</dd>
        </div>
        {reward?.externalRef ? (
          <div className="sm:col-span-2">
            <dt className="text-text-muted">External reference</dt>
            <dd className="break-words text-text-primary">{reward.externalRef}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

function FeedbackListRow({ item, active, onSelect }: { item: FeedbackSummary; active: boolean; onSelect: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      className={cn(
        "w-full rounded-[var(--radius-md)] border p-3 text-left transition-[background-color,border-color,transform] duration-150 active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "border-accent/50 bg-accent/10" : "border-border bg-surface hover:border-border-strong hover:bg-surface-hover",
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONE[item.status]}>{item.status}</Badge>
            <Badge tone="neutral">{item.kind}</Badge>
            {item.hasAttachment ? <Badge tone="accent">evidence</Badge> : null}
          </div>
          <div className="line-clamp-2 font-semibold text-text-primary">{item.title}</div>
          <div className="truncate text-[length:var(--text-12)] text-text-muted">{item.repo}</div>
        </div>
        <div className="shrink-0 text-right text-[length:var(--text-12)] text-text-muted">
          <div>{formatDate(item.createdAt)}</div>
          <div>{item.validationCount} validations</div>
        </div>
      </div>
    </button>
  );
}

export function FeedbackLoopView({ selectedId, onSelect, onClose }: { selectedId: string | null; onSelect: (id: string) => void; onClose: () => void }) {
  const [filter, setFilter] = useState<FeedbackFilter>("new");
  const loop = useFeedbackLoop(selectedId);
  const filtered = useMemo(() => filterFeedbackItems(loop.summaries, filter), [loop.summaries, filter]);
  const counts = useMemo(() => {
    const next: Record<FeedbackFilter, number> = { new: 0, "needs-validation": 0, accepted: 0, promoted: 0, rejected: 0 };
    for (const item of loop.summaries) next[item.status] += 1;
    return next;
  }, [loop.summaries]);
  const detail = loop.selected;
  const actions = feedbackActionState(detail, loop.selectedReward);
  const detailBusy = loop.busyAction?.startsWith(`${detail?.id ?? ""}:`) ?? false;

  if (loop.loading) {
    return (
      <div className="grid h-full min-h-0 grid-cols-1 gap-3 overflow-hidden p-3 lg:grid-cols-[minmax(320px,420px)_1fr]">
        <div className="space-y-2">
          <SkeletonRow className="h-8" />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
        <SkeletonCard className="h-full min-h-80" />
      </div>
    );
  }

  if (loop.error) {
    return <ErrorState title="Couldn't load Feedback Loop" onRetry={loop.refresh}>{loop.error}</ErrorState>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden p-3">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-text-muted">Queue</div>
          <h1 className="text-lg font-semibold text-text-primary">Feedback Loop</h1>
          <p className="max-w-2xl text-[length:var(--text-13)] text-text-secondary">Review widget submissions, validate demand, promote accepted work to Plane, and track manual rewards.</p>
        </div>
        <Button type="button" onClick={loop.refresh} disabled={loop.loading} className="min-h-10">
          <RefreshCcw className="size-4" aria-hidden="true" />
          Refresh
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden lg:grid-cols-[minmax(320px,420px)_1fr]">
        <Card className="min-h-0 overflow-hidden">
          <CardHeader className="justify-between">
            <CardTitle>Inbox</CardTitle>
            <span>{loop.summaries.length} total</span>
          </CardHeader>
          <CardContent className="flex h-full min-h-0 flex-col gap-3 p-3">
            <div className="flex flex-wrap gap-2" aria-label="Feedback filters">
              {FEEDBACK_FILTERS.map((next) => (
                <button
                  key={next}
                  type="button"
                  onClick={() => setFilter(next)}
                  className={cn(
                    "min-h-10 rounded-[var(--radius-sm)] border px-3 text-[length:var(--text-12)] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    filter === next ? "border-accent/50 bg-accent/15 text-text-primary" : "border-border bg-secondary text-text-secondary hover:border-border-strong hover:text-text-primary",
                  )}
                  aria-pressed={filter === next}
                >
                  {FILTER_LABEL[next]} <span className="text-text-muted">{counts[next]}</span>
                </button>
              ))}
            </div>

            {filtered.length === 0 ? (
              <EmptyState title="No feedback in this lane" className="m-0">Switch filters or wait for the public widget to submit new items.</EmptyState>
            ) : (
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                {filtered.map((item) => <FeedbackListRow key={item.id} item={item} active={item.id === selectedId} onSelect={onSelect} />)}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="min-h-0 overflow-hidden">
          <CardHeader className="justify-between">
            <CardTitle>Detail</CardTitle>
            {detail ? <Button type="button" size="sm" variant="ghost" onClick={onClose}>Close</Button> : null}
          </CardHeader>
          {!detail ? (
            <EmptyState title="Select a feedback item" className="m-3">Open an item to inspect metadata, evidence, validations, rewards, and promotion actions.</EmptyState>
          ) : (
            <CardContent className="h-full min-h-0 overflow-y-auto p-3">
              <div className="space-y-4">
                <section className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={STATUS_TONE[detail.status]}>{detail.status}</Badge>
                    <Badge tone="neutral">{detail.kind}</Badge>
                    {loop.detailLoading ? <Badge tone="accent">loading detail</Badge> : null}
                    {detail.planeIssue ? <Badge tone="success">{detail.planeIssue.identifier ?? "Plane issue"}</Badge> : null}
                  </div>
                  <h2 className="text-xl font-semibold text-text-primary">{detail.title}</h2>
                  <div className="text-[length:var(--text-12)] text-text-muted">Campaign: {loop.campaignById.get(detail.campaignId)?.name ?? detail.campaignId}</div>
                  <p className="whitespace-pre-wrap text-[length:var(--text-13)] leading-relaxed text-text-secondary">{detail.description}</p>
                  <div className="text-[length:var(--text-12)] text-text-muted">Created {formatDate(detail.createdAt)} · Updated {formatDate(detail.updatedAt)}</div>
                </section>

                {loop.actionError ? <ErrorState title="Action failed" className="m-0">{loop.actionError}</ErrorState> : null}

                <section className="flex flex-wrap gap-2" aria-label="Feedback actions" aria-busy={detailBusy}>
                  <Button type="button" className="min-h-10" disabled={!actions.canAccept || detailBusy} onClick={() => loop.accept(detail.id)}>
                    <CheckCircle2 className="size-4" aria-hidden="true" />
                    Accept
                  </Button>
                  <Button type="button" className="min-h-10" variant="danger" disabled={!actions.canReject || detailBusy} onClick={() => loop.reject(detail.id)}>
                    <XCircle className="size-4" aria-hidden="true" />
                    Reject
                  </Button>
                  <Button type="button" className="min-h-10" variant="secondary" disabled={!actions.canPromote || detailBusy} onClick={() => loop.promote(detail.id)}>
                    <Ticket className="size-4" aria-hidden="true" />
                    Promote
                  </Button>
                  <Button type="button" className="min-h-10" variant="outline" disabled={!actions.canValidate || detailBusy} onClick={() => loop.addValidation(detail.id, "valid")}>
                    <ShieldQuestion className="size-4" aria-hidden="true" />
                    Valid
                  </Button>
                  <Button type="button" className="min-h-10" variant="outline" disabled={!actions.canValidate || detailBusy} onClick={() => loop.addValidation(detail.id, "invalid")}>Invalid</Button>
                  <Button type="button" className="min-h-10" variant="outline" disabled={!actions.canValidate || detailBusy} onClick={() => loop.addValidation(detail.id, "unsure")}>Unsure</Button>
                </section>

                <section className="grid gap-3 xl:grid-cols-2">
                  <Card>
                    <CardHeader><CardTitle>Metadata</CardTitle></CardHeader>
                    <CardContent><MetadataList item={detail} /></CardContent>
                  </Card>
                  <Card>
                    <CardHeader><CardTitle>Evidence</CardTitle></CardHeader>
                    <CardContent className="space-y-2 text-[length:var(--text-13)]">
                      {detail.attachment ? (
                        <dl className="space-y-2">
                          <div><dt className="text-text-muted">Attachment</dt><dd className="text-text-primary">{detail.attachment.contentType} · {Math.round(detail.attachment.bytes / 1024)} KB</dd></div>
                          <div><dt className="text-text-muted">Checksum</dt><dd className="break-all text-text-secondary">{detail.attachment.sha256}</dd></div>
                        </dl>
                      ) : <EmptyState title="No screenshot" className="m-0">The widget did not attach visual evidence.</EmptyState>}
                    </CardContent>
                  </Card>
                </section>

                <section className="grid gap-3 xl:grid-cols-[1fr_340px]">
                  <Card>
                    <CardHeader className="justify-between">
                      <CardTitle>Validation</CardTitle>
                      <span>{loop.selectedValidations.length} responses</span>
                    </CardHeader>
                    <CardContent><ValidationList validations={loop.selectedValidations} /></CardContent>
                  </Card>
                  <div className="space-y-3">
                    <RewardPanel item={detail} reward={loop.selectedReward} />
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" className="min-h-10" variant="secondary" disabled={!actions.canApproveReward || detailBusy} onClick={() => loop.approveReward(detail.id)}>
                        <Gift className="size-4" aria-hidden="true" />
                        Approve reward
                      </Button>
                      <Button type="button" className="min-h-10" variant="secondary" disabled={!actions.canMarkRewardPaid || detailBusy} onClick={() => loop.markRewardPaid(detail.id)}>
                        <CircleDollarSign className="size-4" aria-hidden="true" />
                        Mark paid
                      </Button>
                      <Button type="button" className="min-h-10" variant="danger" disabled={!actions.canVoidReward || detailBusy} onClick={() => loop.voidReward(detail.id)}>Void reward</Button>
                    </div>
                  </div>
                </section>
              </div>
            </CardContent>
          )}
        </Card>
      </div>
    </div>
  );
}

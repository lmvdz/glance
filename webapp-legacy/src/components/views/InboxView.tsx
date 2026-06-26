import { useMemo, useState } from "react";
import { CheckCircle2, ExternalLink, RotateCcw } from "lucide-react";
import type { SquadState } from "@/hooks/useSquad";
import { foldInbox } from "@/lib/inbox";
import { apiPost } from "@/lib/api";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/agent/status-badge";
import { RelativeTime } from "@/components/agent/relative-time";
import { AnswerControls } from "@/components/agent/AnswerControls";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

export function InboxView({ squad }: { squad: SquadState }) {
  const { toast } = useToast();
  const [landing, setLanding] = useState<string | null>(null);
  const rows = useMemo(() => foldInbox(squad.agents), [squad.agents]);

  const openAgent = (id: string) => {
    location.hash = "#/agents/" + encodeURIComponent(id);
  };

  const land = async (id: string) => {
    setLanding(id);
    const res = await apiPost<{ ok?: boolean; detail?: string }>(`/api/agents/${encodeURIComponent(id)}/land`, {});
    setLanding(null);
    toast({ title: res?.ok ? "Landed" : "Land failed", description: res?.detail, tone: res?.ok ? "success" : "danger" });
  };
  if (rows.length === 0) {
    return (
      <div className="p-3">
        <EmptyState title="Inbox clear">No agents are waiting on answers, error recovery, or land confirmation.</EmptyState>
      </div>
    );
  }

  return (
    <div className="mx-auto h-full max-w-3xl space-y-3 overflow-y-auto p-4">
      {rows.map((row) => {
        const agent = row.agent;
        if (row.kind === "pending") {
          return (
            <Card key={agent.id + ":" + row.req.id}>
              <CardHeader className="justify-between normal-case">
                <span className="flex items-center gap-2">
                  <span className="font-semibold text-text-1">{agent.name}</span>
                  <span className="font-normal tracking-normal text-text-3">
                    {agent.repo.split("/").filter(Boolean).pop()}
                  </span>
                </span>
                <RelativeTime ts={row.req.createdAt} />
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div>
                  <div className="text-sm font-medium text-text-1">{row.req.title}</div>
                  {row.req.message ? <div className="mt-0.5 whitespace-pre-wrap text-xs text-text-2">{row.req.message}</div> : null}
                </div>
                <AnswerControls
                  request={row.req}
                  onAnswer={(v) => squad.send({ type: "answer", id: agent.id, requestId: row.req.id, value: v })}
                />
              </CardContent>
            </Card>
          );
        }

        if (row.kind === "landReady") {
          return (
            <Card key={agent.id + ":land-ready"}>
              <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <span className="flex min-w-0 items-start gap-2">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-text-1">{agent.name} is ready to land</span>
                    <span className="block truncate text-xs text-text-2">{agent.repo.split("/").filter(Boolean).pop()} · verified by the landing gate</span>
                  </span>
                </span>
                <span className="flex gap-2">
                  <Button type="button" variant="secondary" onClick={() => openAgent(agent.id)}>
                    Open agent
                  </Button>
                  <Button type="button" variant="primary" disabled={landing === agent.id} onClick={() => void land(agent.id)}>
                    {landing === agent.id ? "Landing…" : "Land"}
                  </Button>
                </span>
              </CardContent>
            </Card>
          );
        }

        return (
          <Card key={agent.id + ":error"}>
            <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="flex min-w-0 items-center gap-2">
                <StatusBadge status={agent.status} />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-text-1">{agent.name}</span>
                  <span className="block truncate text-xs text-danger">{agent.error ?? "Agent reported an error"}</span>
                </span>
              </span>
              <span className="flex gap-2">
                <Button type="button" variant="secondary" onClick={() => openAgent(agent.id)}>
                  <ExternalLink className="size-4" aria-hidden="true" />
                  Open
                </Button>
                <Button type="button" variant="secondary" onClick={() => squad.send({ type: "restart", id: agent.id })}>
                  <RotateCcw className="size-4" aria-hidden="true" />
                  Restart
                </Button>
              </span>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

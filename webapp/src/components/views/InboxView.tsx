import { useMemo } from "react";
import type { SquadState } from "@/hooks/useSquad";
import { foldInbox } from "@/lib/inbox";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/agent/status-badge";
import { RelativeTime } from "@/components/agent/relative-time";
import { AnswerControls } from "@/components/agent/AnswerControls";

export function InboxView({ squad }: { squad: SquadState }) {
  const rows = useMemo(() => foldInbox(squad.agents), [squad.agents]);
  const errored = useMemo(() => squad.agents.filter((a) => a.status === "error"), [squad.agents]);

  if (rows.length === 0 && errored.length === 0) {
    return (
      <div className="p-3">
        <EmptyState title="Inbox clear">No agents are waiting on you.</EmptyState>
      </div>
    );
  }

  return (
    <div className="mx-auto h-full max-w-3xl space-y-3 overflow-y-auto p-4">
      {rows.map(({ agent, req }) => (
        <Card key={agent.id + ":" + req.id}>
          <CardHeader className="justify-between normal-case">
            <span className="flex items-center gap-2">
              <span className="font-semibold text-text-1">{agent.name}</span>
              <span className="font-normal tracking-normal text-text-3">
                {agent.repo.split("/").filter(Boolean).pop()}
              </span>
            </span>
            <RelativeTime ts={req.createdAt} />
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div>
              <div className="text-sm font-medium text-text-1">{req.title}</div>
              {req.message ? <div className="mt-0.5 whitespace-pre-wrap text-xs text-text-2">{req.message}</div> : null}
            </div>
            <AnswerControls
              request={req}
              onAnswer={(v) => squad.send({ type: "answer", id: agent.id, requestId: req.id, value: v })}
            />
          </CardContent>
        </Card>
      ))}

      {errored.length > 0 ? (
        <div className="pt-2">
          <h3 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-text-3">Errored</h3>
          {errored.map((a) => (
            <Card key={a.id} className="mb-2">
              <CardContent className="flex items-center gap-2">
                <StatusBadge status={a.status} />
                <span className="text-sm text-text-1">{a.name}</span>
                {a.error ? <span className="truncate text-xs text-danger">{a.error}</span> : null}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}
    </div>
  );
}

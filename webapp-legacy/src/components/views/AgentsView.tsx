import { useEffect, useMemo, type ElementType } from "react";
import {
  Activity,
  AlertCircle,
  Bot,
  CheckCircle2,
  Clock3,
  Cpu,
  Flame,
  GitBranch,
  Gauge,
  MessageSquareWarning,
  Radio,
  ReceiptText,
  Sparkles,
  Users,
  Zap,
} from "lucide-react";
import type { AgentDTO, AgentStatus, TranscriptEntry } from "@/lib/dto";
import type { SquadState } from "@/hooks/useSquad";
import { cn } from "@/lib/cn";
import { AnswerControls } from "@/components/agent/AnswerControls";
import { RelativeTime } from "@/components/agent/relative-time";
import { StatusBadge } from "@/components/agent/status-badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

interface AgentsViewProps {
  squad: SquadState;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const STATUS_ORDER: Record<AgentStatus, number> = {
  input: 0,
  error: 1,
  working: 2,
  starting: 3,
  idle: 4,
  stopped: 5,
};

const STATUS_COPY: Record<AgentStatus, string> = {
  input: "Needs operator input",
  error: "Blocked by error",
  working: "Actively executing",
  starting: "Booting worktree",
  idle: "Ready for dispatch",
  stopped: "Stopped",
};

const STATUS_PANEL: Record<AgentStatus, string> = {
  input: "border-attention/35 bg-attention-subtle",
  error: "border-danger/35 bg-danger-subtle",
  working: "border-warning/35 bg-warning-subtle",
  starting: "border-accent/35 bg-accent-subtle",
  idle: "border-success/35 bg-success-subtle",
  stopped: "border-neutral/30 bg-neutral-subtle",
};


function displayRepo(agent: AgentDTO) {
  return agent.repo.split("/").filter(Boolean).pop() ?? agent.repo;
}

function displayBranch(agent: AgentDTO) {
  return agent.branch || agent.issue?.identifier || displayRepo(agent);
}

function displayActivity(agent: AgentDTO) {
  return agent.activity || agent.todo?.active || agent.issue?.name || STATUS_COPY[agent.status];
}

function contextPercent(agent: AgentDTO): number | null {
  if (agent.contextPct == null) return null;
  return Math.round(agent.contextPct * 100);
}

function formatContext(agent: AgentDTO) {
  const context = contextPercent(agent);
  return context == null ? "n/a" : `${context}%`;
}

function formatReceipt(agent: AgentDTO) {
  const receipt = agent.receipt;
  if (!receipt) return "no receipt";
  if (typeof receipt.costUsd === "number") return `$${receipt.costUsd.toFixed(receipt.costUsd >= 1 ? 2 : 4)}`;
  if (typeof receipt.tokens === "number") return `${Intl.NumberFormat(undefined, { notation: "compact" }).format(receipt.tokens)} tok`;
  return `${receipt.toolCalls} tools`;
}

function formatReceiptHint(agent: AgentDTO) {
  const receipt = agent.receipt;
  if (!receipt) return "latest run";
  if (typeof receipt.durationMs === "number") return `${Math.round(receipt.durationMs / 1000)}s`;
  if (typeof receipt.endedAt === "number") return "completed";
  return "in flight";
}

function sortedAgents(agents: AgentDTO[]) {
  return [...agents].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.lastActivity - a.lastActivity,
  );
}

function fleetSummary(agents: AgentDTO[]) {
  const active = agents.filter((agent) => agent.status === "working" || agent.status === "starting").length;
  const blocked = agents.filter((agent) => agent.status === "input" || agent.status === "error").length;
  const pending = agents.reduce((sum, agent) => sum + agent.pending.length, 0);
  const knownContexts = agents.map(contextPercent).filter((value): value is number => value !== null);
  const avgContext = knownContexts.length
    ? Math.round(knownContexts.reduce((sum, value) => sum + value, 0) / knownContexts.length)
    : null;
  return { active, blocked, pending, avgContext };
}

export function AgentsView({ squad, selectedId, onSelect }: AgentsViewProps) {
  const agents = useMemo(() => sortedAgents(squad.agents), [squad.agents]);
  const selectedAgent = selectedId ? (agents.find((agent) => agent.id === selectedId) ?? null) : null;
  const selectedAgentId = selectedAgent?.id;
  const summary = useMemo(() => fleetSummary(squad.agents), [squad.agents]);

  const { subscribe } = squad;
  useEffect(() => {
    if (selectedAgentId) subscribe(selectedAgentId);
  }, [selectedAgentId, subscribe]);

  return (
    <div className="flex h-full min-h-0 bg-background text-foreground">
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="flex w-full flex-col gap-3 px-3 py-3">
          <header className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-text-3">
                <Radio className={cn("size-3.5", squad.connected ? "text-success" : "text-danger")} aria-hidden />
                Fleet Glance
              </div>
              <h1 className="text-xl font-semibold tracking-tight text-text-1">Agents</h1>
              <p className="mt-0.5 max-w-2xl text-[13px] leading-5 text-text-2">
                Live board for agents, waits, receipts, and worktrees.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "inline-flex min-h-8 items-center gap-2 rounded-md border px-2.5 text-[13px]",
                  squad.connected
                    ? "border-success/25 bg-success-subtle text-success"
                    : "border-danger/25 bg-danger-subtle text-danger",
                )}
              >
                <span className="size-2 rounded-full bg-current" aria-hidden />
                {squad.connected ? "Live socket" : "Reconnecting"}
              </span>
              <span className="inline-flex min-h-8 items-center gap-2 rounded-md border border-border bg-card px-2.5 text-[13px] text-text-2">
                <Users className="size-4 text-accent" aria-hidden />
                {agents.length} agents
              </span>
            </div>
          </header>

          <section className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4" aria-label="Fleet summary">
            <MetricCard icon={Zap} label="Active" value={summary.active} hint="working or starting" />
            <MetricCard icon={MessageSquareWarning} label="Operator waits" value={summary.pending} hint="pending answers" />
            <MetricCard icon={AlertCircle} label="Blocked" value={summary.blocked} hint="input or error" />
            <MetricCard icon={Gauge} label="Avg context" value={summary.avgContext == null ? "n/a" : `${summary.avgContext}%`} hint="reported by agents" />
          </section>

          <section className="overflow-hidden rounded-md border border-border bg-card/80 shadow-[var(--shadow-card)]">
            <div className="flex flex-col gap-2 border-b border-border bg-secondary/50 px-3 py-2 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="flex items-center gap-2 text-sm font-semibold text-text-1">
                  <Activity className="size-4 text-accent" aria-hidden />
                  Fleet board
                </h2>
                <p className="mt-0.5 text-xs text-text-3">Select an agent to inspect work, waits, receipts, and transcript context.</p>
              </div>
              <div className="rounded-md border border-border bg-card px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-3">
                Receipt-backed metrics only
              </div>
            </div>

            {agents.length === 0 ? (
              <EmptyState title="No agents online" className="my-6">
                Spawn a mission from the planner or reconnect to see live fleet activity here.
              </EmptyState>
            ) : (
              <div className="grid gap-px bg-border/60 p-px md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {agents.map((agent) => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    selected={agent.id === selectedId}
                    onSelect={() => onSelect(agent.id)}
                  />
                ))}
              </div>
            )}
          </section>

          {selectedAgent ? (
            <section className="overflow-hidden rounded-md border border-border bg-card/80 shadow-[var(--shadow-card)] xl:hidden">
              <div className="border-b border-border bg-secondary/50 px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-text-3">
                Selected agent context
              </div>
              <div className="p-3">
                <AgentInsight agent={selectedAgent} squad={squad} />
              </div>
            </section>
          ) : null}

          <section className="grid gap-3 md:grid-cols-3" aria-label="Fleet footer stats">
            <FooterStat label="Connected" value={squad.connected ? "Yes" : "No"} />
            <FooterStat label="Tracked transcripts" value={squad.transcripts.size} />
            <FooterStat label="Command menus" value={squad.commands.size} />
          </section>
        </div>
      </main>

      <InsightsColumn agent={selectedAgent} squad={squad} agents={agents} onSelect={onSelect} />
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: ElementType;
  label: string;
  value: string | number;
  hint: string;
}) {
  return (
    <div className="rounded-md border border-border bg-card/80 p-3 shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex size-9 items-center justify-center rounded-lg bg-accent-subtle text-accent">
          <Icon className="size-4" aria-hidden />
        </div>
        <span className="text-2xl font-semibold tabular-nums text-text-1">{value}</span>
      </div>
      <div className="mt-3">
        <p className="text-sm font-medium text-text-1">{label}</p>
        <p className="mt-0.5 text-xs text-text-3">{hint}</p>
      </div>
    </div>
  );
}

function AgentCard({ agent, selected, onSelect }: { agent: AgentDTO; selected: boolean; onSelect: () => void }) {
  const todoLabel = agent.todo ? `${agent.todo.done}/${agent.todo.total}` : "standby";
  const pending = agent.pending.length;

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "group min-h-44 bg-card p-3 text-left transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-surface-2 ring-1 ring-inset ring-accent/70",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={cn("size-2.5 rounded-full", STATUS_PANEL[agent.status])} aria-hidden />
            <h3 className="truncate text-sm font-semibold text-text-1">{agent.name}</h3>
          </div>
          <p className="mt-1 truncate text-xs text-text-3">{displayRepo(agent)}</p>
        </div>
        <StatusBadge status={agent.status} />
      </div>

      <p className="mt-2 line-clamp-2 min-h-8 text-[13px] leading-5 text-text-2">{displayActivity(agent)}</p>

      <div className="mt-3 rounded-md border border-border bg-surface-1/80 p-2 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex min-w-0 items-center gap-1.5 font-semibold text-text-2">
            <ReceiptText className="size-3.5 shrink-0 text-accent" aria-hidden />
            Latest receipt
          </span>
          <span className="shrink-0 font-mono text-text-1">{formatReceipt(agent)}</span>
        </div>
        <p className="mt-1 truncate text-[11px] text-text-3">{formatReceiptHint(agent)}</p>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-1.5 text-xs">
        <MiniStat icon={Cpu} label="Model" value={agent.model || "default"} />
        <MiniStat icon={Gauge} label="Context" value={formatContext(agent)} />
        <MiniStat icon={CheckCircle2} label="Todo" value={todoLabel} />
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-2 text-xs text-text-3">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <GitBranch className="size-3.5 shrink-0 text-accent" aria-hidden />
          <span className="truncate font-mono">{displayBranch(agent)}</span>
        </span>
        <span className={cn("shrink-0", pending > 0 && "font-semibold text-attention")}>
          {pending > 0 ? `${pending} pending` : <RelativeTime ts={agent.lastActivity} />}
        </span>
      </div>
    </button>
  );
}

function MiniStat({
  icon: Icon,
  label,
  value,
}: {
  icon: ElementType;
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-md border border-border bg-surface-1 px-2 py-1.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.08em] text-text-3">
        <Icon className="size-3" aria-hidden />
        {label}
      </div>
      <div className="truncate text-xs font-semibold text-text-1">{value}</div>
    </div>
  );
}

function FooterStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-border bg-card/70 px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-3">{label}</p>
      <p className="mt-1 text-sm font-semibold tabular-nums text-text-1">{value}</p>
    </div>
  );
}

function InsightsColumn({
  agent,
  squad,
  agents,
  onSelect,
}: {
  agent: AgentDTO | null;
  squad: SquadState;
  agents: AgentDTO[];
  onSelect: (id: string) => void;
}) {
  const attentionAgents = agents
    .filter((item) => item.status === "working" || item.status === "input" || item.status === "error")
    .slice(0, 5);

  return (
    <aside className="hidden w-72 shrink-0 flex-col gap-3 overflow-y-auto border-l border-border bg-card/35 p-3 xl:flex">
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-text-3">
          <Flame className="size-4 text-warning" aria-hidden />
          Attention queue
        </h2>
        <div className="flex flex-col gap-2.5">
          {attentionAgents.length > 0 ? (
            attentionAgents.map((item, index) => (
              <AttentionAgentRow key={item.id} agent={item} rank={index + 1} selected={item.id === agent?.id} onSelect={() => onSelect(item.id)} />
            ))
          ) : (
            <div className="rounded-lg border border-border bg-card/70 p-3 text-sm text-text-3">No active agents need attention.</div>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-text-3">
          <Sparkles className="size-4 text-accent" aria-hidden />
          Context
        </h2>
        {agent ? <AgentInsight agent={agent} squad={squad} /> : <FleetInsight agents={agents} squad={squad} />}
      </section>
    </aside>
  );
}

function AttentionAgentRow({
  agent,
  rank,
  selected,
  onSelect,
}: {
  agent: AgentDTO;
  rank: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "w-full rounded-lg border p-3 text-left transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring",
        STATUS_PANEL[agent.status],
        selected && "ring-1 ring-inset ring-accent/70",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-text-2">
            {rank}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-text-1">{agent.name}</p>
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-text-2">{displayActivity(agent)}</p>
          </div>
        </div>
        <span className="shrink-0 text-sm font-semibold tabular-nums text-text-1">{formatContext(agent)}</span>
      </div>
    </button>
  );
}

function FleetInsight({ agents, squad }: { agents: AgentDTO[]; squad: SquadState }) {
  const newest = agents[0] ?? null;
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border bg-card/70 p-3">
        <p className="text-sm font-semibold text-text-1">Fleet readiness</p>
        <p className="mt-2 text-xs leading-relaxed text-text-3">
          {squad.connected
            ? "Socket is live. Select an agent to inspect transcript and controls."
            : "Socket is reconnecting. Showing the last roster received by the UI."}
        </p>
      </div>
      {newest ? (
        <div className="rounded-lg border border-border bg-card/70 p-3">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-text-3">Latest activity</p>
          <p className="mt-2 text-sm font-medium text-text-1">{newest.name}</p>
          <p className="mt-1 text-xs leading-relaxed text-text-3">{displayActivity(newest)}</p>
        </div>
      ) : null}
    </div>
  );
}

function AgentInsight({ agent, squad }: { agent: AgentDTO; squad: SquadState }) {
  const entries = squad.transcripts.get(agent.id) ?? [];
  const recent = entries.slice(-4);
  const context = contextPercent(agent);

  return (
    <div className="space-y-2">
      <div className="rounded-md border border-border bg-card/80 p-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-text-1">{agent.name}</p>
            <p className="mt-1 truncate text-xs text-text-3">{displayBranch(agent)}</p>
          </div>
          <StatusBadge status={agent.status} />
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-2">
          <div className="h-full rounded-full bg-accent" style={{ width: `${context ?? 0}%` }} />
        </div>
        <div className="mt-2 flex items-center justify-between text-xs text-text-3">
          <span>Context load</span>
          <span className="font-mono text-text-1">{context == null ? "not reported" : `${context}%`}</span>
        </div>
      </div>

      {agent.pending.length > 0 ? (
        <div className="space-y-2 rounded-md border border-attention/30 bg-attention-subtle p-2.5">
          <p className="flex items-center gap-2 text-sm font-semibold text-text-1">
            <MessageSquareWarning className="size-4 text-attention" aria-hidden />
            Operator input
          </p>
          {agent.pending.map((request) => (
            <div key={request.id} className="rounded-md border border-border bg-card/70 p-2">
              <p className="text-sm font-medium text-text-1">{request.title}</p>
              {request.message ? <p className="mt-1 whitespace-pre-wrap text-xs text-text-2">{request.message}</p> : null}
              <div className="mt-2">
                <AnswerControls
                  request={request}
                  onAnswer={(value) => squad.send({ type: "answer", id: agent.id, requestId: request.id, value })}
                />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-md border border-border bg-card/80">
        <div className="border-b border-border px-2.5 py-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-text-3">
          Controls
        </div>
        <AgentControlButtons agent={agent} squad={squad} />
      </div>

      <div className="rounded-md border border-border bg-card/80 p-2.5">
        <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-text-3">
          <Clock3 className="size-3.5" aria-hidden />
          Recent transcript
        </p>
        {recent.length > 0 ? (
          <div className="space-y-2">
            {recent.map((entry, index) => (
              <TranscriptLine key={`${entry.ts}-${index}`} entry={entry} />
            ))}
          </div>
        ) : (
          <p className="text-xs leading-relaxed text-text-3">No transcript replay loaded yet. Selecting the agent subscribes to it.</p>
        )}
      </div>
    </div>
  );
}

function AgentControlButtons({ agent, squad }: { agent: AgentDTO; squad: SquadState }) {
  return (
    <div className="grid grid-cols-2 gap-1.5 p-2">
      <Button type="button" variant="secondary" onClick={() => squad.send({ type: "interrupt", id: agent.id })}>
        Interrupt
      </Button>
      <Button type="button" variant="secondary" onClick={() => squad.send({ type: "restart", id: agent.id })}>
        Restart
      </Button>
      <Button type="button" variant="danger" onClick={() => squad.send({ type: "kill", id: agent.id })}>
        Kill
      </Button>
      <Button type="button" variant="danger" onClick={() => squad.send({ type: "remove", id: agent.id, deleteWorktree: true })}>
        Remove
      </Button>
    </div>
  );
}

function TranscriptLine({ entry }: { entry: TranscriptEntry }) {
  return (
    <div className="rounded-md border border-border bg-surface-1 p-2">
      <div className="mb-1 flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-text-3">
        <span className="inline-flex items-center gap-1.5">
          <Bot className="size-3" aria-hidden />
          {entry.kind}
        </span>
        <RelativeTime ts={entry.ts} />
      </div>
      <p className="line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed text-text-2">{entry.text}</p>
    </div>
  );
}

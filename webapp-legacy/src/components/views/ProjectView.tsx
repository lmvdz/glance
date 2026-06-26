import { useEffect, useMemo, useState } from "react";
import {
  GitBranch,
  Network,
  PackageCheck,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Target,
  Users,
  Workflow,
} from "lucide-react";
import type { SquadState } from "@/hooks/useSquad";
import type { AgentDTO, FeatureDTO, IssueRef } from "@/lib/dto";
import { useProjectIssues } from "@/hooks/useTasks";
import { STAGE_LABEL, agentColorVar, stageColorVar } from "@/lib/status";
import { TaskDetail } from "@/components/project/TaskDetail";
import { Button } from "@/components/ui/button";
import { SkeletonCard } from "@/components/ui/skeleton";
import { MetaCard, MetaEmptyPanel, MetaPill, MetaProgress, MetaSectionHeader } from "@/components/meta/MetaSurface";
import { ViewTabs } from "@/components/shared/ViewTabs";
import { featureHash, projectHash, taskHash } from "@/lib/routes";
import { cn } from "@/lib/utils";

type WorkView = "structure" | "graph";
type SortKey = "status" | "identifier" | "title";
type GroupKey = "status" | "kind" | "none";
type ItemKind = "feature" | "task";
type WorkItem = {
  id: string;
  kind: ItemKind;
  ref: string;
  title: string;
  status: string;
  group: string;
  blocked: number;
  agents: AgentDTO[];
  feature?: FeatureDTO;
  issue?: IssueRef;
};

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "status", label: "Status" },
  { value: "identifier", label: "Identifier" },
  { value: "title", label: "Title" },
];
const GROUP_OPTIONS: { value: GroupKey; label: string }[] = [
  { value: "status", label: "Status" },
  { value: "kind", label: "Kind" },
  { value: "none", label: "None" },
];

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function featurePct(feature: FeatureDTO): number {
  if (feature.workflowProgress?.total) return (feature.workflowProgress.done / feature.workflowProgress.total) * 100;
  if (feature.stage === "done") return 100;
  if (feature.stage === "landed") return 90;
  if (feature.stage === "review") return 72;
  if (feature.stage === "in-progress") return 45;
  if (feature.stage === "issues-created") return 25;
  return 12;
}

function issueTone(state?: string): "good" | "warn" | "danger" | "accent" | "neutral" {
  if (state === "completed") return "good";
  if (state === "started") return "accent";
  if (state === "cancelled") return "danger";
  return "neutral";
}

function statusColor(item: WorkItem): string {
  return item.kind === "feature" && item.feature ? stageColorVar(item.feature.stage) : item.issue?.state === "completed" ? "var(--color-glyph-done)" : item.issue?.state === "started" ? "var(--color-glyph-progress)" : item.issue?.state === "cancelled" ? "var(--color-glyph-cancelled)" : "var(--color-glyph-draft)";
}

function compareStatus(a: WorkItem, b: WorkItem): number {
  const order = ["diverged", "blocked", "review", "in-progress", "started", "issues-created", "planned", "unstarted", "landed", "completed", "done", "cancelled"];
  const ai = order.indexOf(a.blocked ? "blocked" : a.status);
  const bi = order.indexOf(b.blocked ? "blocked" : b.status);
  return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
}

function buildWorkItems(features: FeatureDTO[], issues: IssueRef[], agents: AgentDTO[]): WorkItem[] {
  const agentByFeature = new Map(features.map((f) => [f.id, agents.filter((a) => a.featureId === f.id)]));
  const agentByIssue = new Map<string, AgentDTO>();
  for (const agent of agents) if (agent.issue?.id) agentByIssue.set(agent.issue.id, agent);
  return [
    ...features.map((feature) => ({
      id: feature.id,
      kind: "feature" as const,
      ref: feature.issueIdentifiers?.[0] ?? basename(feature.planDir ?? feature.id),
      title: feature.title,
      status: feature.stage,
      group: STAGE_LABEL[feature.stage],
      blocked: feature.blocked || feature.divergent ? 1 : 0,
      agents: agentByFeature.get(feature.id) ?? [],
      feature,
    })),
    ...issues.map((issue) => {
      const agent = agentByIssue.get(issue.id);
      return {
        id: issue.id,
        kind: "task" as const,
        ref: issue.identifier ?? issue.id.slice(0, 8),
        title: issue.name,
        status: issue.state ?? "unstarted",
        group: issue.state ?? "Unstarted",
        blocked: issue.blockedBy?.length ?? 0,
        agents: agent ? [agent] : [],
        issue,
      };
    }),
  ];
}

function LandingGatePanel({ features, issues, onPreview }: { features: FeatureDTO[]; issues: IssueRef[]; onPreview: () => void }) {
  const landed = features.filter((f) => f.stage === "landed" || f.stage === "done").length;
  const review = features.filter((f) => f.stage === "review").length;
  const conflicts = features.filter((f) => f.blocked || f.divergent).length + issues.filter((i) => (i.blockedBy?.length ?? 0) > 0).length;
  const progress = features.length ? (landed / features.length) * 100 : 0;
  return (
    <MetaCard className="overflow-hidden">
      <MetaSectionHeader eyebrow="Review / Land" title="Landing gate" action={<MetaPill tone={conflicts ? "danger" : review ? "accent" : "neutral"}>{conflicts ? "blocked" : review ? "review" : "clear"}</MetaPill>}>
        The merge path is the product: review, prove, land.
      </MetaSectionHeader>
      <div className="space-y-3 p-3">
        <MetaProgress value={progress} label={`${landed}/${features.length || 0} landed`} />
        <div className="grid grid-cols-3 gap-2 text-center text-xs">
          <div className="rounded border border-border p-2"><div className="font-semibold text-text-primary">{review}</div><div className="text-text-muted">review</div></div>
          <div className="rounded border border-border p-2"><div className="font-semibold text-text-primary">{conflicts}</div><div className="text-text-muted">blocked</div></div>
          <div className="rounded border border-border p-2"><div className="font-semibold text-text-primary">{issues.length}</div><div className="text-text-muted">tasks</div></div>
        </div>
        <Button type="button" className="w-full" variant="secondary" onClick={onPreview} disabled={features.length === 0}>
          {conflicts > 0 ? "Inspect blockers" : "Open landing candidate"}
        </Button>
      </div>
    </MetaCard>
  );
}

function ProjectReviewPanel({ agents }: { agents: AgentDTO[] }) {
  const activeAgents = agents.filter((a) => a.status === "working" || a.status === "input");
  return (
    <MetaCard className="overflow-hidden">
      <MetaSectionHeader eyebrow="Crew" title="Active operators" action={<MetaPill tone={activeAgents.length ? "accent" : "neutral"}>{activeAgents.length}</MetaPill>}>
        Piyaz-style: one project surface, every worker visible in context.
      </MetaSectionHeader>
      <div className="space-y-2 p-3">
        {activeAgents.length === 0 ? <p className="text-sm text-text-muted">No active agents on this project.</p> : activeAgents.map((agent) => <AgentMini key={agent.id} agent={agent} />)}
      </div>
    </MetaCard>
  );
}

function AgentMini({ agent }: { agent: AgentDTO }) {
  return (
    <div className="rounded border border-border bg-secondary/40 px-2.5 py-2 text-sm">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full" style={{ background: agentColorVar(agent.status) }} />
        <span className="min-w-0 flex-1 truncate text-text-primary">{agent.name}</span>
        <span className="text-xs text-text-muted">{agent.status}</span>
      </div>
      {agent.activity ? <p className="mt-1 truncate text-xs text-text-muted">{agent.activity}</p> : null}
    </div>
  );
}

function WorkspaceToolbar({ view, setView, query, setQuery, sort, setSort, group, setGroup, filterOpen, setFilterOpen, filterCount }: { view: WorkView; setView: (view: WorkView) => void; query: string; setQuery: (value: string) => void; sort: SortKey; setSort: (value: SortKey) => void; group: GroupKey; setGroup: (value: GroupKey) => void; filterOpen: boolean; setFilterOpen: (value: boolean) => void; filterCount: number }) {
  return (
    <div className="border-b border-border bg-secondary/35 p-2">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <ViewTabs activeId={view} onChange={(id) => setView(id as WorkView)} tabs={[{ id: "structure", label: "Structure" }, { id: "graph", label: "Graph" }]} />
        <label className="flex min-h-9 flex-1 items-center gap-2 rounded-md border border-border bg-base px-2 text-[13px] text-text-muted focus-within:border-accent">
          <Search className="h-4 w-4" aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tasks, missions, identifiers…" className="min-w-0 flex-1 bg-transparent text-text-primary outline-none placeholder:text-text-muted" />
        </label>
        <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)} className="min-h-9 rounded-md border border-border bg-base px-2 text-[13px] text-text-secondary focus:border-accent focus:outline-none">
          {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>Sort: {option.label}</option>)}
        </select>
        <select value={group} onChange={(event) => setGroup(event.target.value as GroupKey)} className="min-h-9 rounded-md border border-border bg-base px-2 text-[13px] text-text-secondary focus:border-accent focus:outline-none">
          {GROUP_OPTIONS.map((option) => <option key={option.value} value={option.value}>Group: {option.label}</option>)}
        </select>
        <button type="button" onClick={() => setFilterOpen(!filterOpen)} className={cn("inline-flex min-h-9 items-center gap-2 rounded-md border px-2.5 text-[13px]", filterOpen || filterCount ? "border-accent/40 bg-accent/10 text-accent-light" : "border-border bg-base text-text-secondary")}>
          <SlidersHorizontal className="h-4 w-4" aria-hidden="true" /> Filters{filterCount ? ` · ${filterCount}` : ""}
        </button>
      </div>
    </div>
  );
}

function FilterPanel({ onlyBlocked, setOnlyBlocked, onlyActive, setOnlyActive }: { onlyBlocked: boolean; setOnlyBlocked: (value: boolean) => void; onlyActive: boolean; setOnlyActive: (value: boolean) => void }) {
  return (
    <div className="flex flex-wrap gap-2 border-b border-border bg-base px-3 py-2 text-[13px]">
      <label className="inline-flex min-h-8 items-center gap-2 rounded-md border border-border bg-secondary/50 px-2.5 text-text-secondary">
        <input type="checkbox" checked={onlyBlocked} onChange={(event) => setOnlyBlocked(event.target.checked)} /> Blocked only
      </label>
      <label className="inline-flex min-h-8 items-center gap-2 rounded-md border border-border bg-secondary/50 px-2.5 text-text-secondary">
        <input type="checkbox" checked={onlyActive} onChange={(event) => setOnlyActive(event.target.checked)} /> Active agents only
      </label>
    </div>
  );
}

function groupLabel(item: WorkItem, group: GroupKey): string {
  if (group === "kind") return item.kind === "feature" ? "Missions" : "Tasks";
  if (group === "none") return "All work";
  return item.blocked ? "Blocked" : item.group;
}

function WorkRow({ item, focused, onOpen }: { item: WorkItem; focused: boolean; onOpen: (item: WorkItem) => void }) {
  const activeAgent = item.agents.find((agent) => agent.status === "working" || agent.status === "input" || agent.status === "error");
  return (
    <button type="button" onClick={() => onOpen(item)} className={cn("group flex min-h-10 w-full items-center gap-2 rounded px-2 text-left text-sm transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", focused && "ring-1 ring-accent ring-inset")}>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: statusColor(item) }} title={item.status} />
      <span className="w-20 shrink-0 truncate font-mono text-xs text-text-muted">{item.ref}</span>
      <span className="min-w-0 flex-1 truncate text-text-primary">{item.title}</span>
      {item.kind === "feature" && item.feature ? <MetaPill tone={item.feature.blocked || item.feature.divergent ? "danger" : item.feature.stage === "review" ? "accent" : "neutral"}>{STAGE_LABEL[item.feature.stage]}</MetaPill> : <MetaPill tone={issueTone(item.issue?.state)}>{item.issue?.state ?? "task"}</MetaPill>}
      {item.blocked > 0 ? <span className="shrink-0 rounded bg-warning-subtle px-1.5 py-0.5 text-xs text-warning" title={`${item.blocked} blockers`}>⛓ {item.blocked}</span> : null}
      {activeAgent ? <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: agentColorVar(activeAgent.status) }} title={`${activeAgent.name}: ${activeAgent.status}`} /> : null}
    </button>
  );
}

function StructurePane({ items, group, focusedId, onOpen }: { items: WorkItem[]; group: GroupKey; focusedId: string | null; onOpen: (item: WorkItem) => void }) {
  if (items.length === 0) return <MetaEmptyPanel title="No matching work">Clear search or filters to see tasks and missions.</MetaEmptyPanel>;
  const sections = new Map<string, WorkItem[]>();
  for (const item of items) {
    const label = groupLabel(item, group);
    sections.set(label, [...(sections.get(label) ?? []), item]);
  }
  return (
    <div className="space-y-2 p-2">
      {[...sections.entries()].map(([label, list]) => (
        <section key={label} className="overflow-hidden rounded-[var(--radius-sm)] border border-border bg-secondary/25">
          <div className="flex items-center justify-between border-b border-border px-2 py-1.5 text-[0.65rem] font-semibold uppercase tracking-wide text-text-muted">
            <span>{label}</span><span>{list.length}</span>
          </div>
          <div className="p-1">
            {list.map((item) => <WorkRow key={`${item.kind}:${item.id}`} item={item} focused={focusedId === item.id} onOpen={onOpen} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

function GraphPane({ items, onOpen }: { items: WorkItem[]; onOpen: (item: WorkItem) => void }) {
  const blocked = items.filter((item) => item.blocked > 0);
  const ready = items.filter((item) => item.blocked === 0);
  return (
    <div className="relative min-h-[34rem] overflow-hidden bg-base p-3">
      <div className="absolute inset-0 opacity-50" style={{ background: "radial-gradient(circle at 30% 20%, var(--color-accent-subtle), transparent 34%), radial-gradient(circle at 70% 65%, var(--color-success-subtle), transparent 28%)" }} />
      <div className="relative grid gap-3 lg:grid-cols-2">
        <GraphColumn title="Blocked / risky" tone="danger" items={blocked} onOpen={onOpen} />
        <GraphColumn title="Ready / moving" tone="good" items={ready} onOpen={onOpen} />
      </div>
    </div>
  );
}

function GraphColumn({ title, tone, items, onOpen }: { title: string; tone: "danger" | "good"; items: WorkItem[]; onOpen: (item: WorkItem) => void }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-border bg-surface/75 p-3 shadow-[var(--shadow-card)] backdrop-blur">
      <div className="mb-3 flex items-center justify-between text-sm font-semibold text-text-primary"><span>{title}</span><MetaPill tone={tone}>{items.length}</MetaPill></div>
      <div className="grid gap-2">
        {items.length === 0 ? <p className="text-sm text-text-muted">No nodes in this lane.</p> : items.map((item) => (
          <button key={`${title}:${item.kind}:${item.id}`} type="button" onClick={() => onOpen(item)} className="rounded-[var(--radius-sm)] border border-border bg-base/80 p-2 text-left transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full" style={{ background: statusColor(item) }} /><span className="font-mono text-xs text-text-muted">{item.ref}</span><span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{item.title}</span></div>
            <div className="mt-1 flex flex-wrap gap-1.5 text-xs text-text-muted"><span>{item.kind}</span><span>{item.status}</span>{item.agents.length ? <span>{item.agents.length} agents</span> : null}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function ContextBundle({ repo, items, features, issues }: { repo: string; items: WorkItem[]; features: FeatureDTO[]; issues: IssueRef[] }) {
  const next = items.find((item) => item.blocked > 0) ?? items.find((item) => item.status === "review" || item.status === "started") ?? items[0];
  return (
    <MetaCard className="overflow-hidden">
      <MetaSectionHeader eyebrow="Context bundle" title={next ? next.ref : "No active bundle"} action={<MetaPill tone={next?.blocked ? "danger" : "accent"}>{next?.kind ?? "idle"}</MetaPill>}>
        The bundle an agent should receive before it touches this project.
      </MetaSectionHeader>
      <div className="divide-y divide-border text-sm">
        <BundleRow icon={<Target className="h-4 w-4" />} title="Project" body={basename(repo)} />
        <BundleRow icon={<Workflow className="h-4 w-4" />} title="Spec" body={next?.title ?? "No task selected."} />
        <BundleRow icon={<Network className="h-4 w-4" />} title="Prerequisites" body={next?.blocked ? `${next.blocked} blocker(s) must clear first.` : "No known blockers in the current feed."} />
        <BundleRow icon={<ShieldCheck className="h-4 w-4" />} title="Verification" body="Run the repo gate before any landing action." />
        <BundleRow icon={<GitBranch className="h-4 w-4" />} title="Neighbors" body={`${features.length} missions · ${issues.length} tasks`} />
      </div>
    </MetaCard>
  );
}

function BundleRow({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return <div className="flex gap-3 p-3"><span className="mt-0.5 text-accent-light">{icon}</span><span className="min-w-0"><span className="block text-xs font-semibold uppercase tracking-wide text-text-muted">{title}</span><span className="mt-1 block text-text-secondary">{body}</span></span></div>;
}

export function ProjectView({ repo, taskId, squad }: { repo: string; taskId: string | null; squad: SquadState }) {
  const { issues, loading, configured } = useProjectIssues(repo);
  const [view, setView] = useState<WorkView>("structure");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("status");
  const [group, setGroup] = useState<GroupKey>("status");
  const [filterOpen, setFilterOpen] = useState(false);
  const [onlyBlocked, setOnlyBlocked] = useState(false);
  const [onlyActive, setOnlyActive] = useState(false);

  const features = useMemo(() => squad.features.filter((f) => f.repo === repo), [squad.features, repo]);
  const repoAgents = useMemo(() => squad.agents.filter((a) => a.repo === repo), [squad.agents, repo]);
  const items = useMemo(() => buildWorkItems(features, issues, repoAgents), [features, issues, repoAgents]);
  const filterCount = Number(onlyBlocked) + Number(onlyActive);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter((item) => !q || item.title.toLowerCase().includes(q) || item.ref.toLowerCase().includes(q) || item.status.toLowerCase().includes(q))
      .filter((item) => !onlyBlocked || item.blocked > 0)
      .filter((item) => !onlyActive || item.agents.some((agent) => agent.status === "working" || agent.status === "input" || agent.status === "error"))
      .sort((a, b) => sort === "status" ? compareStatus(a, b) || a.ref.localeCompare(b.ref) : sort === "identifier" ? a.ref.localeCompare(b.ref) : a.title.localeCompare(b.title));
  }, [items, query, onlyBlocked, onlyActive, sort]);

  const flatIds = filtered.map((item) => item.id);
  const [focus, setFocus] = useState(0);
  const openItem = (item: WorkItem) => {
    location.hash = item.kind === "feature" ? featureHash(item.id) : taskHash(repo, item.id);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (taskId || flatIds.length === 0) return;
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        setFocus((value) => Math.min(value + 1, flatIds.length - 1));
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        setFocus((value) => Math.max(value - 1, 0));
      } else if (event.key === "Enter") {
        const item = filtered[focus];
        if (item) openItem(item);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flatIds, filtered, focus, repo, taskId]);

  const name = basename(repo);
  const empty = features.length === 0 && issues.length === 0;
  if (taskId) return <TaskDetail repo={repo} taskId={taskId} onClose={() => { location.hash = projectHash(repo); }} squad={squad} />;
  const landed = features.filter((f) => f.stage === "landed" || f.stage === "done").length;
  const avgProgress = features.length ? features.reduce((sum, feature) => sum + featurePct(feature), 0) / features.length : 0;
  const previewLanding = () => {
    const candidate = features.find((feature) => feature.stage === "review" || feature.blocked || feature.divergent) ?? features[0];
    if (candidate) location.hash = featureHash(candidate.id);
  };

  return (
    <div className="relative h-full overflow-hidden bg-base">
      <div className="border-b border-border px-3 py-3">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-text-muted">Project workspace</p>
            <h1 className="truncate text-lg font-semibold text-text-primary" title={repo}>{name}</h1>
            <p className="mt-0.5 text-[13px] text-text-muted">{features.length} mission{features.length === 1 ? "" : "s"} · {issues.length} task{issues.length === 1 ? "" : "s"}{configured ? "" : " · Plane not configured"}</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-3 lg:w-[27rem]">
            <Metric icon={<PackageCheck className="h-4 w-4 text-done" />} label="Landed" value={landed} />
            <Metric icon={<Users className="h-4 w-4 text-accent-light" />} label="Agents" value={repoAgents.length} />
            <Metric icon={<Target className="h-4 w-4 text-progress" />} label="Review" value={features.filter((feature) => feature.stage === "review").length} />
          </div>
        </div>
        <div className="mt-3 max-w-3xl"><MetaProgress value={avgProgress} label={`${Math.round(avgProgress)}% workflow progress`} /></div>
      </div>

      {loading ? (
        <div className="grid gap-3 p-3 xl:grid-cols-[minmax(0,1fr)_20rem]"><div className="space-y-2"><SkeletonCard /><SkeletonCard /><SkeletonCard /></div><SkeletonCard className="h-56" /></div>
      ) : empty ? (
        <div className="p-3"><MetaEmptyPanel title="No project work yet">Features, tasks, and landing reviews will appear once this repo is attached to a plan.</MetaEmptyPanel></div>
      ) : (
        <div className="flex h-[calc(100%-7.8rem)] min-h-0">
          <section data-panel="navigator" className="flex min-w-0 flex-1 flex-col border-r border-border">
            <WorkspaceToolbar view={view} setView={setView} query={query} setQuery={setQuery} sort={sort} setSort={setSort} group={group} setGroup={setGroup} filterOpen={filterOpen} setFilterOpen={setFilterOpen} filterCount={filterCount} />
            {filterOpen ? <FilterPanel onlyBlocked={onlyBlocked} setOnlyBlocked={setOnlyBlocked} onlyActive={onlyActive} setOnlyActive={setOnlyActive} /> : null}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {view === "structure" ? <StructurePane items={filtered} group={group} focusedId={flatIds[focus] ?? null} onOpen={openItem} /> : <GraphPane items={filtered} onOpen={openItem} />}
            </div>
          </section>
          <aside className="hidden w-[22rem] shrink-0 space-y-3 overflow-y-auto p-3 xl:block">
            <ContextBundle repo={repo} items={filtered} features={features} issues={issues} />
            <LandingGatePanel features={features} issues={issues} onPreview={previewLanding} />
            <ProjectReviewPanel agents={repoAgents} />
            <MetaCard className="p-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-text-primary"><ShieldCheck className="h-4 w-4 text-done" aria-hidden="true" />Verification posture</div>
              <p className="mt-2 text-sm text-text-muted">Every path ends in the repo gate. Thin config pages stay out of navigation until they change this flow.</p>
              <div className="mt-3 flex flex-wrap gap-2"><MetaPill tone="good">proof first</MetaPill><MetaPill tone="neutral"><GitBranch className="mr-1 h-3.5 w-3.5" aria-hidden="true" />branch aware</MetaPill></div>
            </MetaCard>
          </aside>
        </div>
      )}
    </div>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return <div className="rounded-[var(--radius-sm)] border border-border bg-surface p-2"><div className="flex items-center gap-2 text-xs text-text-muted">{icon}{label}</div><p className="mt-0.5 text-base font-semibold text-text-primary">{value}</p></div>;
}

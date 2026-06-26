import { useEffect, useMemo, useState, type ElementType } from "react";
import { Boxes, FileCode2, FileText, Flame, HelpCircle, Info, Layers, ShieldCheck, Sparkles, Unplug } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { apiFetch } from "@/lib/ws";
import { magma, normalizeHeatData, type HeatData, type HotArea, type Insight, type TreeNode } from "@/lib/heat-data";

const ROW_H = "h-8";

type LoadState =
  | { status: "loading"; data: null; error: null }
  | { status: "ready"; data: HeatData; error: null }
  | { status: "error"; data: null; error: string };

function rowIcon(node: TreeNode) {
  if (node.type === "folder") return <Layers className="size-4 shrink-0 text-text-muted" aria-hidden="true" />;
  const Icon = node.name.endsWith(".md") ? FileText : FileCode2;
  return <Icon className="size-4 shrink-0 text-text-muted" aria-hidden="true" />;
}

function tagTone(tag: HotArea["tag"]): "danger" | "accent" | "success" | "neutral" {
  if (tag === "CORE HOTSPOT") return "danger";
  if (tag === "GROWING") return "accent";
  if (tag === "STEADY") return "success";
  return "neutral";
}

const INSIGHT_ICON: Record<NonNullable<Insight["icon"]>, ElementType> = {
  modularize: Boxes,
  extract: Unplug,
  tests: ShieldCheck,
};

function formatWindow(days: string[]) {
  if (days.length === 0) return "No samples";
  if (days.length === 1) return days[0];
  return `${days[0]}–${days[days.length - 1]}`;
}

function formatGeneratedAt(ts?: number) {
  if (!ts) return "Not reported";
  return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function heatCells(node: TreeNode, days: string[]) {
  return days.map((_, index) => node.heat?.[index] ?? null);
}

export function HeatmapView() {
  const [selected, setSelected] = useState("");
  const [showPeaks, setShowPeaks] = useState(true);
  const [hover, setHover] = useState<{ node: string; day: string; value: number } | null>(null);
  const [state, setState] = useState<LoadState>({ status: "loading", data: null, error: null });

  const load = () => {
    setState({ status: "loading", data: null, error: null });
    apiFetch("/api/heat")
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return normalizeHeatData(await response.json());
      })
      .then((data) => setState({ status: "ready", data, error: null }))
      .catch(() => setState({ status: "error", data: null, error: "The daemon did not return heat data." }));
  };

  useEffect(() => {
    load();
  }, []);

  const data = state.data;
  const firstFileId = useMemo(() => data?.tree.find((node) => node.type === "file")?.id ?? "", [data]);

  useEffect(() => {
    if (!data) return;
    if (!selected || !data.tree.some((node) => node.id === selected)) setSelected(firstFileId);
  }, [data, firstFileId, selected]);

  if (state.status === "loading") {
    return (
      <div className="h-full overflow-y-auto bg-base p-3 text-text-primary">
        <header className="mb-3 border-b border-border pb-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-2 h-7 w-56" />
        </header>
        <div className="mb-3 grid gap-2 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-14" />)}
        </div>
        <Skeleton className="h-[420px] w-full" />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="h-full overflow-y-auto bg-base p-3 text-text-primary">
        <ErrorState title="Couldn't load heatmap" onRetry={load}>
          {state.error} Try again after the daemon exposes /api/heat.
        </ErrorState>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="h-full overflow-y-auto bg-base p-3 text-text-primary">
        <EmptyState title="No heat payload">The daemon returned no heat data.</EmptyState>
      </div>
    );
  }

  const selectedNode = data.tree.find((node) => node.id === selected);
  const hasHeat = data.days.length > 0 && data.tree.some((node) => node.heat?.length);

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_18rem] overflow-hidden bg-base text-text-primary max-xl:grid-cols-1">
      <main className="min-w-0 overflow-y-auto p-3">
        <header className="mb-3 flex flex-wrap items-end justify-between gap-3 border-b border-border pb-3">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-text-muted">
              <Flame className="size-3.5 text-progress" aria-hidden="true" /> Context heat graph
            </div>
            <h1 className="truncate text-lg font-semibold tracking-tight">Codebase heatmap</h1>
            <p className="mt-0.5 text-[13px] text-text-muted">
              Receipt-backed file heat from the daemon. Empty means no completed runs have touched files yet.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={data.source ? "accent" : "neutral"}>{data.source ?? "/api/heat"}</Badge>
            <Button type="button" size="sm" variant={showPeaks ? "primary" : "secondary"} onClick={() => setShowPeaks((v) => !v)}>
              {showPeaks ? "Peaks on" : "Peaks off"}
            </Button>
          </div>
        </header>

        <div className="mb-3 grid gap-2 md:grid-cols-4">
          <Metric label="Files" value={data.tree.filter((node) => node.type === "file").length} />
          <Metric label="Window" value={formatWindow(data.days)} />
          <Metric label="Generated" value={formatGeneratedAt(data.generatedAt)} />
          <Metric label="Selected" value={selectedNode?.name ?? "none"} />
        </div>

        {!hasHeat ? (
          <EmptyState title="No heat samples yet" className="my-6">
            Completed agent runs with touched files will populate this map from /api/heat.
          </EmptyState>
        ) : (
          <Card className="bg-card/80">
            <CardHeader className="grid grid-cols-[260px_1fr] p-0 max-md:grid-cols-1">
              <div className="border-r border-border px-3 py-2 max-md:border-r-0">
                <CardTitle>File / module</CardTitle>
              </div>
              <div className="flex items-center gap-1.5 px-3 py-2 text-[length:var(--text-11)] font-semibold uppercase tracking-[0.06em] text-text-3">
                Heat over time <Info className="size-3.5" aria-hidden="true" />
              </div>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <div className="min-w-[760px] grid-cols-[260px_1fr] md:grid">
                <div className="border-r border-border">
                  <div className="h-8 border-b border-border" />
                  {data.tree.map((node) => {
                    const selectedRow = node.id === selected;
                    return (
                      <button
                        key={node.id}
                        type="button"
                        disabled={node.type === "folder"}
                        onClick={() => setSelected(node.id)}
                        className={cn(
                          "flex w-full items-center gap-2 px-3 text-left text-[13px] disabled:cursor-default focus-visible:ring-2 focus-visible:ring-ring",
                          ROW_H,
                          selectedRow ? "bg-secondary text-text-primary" : "text-text-secondary hover:bg-secondary/50",
                        )}
                        style={{ paddingLeft: `${12 + node.depth * 16}px` }}
                      >
                        {rowIcon(node)}
                        <span className="truncate">{node.name}</span>
                      </button>
                    );
                  })}
                </div>

                <div>
                  <div className="grid h-8 border-b border-border" style={{ gridTemplateColumns: `repeat(${data.days.length}, minmax(4rem, 1fr))` }}>
                    {data.days.map((day) => (
                      <div key={day} className="flex items-center justify-center text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted">
                        {day}
                      </div>
                    ))}
                  </div>
                  {data.tree.map((node) => {
                    const heat = heatCells(node, data.days);
                    const numericHeat = heat.filter((value): value is number => value !== null);
                    const peak = numericHeat.length ? Math.max(...numericHeat) : 0;
                    return (
                      <div key={node.id} className={cn("grid", ROW_H, node.id === selected && "ring-1 ring-inset ring-accent/70")} style={{ gridTemplateColumns: `repeat(${data.days.length}, minmax(4rem, 1fr))` }}>
                        {heat.map((value, i) => {
                          const hotPeak = showPeaks && node.type === "file" && value != null && value > 0.45 && value === peak;
                          return (
                            <div
                              key={`${node.id}-${data.days[i]}`}
                              onMouseEnter={() => (value == null ? setHover(null) : setHover({ node: node.name, day: data.days[i], value }))}
                              onMouseLeave={() => setHover(null)}
                              className="relative border-b border-r border-black/25 bg-surface-2/40 transition-[filter] hover:brightness-125"
                              style={value == null ? undefined : { backgroundColor: magma(value) }}
                            >
                              {hotPeak ? <span className="absolute inset-0 m-auto size-1.5 rounded-full bg-white/90 shadow-[0_0_6px_rgba(255,255,255,0.6)]" /> : null}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-xs text-text-muted">
                <span>Heat is normalized from receipt file-touch activity.</span>
                <span className="shrink-0 font-mono text-text-primary">{hover ? `${hover.node} · ${hover.day} · ${Math.round(hover.value * 100)}` : "hover a cell"}</span>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="mt-3 flex items-center gap-3 rounded-[var(--radius-md)] border border-border bg-surface p-2.5 text-[13px] text-text-muted">
          <HelpCircle className="size-4 shrink-0 text-accent-light" aria-hidden="true" />
          This page only renders daemon data. If receipts are empty, the map stays empty instead of showing sample files.
        </div>
      </main>

      <aside className="min-h-0 overflow-y-auto border-l border-border bg-card/35 p-3 max-xl:hidden">
        <section className="mb-4">
          <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-text-muted">
            <Sparkles className="size-4 text-progress" aria-hidden="true" /> Hot areas
          </h2>
          {data.hotAreas.length > 0 ? (
            <div className="space-y-2">
              {data.hotAreas.map((area) => (
                <div key={area.path} className="rounded-[var(--radius-sm)] border border-border bg-surface p-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-text-primary">{area.path}</div>
                      {area.description ? <p className="mt-1 line-clamp-2 text-xs text-text-muted">{area.description}</p> : null}
                    </div>
                    <span className="font-mono text-sm text-progress">{Math.round(area.score)}</span>
                  </div>
                  <div className="mt-2"><Badge tone={tagTone(area.tag)}>{area.tag ?? `#${area.rank || "hot"}`}</Badge></div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No hot areas">The daemon did not report any file hotspots.</EmptyState>
          )}
        </section>

        <section>
          <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-text-muted">
            <ShieldCheck className="size-4 text-done" aria-hidden="true" /> Receipt insights
          </h2>
          {data.insights.length > 0 ? (
            <div className="space-y-2">
              {data.insights.map((insight) => {
                const Icon = insight.icon ? INSIGHT_ICON[insight.icon] : ShieldCheck;
                return (
                  <div key={insight.title} className="flex items-start gap-2 rounded-[var(--radius-sm)] border border-border bg-surface p-2.5">
                    <Icon className="mt-0.5 size-4 shrink-0 text-accent-light" aria-hidden="true" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-text-primary">{insight.title}</div>
                      <p className="mt-0.5 text-xs text-text-muted">{insight.detail}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState title="No insights yet">Insights will appear when receipt history has enough signal.</EmptyState>
          )}
        </section>
      </aside>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-[var(--radius-sm)] border border-border bg-surface px-2.5 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">{label}</div>
      <div className="mt-0.5 truncate text-sm font-semibold text-text-primary">{value}</div>
    </div>
  );
}

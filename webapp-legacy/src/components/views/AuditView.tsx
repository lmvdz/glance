import { useEffect, useMemo, useState } from "react";
import { CalendarDays, ClipboardCopy, Download, Eye, FileText, Filter, GitCommitHorizontal, RefreshCw, ShieldCheck, Sparkles, Wrench } from "lucide-react";
import type { AuditEntry } from "@/lib/dto";
import { apiGet } from "@/lib/api";
import { RelativeTime } from "@/components/agent/relative-time";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";

type AuditFilter = "all" | "governance" | "provenance" | "observer";
type BadgeTone = "success" | "warning" | "attention" | "danger" | "accent" | "neutral";


function classify(entry: AuditEntry): AuditFilter {
  const text = `${entry.actor ?? ""} ${entry.action} ${entry.target ?? ""} ${entry.detail ?? ""}`.toLowerCase();
  if (text.includes("observer") || text.includes("scout") || text.includes("finding") || text.includes("opportunity")) return "observer";
  if (text.includes("provenance") || text.includes("handoff") || text.includes("lease") || text.includes("commit")) return "provenance";
  if (text.includes("policy") || text.includes("govern") || text.includes("capability") || text.includes("admission")) return "governance";
  return "all";
}

function outcomeTone(outcome?: string, detail?: string): BadgeTone {
  const text = `${outcome ?? ""} ${detail ?? ""}`.toLowerCase();
  if (text.includes("critical") || text.includes("reject") || text.includes("fail")) return "danger";
  if (text.includes("thrott") || text.includes("review") || text.includes("new")) return "warning";
  if (text.includes("allow") || text.includes("verified") || text.includes("success") || text.includes("pass")) return "success";
  if (text.includes("created") || text.includes("generated")) return "accent";
  return "neutral";
}

function categoryLabel(category: AuditFilter): string {
  if (category === "governance") return "Governance";
  if (category === "provenance") return "Provenance";
  if (category === "observer") return "Observer";
  return "General";
}

function categoryIcon(category: AuditFilter) {
  if (category === "governance") return ShieldCheck;
  if (category === "provenance") return GitCommitHorizontal;
  if (category === "observer") return Eye;
  return FileText;
}

// ponytail: 4s poll (matches the live SPA's feature cadence). Upgrade path:
// consume the `audit` WS event to prepend rows live.
export function AuditView() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [filter, setFilter] = useState<AuditFilter>("all");
  const [refresh, setRefresh] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const d = await apiGet<AuditEntry[]>("/api/audit?limit=200");
      if (alive) setEntries(d ?? []);
    };
    load();
    const id = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [refresh]);

  const displayEntries = entries ?? [];
  const empty = entries !== null && entries.length === 0;
  const stats = useMemo(() => {
    const counts = { governance: 0, provenance: 0, observer: 0 };
    for (const entry of displayEntries) {
      const category = classify(entry);
      if (category !== "all") counts[category]++;
    }
    return counts;
  }, [displayEntries]);
  const filtered = useMemo(
    () => (filter === "all" ? displayEntries : displayEntries.filter((entry) => classify(entry) === filter)),
    [displayEntries, filter],
  );

  const exportAudit = () => {
    const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `omp-squad-audit-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyEntry = (entry: AuditEntry, key: string) => {
    void navigator.clipboard?.writeText(JSON.stringify(entry, null, 2));
    setCopied(key);
    window.setTimeout(() => setCopied((value) => (value === key ? null : value)), 1400);
  };

  if (entries === null) {
    return (
      <div className="h-full overflow-y-auto bg-background p-3 text-foreground">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <Skeleton className="mb-2 h-6 w-48" />
            <Skeleton className="h-3.5 w-72" />
          </div>
          <Skeleton className="h-8 w-28" />
        </div>
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
          <Skeleton className="h-[520px]" />
          <Skeleton className="h-[520px]" />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-background text-foreground">
      <header className="flex flex-col gap-2 border-b border-border px-3 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-text-muted">
            <Eye className="size-3.5" aria-hidden="true" />
            Observer / Audit
          </div>
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-text-primary">
            Governance provenance
            <span className="rounded-[var(--radius-full)] border border-border px-2 py-0.5 text-xs text-text-muted">{displayEntries.length}</span>
          </h1>
          <p className="mt-0.5 text-[13px] text-text-muted">
            Observer findings, policy decisions, and handoff records from the live daemon.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => setRefresh((n) => n + 1)}>
            <RefreshCw className="size-4" aria-hidden="true" />
            Refresh
          </Button>
          <Button type="button" variant="outline" disabled title="The daemon API currently returns the latest audit window.">
            <CalendarDays className="size-4" aria-hidden="true" />
            Latest window
          </Button>
          <Button type="button" variant="outline" onClick={exportAudit} disabled={filtered.length === 0}>
            <Download className="size-4" aria-hidden="true" />
            Export JSON
          </Button>
        </div>
      </header>

      <main className="grid gap-3 p-3 xl:grid-cols-[minmax(0,1fr)_300px]">
        <section className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {([
              ["all", "All records", Filter],
              ["governance", "Governance", ShieldCheck],
              ["provenance", "Provenance", GitCommitHorizontal],
              ["observer", "Observer", Eye],
            ] as const).map(([value, label, Icon]) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={cn(
                  "inline-flex min-h-8 items-center gap-2 rounded-[var(--radius-sm)] border px-2.5 py-1 text-[13px] transition-colors",
                  filter === value
                    ? "border-accent bg-accent/15 text-text-primary"
                    : "border-border bg-secondary text-text-secondary hover:border-border-strong hover:bg-surface-hover",
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>

          <Card>
            <CardHeader className="grid grid-cols-[64px_minmax(220px,1fr)_112px_132px_minmax(150px,0.7fr)] gap-3 max-lg:hidden">
              <CardTitle>Priority</CardTitle>
              <span>Record</span>
              <span>Severity</span>
              <span>Source</span>
              <span>Suggested action</span>
            </CardHeader>
            <CardContent className="p-0">
              {empty ? (
                <div className="p-6 text-sm text-text-muted">No audit records yet. Spawn, steer, answer, land, or change policy and records will appear here.</div>
              ) : (
                <div className="divide-y divide-border">
                  {filtered.map((entry, i) => {
                    const category = classify(entry);
                    const Icon = categoryIcon(category);
                    const tone = outcomeTone(entry.outcome, entry.detail);
                    return (
                      <article
                        key={`${entry.at}-${entry.action}-${i}`}
                        className="grid gap-2 border-l-2 border-l-accent/70 p-3 lg:grid-cols-[64px_minmax(220px,1fr)_112px_132px_minmax(150px,0.7fr)] lg:gap-3"
                      >
                        <div className="flex items-center gap-2 lg:block">
                          <div className="text-xl font-semibold tabular-nums text-text-primary">{i + 1}</div>
                          <div className="mt-0.5 text-xs text-text-muted">
                            <RelativeTime ts={entry.at} />
                          </div>
                        </div>
                        <div className="min-w-0">
                          <h2 className="truncate text-sm font-semibold text-text-primary">{entry.target ?? entry.action}</h2>
                          <p className="mt-0.5 line-clamp-2 text-[13px] text-text-secondary">{entry.detail ?? entry.action}</p>
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            <Badge tone={category === "observer" ? "accent" : "neutral"}>{categoryLabel(category)}</Badge>
                          </div>
                        </div>
                        <div className="flex items-center lg:block">
                          <Badge tone={tone}>{entry.outcome ?? "recorded"}</Badge>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-border bg-secondary text-accent">
                            <Icon className="size-4" aria-hidden="true" />
                          </span>
                          <div className="min-w-0">
                            <div className="truncate text-sm text-text-primary">{entry.actor ?? "system"}</div>
                            <div className="truncate text-xs text-text-muted">{entry.action}</div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button type="button" variant={tone === "danger" ? "danger" : "outline"} size="sm" onClick={() => copyEntry(entry, `${entry.at}-${i}`)}>
                            {copied === `${entry.at}-${i}` ? <ClipboardCopy className="size-4" aria-hidden="true" /> : tone === "danger" ? <Wrench className="size-4" aria-hidden="true" /> : <FileText className="size-4" aria-hidden="true" />}
                            {copied === `${entry.at}-${i}` ? "Copied" : "Copy JSON"}
                          </Button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        <aside className="space-y-3">
          <Card>
            <CardHeader>
              <CardTitle>Pattern → opportunity</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-[var(--radius-md)] border border-border bg-secondary/60 p-3">
                <div className="text-xs uppercase tracking-wide text-text-muted">Live records</div>
                <div className="mt-2 flex items-end gap-3">
                  <span className="text-2xl font-semibold tabular-nums text-text-primary">{displayEntries.length}</span>
                  <span className="pb-0.5 text-text-muted">records</span>
                </div>
                <p className="mt-1.5 text-xs text-text-muted">Counts are derived from the live `/api/audit` response.</p>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-[var(--radius-sm)] border border-border p-2">
                  <div className="text-lg font-semibold text-text-primary">{stats.governance}</div>
                  <div className="text-xs text-text-muted">Policy</div>
                </div>
                <div className="rounded-[var(--radius-sm)] border border-border p-2">
                  <div className="text-lg font-semibold text-text-primary">{stats.provenance}</div>
                  <div className="text-xs text-text-muted">Provenance</div>
                </div>
                <div className="rounded-[var(--radius-sm)] border border-border p-2">
                  <div className="text-lg font-semibold text-text-primary">{stats.observer}</div>
                  <div className="text-xs text-text-muted">Observer</div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="justify-between">
              <CardTitle>Integrity signals</CardTitle>
              <ShieldCheck className="size-4 text-success" aria-hidden="true" />
            </CardHeader>
            <CardContent className="space-y-2">
              {[
                ["Append-only log", displayEntries.length > 0 ? "active" : "waiting"],
                ["Actor attribution", displayEntries.some((entry) => entry.actor) ? "present" : "empty"],
                ["Export redaction", "client export"],
                ["Policy trace", stats.governance > 0 ? "present" : "empty"],
              ].map(([label, value]) => (
                <div key={label} className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-border px-3 py-2 text-sm">
                  <span className="text-text-secondary">{label}</span>
                  <Badge tone={value === "present" || value === "active" ? "success" : "neutral"}>{value}</Badge>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent opportunities</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {displayEntries.slice(0, 3).map((entry, i) => (
                <button
                  key={`${entry.action}-${i}`}
                  type="button"
                  onClick={() => copyEntry(entry, `recent-${entry.at}-${i}`)}
                  className="flex min-h-8 w-full items-start gap-2 rounded-[var(--radius-sm)] border border-border p-2 text-left text-sm transition-colors hover:border-border-strong hover:bg-surface-hover"
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-accent/15 text-accent">
                    <Sparkles className="size-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-text-primary">{copied === `recent-${entry.at}-${i}` ? "Copied record JSON" : (entry.target ?? entry.action)}</span>
                    <span className="mt-1 block text-xs text-text-muted">
                      <RelativeTime ts={entry.at} /> · {entry.outcome ?? "recorded"}
                    </span>
                  </span>
                </button>
              ))}
            </CardContent>
          </Card>
        </aside>
      </main>
    </div>
  );
}

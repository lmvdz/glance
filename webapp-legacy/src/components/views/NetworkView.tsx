import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, GitBranch, Globe2, RadioTower, ShieldCheck, Users } from "lucide-react";
import type { SquadState } from "@/hooks/useSquad";
import { apiGet } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";

// Loose shapes — these come from our own daemon (trusted) and vary by deployment.
interface FederationSnapshot {
  coordinator?: string | null;
  operators?: { id?: string; name?: string; availability?: string }[];
  collisions?: { repo?: string; path?: string }[];
}
interface PresenceEntry { operator?: string; name?: string; availability?: string }
interface LeaseEntry { path?: string; holder?: string; operator?: string }
interface PlaneIssue { identifier?: string; name?: string; state?: string; url?: string }
interface GovernanceSnapshot { federation?: { coordinator?: boolean; dbRegistry?: boolean } }

type BadgeTone = "success" | "warning" | "attention" | "danger" | "accent" | "neutral";

const OPERATOR_POSITIONS = [
  { left: "9%", top: "20%" },
  { left: "71%", top: "18%" },
  { left: "14%", top: "68%" },
  { left: "72%", top: "68%" },
  { left: "41%", top: "8%" },
  { left: "43%", top: "77%" },
];

function availabilityTone(value?: string): BadgeTone {
  const v = (value ?? "").toLowerCase();
  if (v.includes("online") || v.includes("working")) return "success";
  if (v.includes("delegat") || v.includes("review")) return "accent";
  if (v.includes("standby") || v.includes("watch")) return "warning";
  if (v.includes("offline") || v.includes("error")) return "danger";
  return "neutral";
}

function statusColor(value?: string): string {
  const tone = availabilityTone(value);
  if (tone === "success") return "var(--color-done)";
  if (tone === "warning") return "var(--color-progress)";
  if (tone === "danger") return "var(--color-danger)";
  if (tone === "accent") return "var(--color-accent)";
  return "var(--color-text-muted)";
}

function repoName(repo: string): string {
  return repo.split("/").filter(Boolean).pop() ?? repo;
}

export function NetworkView({ squad }: { squad: SquadState }) {
  const liveRepos = useMemo(() => {
    const set = new Set<string>();
    for (const f of squad.features) set.add(f.repo);
    for (const a of squad.agents) set.add(a.repo);
    return [...set];
  }, [squad.features, squad.agents]);
  const repos = liveRepos;
  const hasRepo = repos.length > 0;

  const [repo, setRepo] = useState("");
  const activeRepo = repo || repos[0] || "";
  const activeLabel = activeRepo ? repoName(activeRepo) : "this daemon";
  const repoAgents = useMemo(() => squad.agents.filter((a) => a.repo === activeRepo), [squad.agents, activeRepo]);
  const agentPresence = useMemo<PresenceEntry[]>(
    () => repoAgents.map((a) => ({ operator: a.id, name: a.name, availability: a.status })),
    [repoAgents],
  );
  const agentIssues = useMemo<PlaneIssue[]>(
    () =>
      repoAgents
        .filter((a) => a.issue)
        .map((a) => ({
          identifier: a.issue?.identifier,
          name: a.issue?.name ?? a.name,
          state: a.issue?.state ?? a.status,
          url: a.issue?.url,
        })),
    [repoAgents],
  );

  const [fed, setFed] = useState<FederationSnapshot | null>(null);
  const [presence, setPresence] = useState<PresenceEntry[] | null>(null);
  const [leases, setLeases] = useState<LeaseEntry[] | null>(null);
  const [issues, setIssues] = useState<PlaneIssue[] | null>(null);
  const [planeOff, setPlaneOff] = useState(false);
  const [governance, setGovernance] = useState<GovernanceSnapshot | null>(null);
  const [selectedOperator, setSelectedOperator] = useState<string>("local");

  useEffect(() => {
    let alive = true;
    apiGet<FederationSnapshot>("/api/federation").then((d) => {
      if (alive) setFed(d ?? {});
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    apiGet<GovernanceSnapshot>("/api/governance").then((d) => {
      if (alive) setGovernance(d ?? {});
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!activeRepo) {
      setPresence([]);
      setLeases([]);
      setIssues([]);
      setPlaneOff(false);
      return;
    }
    let alive = true;
    const q = "?repo=" + encodeURIComponent(activeRepo);
    apiGet<PresenceEntry[]>("/api/presence" + q).then((d) => alive && setPresence(d ?? []));
    apiGet<LeaseEntry[]>("/api/leases" + q).then((d) => alive && setLeases(d ?? []));
    apiGet<PlaneIssue[]>("/api/plane/issues?project=" + encodeURIComponent(activeRepo)).then((d) => {
      if (!alive) return;
      setPlaneOff(d === null);
      setIssues(d ?? []);
    });
    return () => {
      alive = false;
    };
  }, [activeRepo]);

  const federationOperators = fed?.operators?.length ? fed.operators : [];
  const localOperators = repoAgents.length
    ? repoAgents.slice(0, 6).map((a) => ({ id: a.id, name: a.name, availability: a.status }))
    : [];
  const operators = federationOperators.length ? federationOperators : localOperators;
  const registryMode = governance === null
    ? "checking registry"
    : governance.federation?.dbRegistry
      ? "DB registry"
      : governance.federation?.coordinator
        ? "coordinator"
        : "local-only";
  const federationMode = fed === null || governance === null
    ? "checking registry"
    : federationOperators.length || fed?.coordinator
      ? "federation registry"
      : registryMode;
  const registryEmptyDetail = registryMode === "DB registry"
    ? "DB registry is active, so legacy local presence and lease files are intentionally hidden."
    : "No coordinator or peer registry entries are configured; this daemon is local-only unless live agents appear below.";
  const operatorSource = federationOperators.length ? "federation registry" : localOperators.length ? "live local agents" : "none";
  const collisions = fed?.collisions ?? [];
  const selected = operators.find((o) => (o.id ?? o.name) === selectedOperator) ?? operators[0];
  const readyLeases = leases;
  const readyPresence = presence?.length ? presence : agentPresence.length ? agentPresence : presence;
  const readyIssues = issues?.length ? issues : agentIssues.length ? agentIssues : issues;

  return (
    <div className="h-full overflow-y-auto bg-background text-foreground">
      <header className="flex flex-col gap-2 border-b border-border px-3 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-text-muted">
            <Globe2 className="size-3.5" aria-hidden="true" />
            Federation
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-text-primary">Network & operator graph</h1>
          <p className="mt-1 text-sm text-text-muted">Presence, leases, and governance handoffs for {activeLabel}; registry mode: {federationMode}.</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {hasRepo ? (
            <div className="w-full sm:w-72">
              <Select value={activeRepo} onValueChange={setRepo}>
                <SelectTrigger aria-label="Select repository">
                  <SelectValue placeholder="Select a repo" />
                </SelectTrigger>
                <SelectContent>
                  {repos.map((r) => (
                    <SelectItem key={r} value={r}>
                      {repoName(r)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <Badge tone={squad.connected ? "success" : "danger"}>
            <RadioTower className="size-4" aria-hidden="true" />
            {squad.connected ? "live daemon" : "offline"}
          </Badge>
        </div>
      </header>

      <main className="grid gap-3 p-3 xl:grid-cols-[minmax(0,1fr)_304px]">
        <section className="space-y-3">
          <Card className="bg-card/80">
            <CardHeader className="justify-between">
              <CardTitle>{operatorSource === "live local agents" ? "Local roster map" : "Federation map"}</CardTitle>
              <Badge tone={collisions.length ? "warning" : operatorSource === "live local agents" ? "accent" : "success"}>
                {collisions.length ? `${collisions.length} conflict risk` : operatorSource === "live local agents" ? "local roster" : federationMode}
              </Badge>
            </CardHeader>
            <CardContent className="p-0">
              {fed === null ? (
                <div className="grid gap-2 p-3 md:grid-cols-3">
                  <Skeleton className="h-32" />
                  <Skeleton className="h-32" />
                  <Skeleton className="h-32" />
                </div>
              ) : operators.length === 0 ? (
                <EmptyState title="No federation registry entries">{registryEmptyDetail}</EmptyState>
              ) : (
                <div className="relative min-h-[320px] overflow-hidden bg-[radial-gradient(circle_at_center,var(--color-accent-glow),transparent_58%)]">
                  <svg className="absolute inset-0 size-full" aria-hidden="true" preserveAspectRatio="none">
                    {operators.map((operator, i) => {
                      const pos = OPERATOR_POSITIONS[i % OPERATOR_POSITIONS.length];
                      const x = Number.parseFloat(pos.left);
                      const y = Number.parseFloat(pos.top);
                      return (
                        <line
                          key={operator.id ?? operator.name ?? i}
                          x1="50%"
                          y1="50%"
                          x2={`${x + 8}%`}
                          y2={`${y + 6}%`}
                          stroke={statusColor(operator.availability)}
                          strokeWidth="1.5"
                          strokeDasharray={availabilityTone(operator.availability) === "warning" ? "5 5" : undefined}
                          opacity="0.65"
                        />
                      );
                    })}
                  </svg>

                  <div className="absolute left-1/2 top-1/2 w-48 -translate-x-1/2 -translate-y-1/2 rounded-[var(--radius-md)] border border-accent/40 bg-secondary/90 p-3 text-center shadow-[var(--shadow-2)]">
                    <div className="mx-auto mb-2 flex size-9 items-center justify-center rounded-[var(--radius-sm)] bg-accent/15 text-accent">
                      <ShieldCheck className="size-5" aria-hidden="true" />
                    </div>
                    <div className="text-sm font-semibold text-text-primary">{fed.coordinator ?? registryMode}</div>
                    <div className="mt-1 text-xs text-text-muted">{operators.length} operators from {operatorSource} · {readyLeases?.length ?? 0} leases</div>
                  </div>

                  {operators.map((operator, i) => {
                    const id = operator.id ?? operator.name ?? String(i);
                    const pos = OPERATOR_POSITIONS[i % OPERATOR_POSITIONS.length];
                    const active = id === (selected?.id ?? selected?.name);
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setSelectedOperator(id)}
                        className={cn(
                          "absolute min-h-8 w-40 -translate-x-1/2 rounded-[var(--radius-md)] border bg-card/95 p-2 text-left shadow-[var(--shadow-1)] transition-colors hover:border-border-strong hover:bg-surface-raised",
                          active ? "border-accent text-text-primary" : "border-border text-text-secondary",
                        )}
                        style={{ left: pos.left, top: pos.top }}
                      >
                        <span className="mb-2 flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate text-sm font-semibold">{operator.name ?? operator.id}</span>
                          <span className="size-2.5 rounded-full" style={{ background: statusColor(operator.availability) }} />
                        </span>
                        <span className="text-xs uppercase tracking-wide text-text-muted">{operator.availability ?? "unknown"}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-3 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Operator presence</CardTitle>
              </CardHeader>
              <CardContent>
                {readyPresence === null ? (
                  <Skeleton className="h-28" />
                ) : readyPresence.length === 0 ? (
                  <p className="text-sm text-text-muted">{registryMode === "DB registry" ? "DB registry is active; legacy local presence records are intentionally hidden." : "No local presence records for this local-only repo."}</p>
                ) : (
                  <div className="space-y-2">
                    {readyPresence.map((p, i) => (
                      <div key={`${p.operator ?? p.name ?? i}`} className="flex items-center gap-3 rounded-[var(--radius-sm)] border border-border bg-secondary/60 p-2">
                        <span className="size-2.5 rounded-full" style={{ background: statusColor(p.availability) }} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-text-primary">{p.name ?? p.operator}</div>
                          <div className="truncate text-xs text-text-muted">{p.operator ?? "local"} · {p.availability ?? "available"}</div>
                        </div>
                        <Badge tone={availabilityTone(p.availability)}>{p.availability ?? "ready"}</Badge>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>File leases</CardTitle>
              </CardHeader>
              <CardContent>
                {readyLeases === null ? (
                  <Skeleton className="h-28" />
                ) : readyLeases.length === 0 ? (
                  <p className="text-sm text-text-muted">{registryMode === "DB registry" ? "DB registry is active; legacy local lease files are intentionally hidden." : "No file leases reported for this local-only repo."}</p>
                ) : (
                  <div className="space-y-1.5">
                    {readyLeases.map((l, i) => (
                      <div key={`${l.path ?? i}`} className="grid grid-cols-[1fr_auto] gap-3 rounded-[var(--radius-sm)] border border-border/80 px-2.5 py-2 font-mono text-xs">
                        <span className="truncate text-text-primary">{l.path}</span>
                        <span className="shrink-0 text-text-muted">{l.holder ?? l.operator}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </section>

        <aside className="space-y-3">
          <Card>
            <CardHeader>
              <CardTitle>Selected operator</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-[var(--radius-md)] border border-border bg-secondary/60 p-2.5">
                <div className="flex items-center gap-3">
                  <div className="flex size-8 items-center justify-center rounded-[var(--radius-sm)] bg-accent/15 text-accent">
                    <Users className="size-5" aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-text-primary">{selected?.name ?? selected?.id ?? "No operator selected"}</div>
                    <div className="text-xs text-text-muted">{selected?.availability ?? "unknown"}</div>
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-[var(--radius-sm)] border border-border p-2">
                  <div className="text-xs text-text-muted">Presence</div>
                  <div className="mt-1 font-semibold text-text-primary">{readyPresence?.length ?? "—"}</div>
                </div>
                <div className="rounded-[var(--radius-sm)] border border-border p-2">
                  <div className="text-xs text-text-muted">Leases</div>
                  <div className="mt-1 font-semibold text-text-primary">{readyLeases?.length ?? "—"}</div>
                </div>
              </div>
              <p className="rounded-[var(--radius-sm)] border border-border bg-secondary/50 p-2.5 text-[13px] text-text-muted">
                {operatorSource === "live local agents" ? "Showing live local agents because the federation registry returned no peers." : "Select an operator node to inspect its registry presence, leases, and Plane-linked work."}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="justify-between">
              <CardTitle>Conflict risks</CardTitle>
              <AlertTriangle className="size-4 text-warning" aria-hidden="true" />
            </CardHeader>
            <CardContent>
              {collisions.length === 0 ? (
                <div className="flex items-start gap-2 rounded-[var(--radius-sm)] border border-border bg-secondary/60 p-3 text-sm text-text-muted">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
                  No active cross-operator lease conflicts.
                </div>
              ) : (
                <div className="space-y-2">
                  {collisions.map((c, i) => (
                    <div key={`${c.repo ?? activeRepo}-${c.path ?? i}`} className="rounded-[var(--radius-sm)] border border-warning/30 bg-warning-subtle p-3">
                      <div className="text-sm font-medium text-text-primary">{repoName(c.repo ?? activeRepo)}</div>
                      <div className="mt-1 truncate font-mono text-xs text-warning">{c.path ?? "unknown path"}</div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Plane issues</CardTitle>
            </CardHeader>
            <CardContent>
              {planeOff ? (
                <p className="text-sm text-text-muted">Plane not connected. Set PLANE_API_KEY + PLANE_WORKSPACE on the daemon.</p>
              ) : readyIssues === null ? (
                <Skeleton className="h-28" />
              ) : readyIssues.length === 0 ? (
                <p className="text-sm text-text-muted">No open issues.</p>
              ) : (
                <div className="space-y-1.5">
                  {readyIssues.map((it, i) => {
                    const url = it.url && it.url !== "#" ? it.url : "";
                    const content = (
                      <>
                        <GitBranch className="size-4 shrink-0 text-accent" aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{it.name}</span>
                          {it.identifier ? <span className="font-mono text-xs text-text-muted">{it.identifier}</span> : null}
                        </span>
                        <span className="shrink-0 text-xs text-text-muted">{it.state ?? "Open"}</span>
                        {url ? <ExternalLink className="size-3.5 shrink-0 text-text-muted" aria-hidden="true" /> : null}
                      </>
                    );
                    const cls = "flex min-h-8 items-center gap-2 rounded-[var(--radius-sm)] border border-border px-2 py-1.5 text-sm text-text-primary transition-colors hover:border-border-strong hover:bg-surface-hover";
                    return url ? (
                      <a key={`${it.identifier ?? it.name ?? i}`} href={url} target="_blank" rel="noreferrer" className={cls}>{content}</a>
                    ) : (
                      <div key={`${it.identifier ?? it.name ?? i}`} className={cls}>{content}</div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </aside>
      </main>
    </div>
  );
}

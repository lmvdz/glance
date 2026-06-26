import { useEffect, useState, type ReactNode } from "react";
import { Activity, AlertTriangle, Bot, CheckCircle2, Cpu, GitBranch, Map, Route, Settings, ShieldCheck, Trophy, UserCog, Wrench } from "lucide-react";
import type { SquadState } from "@/hooks/useSquad";
import type { AgentDTO, AgentProfile, SettingsDTO, FeatureFlagDTO } from "@/lib/dto";
import type { View } from "@/components/layout/Sidebar";
import { apiGet, apiPost } from "@/lib/api";
import { apiFetch } from "@/lib/ws";
import { inboxActionCount } from "@/lib/inbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { SkeletonCard } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";

interface DashboardPagesViewProps {
  page: View;
  squad: SquadState;
  onView: (view: View) => void;
}

type BadgeTone = "success" | "warning" | "attention" | "danger" | "accent" | "neutral";
type Tile = { title: string; value: string | number; detail: string; tone?: BadgeTone };

function repoName(repo: string): string {
  return repo.split("/").filter(Boolean).pop() ?? repo;
}

function useProfiles() {
  const [state, setState] = useState<{ profiles: AgentProfile[]; loading: boolean; error: boolean }>({
    profiles: [],
    loading: true,
    error: false,
  });

  useEffect(() => {
    let alive = true;
    apiGet<{ profiles?: AgentProfile[] }>("/api/profiles").then((data) => {
      if (!alive) return;
      setState({ profiles: Array.isArray(data?.profiles) ? data.profiles : [], loading: false, error: data === null });
    });
    return () => {
      alive = false;
    };
  }, []);

  return state;
}

type FleetHealth = {
  ok: boolean;
  warnings?: string[];
  rssMb?: number;
  load1?: number;
  ncpu?: number;
  freeRatio?: number;
  agents?: number;
  hosts?: number;
  projects?: number;
  uptimeSec?: number;
  at?: number;
};

type UsageRollup = {
  runs?: unknown[] | number;
  receipts?: unknown[] | number;
  toolCalls?: number;
  costUsd?: number;
  tokens?: number;
  durationMs?: number;
  agents?: number;
  since?: number;
};

type GovernanceSnapshot = {
  authMode: "db" | "file";
  role: string;
  wipCap: number;
  maxAgents: number;
  federation: { coordinator: boolean; dbRegistry: boolean };
  audit: { available: true };
};

function useApiResource<T>(path: string) {
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: boolean }>({
    data: null,
    loading: true,
    error: false,
  });

  useEffect(() => {
    let alive = true;
    setState((current) => ({ ...current, loading: true, error: false }));
    apiFetch(path)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as T;
      })
      .then((data) => {
        if (alive) setState({ data, loading: false, error: false });
      })
      .catch(() => {
        if (alive) setState({ data: null, loading: false, error: true });
      });
    return () => {
      alive = false;
    };
  }, [path, version]);

  return { ...state, retry: () => setVersion((value) => value + 1) };
}

function useSettingsResource() {
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<{ data: SettingsDTO | null; loading: boolean; error: boolean }>({
    data: null,
    loading: true,
    error: false,
  });

  useEffect(() => {
    let alive = true;
    setState((current) => ({ ...current, loading: true, error: false }));
    apiGet<SettingsDTO>("/api/settings")
      .then((data) => {
        if (alive) setState({ data, loading: false, error: data === null });
      });
    return () => {
      alive = false;
    };
  }, [version]);

  return { ...state, retry: () => setVersion((value) => value + 1) };
}


function formatCompact(value: number | undefined, suffix = "") {
  return typeof value === "number" && Number.isFinite(value) ? `${Intl.NumberFormat(undefined, { notation: "compact" }).format(value)}${suffix}` : "—";
}

function formatCost(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(value >= 1 ? 2 : 4)}` : "—";
}

function formatDuration(seconds: number | undefined) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

function formatUsageDuration(ms: number | undefined) {
  return formatDuration(typeof ms === "number" ? ms / 1000 : undefined);
}

function countUsage(value: unknown[] | number | undefined) {
  if (Array.isArray(value)) return value.length;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function ApiSkeletonGrid() {
  return (
    <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 4 }).map((_, index) => <SkeletonCard key={index} />)}
    </div>
  );
}

function ProfileCard({ profile, agents }: { profile: AgentProfile; agents: AgentDTO[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{profile.name}</CardTitle>
        <Badge tone={profile.default ? "success" : "accent"}>{profile.default ? "default" : profile.runtime}</Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm leading-relaxed text-text-secondary">{profile.description ?? "Configured daemon profile."}</p>
        <div className="flex flex-wrap gap-1.5">
          {profile.model ? <Badge tone="neutral">{profile.model}</Badge> : null}
          {profile.approvalMode ? <Badge tone="warning">{profile.approvalMode}</Badge> : null}
          {(profile.capabilities ?? []).map((capability) => (
            <Badge key={capability} tone="neutral">{capability}</Badge>
          ))}
        </div>
        <div className="space-y-1.5">
          {agents.length === 0 ? (
            <p className="rounded border border-border bg-secondary/60 px-2 py-1.5 text-sm text-text-muted">No live agents use this profile.</p>
          ) : (
            agents.map((agent) => (
              <div key={agent.id} className="rounded border border-border px-2 py-1.5 text-sm text-text-secondary">
                {agent.name} · {agent.status}
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function PageShell({ title, eyebrow, children }: { title: string; eyebrow: string; children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto bg-base text-text-primary">
      <header className="border-b border-border px-3 py-3">
        <div className="text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-text-muted">{eyebrow}</div>
        <h1 className="mt-1 text-lg font-semibold tracking-tight">{title}</h1>
      </header>
      <main className="space-y-3 p-3">{children}</main>
    </div>
  );
}

function TileGrid({ tiles }: { tiles: Tile[] }) {
  return (
    <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
      {tiles.map((tile) => (
        <Card key={tile.title}>
          <CardContent>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-text-muted">{tile.title}</div>
                <div className="mt-1 text-2xl font-semibold tabular-nums text-text-primary">{tile.value}</div>
              </div>
              <Badge tone={tile.tone ?? "neutral"}>{tile.tone ?? "live"}</Badge>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-text-muted">{tile.detail}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function CapabilityRows({ rows }: { rows: { icon: ReactNode; title: string; detail: string; action?: ReactNode; status?: { label: string; tone: BadgeTone } }[] }) {
  return (
    <div className="grid gap-2 lg:grid-cols-2">
      {rows.map((row) => (
        <Card key={row.title}>
          <CardContent className="flex items-start gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-border bg-secondary text-accent">{row.icon}</span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-3">
                <span className="block font-semibold text-text-primary">{row.title}</span>
                {row.status ? <Badge tone={row.status.tone}>{row.status.label}</Badge> : null}
              </span>
              <span className="mt-1 block text-[13px] leading-relaxed text-text-secondary">{row.detail}</span>
              {row.action ? <span className="mt-3 block">{row.action}</span> : null}
            </span>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function SettingsPage() {
  const settings = useSettingsResource();
  const { toast } = useToast();
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const toggleFlag = async (flag: FeatureFlagDTO) => {
    const enabled = !flag.enabled;
    setPendingKey(flag.key);
    const updated = await apiPost<SettingsDTO>("/api/settings/feature-flags", { key: flag.key, enabled });
    setPendingKey(null);
    if (!updated) {
      toast({ title: "Feature flag not saved", description: "Admin access is required for daemon settings.", tone: "danger" });
      return;
    }
    settings.retry();
    toast({
      title: enabled ? "Feature flag enabled" : "Feature flag disabled",
      description: flag.restartRequired ? "Saved. Restart the daemon for this flag to fully take effect." : "Saved and applied to the running daemon.",
      tone: "success",
    });
  };

  return (
    <PageShell title="Settings" eyebrow="Configuration">
      <CapabilityRows rows={[
        { icon: <Settings className="size-4" aria-hidden="true" />, title: "UI preferences", detail: "Theme toggle is live in the top bar. Density follows the compact operator layout tokens." },
        { icon: <Route className="size-4" aria-hidden="true" />, title: "Routing", detail: "Hash routes stay dependency-free; add a router only when nested browser history becomes necessary." },
        { icon: <ShieldCheck className="size-4" aria-hidden="true" />, title: "Runtime flags", detail: "Daemon feature flags are persisted in settings.json and applied before boot loops start.", status: { label: "live api", tone: "success" } },
      ]} />
      <Card>
        <CardHeader>
          <CardTitle>Feature flags</CardTitle>
          {settings.data ? <Badge tone="neutral">{settings.data.featureFlags.length} flags</Badge> : null}
        </CardHeader>
        <CardContent className="space-y-2">
          {settings.loading ? (
            <div className="grid gap-2 md:grid-cols-2">
              <SkeletonCard />
              <SkeletonCard />
            </div>
          ) : settings.error || !settings.data ? (
            <ErrorState title="Couldn't load settings" onRetry={settings.retry}>
              The daemon did not return /api/settings.
            </ErrorState>
          ) : settings.data.featureFlags.length === 0 ? (
            <EmptyState title="No feature flags">The daemon has no toggleable feature flags.</EmptyState>
          ) : (
            <div className="grid gap-2 lg:grid-cols-2">
              {settings.data.featureFlags.map((flag) => (
                <FeatureFlagRow key={flag.key} flag={flag} pending={pendingKey === flag.key} onToggle={() => void toggleFlag(flag)} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}

function FeatureFlagRow({ flag, pending, onToggle }: { flag: FeatureFlagDTO; pending: boolean; onToggle: () => void }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-border bg-secondary/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold text-text-primary">{flag.label}</p>
            <Badge tone={flag.enabled ? "success" : "neutral"}>{flag.enabled ? "on" : "off"}</Badge>
            <Badge tone={flag.source === "settings" ? "accent" : "neutral"}>{flag.source}</Badge>
            {flag.restartRequired ? <Badge tone="warning">restart</Badge> : null}
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">{flag.description}</p>
          <p className="mt-2 font-mono text-[11px] text-text-muted">{flag.key}</p>
        </div>
        <Button type="button" aria-pressed={flag.enabled} disabled={pending} variant={flag.enabled ? "danger" : "primary"} onClick={onToggle} className="min-h-10">
          {pending ? "Saving…" : flag.enabled ? "Disable" : "Enable"}
        </Button>
      </div>
      {flag.restartRequired ? (
        <p className="mt-2 rounded border border-warning/25 bg-warning-subtle px-2 py-1.5 text-xs leading-relaxed text-text-secondary">
          Applies on next daemon restart; the saved value is still persisted now.
        </p>
      ) : null}
    </div>
  );
}


function HealthTiles({ squad }: { squad: SquadState }) {
  const health = useApiResource<FleetHealth>("/api/health");

  if (health.loading) return <ApiSkeletonGrid />;
  if (health.error) {
    return (
      <ErrorState title="Couldn't load fleet health" onRetry={health.retry}>
        The daemon did not return /api/health. Roster data is still coming from the websocket.
      </ErrorState>
    );
  }

  const data = health.data;
  if (!data) {
    return <EmptyState title="No health sample">The daemon returned no health payload.</EmptyState>;
  }

  return (
    <>
      <TileGrid tiles={[
        { title: "Daemon", value: data.ok ? "Healthy" : "Warnings", detail: data.warnings?.[0] ?? "Latest /api/health sample.", tone: data.ok ? "success" : "warning" },
        { title: "Agents", value: data.agents ?? squad.agents.length, detail: "Live non-terminal roster from /api/health." },
        { title: "Hosts", value: data.hosts ?? "—", detail: "Detached agent-host processes." },
        { title: "Uptime", value: formatDuration(data.uptimeSec), detail: `RSS ${formatCompact(data.rssMb, " MB")} · load ${formatCompact(data.load1)}` },
      ]} />
      {data.warnings && data.warnings.length > 1 ? (
        <Card>
          <CardContent className="space-y-1.5">
            <div className="text-sm font-semibold text-text-primary">Health warnings</div>
            {data.warnings.map((warning) => <p key={warning} className="text-xs leading-relaxed text-text-muted">{warning}</p>)}
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}

function UsageTiles() {
  const usage = useApiResource<UsageRollup>("/api/usage");

  if (usage.loading) return <ApiSkeletonGrid />;
  if (usage.error) {
    return (
      <ErrorState title="Couldn't load usage" onRetry={usage.retry}>
        The daemon did not return /api/usage, so cost and token rollups are hidden.
      </ErrorState>
    );
  }

  const data = usage.data;
  const runCount = countUsage(data?.runs) ?? countUsage(data?.receipts);
  const usageHasMetric = data ? ["toolCalls", "costUsd", "tokens", "durationMs"].some((key) => ((data[key as keyof UsageRollup] as number | undefined) ?? 0) > 0) : false;
  const hasSignal = runCount === undefined ? usageHasMetric : runCount > 0;
  if (!data || !hasSignal) {
    return <EmptyState title="No usage receipts yet">Completed runs with receipt data will populate cost, token, and tool-call totals.</EmptyState>;
  }

  return (
    <TileGrid tiles={[
      { title: "Runs", value: runCount ?? "—", detail: "Completed receipt records." },
      { title: "Tool calls", value: formatCompact(data.toolCalls), detail: "Assistant tool calls observed in receipts." },
      { title: "Tokens", value: formatCompact(data.tokens), detail: "Input, output, and cache tokens when reported." },
      { title: "Cost", value: formatCost(data.costUsd), detail: `Receipt duration ${formatUsageDuration(data.durationMs)}.` },
    ]} />
  );
}

function ObservabilityPage({ squad, waiting, repos, onView }: { squad: SquadState; waiting: number; repos: string[]; onView: (view: View) => void }) {
  return (
    <PageShell title="Observability" eyebrow="Diagnostics">
      <HealthTiles squad={squad} />
      <UsageTiles />
      <TileGrid tiles={[
        { title: "Socket agents", value: squad.agents.length, detail: "Roster from the live websocket." },
        { title: "Waiting", value: waiting, detail: "Agents needing input or reporting errors.", tone: waiting ? "warning" : "success" },
        { title: "Repos", value: repos.length, detail: "Repos inferred from live agents and missions." },
        { title: "Missions", value: squad.features.length, detail: "Plan features returned by `/api/features`." },
      ]} />
      <CapabilityRows rows={[
        { icon: <Map className="size-4" aria-hidden="true" />, title: "Context heatmap", detail: "Receipt-backed code heat from /api/heat.", action: <Button type="button" onClick={() => onView("heatmap")}>Open heatmap</Button>, status: { label: "/api/heat", tone: "accent" } },
        { icon: <GitBranch className="size-4" aria-hidden="true" />, title: "Trace graph", detail: "Workflow graph and trace overlays from live features/agents.", action: <Button type="button" onClick={() => onView("graph")}>Open trace</Button> },
        { icon: <ShieldCheck className="size-4" aria-hidden="true" />, title: "Audit explorer", detail: "Immutable daemon log with provenance filters and JSON export.", action: <Button type="button" onClick={() => onView("audit")}>Open audit</Button> },
        { icon: <Cpu className="size-4" aria-hidden="true" />, title: "Resource governance", detail: "Host pressure is read from /api/health; write controls stay hidden until daemon mutation APIs exist.", status: { label: "/api/health", tone: "success" } },
      ]} />
    </PageShell>
  );
}

function GovernancePage({
  agents,
  profileState,
  capabilityCount,
  onView,
}: {
  agents: AgentDTO[];
  profileState: { profiles: AgentProfile[]; loading: boolean; error: boolean };
  capabilityCount: number;
  onView: (view: View) => void;
}) {
  const governance = useApiResource<GovernanceSnapshot>("/api/governance");
  const data = governance.data;
  const governanceReady = !governance.loading && !governance.error && !!data;
  const governanceMissing = !governance.loading && !governanceReady;
  const federationLabel = data?.federation.dbRegistry ? "db registry" : data?.federation.coordinator ? "coordinator" : "local-only";

  return (
    <PageShell title="Governance" eyebrow="Policy surface">
      <CapabilityRows rows={[
        {
          icon: <ShieldCheck className="size-4" aria-hidden="true" />,
          title: "Capabilities",
          detail: profileState.loading
            ? "Checking /api/profiles for configured grants."
            : profileState.error
              ? "Missing: /api/profiles did not respond, so the UI cannot show configured capability grants."
              : `${capabilityCount} capability grants configured across ${profileState.profiles.length} daemon profiles.`,
          status: profileState.loading ? { label: "checking", tone: "neutral" } : profileState.error ? { label: "missing", tone: "danger" } : { label: "configured", tone: "success" },
          action: <Button type="button" onClick={() => onView("profiles")}>Open profiles</Button>,
        },
        {
          icon: <UserCog className="size-4" aria-hidden="true" />,
          title: "Operators",
          detail: governance.loading
            ? "Checking /api/governance for operator policy."
            : governanceMissing
              ? `Missing: /api/governance did not respond. ${agents.length} live local agents are visible from the websocket.`
              : `${agents.length} live local agents; auth mode ${data!.authMode}; current role ${data!.role}.`,
          status: governance.loading ? { label: "checking", tone: "neutral" } : governanceMissing ? { label: "missing", tone: "warning" } : { label: data!.authMode, tone: "accent" },
        },
        {
          icon: <Route className="size-4" aria-hidden="true" />,
          title: "Federation policy",
          detail: governance.loading
            ? "Checking /api/governance for federation mode."
            : governanceMissing
              ? "Missing: /api/governance did not report federation mode. Network still reads daemon federation endpoints directly."
              : data!.federation.dbRegistry
                ? "DB registry is active; legacy local presence and lease files are intentionally hidden."
                : data!.federation.coordinator
                  ? "Coordinator mode is configured for this daemon."
                  : "No coordinator configured; this daemon is operating local-only.",
          status: governance.loading ? { label: "checking", tone: "neutral" } : governanceMissing ? { label: "missing", tone: "warning" } : { label: federationLabel, tone: data!.federation.coordinator ? "success" : "accent" },
          action: <Button type="button" onClick={() => onView("network")}>Open federation</Button>,
        },
        {
          icon: <Wrench className="size-4" aria-hidden="true" />,
          title: "Admission controls",
          detail: governance.loading
            ? "Checking /api/governance for admission limits."
            : governanceMissing
              ? "Missing: /api/governance did not report WIP or max-agent limits."
              : `Configured: WIP cap ${data!.wipCap}, max agents ${data!.maxAgents}. Mutation controls remain hidden until daemon write APIs exist.`,
          status: governance.loading ? { label: "checking", tone: "neutral" } : governanceMissing ? { label: "missing", tone: "warning" } : { label: "configured", tone: "success" },
        },
      ]} />
    </PageShell>
  );
}

export function DashboardPagesView({ page, squad, onView }: DashboardPagesViewProps) {
  const waiting = inboxActionCount(squad.agents);
  const working = squad.agents.filter((a) => a.status === "working").length;
  const repos = [...new Set([...squad.features.map((f) => f.repo), ...squad.agents.map((a) => a.repo)])];
  const conflicted = squad.features.filter((f) => f.blocked || f.divergent || f.stage === "diverged");
  const review = squad.features.filter((f) => f.stage === "review" || f.stage === "landed");
  const profileState = useProfiles();
  const profileIds = new Set(profileState.profiles.map((profile) => profile.id));
  const unprofiledAgents = squad.agents.filter((agent) => !agent.profileId || !profileIds.has(agent.profileId));
  const liveProfileCount = new Set(squad.agents.map((agent) => agent.profileId).filter(Boolean)).size;
  const capabilityCount = profileState.profiles.reduce((sum, profile) => sum + (profile.capabilities?.length ?? 0), 0);

  if (page === "profiles") {
    return (
      <PageShell title="Agent profiles" eyebrow="Fleet identity">
        {profileState.loading ? (
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        ) : profileState.error ? (
          <EmptyState title="Profile registry unavailable">Could not load /api/profiles. Live agents are still shown elsewhere, but this page will not invent model buckets as profiles.</EmptyState>
        ) : (
          <div className="space-y-3">
            {profileState.profiles.length === 0 ? (
              <EmptyState title="No configured profiles">The daemon returned an empty profile registry.</EmptyState>
            ) : (
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {profileState.profiles.map((profile) => (
                  <ProfileCard key={profile.id} profile={profile} agents={squad.agents.filter((agent) => agent.profileId === profile.id)} />
                ))}
              </div>
            )}
            {unprofiledAgents.length > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle>Live agents without a configured profile</CardTitle>
                  <Badge tone="warning">{unprofiledAgents.length} agents</Badge>
                </CardHeader>
                <CardContent className="space-y-1.5">
                  {unprofiledAgents.map((agent) => (
                    <div key={agent.id} className="rounded border border-border px-2 py-1.5 text-sm text-text-secondary">
                      {agent.name} · {agent.profileId ? `unknown profile ${agent.profileId}` : "no profileId"}{agent.model ? ` · model ${agent.model}` : ""}
                    </div>
                  ))}
                </CardContent>
              </Card>
            ) : null}
          </div>
        )}
      </PageShell>
    );
  }

  if (page === "tournaments") {
    return (
      <PageShell title="Best-of-N tournaments" eyebrow="Selection gates">
        <TileGrid tiles={[{ title: "Reviewable", value: review.length, detail: "Features in review/landed stages can feed a bracket.", tone: review.length ? "warning" : "neutral" }, { title: "Active missions", value: squad.features.length, detail: "Live feature count from the daemon." }, { title: "Workers", value: squad.agents.length, detail: "Candidate-generating agents currently visible." }]} />
        {review.length === 0 ? (
          <EmptyState title="No candidates ready">Promote work to review/landing before a tournament can compare candidates.</EmptyState>
        ) : (
          <CapabilityRows rows={review.map((f) => ({ icon: <Trophy className="size-4" aria-hidden="true" />, title: f.title, detail: `${f.stage} · ${repoName(f.repo)}. Tournament mutation API is not configured.`, status: { label: "missing api", tone: "warning" } }))} />
        )}
      </PageShell>
    );
  }

  if (page === "observability") {
    return <ObservabilityPage squad={squad} waiting={waiting} repos={repos} onView={onView} />;
  }

  if (page === "governance") {
    return <GovernancePage agents={squad.agents} profileState={profileState} capabilityCount={capabilityCount} onView={onView} />;
  }

  if (page === "settings") {
    return <SettingsPage />;
  }

  if (page === "conflicts") {
    return (
      <PageShell title="Conflict resolver" eyebrow="Landing safety">
        {conflicted.length === 0 ? (
          <EmptyState title="No active conflicts">Blocked or diverged missions will appear here with their resolution gate.</EmptyState>
        ) : (
          <CapabilityRows rows={conflicted.map((f) => ({ icon: <AlertTriangle className="size-4" aria-hidden="true" />, title: f.title, detail: `${f.stage} · ${repoName(f.repo)}. Resolution mutation API is not configured.`, status: { label: "missing api", tone: "warning" } }))} />
        )}
      </PageShell>
    );
  }

  if (page === "onboarding") {
    return (
      <PageShell title="Onboarding" eyebrow="First run">
        <CapabilityRows rows={[
          {
            icon: repos.length ? <CheckCircle2 className="size-4" aria-hidden="true" /> : <GitBranch className="size-4" aria-hidden="true" />,
            title: "Connect a repo",
            detail: repos.length ? `${repos.length} repos visible: ${repos.map(repoName).join(", ")}` : "Start the daemon against a repo/worktree so projects appear in the left tree.",
            status: repos.length ? { label: "done", tone: "success" } : { label: "missing", tone: "warning" },
          },
          {
            icon: !profileState.error && profileState.profiles.length ? <CheckCircle2 className="size-4" aria-hidden="true" /> : <Bot className="size-4" aria-hidden="true" />,
            title: "Configure profiles",
            detail: profileState.loading
              ? "Checking /api/profiles."
              : profileState.error
                ? "Missing: /api/profiles is not reachable, so profile selection cannot be verified."
                : `${profileState.profiles.length} profiles configured; ${liveProfileCount} profile ids currently used by live agents.`,
            status: profileState.loading ? { label: "checking", tone: "neutral" } : profileState.error || profileState.profiles.length === 0 ? { label: "missing", tone: "warning" } : { label: "done", tone: "success" },
            action: <Button type="button" onClick={() => onView("profiles")}>Open profiles</Button>,
          },
          {
            icon: squad.agents.length ? <CheckCircle2 className="size-4" aria-hidden="true" /> : <Activity className="size-4" aria-hidden="true" />,
            title: "Run first agent",
            detail: squad.agents.length ? `${squad.agents.length} agents are in the roster.` : "Use Control Tower to spawn the first agent.",
            status: squad.agents.length ? { label: "done", tone: "success" } : { label: "missing", tone: "warning" },
            action: <Button type="button" onClick={() => onView("console")}>Open Control Tower</Button>,
          },
        ]} />
      </PageShell>
    );
  }

  return (
    <PageShell title="Fleet health" eyebrow="Live rollup">
      <HealthTiles squad={squad} />
      <TileGrid tiles={[
        { title: "Working", value: working, detail: "Agents actively running." },
        { title: "Waiting", value: waiting, detail: "Agents needing input or error recovery.", tone: waiting ? "warning" : "success" },
        { title: "Repos", value: repos.length, detail: "Workspaces with active data." },
        { title: "Conflicts", value: conflicted.length, detail: "Blocked/diverged missions.", tone: conflicted.length ? "danger" : "success" },
      ]} />
    </PageShell>
  );
}

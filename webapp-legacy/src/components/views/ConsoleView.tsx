import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  WebSpeechDictationAdapter,
  WebSpeechSynthesisAdapter,
  createMessageQueue,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { AlertTriangle, Bell, ClipboardList, Code2, FileDiff, FolderGit2, GitBranch, History, Sparkles, Terminal } from "lucide-react";
import type { AgentDTO, AgentProfile, FeatureDTO, PendingRequest } from "@/lib/dto";
import type { SquadState } from "@/hooks/useSquad";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { apiGet, apiPost } from "@/lib/api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { agentColorVar } from "@/lib/status";
import { appendText } from "@/lib/assistant-text";
import { buildOmpMessages, messagePlainText, toThreadMessage, type OmpChatMessage, type PendingUserMessage } from "@/lib/omp-thread";
import { Thread } from "@/components/assistant-ui/thread";
import { AnswerControls } from "@/components/agent/AnswerControls";
import { MetaEmptyPanel, MetaPill, MetaProgress } from "@/components/meta/MetaSurface";
import { RelativeTime } from "@/components/agent/relative-time";
import { cn } from "@/lib/cn";
import { uniqueModelOptions, type ModelOption } from "@/lib/model-options";

const PROMPTS = [
  {
    title: "Operator attention",
    prompt: "Summarize what needs operator attention and propose the next command.",
  },
  {
    title: "Risk check",
    prompt: "Inspect the riskiest in-progress work and tell me who should act.",
  },
  {
    title: "Landing plan",
    prompt: "Draft a landing plan for review-ready missions, including verification.",
  },
];

const DEFAULT_MODEL = "__default__";
const DEFAULT_PROFILE = "default";


type TowerMode = "agents" | "tasks" | "modules";

type ProjectRow = {
  repo: string;
  name: string;
  agents: AgentDTO[];
  features: FeatureDTO[];
  tasks: { id: string; label: string; state?: string; agentId?: string }[];
  modules: { id: string; label: string; stage: string }[];
};


function OmpWelcome() {
  return (
    <div className="mb-6 flex flex-col items-center gap-4 px-4 text-center">
      <span className="flex size-12 items-center justify-center rounded-[var(--radius-md)] border border-border bg-surface text-accent">
        <Sparkles className="size-5" aria-hidden="true" />
      </span>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-text-primary">Talk to omp directly</h2>
        <p className="max-w-xl text-sm leading-6 text-text-muted">This is a live assistant-ui thread bound to one omp session. Plain chat stays chat; explicit work can still steer the squad.</p>
      </div>
    </div>
  );
}

function PendingRequestPanel({ requests, onAnswer }: { requests: PendingRequest[]; onAnswer: (requestId: string, value: string) => void }) {
  if (requests.length === 0) return null;
  return (
    <div className="border-b border-border bg-progress-bg/70 p-3">
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        {requests.map((request) => (
          <section key={request.id} className="rounded-[var(--radius-md)] border border-progress/40 bg-surface p-3 shadow-[var(--shadow-card)]">
            <div className="mb-2 flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-progress" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-text-primary">{request.title}</h3>
                {request.message ? <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-text-muted">{request.message}</p> : null}
              </div>
            </div>
            <AnswerControls request={request} onAnswer={(value) => onAnswer(request.id, value)} />
          </section>
        ))}
      </div>
    </div>
  );
}


function RouteContextBanner({ context }: { context: string | null | undefined }) {
  const [copied, setCopied] = useState(false);
  if (!context) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(context);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="border-b border-border bg-accent/10 p-3">
      <div className="mx-auto flex max-w-3xl flex-col gap-2 rounded-[var(--radius-md)] border border-accent/30 bg-surface p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">Route context ready</h2>
            <p className="mt-1 text-xs text-text-muted">Nothing has been sent. Copy this fenced context into the composer when you want Control Tower to use it.</p>
          </div>
          <Button type="button" size="sm" variant="secondary" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy context"}
          </Button>
        </div>
        <pre className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] border border-border bg-secondary p-2 font-mono text-xs text-text-secondary">{context}</pre>
      </div>
    </div>
  );
}

function OmpLiveSession({
  agent,
  squad,
  onSelect,
  onBack,
  routeContext,
}: {
  agent: AgentDTO | null;
  squad: SquadState;
  onSelect: (id: string) => void;
  onBack: () => void;
  routeContext?: string | null;
}) {
  const { send, subscribe, connected } = squad;
  const activeId = agent?.id ?? null;
  const transcript = activeId ? (squad.transcripts.get(activeId) ?? []) : [];
  const [pending, setPending] = useState<PendingUserMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([{ label: "omp default", value: "" }]);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState(DEFAULT_PROFILE);
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL);
  const submitTextRef = useRef<(raw: string) => Promise<void>>(async () => {});
  const cancelRef = useRef<() => void>(() => {});
  const messageQueue = useMemo(
    () =>
      createMessageQueue({
        run: (message) => {
          void submitTextRef.current(appendText(message));
        },
        cancel: () => cancelRef.current(),
      }),
    [],
  );
  const dictationAdapter = useMemo(() => (typeof window !== "undefined" && WebSpeechDictationAdapter.isSupported() ? new WebSpeechDictationAdapter({ interimResults: true }) : undefined), []);
  const speechAdapter = useMemo(() => (typeof window !== "undefined" && "speechSynthesis" in window ? new WebSpeechSynthesisAdapter() : undefined), []);

  useEffect(() => {
    if (activeId) subscribe(activeId);
  }, [activeId, subscribe]);

  useEffect(() => {
    void apiGet<{ models: ModelOption[] }>("/api/models").then((result) => {
      if (result?.models.length) setModelOptions(uniqueModelOptions(result.models));
    });
    void apiGet<{ profiles: AgentProfile[] }>("/api/profiles").then((result) => {
      if (result?.profiles.length) setProfiles(result.profiles);
    });
  }, []);

  useEffect(() => {
    const model = agent?.model?.trim();
    setSelectedModel(model && modelOptions.some((option) => option.value === model) ? model : DEFAULT_MODEL);
  }, [agent?.model, modelOptions]);

  useEffect(() => {
    setSelectedProfile(agent?.profileId ?? profiles.find((profile) => profile.default)?.id ?? DEFAULT_PROFILE);
  }, [agent?.profileId, profiles]);


  useEffect(() => {
    setPending([]);
    setError(null);
  }, [activeId]);

  useEffect(() => {
    if (transcript.length === 0) return;
    setPending((items) => items.filter((item) => !transcript.some((entry) => entry.kind === "user" && entry.clientTurnId === item.clientTurnId)));
  }, [transcript]);

  const isRunning = busy || agent?.status === "starting" || agent?.status === "working";

  const messages = useMemo<OmpChatMessage[]>(() => buildOmpMessages(activeId, transcript, pending, isRunning), [activeId, isRunning, pending, transcript]);

  const modelSpec = selectedModel === DEFAULT_MODEL ? "" : selectedModel;

  const setModel = (value: string) => {
    setSelectedModel(value);
    const model = value === DEFAULT_MODEL ? "" : value;
    if (agent && model) send({ type: "set-model", id: agent.id, model });
  };

  const submitText = useCallback(async (raw: string): Promise<void> => {
    const text = raw.trim();
    if (!text) return;
    if (!connected) {
      setError("Daemon websocket is disconnected. Reconnect before starting a live omp chat.");
      return;
    }
    const clientTurnId = `turn:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const optimistic: PendingUserMessage = { id: `pending:${clientTurnId}`, text, ts: Date.now(), clientTurnId };
    setPending((items) => [...items, optimistic]);
    setError(null);

    if (activeId) {
      send({ type: "prompt", id: activeId, message: text, clientTurnId });
      return;
    }

    setBusy(true);
    const result = await apiPost<{ agentId: string }>("/api/console", { model: modelSpec || undefined, profileId: selectedProfile || undefined });
    setBusy(false);
    if (result) {
      onSelect(result.agentId);
      send({ type: "prompt", id: result.agentId, message: text, clientTurnId });
    } else {
      setError("Could not start an omp session. Check the daemon connection and try again.");
    }
  }, [activeId, connected, modelSpec, onSelect, selectedProfile, send]);

  useEffect(() => {
    submitTextRef.current = submitText;
  }, [submitText]);

  const cancelRun = useCallback(() => {
    if (activeId) send({ type: "interrupt", id: activeId });
  }, [activeId, send]);

  useEffect(() => {
    cancelRef.current = cancelRun;
  }, [cancelRun]);

  const answerRequest = useCallback((requestId: string, value: string) => {
    if (activeId) send({ type: "answer", id: activeId, requestId, value });
  }, [activeId, send]);


  useEffect(() => {
    if (isRunning) messageQueue.notifyBusy();
    else messageQueue.notifyIdle();
  }, [isRunning, messageQueue]);

  const runtime = useExternalStoreRuntime<OmpChatMessage>({
    messages,
    convertMessage: toThreadMessage,
    isRunning,
    isSendDisabled: !connected,
    suggestions: PROMPTS.map(({ prompt }) => ({ prompt })),
    queue: messageQueue.adapter,
    adapters: { dictation: dictationAdapter, speech: speechAdapter },
    onNew: async (message) => {
      const text = appendText(message);
      if (!text) return;
      await submitText(text);
    },
    onEdit: async (message) => {
      const text = appendText(message);
      if (text) await submitText(text);
    },
    onReload: async () => {
      const text = [...messages].reverse().find((message) => message.role === "user" && !message.pending);
      const prompt = text ? messagePlainText(text) : "";
      if (prompt) await submitText(prompt);
    },
    onCancel: async () => cancelRun(),
    unstable_capabilities: { copy: true },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <section className="flex h-full min-h-0 flex-col bg-base/90">
        <div className="flex min-h-11 items-center gap-2 border-b border-border px-3">
          {agent ? <Button type="button" size="sm" variant="ghost" onClick={onBack}>New chat</Button> : null}
          <span className="h-2 w-2 rounded-full" style={{ background: agent ? agentColorVar(agent.status) : "var(--color-accent)" }} />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold text-text-primary">{agent?.name ?? "Oh My Pi live session"}</h1>
            <p className="truncate text-xs text-text-muted">{agent ? "Live transcript + steering prompts over the daemon websocket." : "Start an idle omp session, then send chat turns over the live websocket."}</p>
          </div>
          <div className="flex min-w-44 items-center gap-2">
            <Select value={selectedProfile} onValueChange={setSelectedProfile} disabled={!!agent}>
              <SelectTrigger aria-label="Agent profile">
                <SelectValue placeholder="Profile" />
              </SelectTrigger>
              <SelectContent>
                {(profiles.length ? profiles : [{ id: DEFAULT_PROFILE, name: "Default OMP operator", runtime: "omp-operator" as const }]).map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={selectedModel} onValueChange={setModel}>
              <SelectTrigger aria-label="LLM model">
                <SelectValue placeholder="Model" />
              </SelectTrigger>
              <SelectContent>
                {modelOptions.map((option) => (
                  <SelectItem key={option.value || DEFAULT_MODEL} value={option.value || DEFAULT_MODEL}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <MetaPill tone={agent?.status === "error" ? "danger" : agent?.status === "input" ? "warn" : busy || agent?.status === "working" ? "accent" : "neutral"}>
              {busy ? "starting" : agent?.status ?? "ready"}
            </MetaPill>
          </div>
        </div>

        <PendingRequestPanel requests={agent?.pending ?? []} onAnswer={answerRequest} />
        <RouteContextBanner context={routeContext} />
        <div className="min-h-0 flex-1">
          <Thread
            components={{ Welcome: OmpWelcome }}
            inputPlaceholder={agent ? "Reply, steer, or ask a follow-up…" : "Say hello, ask a question, or describe work for omp…"}
            composerFooter={error ? <p className="rounded-[var(--radius-sm)] border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger">{error}</p> : null}
          />
        </div>
      </section>
    </AssistantRuntimeProvider>
  );
}


export function ConsoleView({ squad, handoffContext }: { squad: SquadState; handoffContext?: string | null }) {
  const [mode, setMode] = useState<TowerMode>("agents");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = selectedId ? (squad.agents.find((a) => a.id === selectedId) ?? null) : null;
  const working = squad.agents.filter((a) => a.status === "working").length;
  const needsInput = squad.agents.filter((a) => a.status === "input" || a.status === "error").length;
  const completion = squad.agents.length ? ((squad.agents.length - needsInput) / squad.agents.length) * 100 : 100;
  const notifications = squad.agents.filter((a) => a.status === "input" || a.status === "error" || a.pending.length > 0);
  const activity = [...squad.agents].sort((a, b) => b.lastActivity - a.lastActivity).slice(0, 6);
  const diffTargets = squad.features.filter((f) => f.unlandedFiles > 0 || f.divergent || f.blocked).slice(0, 5);

  const projects = useMemo<ProjectRow[]>(() => {
    const byRepo: Record<string, ProjectRow> = {};
    for (const feature of squad.features) {
      const name = feature.repo.split("/").filter(Boolean).pop() ?? feature.repo;
      const row = (byRepo[feature.repo] ??= { repo: feature.repo, name, agents: [], features: [], tasks: [], modules: [] });
      row.features.push(feature);
      for (const identifier of feature.issueIdentifiers ?? []) row.tasks.push({ id: `${feature.id}:${identifier}`, label: identifier, state: feature.stage });
      row.modules.push({ id: feature.id, label: feature.planDir?.split("/").filter(Boolean).pop() ?? feature.workflowStage ?? feature.title, stage: feature.stage });
    }
    for (const agent of squad.agents) {
      const name = agent.repo.split("/").filter(Boolean).pop() ?? agent.repo;
      const row = (byRepo[agent.repo] ??= { repo: agent.repo, name, agents: [], features: [], tasks: [], modules: [] });
      row.agents.push(agent);
      if (agent.issue) row.tasks.push({ id: agent.issue.id, label: agent.issue.identifier ?? agent.issue.name, state: agent.issue.state, agentId: agent.id });
    }
    return Object.values(byRepo).sort((a, b) => b.agents.filter((agent) => agent.status === "input" || agent.status === "error").length - a.agents.filter((agent) => agent.status === "input" || agent.status === "error").length || a.name.localeCompare(b.name));
  }, [squad.agents, squad.features]);


  return (
    <div className="grid h-full min-h-0 bg-base text-text-primary xl:grid-cols-[280px_minmax(0,1fr)_320px]">
      <aside className="min-h-0 overflow-y-auto border-r border-border bg-base-2/95 p-2 max-xl:hidden" aria-label="Command Tower projects">
        <div className="mb-2 rounded-[var(--radius-md)] border border-border bg-surface p-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <Terminal className="size-4 text-accent" aria-hidden="true" />
            Command Tower
          </div>
          <p className="mt-1 text-xs leading-relaxed text-text-muted">Projects first. Flip each project between agents, tasks, and modules.</p>
        </div>

        <div className="mb-2 grid grid-cols-3 rounded-[var(--radius-md)] border border-border bg-surface p-1" role="tablist" aria-label="Project content">
          {(["agents", "tasks", "modules"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={mode === tab}
              onClick={() => setMode(tab)}
              className={cn(
                "min-h-8 rounded-[var(--radius-sm)] px-2 text-xs font-medium capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                mode === tab ? "bg-accent text-primary-foreground" : "text-text-muted hover:bg-surface-hover hover:text-text-primary",
              )}
            >
              {tab}
            </button>
          ))}
        </div>

        {projects.length === 0 ? (
          <MetaEmptyPanel title="No projects yet">Start or connect a squad; live projects will appear here.</MetaEmptyPanel>
        ) : (
          <div className="space-y-2">
            {projects.map((project) => {
              const list = mode === "agents" ? project.agents : mode === "tasks" ? project.tasks : project.modules;
              return (
                <section key={project.repo} className="rounded-[var(--radius-md)] border border-border bg-surface/80">
                  <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <FolderGit2 className="size-4 shrink-0 text-accent" aria-hidden="true" />
                      <span className="truncate text-sm font-semibold">{project.name}</span>
                    </div>
                    <span className="text-xs tabular-nums text-text-muted">{list.length}</span>
                  </div>
                  <div className="space-y-1 p-1.5">
                    {list.length === 0 ? <p className="px-2 py-2 text-xs text-text-muted">No {mode} reported.</p> : null}
                    {mode === "agents" && project.agents.map((agent) => (
                      <button key={agent.id} type="button" onClick={() => setSelectedId(agent.id)} className="flex min-h-9 w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 text-left text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        <span className="size-2 rounded-full" style={{ background: agentColorVar(agent.status) }} />
                        <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                        {agent.pending.length > 0 ? <Badge tone="warning">ask</Badge> : null}
                      </button>
                    ))}
                    {mode === "tasks" && project.tasks.map((task) => (
                      <button key={task.id} type="button" onClick={() => task.agentId && setSelectedId(task.agentId)} disabled={!task.agentId} className="flex min-h-9 w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 text-left text-sm text-text-secondary enabled:hover:bg-surface-hover enabled:hover:text-text-primary disabled:cursor-default disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        <ClipboardList className="size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate">{task.label}</span>
                        {task.state ? <span className="text-[11px] text-text-muted">{task.state}</span> : null}
                      </button>
                    ))}
                    {mode === "modules" && project.modules.map((module) => (
                      <div key={module.id} className="flex min-h-9 items-center gap-2 rounded-[var(--radius-sm)] px-2 text-sm text-text-secondary">
                        <Code2 className="size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate">{module.label}</span>
                        <span className="text-[11px] text-text-muted">{module.stage}</span>
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </aside>

      <main className="min-h-0 overflow-hidden border-r border-border bg-[radial-gradient(circle_at_50%_0%,var(--color-accent-glow),transparent_32%)]">
        <OmpLiveSession agent={selected} squad={squad} onSelect={setSelectedId} onBack={() => setSelectedId(null)} routeContext={handoffContext} />
      </main>

      <aside className="min-h-0 overflow-y-auto bg-base-2/95 p-2 max-xl:hidden" aria-label="Heads up display">
        <div className="mb-2 grid grid-cols-3 gap-2">
          <div className="rounded-[var(--radius-md)] border border-border bg-surface p-2 text-center"><div className="text-lg font-semibold tabular-nums">{working}</div><div className="text-[11px] text-text-muted">working</div></div>
          <div className="rounded-[var(--radius-md)] border border-border bg-surface p-2 text-center"><div className="text-lg font-semibold tabular-nums">{needsInput}</div><div className="text-[11px] text-text-muted">alerts</div></div>
          <div className="rounded-[var(--radius-md)] border border-border bg-surface p-2 text-center"><div className="text-lg font-semibold tabular-nums">{diffTargets.length}</div><div className="text-[11px] text-text-muted">diffs</div></div>
        </div>
        <MetaProgress value={completion} label={`${squad.agents.length} agents · ${squad.features.length} missions`} />

        <section className="mt-3 rounded-[var(--radius-md)] border border-border bg-surface">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-text-muted"><Bell className="size-4" aria-hidden="true" />Notifications</div>
          <div className="space-y-1.5 p-2">
            {notifications.length === 0 ? <p className="rounded-[var(--radius-sm)] border border-border bg-secondary/50 p-2 text-sm text-text-muted">All caught up.</p> : null}
            {notifications.slice(0, 5).map((agent) => (
              <button key={agent.id} type="button" onClick={() => setSelectedId(agent.id)} className="flex min-h-10 w-full items-center gap-2 rounded-[var(--radius-sm)] border border-border px-2 text-left hover:border-border-strong hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {agent.status === "error" ? <AlertTriangle className="size-4 text-danger" aria-hidden="true" /> : <Bell className="size-4 text-progress" aria-hidden="true" />}
                <span className="min-w-0 flex-1"><span className="block truncate text-sm text-text-primary">{agent.name}</span><span className="block truncate text-xs text-text-muted">{agent.pending[0]?.title ?? agent.status}</span></span>
              </button>
            ))}
          </div>
        </section>

        <section className="mt-3 rounded-[var(--radius-md)] border border-border bg-surface">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-text-muted"><History className="size-4" aria-hidden="true" />Live changelog</div>
          <div className="space-y-1.5 p-2">
            {activity.length === 0 ? <p className="rounded-[var(--radius-sm)] border border-border bg-secondary/50 p-2 text-sm text-text-muted">No agent activity yet.</p> : null}
            {activity.map((agent) => (
              <button key={agent.id} type="button" onClick={() => setSelectedId(agent.id)} className="flex min-h-10 w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 text-left hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="size-2 rounded-full" style={{ background: agentColorVar(agent.status) }} />
                <span className="min-w-0 flex-1"><span className="block truncate text-sm text-text-primary">{agent.activity ?? agent.name}</span><span className="block text-xs text-text-muted"><RelativeTime ts={agent.lastActivity} /></span></span>
              </button>
            ))}
          </div>
        </section>

        <section className="mt-3 rounded-[var(--radius-md)] border border-border bg-surface">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-text-muted"><FileDiff className="size-4" aria-hidden="true" />Git diffs</div>
          <div className="space-y-1.5 p-2">
            {diffTargets.length === 0 ? <p className="rounded-[var(--radius-sm)] border border-border bg-secondary/50 p-2 text-sm text-text-muted">No unlanded feature diffs reported.</p> : null}
            {diffTargets.map((feature) => (
              <div key={feature.id} className="rounded-[var(--radius-sm)] border border-border p-2">
                <div className="flex items-center gap-2"><GitBranch className="size-4 text-accent" aria-hidden="true" /><span className="min-w-0 flex-1 truncate text-sm text-text-primary">{feature.title}</span></div>
                <div className="mt-1 flex items-center justify-between gap-2 text-xs text-text-muted"><span>{feature.stage}</span><span>{feature.unlandedFiles} files</span></div>
              </div>
            ))}
          </div>
        </section>
      </aside>
    </div>
  );
}

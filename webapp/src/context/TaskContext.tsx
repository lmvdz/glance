import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { Task, Project, TaskComment } from '../types';
import { jsonInit, apiJson } from '../lib/api';
import { projectsByTeam, resolveCurrentProject, tasksForProject, tasksFromSquad } from '../lib/task-model';
import { buildReviewHash, parseReviewHash } from '../lib/plan-doc-review';
import { buildPlanRealityHash, parsePlanRealityHash } from '../lib/plan-reality-route';
import { buildPlanBriefHash, parsePlanBriefHash } from '../lib/plan-brief-route';
import { parseAgentHash } from '../lib/agent-link';
import { useSquad } from '../hooks/useSquad';
import { coerceView, VIEW_STORAGE_KEY } from '../lib/viewAlias';
import type { TasksListMode } from '../lib/pageContextDerive';
import type { AgentDTO, ArtifactCommentDTO, AuditEntry, CapabilitySnapshotDTO, ChannelEntry, ClientCommand, CommandAckDTO, FeatureDTO, PresenceSnapshot, ProjectDTO, PublicCapabilityCatalogDTO, TranscriptEntry } from '../lib/dto';

export interface ToastInfo {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
}

/**
 * The nav shell (GRAPH-FOLD.md §6e: Fleet · Tasks · Graph · Capabilities, joined by comprehension
 * batch-3's `fog` — see its own doc below) + the views reached BY ROUTING INTO them rather than
 * from the top-level rail: `org` (the AccountMenu gear), `intervene` (a "Needs you" tap),
 * `review` (a design-review deep link). `plan-reality` (OMPSQ-448 comprehension) is the newest
 * routed-into view — a plans index + per-plan "plan vs reality" comprehension page, deep-linkable
 * via `#/plan-reality[/:featureId]` (see `lib/plan-reality-route.ts`), reached both from its own
 * nav-rail entry and from a TaskDetail strip. The eight GRAPH-FOLD-retired keys (attention/active/
 * cockpit/automation/fleet-health/heat/activity-heatmap/scoreboard/topology/federation/knowledge)
 * are GONE from this union on purpose — any stale value (e.g. a pre-fold localStorage `view`) is
 * coerced through `lib/viewAlias.ts` BEFORE it ever becomes state, so nothing outside this file
 * can construct an AppView the render switch doesn't handle. NOTE: GRAPH-FOLD's own alias map
 * still sends the dead `heat` key to `omp-graph` (unchanged, per the comprehension-fog review
 * verdict) — `fog` is a genuinely NEW view, not a resurrection of the retired Heat page; it has no
 * entry in `VIEW_ALIAS_MAP`.
 */
export type AppView = 'fleet' | 'tasks' | 'omp-graph' | 'fog' | 'daily' | 'capabilities' | 'org' | 'intervene' | 'review' | 'plan-reality' | 'plan-brief';
export type TaskFilter = 'open' | 'active' | 'done' | 'all';

/** Read the raw persisted view key (pre-coercion) — a plain function so both the `view` and
 *  `isCommandPaletteOpen` lazy initializers read the SAME localStorage value without a second
 *  `coerceView` call disagreeing (there's only one read; window/SSR-guarded). */
function readStoredView(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(VIEW_STORAGE_KEY);
}

/** D4/D8 (CANVAS-AND-PAGE-CHAT.md): the Tasks LIST|CANVAS toggle's persisted key. DEFAULT LIST —
 *  the canvas is opt-in (red-team guard), so an absent/garbage value must fall back to 'list', not
 *  merely "whatever wasn't 'list'". A pure function so the lazy `useState` initializer and any test
 *  agree on exactly one coercion rule. */
export const TASKS_VIEW_STORAGE_KEY = 'omp.tasks.view';

/** The operator's selected project, persisted like the view + tasks-mode keys. Absent/stale ⇒ the
 *  busiest project (projects() sorts by lastActivity), never a dead workspace. */
export const PROJECT_STORAGE_KEY = 'omp.project';
export function initialTasksListMode(stored: string | null): TasksListMode {
  return stored === 'canvas' ? 'canvas' : 'list';
}

/** One soft-deleted feature in the "garbage bin" (GET /api/features/archived). */
export interface ArchivedFeature {
  id: string;
  title: string;
  repo: string;
  planDir?: string;
  moduleUrl?: string;
  updatedAt: number;
}

interface ApiComment {
  id: string;
  repo: string;
  subject: string;
  body: string;
  author: string;
  createdAt: number;
  urgent?: boolean;
  resolvedAt?: number;
  kind?: "comment" | "plan-annotation";
  annotation?: { planPath: string; lineStart?: number; lineEnd?: number; quote?: string };
}

interface TaskContextType {
  /** Scoped to `currentProject` — what "switching projects" means. */
  tasks: Task[];
  /** EVERY task, across every project. Deep links (`#/review/:taskId`) and the Fleet's unstaffed-plan
   *  rows address tasks the current project scope excludes; searching `tasks` there silently found
   *  nothing. Never render this as a list — it is a lookup table. */
  allTasks: Task[];
  projects: Record<string, Project[]>;
  currentProject: Project | null;
  /** Raw per-repo rollups (agent/feature counts, `registered`) — the switcher's data. Unlike `tasks`,
   *  this is never scoped to the current project. */
  projectDtos: ProjectDTO[];
  commentEvents: ArtifactCommentDTO[];
  resolvedCommentEvents: Map<string, number>;
  commandAcks: CommandAckDTO[];
  channelEntries: ChannelEntry[];
  presence: PresenceSnapshot;
  connected: boolean;
  agents: AgentDTO[];
  /** Raw live feature/plan list — the other half of the active-work join (agents being the first). */
  features: FeatureDTO[];
  /** Recent fleet audit trail (newest-first) — the narrative source for "what the fleet just did". */
  audit: AuditEntry[];
  transcripts: Map<string, TranscriptEntry[]>;
  capabilities: CapabilitySnapshotDTO;
  publicCatalog: PublicCapabilityCatalogDTO[];
  selectedTaskId: string | null;
  toasts: ToastInfo[];
  view: AppView;
  taskFilter: TaskFilter;
  /** Feature 1 D4 (CANVAS-AND-PAGE-CHAT.md): the Tasks LIST|CANVAS toggle, persisted to
   *  localStorage['omp.tasks.view'] mirroring 'omp.workbench.collapsed'. Lives here (not local
   *  TaskListView state) so it survives that component unmounting behind TaskDetail — switching
   *  modes never disturbs `selectedTaskId`, and vice versa; the two are independent state. */
  tasksListMode: TasksListMode;
  /** Taste-review nit 3 (CANVAS-AND-PAGE-CHAT.md D6): the Category Canvas's "+N more" overflow
   *  chip promised a FILTERED list (that category's plans) but landed on the full unfiltered one —
   *  List mode had no category filter to hand it. Lives here (not local TaskListView state) so it
   *  survives a round trip through TaskDetail, the same reason `tasksListMode` isn't local:
   *  clicking a satellite in the filtered list opens TaskDetail, and coming back should not have
   *  silently dropped the filter. `null` = unfiltered. */
  taskCategoryFilter: string | null;
  isChatOpen: boolean;
  /** ⌘K palette (GRAPH-FOLD.md §3) — open everywhere, not scoped to a view. */
  isCommandPaletteOpen: boolean;
  openCommandPalette: () => void;
  closeCommandPalette: () => void;
  toggleCommandPalette: () => void;
  /** The agent that was most recently opened via openConsole(). AssistantChat reacts to switch its active session. */
  openedConsoleAgentId: string | null;
  /** The agent the Intervene View is focused on (set by openIntervene). */
  interveneAgentId: string | null;
  /** The task (feature) the Design Review screen is focused on (set by openReview). Mirrors the
   *  deep-linkable `#/review/:taskId[?doc=...]` hash so a refresh/share lands on the same review. */
  reviewTaskId: string | null;
  /** The specific plan-doc path being reviewed, when the caller named one (else the feature's first doc). */
  reviewDocPath: string | undefined;
  /** The feature the standalone plan-reality screen is focused on (set by openPlanReality). `null`
   *  ⇒ the plans index. Mirrors the deep-linkable `#/plan-reality[/:featureId]` hash, same pattern
   *  as `reviewTaskId`/openReview. */
  planRealityFeatureId: string | null;
  /** The plans/<name> directory rendered as a styled brief. null ⇒ brief index. */
  planBriefName: string | null;
  reload: () => Promise<void>;
  setView: (view: AppView) => void;
  setTaskFilter: (filter: TaskFilter) => void;
  setTasksListMode: (mode: TasksListMode) => void;
  /** Set (or clear, with `null`) the List-mode category filter (taste-review nit 3). */
  setTaskCategoryFilter: (categoryId: string | null) => void;
  setIsChatOpen: (isOpen: boolean) => void;
  /** Subscribe to an agent's transcript AND open the chat panel focused on that agent. No-op if agentId is undefined. */
  openConsole: (agentId: string | undefined) => void;
  /** Focus the full-screen Intervene View on an agent (subscribe + route). The step-in surface off a "Needs you" tap. */
  openIntervene: (agentId: string | undefined) => void;
  /** Route to the design-review screen for one task's plan doc (`/review/:taskId`). */
  openReview: (taskId: string, docPath?: string) => void;
  /** Leave the Design Review screen back to Tasks (keeps the task selected, so TaskDetail resumes). */
  closeReview: () => void;
  /** Route to the standalone plan-reality screen. Omit `featureId` for the plans index; pass one
   *  to open that plan's comprehension page directly (the TaskDetail strip's click target). */
  openPlanReality: (featureId?: string) => void;
  /** Leave the plan-reality screen back to Tasks. */
  closePlanReality: () => void;
  /** Route to a styled deterministic plan explainer. Omit name for the briefs index. */
  openPlanBrief: (name?: string) => void;
  /** Leave the plan-brief screen back to Tasks. */
  closePlanBrief: () => void;
  /** Switch the workspace to another project. Persisted; scopes `tasks`, chat and spawn — never the Fleet. */
  selectProject: (id: string) => void;
  /** Register a repo as a project (POST /api/projects). Absolute path to a git repo; the daemon validates. */
  addProject: (repo: string) => Promise<void>;
  /** Un-register a repo. Deletes nothing; a repo with live agents or features keeps listing. */
  removeProject: (repo: string) => Promise<void>;
  selectTask: (id: string | null) => void;
  addTask: (task: Partial<Task>) => void;
  deleteTask: (id: string) => void;
  restoreFeature: (id: string, repo?: string) => Promise<void>;
  hardDeleteFeature: (id: string, opts?: { repo?: string; plane?: 'keep' | 'detach' }) => Promise<void>;
  loadArchivedFeatures: (repo?: string) => Promise<ArchivedFeature[]>;
  toggleTaskComplete: (id: string) => void;
  updateTask: (id: string, updates: Partial<Task>) => void;
  /** Set (or clear, with `null`) the operator category override — a dedicated setter rather than
   *  routing through `updateTask`'s Partial<Task> diff, since `undefined` there means "field not
   *  provided", not "clear this override"; `null` is the only unambiguous "back to Auto" signal. */
  setTaskCategory: (id: string, category: Task['category'] | null) => void;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  sendConsoleCommand: (command: ClientCommand) => void;
  subscribeConsole: (id: string) => void;
  installCapability: (packId: string) => void;
  importCatalogCapability: (catalogId: string) => void;
  setCapabilityEnabled: (installId: string, enabled: boolean) => void;
  runCapability: (installId: string, bindingKey?: string) => void;
  addTaskComment: (id: string, text: string, urgent?: boolean) => Promise<TaskComment | null>;
  loadTaskComments: (id: string) => Promise<TaskComment[]>;
}

const TaskContext = createContext<TaskContextType | undefined>(undefined);

function stageForStatus(status: Task['status']): 'planned' | 'in-progress' | 'done' {
  if (status === 'done') return 'done';
  if (status === 'active') return 'in-progress';
  return 'planned';
}

function apiCommentToTask(comment: ApiComment): TaskComment {
  return { id: comment.id, text: comment.body, timestamp: new Date(comment.createdAt).toISOString(), author: comment.author, urgent: comment.urgent, resolvedAt: comment.resolvedAt, kind: comment.kind, subject: comment.subject, annotation: comment.annotation };
}

export function reconcileSelectedTaskId(selectedTaskId: string | null, tasks: Pick<Task, 'id'>[]): string | null {
  if (!selectedTaskId) return null;
  return tasks.some((task) => task.id === selectedTaskId) ? selectedTaskId : null;
}

export function TaskProvider({ children }: { children: ReactNode }) {
  const squad = useSquad();
  const baseTasks = useMemo(() => tasksFromSquad(squad.features, squad.agents, squad.projects), [squad.features, squad.agents, squad.projects]);
  const [localEdits, setLocalEdits] = useState<Record<string, Partial<Task>>>({});
  const scopedTasks = useMemo(() => baseTasks.map((task) => ({ ...task, ...localEdits[task.id] })), [baseTasks, localEdits]);
  const projects = useMemo(() => projectsByTeam(squad.projects, squad.features), [squad.projects, squad.features]);
  const [selectedProjectId, setSelectedProjectIdState] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    try { return window.localStorage.getItem(PROJECT_STORAGE_KEY); } catch { return null; }
  });
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  // The operator's EXPLICIT project choice, persisted. `currentProject` used to be
  // `selectedTask?.properties.project ?? projects[0]` — derived, never settable, so nothing in the UI
  // could switch projects and the sidebar's project rows only toggled a disclosure. Explicit choice
  // wins; a stale id (project un-registered, or its repo drained) falls back to the busiest project
  // rather than stranding the workspace on nothing.
  const projectList = useMemo(() => Object.values(projects).flat(), [projects]);
  const currentProject = resolveCurrentProject(projectList, selectedProjectId);

  // Tasks are scoped to the current project — that is what "switching" means. The FLEET is deliberately
  // NOT scoped: a blocked or errored agent in another repo must never be hidden by a project filter
  // (GRAPH-FOLD §6(g) — Needs-you is pinned and non-collapsible, and this is the same invariant one
  // level up). Agents carry their own repo, so the cockpit still shows every one of them.
  const tasks = useMemo(() => tasksForProject(scopedTasks, currentProject), [scopedTasks, currentProject]);
  const [toasts, setToasts] = useState<ToastInfo[]>([]);
  // Restore + coerce the persisted view in one lazy read (GRAPH-FOLD.md §3 alias/redirect map) —
  // a stale pre-fold key (or garbage) never reaches state as anything but a real AppView.
  const [view, setViewState] = useState<AppView>(() => coerceView(readStoredView()).view);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState<boolean>(() => coerceView(readStoredView()).openPalette);
  // Taste-review nit 3: `openPalette` is true for exactly one coercion — a stale `knowledge` key
  // (see viewAlias.ts) — so it doubles as "did THIS boot teleport here from the dead Knowledge
  // page". Captured once at mount (like the two reads above) so the one-time toast below never
  // re-derives it from a localStorage read that the normalization effect has since overwritten.
  const [bootCoercedFromKnowledge] = useState<boolean>(() => coerceView(readStoredView()).openPalette);
  // Belt-and-suspenders against StrictMode's dev-mode double-invoke of mount effects (verified
  // live: without this, the toast below fired twice on one real page load) — a ref survives the
  // synthetic unmount/remount cycle StrictMode runs on the SAME component instance, so it still
  // gates a genuine single boot to exactly one toast.
  const knowledgeToastFiredRef = useRef(false);
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('open');
  const [tasksListMode, setTasksListModeState] = useState<TasksListMode>(() =>
    initialTasksListMode(typeof window === 'undefined' ? null : window.localStorage.getItem(TASKS_VIEW_STORAGE_KEY)),
  );
  // Taste-review nit 3: ephemeral (not persisted) — unlike `tasksListMode`, there's no honest
  // "last filter" to restore across a reload; it's a transient in-session scope, set exactly by
  // the canvas's overflow chip or cleared by the list's own filter chip.
  const [taskCategoryFilter, setTaskCategoryFilter] = useState<string | null>(null);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [openedConsoleAgentId, setOpenedConsoleAgentId] = useState<string | null>(null);
  const [interveneAgentId, setInterveneAgentId] = useState<string | null>(null);
  const [reviewTaskId, setReviewTaskId] = useState<string | null>(null);
  const [reviewDocPath, setReviewDocPath] = useState<string | undefined>(undefined);
  const [planRealityFeatureId, setPlanRealityFeatureId] = useState<string | null>(null);
  const [planBriefName, setPlanBriefName] = useState<string | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);

  useEffect(() => {
    const nextSelectedTaskId = reconcileSelectedTaskId(selectedTaskId, tasks);
    if (nextSelectedTaskId !== selectedTaskId) setSelectedTaskId(nextSelectedTaskId);
  }, [tasks, selectedTaskId]);

  // The fleet narrative isn't on the WS snapshot — poll the append-only audit log. Shared here so
  // the Active Work pane and the assistant both narrate "what just happened" from one source.
  useEffect(() => {
    let alive = true;
    const load = () =>
      apiJson<AuditEntry[] | { entries?: AuditEntry[] }>('/api/audit?limit=80')
        .then((r) => { if (alive) setAudit(Array.isArray(r) ? r : r?.entries ?? []); })
        .catch(() => { /* daemon offline / not yet up — keep the last good list */ });
    void load();
    const interval = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(interval); };
  }, []);

  const selectedTask = tasks.find((task) => task.id === selectedTaskId);

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'success') => {
    const id = Math.random().toString(36).substr(2, 9);
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3000);
  };

  const openConsole = (agentId: string | undefined) => {
    if (!agentId) return;
    squad.subscribe(agentId);
    setOpenedConsoleAgentId(agentId);
    setIsChatOpen(true);
  };

  // Step into one agent full-screen: subscribe to its transcript (so the diff/console are warm)
  // and route to the Intervene View. The primary target of a "Needs you" tap.
  const openIntervene = (agentId: string | undefined) => {
    if (!agentId) return;
    squad.subscribe(agentId);
    setInterveneAgentId(agentId);
    setView('intervene');
  };

  // Design Review has no react-router (this SPA doesn't use one anywhere), but the reference
  // treats it as a real route — so it's deep-linkable via a `#/review/:taskId[?doc=...]` hash,
  // synced both ways: openReview/closeReview write the hash, and a hashchange listener (below)
  // restores the view on a fresh load or back/forward navigation.
  const openReview = (taskId: string, docPath?: string) => {
    setReviewTaskId(taskId);
    setReviewDocPath(docPath);
    setView('review');
    window.location.hash = buildReviewHash({ taskId, docPath });
  };

  const closeReview = () => {
    setView('tasks');
    if (window.location.hash.startsWith('#/review/')) history.replaceState(null, '', window.location.pathname + window.location.search);
  };

  // Plan-reality (OMPSQ-448) mirrors the review screen's own hash-route discipline exactly:
  // no react-router in this SPA, so `#/plan-reality[/:featureId]` is the deep-linkable state,
  // synced both ways (openPlanReality/closePlanReality write it; the listener below restores it).
  const openPlanReality = (featureId?: string) => {
    setPlanRealityFeatureId(featureId ?? null);
    setView('plan-reality');
    window.location.hash = buildPlanRealityHash({ featureId });
  };

  const closePlanReality = () => {
    setView('tasks');
    if (window.location.hash.startsWith('#/plan-reality')) history.replaceState(null, '', window.location.pathname + window.location.search);
  };

  const openPlanBrief = (name?: string) => {
    setPlanBriefName(name ?? null);
    setView('plan-brief');
    window.location.hash = name ? buildPlanBriefHash({ name }) : '#/plans';
  };

  const closePlanBrief = () => {
    setView('tasks');
    if (window.location.hash.startsWith('#/plans')) history.replaceState(null, '', window.location.pathname + window.location.search);
  };


  useEffect(() => {
    const applyHash = () => {
      const parsed = parseReviewHash(window.location.hash);
      if (!parsed) return;
      // A shared/refreshed `#/review/:taskId` may name a task in a DIFFERENT project than the one the
      // operator last selected. Follow it: without this the review screen scopes to the wrong project,
      // finds no task, derives an empty repo, and renders nothing. (gpt-5.6-sol)
      const target = scopedTasks.find((task) => task.id === parsed.taskId);
      if (target && target.properties.project.id !== selectedProjectId) selectProjectId(target.properties.project.id);
      setReviewTaskId(parsed.taskId);
      setReviewDocPath(parsed.docPath);
      setView('review');
    };
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  }, []);

  useEffect(() => {
    const applyHash = () => {
      const parsed = parsePlanRealityHash(window.location.hash);
      if (!parsed) return;
      setPlanRealityFeatureId(parsed.featureId ?? null);
      setView('plan-reality');
    };
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  }, []);

  useEffect(() => {
    const applyHash = () => {
      if (window.location.hash === '#/plans') {
        setPlanBriefName(null);
        setView('plan-brief');
        return;
      }
      const parsed = parsePlanBriefHash(window.location.hash);
      if (!parsed) return;
      setPlanBriefName(parsed.name);
      setView('plan-brief');
    };
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  }, []);

  // `#/agent/<id>` — the deep link BOTH existing producers emit (push payloads, src/push.ts;
  // the URL `glance here` prints, src/here-web.ts). One-way (URL → state) on load and on
  // back/forward: it opens the agent's console chat, which tolerates the roster still being in
  // flight (AssistantChat materializes the session once the agent arrives — its effect re-runs
  // on `agents`). Deliberately NOT synced back: opening a console from inside the UI must not
  // hijack the address bar, so openConsole never writes the hash. No project-follow either —
  // the fleet is unscoped by design (agents carry their own repo; see the scoping comment on
  // `tasks` above), so the chat opens regardless of which project the operator last selected.
  useEffect(() => {
    const applyAgentHash = () => {
      const id = parseAgentHash(window.location.hash);
      if (id) openConsole(id);
    };
    applyAgentHash();
    window.addEventListener('hashchange', applyAgentHash);
    return () => window.removeEventListener('hashchange', applyAgentHash);
  }, []);

  // The only mutator of `view` state — persists every navigation to localStorage so a reload
  // restores the same screen. TypeScript already guarantees `next` is a live AppView (the dead
  // keys aren't in the union), so this never needs to re-run it through coerceView; only the
  // localStorage RESTORE path (above) reads a value that could be stale.
  const setView = useCallback((next: AppView) => {
    setViewState(next);
    if (typeof window !== 'undefined') window.localStorage.setItem(VIEW_STORAGE_KEY, next);
  }, []);

  // Mirrors setView: the only mutator, persists on every flip so a reload lands back on the same
  // mode. D8's default-LIST guard lives in `initialTasksListMode`, not here — this just persists
  // whatever the toggle asked for.
  const setTasksListMode = useCallback((next: TasksListMode) => {
    setTasksListModeState(next);
    if (typeof window !== 'undefined') window.localStorage.setItem(TASKS_VIEW_STORAGE_KEY, next);
  }, []);

  const openCommandPalette = useCallback(() => setIsCommandPaletteOpen(true), []);
  const closeCommandPalette = useCallback(() => setIsCommandPaletteOpen(false), []);
  const toggleCommandPalette = useCallback(() => setIsCommandPaletteOpen((open) => !open), []);

  // Normalize the persisted key once per boot: after a dead key was coerced (heat → omp-graph,
  // knowledge → omp-graph + palette, …) write the LIVE key back so the alias only fires once —
  // otherwise a stale `knowledge` would re-open the palette on every reload forever.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.localStorage.getItem(VIEW_STORAGE_KEY) !== view) window.localStorage.setItem(VIEW_STORAGE_KEY, view);
    // Taste-review nit 3: the `knowledge` coercion lands on Graph with the palette already open
    // but empty — silent unless you know why. One toast, once (bootCoercedFromKnowledge is fixed
    // at mount, and the write above retires the `knowledge` key so a reload never re-fires it).
    if (bootCoercedFromKnowledge && !knowledgeToastFiredRef.current) {
      knowledgeToastFiredRef.current = true;
      showToast('Knowledge base is now ⌘K — search opens in the command palette.', 'info');
    }
    // Mount-only: `view` here is the already-coerced initial state; later writes go through setView.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Switching projects clears the task selection: the selected task belongs to the project you left,
   *  and `tasks` is about to stop containing it. Leaving it set stranded TaskDetail on a ghost. */
  /** Persist a project choice without touching the task selection — used by the review deep link, which
   *  is selecting a task in that very project. */
  const selectProjectId = (id: string) => {
    setSelectedProjectIdState(id);
    if (typeof window !== 'undefined') {
      try { window.localStorage.setItem(PROJECT_STORAGE_KEY, id); } catch { /* private mode — session-only */ }
    }
  };

  const selectProject = (id: string) => {
    setSelectedProjectIdState(id);
    setSelectedTaskId(null);
    if (typeof window !== 'undefined') {
      try { window.localStorage.setItem(PROJECT_STORAGE_KEY, id); } catch { /* private mode — selection is session-only */ }
    }
  };

  const addProject = async (repo: string) => {
    const trimmed = repo.trim();
    if (!trimmed) return;
    try {
      // Switch to the repo the SERVER canonicalized, not the string that was typed: it resolves symlinks
      // and walks up to the repo root, so `/repo/src` comes back as `/repo`. Mirroring the input instead
      // would select a project id that does not exist and strand the workspace.
      const created = await apiJson<{ repo: string }>('/api/projects', jsonInit('POST', { repo: trimmed }));
      await squad.reload();
      selectProject(created.repo);
      showToast(`Project added: ${created.repo}`);
    } catch (error) {
      showToast((error as Error).message || 'Could not add project', 'error');
    }
  };

  const removeProject = async (repo: string) => {
    try {
      await apiJson(`/api/projects?repo=${encodeURIComponent(repo)}`, { method: 'DELETE' });
      await squad.reload();
      showToast(`Project removed: ${repo}`);
    } catch (error) {
      showToast((error as Error).message || 'Could not remove project', 'error');
    }
  };

  const selectTask = (id: string | null) => setSelectedTaskId(id);

  const addTask = (partialTask: Partial<Task>) => {
    const title = partialTask.title?.trim() || 'New Task';
    const repo = currentProject?.id || squad.projects[0]?.repo;
    void apiJson('/api/features', jsonInit('POST', { title, repo }))
      .then(() => squad.reload())
      .then(() => showToast(`Feature created: ${title}`))
      .catch((error: Error) => showToast(error.message || 'Could not create feature', 'error'));
  };

  // Archive = reversible: flips the flag AND (server-side) moves plans/<x>/ → plans/.archive/<x>/.
  const deleteTask = (id: string) => {
    const task = tasks.find((item) => item.id === id);
    const featureId = task?.sourceId ?? id;
    void apiJson(`/api/features/${encodeURIComponent(featureId)}`, jsonInit('PATCH', { repo: task?.properties.project.id, archived: true }))
      .then(() => squad.reload())
      .then(() => showToast(`Archived ${id} — restorable from Archived`))
      .catch((error: Error) => showToast(error.message || 'Could not archive feature', 'error'));
  };

  // Restore an archived feature (un-flag + move the plan dir back out of .archive).
  const restoreFeature = (id: string, repo?: string) =>
    apiJson(`/api/features/${encodeURIComponent(id)}`, jsonInit('PATCH', { repo, archived: false }))
      .then(() => squad.reload())
      .then(() => showToast(`Restored ${id}`))
      .catch((error: Error) => showToast(error.message || 'Could not restore feature', 'error'));

  // Hard delete = permanent: removes the feature + its plan dir. `plane: "detach"` also drops the
  // Plane module grouping (issues untouched). Destructive; callers confirm first.
  const hardDeleteFeature = (id: string, opts: { repo?: string; plane?: 'keep' | 'detach' } = {}) => {
    const qs = new URLSearchParams();
    if (opts.repo) qs.set('repo', opts.repo);
    if (opts.plane === 'detach') qs.set('plane', 'detach');
    return apiJson(`/api/features/${encodeURIComponent(id)}${qs.toString() ? `?${qs}` : ''}`, { method: 'DELETE' })
      .then(() => squad.reload())
      .then(() => showToast(`Deleted ${id} permanently`))
      .catch((error: Error) => showToast(error.message || 'Could not delete feature', 'error'));
  };

  const loadArchivedFeatures = (repo?: string) =>
    apiJson<{ features: ArchivedFeature[] }>(`/api/features/archived${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`)
      .then((r) => r.features)
      .catch(() => [] as ArchivedFeature[]);

  const toggleTaskComplete = (id: string) => {
    const task = tasks.find((item) => item.id === id);
    if (!task) return;
    updateTask(id, { status: task.status === 'done' ? 'todo' : 'done' });
  };

  const updateTask = (id: string, updates: Partial<Task>) => {
    const task = tasks.find((item) => item.id === id);
    if (!task) return;
    const featureId = task.sourceId ?? id;
    setLocalEdits((previous) => ({ ...previous, [id]: { ...previous[id], ...updates } }));
    const patch: { repo: string; title?: string; stageOverride?: string; description?: string; acceptanceCriteria?: Task['acceptanceCriteria']; decisions?: Task['decisions']; relationships?: Task['relationships'] } = { repo: task.properties.project.id };
    if (updates.title !== undefined) patch.title = updates.title;
    if (updates.status) patch.stageOverride = stageForStatus(updates.status);
    if (updates.description !== undefined) patch.description = updates.description;
    if (updates.acceptanceCriteria !== undefined) patch.acceptanceCriteria = updates.acceptanceCriteria;
    if (updates.decisions !== undefined) patch.decisions = updates.decisions;
    if (updates.relationships !== undefined) patch.relationships = updates.relationships;
    if (Object.keys(patch).length <= 1) return;
    void apiJson(`/api/features/${encodeURIComponent(featureId)}`, jsonInit('PATCH', patch))
      .then(() => squad.reload())
      .then(() => showToast(`Feature updated: ${id}`))
      .catch((error: Error) => showToast(error.message || 'Could not update feature', 'error'));
  };

  const setTaskCategory = (id: string, category: Task['category'] | null) => {
    const task = tasks.find((item) => item.id === id);
    if (!task) return;
    const featureId = task.sourceId ?? id;
    void apiJson(`/api/features/${encodeURIComponent(featureId)}`, jsonInit('PATCH', { repo: task.properties.project.id, category }))
      .then(() => squad.reload())
      .then(() => showToast(category ? `Category set to ${category}` : 'Category reset to auto'))
      .catch((error: Error) => showToast(error.message || 'Could not update category', 'error'));
  };

  const installCapability = (packId: string) => {
    void apiJson('/api/capability-installs', jsonInit('POST', { packId, enable: true }))
      .then(() => squad.reload())
      .then(() => showToast('Capability installed'))
      .catch((error: Error) => showToast(error.message || 'Could not install capability', 'error'));
  };

  const importCatalogCapability = (catalogId: string) => {
    void apiJson('/api/capability-sources', jsonInit('POST', { catalogId }))
      .then(() => squad.reload())
      .then(() => showToast('Capability imported from public catalog'))
      .catch((error: Error) => showToast(error.message || 'Could not import catalog capability', 'error'));
  };

  const setCapabilityEnabled = (installId: string, enabled: boolean) => {
    void apiJson(`/api/capability-installs/${encodeURIComponent(installId)}`, jsonInit('PATCH', { enabled }))
      .then(() => squad.reload())
      .then(() => showToast(enabled ? 'Capability enabled' : 'Capability disabled'))
      .catch((error: Error) => showToast(error.message || 'Could not update capability', 'error'));
  };

  const runCapability = (installId: string, bindingKey?: string) => {
    void apiJson(`/api/capability-installs/${encodeURIComponent(installId)}/run`, jsonInit('POST', { bindingKey }))
      .then(() => squad.reload())
      .then(() => showToast('Capability run started'))
      .catch((error: Error) => showToast(error.message || 'Could not run capability', 'error'));
  };

  const loadTaskComments = async (id: string): Promise<TaskComment[]> => {
    const task = tasks.find((item) => item.id === id);
    if (!task) return [];
    const subject = task.sourceId ?? id;
    const repo = task.properties.project.id;
    const rows = await apiJson<ApiComment[]>(`/api/comments?repo=${encodeURIComponent(repo)}&subject=${encodeURIComponent(subject)}`).catch(() => []);
    return rows.map(apiCommentToTask);
  };

  const addTaskComment = async (id: string, text: string, urgent = false): Promise<TaskComment | null> => {
    const task = tasks.find((item) => item.id === id);
    if (!task || !text.trim()) return null;
    const subject = task.sourceId ?? id;
    const repo = task.properties.project.id;
    const saved = apiCommentToTask(await apiJson<ApiComment>('/api/comments', jsonInit('POST', { repo, subject, body: text.trim(), urgent })));
    setLocalEdits((previous) => ({
      ...previous,
      [id]: {
        ...previous[id],
        comments: [...(previous[id]?.comments ?? task.comments ?? []), saved],
      },
    }));
    showToast('Comment added to task context', 'success');
    return saved;
  };

  return (
    <TaskContext.Provider value={{ tasks, allTasks: scopedTasks, agents: squad.agents, features: squad.features, audit, projects, currentProject, projectDtos: squad.projects, selectProject, addProject, removeProject, capabilities: squad.capabilities, publicCatalog: squad.publicCatalog, connected: squad.connected, transcripts: squad.transcripts, commentEvents: squad.commentEvents, resolvedCommentEvents: squad.resolvedCommentEvents, commandAcks: squad.commandAcks, channelEntries: squad.channelEntries, presence: squad.presence, selectedTaskId, toasts, view, taskFilter, tasksListMode, taskCategoryFilter, isChatOpen, isCommandPaletteOpen, openCommandPalette, closeCommandPalette, toggleCommandPalette, openedConsoleAgentId, interveneAgentId, reviewTaskId, reviewDocPath, planRealityFeatureId, planBriefName, reload: squad.reload, setView, setTaskFilter, setTasksListMode, setTaskCategoryFilter, setIsChatOpen, openConsole, openIntervene, openReview, closeReview, openPlanReality, closePlanReality, openPlanBrief, closePlanBrief, selectTask, addTask, deleteTask, restoreFeature, hardDeleteFeature, loadArchivedFeatures, toggleTaskComplete, updateTask, setTaskCategory, showToast, sendConsoleCommand: squad.send, subscribeConsole: squad.subscribe, installCapability, importCatalogCapability, setCapabilityEnabled, runCapability, addTaskComment, loadTaskComments }}>
      {children}
    </TaskContext.Provider>
  );
}

export function useTaskContext() {
  const context = useContext(TaskContext);
  if (!context) throw new Error('useTaskContext must be used within TaskProvider');
  return context;
}

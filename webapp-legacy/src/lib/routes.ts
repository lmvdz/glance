export const APP_VIEWS = [
  "inbox",
  "feedback-loop",
  "agents",
  "features",
  "graph",
  "heatmap",
  "audit",
  "network",
  "project",
  "console",
  "profiles",
  "tournaments",
  "observability",
  "governance",
  "settings",
  "conflicts",
  "onboarding",
] as const;

export type AppView = (typeof APP_VIEWS)[number];

export const CORE_VIEWS = ["console", "agents", "features", "inbox", "audit"] as const satisfies readonly AppView[];

export interface AppRoute {
  view: AppView;
  sel: string | null;
  taskId: string | null;
  handoffContext: string | null;
}

const decode = (value: string | undefined): string | null => {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export function parseHash(hash: string): AppRoute {
  const raw = hash.replace(/^#\/?/, "");
  const [path = "", query = ""] = raw.split("?", 2);
  const parts = path.split("/").filter(Boolean);
  const view = APP_VIEWS.includes(parts[0] as AppView) ? (parts[0] as AppView) : "agents";
  const params = new URLSearchParams(query);
  let sel: string | null = null;
  let taskId: string | null = null;
  let handoffContext = decode(params.get("context") ?? undefined);

  if (view === "project") {
    sel = decode(parts[1]);
    const taskIndex = parts.indexOf("task");
    if (taskIndex >= 0) taskId = decode(parts.slice(taskIndex + 1).join("/"));
  } else if (view === "console") {
    if (parts[1] === "context") handoffContext = decode(parts.slice(2).join("/"));
    else sel = decode(parts.slice(1).join("/"));
  } else {
    sel = decode(parts.slice(1).join("/"));
  }

  return { view, sel, taskId, handoffContext };
}

export const viewHash = (view: AppView): string => `#/${view}`;
export const featureHash = (featureId: string): string => `#/features/${encodeURIComponent(featureId)}`;
export const projectHash = (repo: string): string => `#/project/${encodeURIComponent(repo)}`;
export const taskHash = (repo: string, taskId: string): string => `${projectHash(repo)}/task/${encodeURIComponent(taskId)}`;
export const consoleHandoffHash = (context: string): string => `#/console/context/${encodeURIComponent(context)}`;

export function fencedRouteContext(lines: Record<string, string | number | boolean | null | undefined>): string {
  const body = Object.entries(lines)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined && entry[1] !== null && entry[1] !== "")
    .map(([key, value]) => `${key}: ${String(value).replace(/\n/g, " ")}`)
    .join("\n");
  return `\`\`\`route-context\n${body}\n\`\`\``;
}

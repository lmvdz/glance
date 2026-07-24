export type HubRoute =
  | { kind: 'hub'; channelId: string; entryId?: string }
  | { kind: 'workbench'; view: WorkbenchRouteView; id?: string };

export type WorkbenchRouteView =
  | 'fleet'
  | 'tasks'
  | 'task'
  | 'graph'
  | 'fog'
  | 'daily'
  | 'economics'
  | 'capabilities'
  | 'org'
  | 'intervene'
  | 'review'
  | 'plan-reality'
  | 'plans';

export const DEFAULT_CHANNEL_ID = 'fleet';

const trimHash = (hash: string): string => hash.replace(/^#/, '').replace(/^\//, '').replace(/\/+$/, '');
const decode = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export function parseHubHash(hash: string): HubRoute {
  const path = trimHash(hash);
  if (!path || path === DEFAULT_CHANNEL_ID) return { kind: 'hub', channelId: DEFAULT_CHANNEL_ID };

  const [head, rawId, sub, rawSubId] = path.split('/');
  if (head === 'channel') return { kind: 'hub', channelId: decode(rawId) || DEFAULT_CHANNEL_ID, ...(sub === 'entry' && decode(rawSubId) ? { entryId: decode(rawSubId) } : {}) };
  if (head === 'intervene') return { kind: 'workbench', view: 'intervene', id: decode(rawId) };
  if (head === 'agent') return { kind: 'workbench', view: 'intervene', id: decode(rawId) };
  if (head === 'review') return { kind: 'workbench', view: 'review', id: decode(rawId) };
  if (head === 'plan-reality') return { kind: 'workbench', view: 'plan-reality', id: decode(rawId) };
  if (head === 'plans') return { kind: 'workbench', view: 'plans', id: decode(rawId) };
  if (head === 'workbench') {
    const view = normalizeWorkbenchView(rawId);
    return { kind: 'workbench', view: view ?? 'fleet' };
  }
  return { kind: 'hub', channelId: DEFAULT_CHANNEL_ID };
}

export function hubHref(channelId = DEFAULT_CHANNEL_ID, entryId?: string): string {
  if (entryId) return `#/channel/${encodeURIComponent(channelId)}/entry/${encodeURIComponent(entryId)}`;
  return channelId === DEFAULT_CHANNEL_ID ? `#${DEFAULT_CHANNEL_ID}` : `#/channel/${encodeURIComponent(channelId)}`;
}

export function workbenchHref(view: WorkbenchRouteView, id?: string): string {
  if (view === 'intervene') return `#/intervene/${encodeURIComponent(id ?? '')}`;
  if (view === 'review') return `#/review/${encodeURIComponent(id ?? '')}`;
  if (view === 'plan-reality') return id ? `#/plan-reality/${encodeURIComponent(id)}` : '#/plan-reality';
  if (view === 'plans') return id ? `#/plans/${encodeURIComponent(id)}` : '#/plans';
  return `#/workbench/${view}`;
}

export function normalizeWorkbenchView(value: string | undefined): WorkbenchRouteView | null {
  switch (value) {
    case 'fleet':
    case 'tasks':
    case 'task':
    case 'graph':
    case 'fog':
    case 'daily':
    case 'economics':
    case 'capabilities':
    case 'org':
    case 'intervene':
    case 'review':
    case 'plan-reality':
    case 'plans':
      return value;
    case 'omp-graph':
      return 'graph';
    case 'plan-brief':
      return 'plans';
    default:
      return null;
  }
}

export function shouldColdBootFleet(hash: string): boolean {
  const path = trimHash(hash);
  return !path || path === '/';
}

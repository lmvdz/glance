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
  | 'plans'
  | 'gate-verdict';

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
  // Both spellings of "open this unit" now land in the room standing at that node. The workbench
  // step-in screen they used to reach was a second application with its own roster, its own transcript
  // and its own LAND/CHANGES/RUN stack; the room answers the same questions in the frame the reference
  // draws. Old links keep working — they arrive somewhere better.
  if (head === 'intervene' || head === 'agent') {
    const id = decode(rawId);
    return id ? { kind: 'hub', channelId: `node:${id}` } : { kind: 'hub', channelId: DEFAULT_CHANNEL_ID };
  }
  if (head === 'review') return { kind: 'workbench', view: 'review', id: decode(rawId) };
  if (head === 'plan-reality') return { kind: 'workbench', view: 'plan-reality', id: decode(rawId) };
  if (head === 'plans') return { kind: 'workbench', view: 'plans', id: decode(rawId) };
  if (head === 'gate-verdict') {
    const channelId = decode(rawId);
    const entryId = decode(sub);
    return { kind: 'workbench', view: 'gate-verdict', id: channelId && entryId ? `${channelId}\u0000${entryId}` : undefined };
  }
  if (head === 'task') return { kind: 'workbench', view: 'task', id: decode(rawId) };
  if (head === 'workbench') {
    const view = normalizeWorkbenchView(rawId);
    // The fleet roster dissolved into the room: FLEET PULSE says whether the fleet is calm and the
    // standing tree says where everything is. An unrecognised workbench view lands there too, rather
    // than on a page that exists only because a URL named it.
    if (!view || view === 'fleet' || view === 'intervene') return { kind: 'hub', channelId: DEFAULT_CHANNEL_ID };
    return { kind: 'workbench', view, ...(view === 'task' && decode(sub) ? { id: decode(sub) } : {}) };
  }
  return { kind: 'hub', channelId: DEFAULT_CHANNEL_ID };
}

export function hubHref(channelId = DEFAULT_CHANNEL_ID, entryId?: string): string {
  if (entryId) return `#/channel/${encodeURIComponent(channelId)}/entry/${encodeURIComponent(entryId)}`;
  return channelId === DEFAULT_CHANNEL_ID ? `#${DEFAULT_CHANNEL_ID}` : `#/channel/${encodeURIComponent(channelId)}`;
}
/**
 * Standing inside a unit.
 *
 * A unit is a ROOM, not a workbench page — `01-room.html` puts its conversation in the centre and its
 * state beside it, which is what `#/channel/node:<id>` renders. The old `#/intervene/<id>` screen was a
 * separate application reached by a separate URL; sending both spellings here is what stops it coming
 * back through a stale link.
 */
export function unitHref(agentId: string): string {
  return hubHref(`node:${agentId}`);
}

export function gateVerdictHref(channelId: string, entryId: string): string {
  return `#/gate-verdict/${encodeURIComponent(channelId)}/${encodeURIComponent(entryId)}`;
}


export function workbenchHref(view: WorkbenchRouteView, id?: string): string {
  if (view === 'intervene') return id ? unitHref(id) : hubHref(DEFAULT_CHANNEL_ID);
  if (view === 'review') return `#/review/${encodeURIComponent(id ?? '')}`;
  if (view === 'plan-reality') return id ? `#/plan-reality/${encodeURIComponent(id)}` : '#/plan-reality';
  if (view === 'plans') return id ? `#/plans/${encodeURIComponent(id)}` : '#/plans';
  if (view === 'gate-verdict' && id) {
    const [channelId, entryId] = id.includes('\u0000') ? id.split('\u0000') : id.split('/');
    return channelId && entryId ? gateVerdictHref(channelId, entryId) : '#/gate-verdict';
  }
  if (view === 'task') return id ? `#/workbench/task/${encodeURIComponent(id)}` : '#/workbench/task';
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
    case 'gate-verdict':
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

/**
 * omp-graph client types — a verbatim mirror of the server wire format
 * (src/omp-graph/schema.ts). Duplicated for now because the webapp and daemon
 * build separately; when omp-graph is extracted to a standalone package this
 * file and the server schema collapse into that package's single source of truth.
 *
 * Keep in lockstep with src/omp-graph/schema.ts.
 */

export type TimeMs = number;

export interface TimeRange {
  start: TimeMs;
  end: TimeMs;
}

export type TrackType = 'events' | 'series' | 'bars' | 'spans' | 'bands';
export type Scale = 'linear' | 'sqrt' | 'log';

export interface EventMark {
  t: TimeMs;
  label: string;
  kind?: string;
  value?: number;
  meta?: Record<string, string | number>;
}

export interface SeriesPoint {
  t: TimeMs;
  v: number;
}

export interface Bin {
  t: TimeMs;
  v: number;
}

export interface Span {
  t0: TimeMs;
  t1: TimeMs;
  label: string;
  status?: string;
  value?: number;
  meta?: Record<string, string | number>;
}

export interface BandSegment {
  t0: TimeMs;
  t1: TimeMs;
  category: string;
  color?: string;
}

interface TrackBase {
  id: string;
  label: string;
  group: string;
  source: string;
  unit?: string;
}

export type GraphTrack =
  | (TrackBase & { type: 'events'; marks: EventMark[] })
  | (TrackBase & { type: 'series'; points: SeriesPoint[]; scale?: Scale })
  | (TrackBase & { type: 'bars'; bins: Bin[]; binMs: number; scale?: Scale })
  | (TrackBase & { type: 'spans'; spans: Span[] })
  | (TrackBase & { type: 'bands'; segments: BandSegment[] });

export interface GraphGroup {
  id: string;
  label: string;
  order?: number;
}

/** A computed "so what?" callout — the insight layer above the descriptive tracks. */
export interface Insight {
  id: string;
  label: string;
  value: string;
  sub?: string;
  tone?: 'good' | 'warn' | 'bad' | 'neutral';
}

export interface GraphDoc {
  range: TimeRange;
  groups: GraphGroup[];
  tracks: GraphTrack[];
  insights?: Insight[];
  sources: string[];
  generatedAt: TimeMs;
}

/**
 * One hovered/selected datum on the canvas — the unit the detail pane routes on.
 * A discrete mark (event), a duration (span), a bucket (bar), or a sample (series).
 */
export interface GraphDatum {
  variant: 'event' | 'span' | 'bar' | 'series';
  trackId: string;
  trackLabel: string;
  source: string;
  t: TimeMs;
  t1?: TimeMs;
  title: string;
  kind?: string;
  status?: string;
  value?: number;
  unit?: string;
  meta?: Record<string, string | number>;
}

// ── commit detail (GET /api/graph/commit) — mirrors src/server.ts CommitDetail ──
export interface CommitLine {
  t: 'ctx' | 'add' | 'del' | 'hunk';
  s: string;
}
export interface CommitFile {
  path: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  lines: CommitLine[];
}
export interface CommitDetail {
  sha: string;
  author: string;
  dateMs: number;
  subject: string;
  files: CommitFile[];
  additions: number;
  deletions: number;
  truncated: boolean;
}

// ── kind → accent color (the moodboard "glow set" as categorical signal) ──
export const KIND_COLOR: Record<string, string> = {
  land: '#f2913d',
  feat: '#f7c873',
  fix: '#e0552f',
  docs: '#3d7dff',
  other: '#7b4bd0',
  // automation loops
  scout: '#2fb6d6',
  observer: '#6fce4f',
  dispatch: '#f5c518',
  opportunity: '#c0327a',
  scope: '#7b4bd0',
  // plane delivery
  done: '#6fce4f',
  // crm touch direction
  in: '#6fce4f',
  out: '#3d7dff',
};

/** status → span color for the SESSIONS track. */
export const STATUS_COLOR: Record<string, string> = {
  working: '#3d7dff',
  spawning: '#2fb6d6',
  landing: '#6fce4f',
  blocked: '#e0552f',
  error: '#e0552f',
  stopped: '#6d7480',
  idle: '#6d7480',
  done: '#6fce4f',
  // plane state groups
  started: '#3d7dff',
  unstarted: '#7a8390',
  backlog: '#5a6270',
  completed: '#6fce4f',
  cancelled: '#e0552f',
  // calendar
  busy: '#3d7dff',
  tentative: '#f5c518',
  // crm touch direction
  in: '#6fce4f',
  out: '#3d7dff',
  mixed: '#7b4bd0',
};

export function kindColor(kind: string | undefined): string {
  return (kind && KIND_COLOR[kind]) || '#7b4bd0';
}

export function statusColor(status: string | undefined): string {
  return (status && STATUS_COLOR[status]) || '#6d7480';
}

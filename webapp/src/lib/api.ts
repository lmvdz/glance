import type { PlanBriefDTO, PlanRealityDTO, TranscriptEntry } from "./dto";

const TOKEN_KEY = "ompsq_token";

export function captureToken(): void {
  try {
    const url = new URL(location.href);
    const token = url.searchParams.get("token");
    if (!token) return;
    localStorage.setItem(TOKEN_KEY, token);
    url.searchParams.delete("token");
    history.replaceState(null, "", url.toString());
  } catch {
    // ponytail: storage/location can be blocked in tests; unauthenticated fetch still works in db mode.
  }
}

/** Persist a bearer token pasted by the operator (file mode's sign-in). */
export function setToken(value: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, value.trim());
  } catch {
    // storage blocked (private mode) — the token lives only for this page's lifetime.
  }
}

export function token(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * Drop any persisted file-mode bearer token.
 *
 * A token left over from an earlier `?token=` (file-mode) session is poison in
 * DB mode: the daemon's loopback bootstrap accepts it and answers `/api/me` with
 * `{mode:"file"}`, so the SPA resolves file mode, skips the DB-mode login + org
 * onboarding, and renders an empty "No project" shell instead. The auth layer
 * clears it the moment it learns the daemon is in DB mode.
 */
export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage blocked (private mode / tests) — nothing persisted to clear.
  }
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  captureToken();
  const headers = new Headers(init?.headers);
  const t = token();
  if (t) headers.set("Authorization", `Bearer ${t}`);
  return fetch(path, { ...init, headers });
}

/** Thrown by `apiJson` on any non-2xx response. Carries the HTTP `status` alongside the server's
 *  body text (the `message`) so a caller can branch on it — e.g. voice-mint distinguishing a 429
 *  org-cap refusal from a generic failure — without re-parsing the message string. Extends `Error`,
 *  so existing `catch` blocks that only read `.message` keep working unchanged. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok) throw new ApiError(await response.text(), response.status);
  return response.json() as Promise<T>;
}

export function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// -----------------------------------------------------------------------------------------------
// Voice lane (webapp-voice-lane/06) — daemon-mint helpers beside `apiJson`, matching its
// conventions (no separate fetch wiring, no module-level state). The minted `value` (an `ek_...`
// ephemeral provider token) is returned to the caller and MUST stay memory-only from there:
// callers must never log it, persist it (no localStorage), or pass it anywhere but the WebRTC SDP
// exchange (`voiceSession.ts`). This module itself never logs a response body.
// -----------------------------------------------------------------------------------------------

/** Mirrors `src/voice-token.ts`'s `VoiceMintToken` (the `POST /api/voice/token` response shape). */
export interface VoiceMintToken {
  provider: string;
  value: string;
  /** Unix epoch SECONDS (not milliseconds) — mirrors the provider's ephemeral-token expiry field.
   *  Compare against `Date.now() / 1000`, never `Date.now()` directly. */
  expiresAt: number;
  transport: "webrtc";
  pinnedAtMint: boolean;
}

/** Mint a short-lived voice provider token via the daemon (`POST /api/voice/token`). Defaults to
 *  `openai` — v1's only registered provider (`./voice/provider.ts`). Throws (via `apiJson`) on a
 *  non-2xx response — the 404 (feature flag off), 403 (DB/org mode), and 429 (per-actor rate cap)
 *  cases the daemon route implements all surface as thrown errors here for the caller to catch. */
export function mintVoiceToken(provider = "openai"): Promise<VoiceMintToken> {
  return apiJson<VoiceMintToken>("/api/voice/token", jsonInit("POST", { provider }));
}

/** Mirrors `GET /api/voice/config`'s viewer-vs-operator-scoped response shape — `providers` is
 *  absent for a viewer-tier actor (the daemon never sends it below operator; see server.ts). */
export interface VoiceConfigResponse {
  enabled: boolean;
  providers?: Array<{ id: string; transport: "webrtc"; model?: string }>;
}

// -----------------------------------------------------------------------------------------------
// Per-org voice key admin (voice-db-mode/06) — the four session-org-scoped admin routes concern 05
// landed (`/api/org/voice*`). The org's OpenAI key is passed to `putOrgVoiceKey` and travels ONLY
// into the request body of the server call below: it is never written to localStorage, never logged,
// and never returned by the server (GET/PUT answer with `last4` only). Everything here is a thin
// `apiJson` wrapper so the key has exactly one destination — the daemon.
// -----------------------------------------------------------------------------------------------

/** Session-org voice-key status. Mirrors `GET /api/org/voice` (and the PUT/enabled responses):
 *  `configured:false` alone when no key is stored, otherwise the non-secret posture. Never the key. */
export interface VoiceKeyStatus {
  configured: boolean;
  /** Last four chars of the stored key — a rotation cross-check, not an identifier. */
  last4?: string;
  /** Kill switch: a stored-but-disabled key mints nothing until re-enabled. */
  enabled?: boolean;
  updatedAt?: number;
  /** `db:<userId>` of the admin who last set the key. */
  updatedBy?: string;
}

/** Read the session org's voice-key status (admin tier server-side; a non-admin call 403s). */
export function getOrgVoiceStatus(): Promise<VoiceKeyStatus> {
  return apiJson<VoiceKeyStatus>("/api/org/voice");
}

/** Persist a candidate key for the session org. The server verifies it against the provider BEFORE
 *  storing (a rejected key writes nothing) and this wrapper never persists or logs `apiKey` — it goes
 *  into the request body and nowhere else. Throws (via `apiJson`) with the server's message on reject. */
export function putOrgVoiceKey(apiKey: string): Promise<VoiceKeyStatus> {
  return apiJson<VoiceKeyStatus>("/api/org/voice-key", jsonInit("PUT", { apiKey }));
}

/** Hard-delete the session org's stored key (reverts to `configured:false`). Distinct from the kill
 *  switch below: this forgets the key, `setOrgVoiceEnabled(false)` keeps it and only stops minting. */
export function deleteOrgVoiceKey(): Promise<VoiceKeyStatus> {
  return apiJson<VoiceKeyStatus>("/api/org/voice-key", { method: "DELETE" });
}

/** Flip the synchronous kill switch without touching the stored key. */
export function setOrgVoiceEnabled(enabled: boolean): Promise<VoiceKeyStatus> {
  return apiJson<VoiceKeyStatus>("/api/org/voice/enabled", jsonInit("POST", { enabled }));
}

// -----------------------------------------------------------------------------------------------
// Debrief lane (webapp-voice-lane/04) — the REST truth source for "while you were away". The WS
// `transcripts` mirror (TaskContext) is NOT used for this: it's empty on a cold page load (a
// fresh voice call may be the first thing the operator does after opening the tab) and a resumed
// WS stream has no completion marker to tell "already known" apart from "finished while away".
// -----------------------------------------------------------------------------------------------

/** `GET /api/agents/:id/transcript` — a plain `TranscriptEntry[]`, oldest-first (see
 *  `src/index.ts`'s `cmdLogs` for the same shape consumed CLI-side). Throws (via `apiJson`) on any
 *  non-2xx, including a 404 for a dead/evicted agent id — callers wrap this in `Promise.allSettled`
 *  so one dead tracked agent never sinks the whole debrief. */
export function fetchAgentTranscript(agentId: string): Promise<TranscriptEntry[]> {
  return apiJson<TranscriptEntry[]>(`/api/agents/${encodeURIComponent(agentId)}/transcript`);
}

// -----------------------------------------------------------------------------------------------
// Comprehension fog (concern 04) — GET /api/fog wire shape. Mirrors `src/comprehension-fog.ts`'s
// `FileFogEntry`/`FogState` exactly (repo is the RAW, unnormalized receipt repo, same
// representation `GET /api/heat`'s tree/hotArea nodes now carry — see heatmap.ts's `attachFog`,
// which joins the two without re-deriving its own repo convention).
// -----------------------------------------------------------------------------------------------

export type FogState = 'never-seen' | 'seen-current' | 'stale';

export interface FogEntryDTO {
  repo: string;
  file: string;
  changesSinceSeen: number;
  lastChangedAt: number;
  lastSeenAt?: number;
  debt: number;
  state: FogState;
}

/** Shape of GET /api/fog. `repoHasHistory` is keyed by the same raw repo strings as `entries`;
 *  `disabled:true` (attention substrate off, `GLANCE_ATTENTION=0`) means `entries`/`repoHasHistory`
 *  are both deliberately empty — never "no debt anywhere." */
export interface FogPayload {
  entries: FogEntryDTO[];
  repoHasHistory: Record<string, boolean>;
  disabled?: boolean;
}

/** Read the comprehension-fog overlay for every repo the caller can see (no `?repo=` — the daemon
 *  derives the actor-visible repo set itself, same discipline as `GET /api/attention/seen`). */
export function fetchFog(): Promise<FogPayload> {
  return apiJson<FogPayload>('/api/fog');
}

// -----------------------------------------------------------------------------------------------
// Weekly episode (comprehension concern 09, voice delivery concern 11) — the state-of-the-codebase
// brief. Mirrors `src/weekly-episode.ts`'s `EpisodeMeta` (list route) and `EpisodeMeta & {markdown}`
// (single-episode route) exactly. The list route NEVER carries markdown (DESIGN.md: "full markdown
// NEVER in the BM25 corpus" — the same discipline extends to this list wire shape); only the
// single-episode fetch below returns it.
// -----------------------------------------------------------------------------------------------

export interface EpisodeMetaDTO {
  version: number;
  id: string;
  repo: string;
  isoWeek: string;
  windowStart: number;
  windowEnd: number;
  generatedAt: number;
  excerpt: string;
  digestCount: number;
  hasStaleAnswers: boolean;
}

export interface EpisodeDTO extends EpisodeMetaDTO {
  markdown: string;
}

/** `GET /api/episodes?repo=` — every episode meta for one repo, newest week first (server-sorted,
 *  `src/server.ts`'s route). `repo` is REQUIRED here (unlike the daemon route's own optional
 *  `?repo=`, which falls back to every actor-visible repo) — the voice debrief lane always knows
 *  which single repo it's calling about and has no use for a cross-repo merge. */
export function fetchEpisodes(repo: string): Promise<EpisodeMetaDTO[]> {
  return apiJson<{ episodes: EpisodeMetaDTO[] }>(`/api/episodes?repo=${encodeURIComponent(repo)}`).then((r) => r.episodes);
}

/** `GET /api/episodes/:id?repo=` — full markdown + meta for one episode. `repo` is required
 *  server-side (an isoWeek `id` alone isn't globally unique, only unique per repo — see
 *  `src/server.ts`'s route doc); throws (via `apiJson`) on a 404 (unknown id) or 400 (foreign/
 *  missing repo). */
export function fetchEpisode(repo: string, id: string): Promise<EpisodeDTO> {
  return apiJson<EpisodeDTO>(`/api/episodes/${encodeURIComponent(id)}?repo=${encodeURIComponent(repo)}`);
}

// -----------------------------------------------------------------------------------------------
// Plan vs reality (OMPSQ-448 comprehension) — `GET /api/features/:id/reality?repo=<repo>` wraps
// its payload in `{ reality: PlanRealityDTO }`; this unwraps it so callers deal in the DTO
// directly. 404 (no plan-reality data for this feature) is a normal, expected state — mapped to
// `null` rather than thrown, mirroring `getVoiceConfig`'s discipline; any other non-2xx still
// throws (via `apiJson`) so a genuine failure isn't silently swallowed as "no data".
// -----------------------------------------------------------------------------------------------

export async function fetchPlanReality(featureId: string, repo: string): Promise<PlanRealityDTO | null> {
  const response = await apiFetch(`/api/features/${encodeURIComponent(featureId)}/reality?repo=${encodeURIComponent(repo)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new ApiError(await response.text(), response.status);
  const body = (await response.json()) as { reality: PlanRealityDTO };
  return body.reality;
}

// -----------------------------------------------------------------------------------------------
// Loop meters + narrative surfaces (previously generated-but-invisible; see lib/loop-meters.ts for
// the wire shapes and coercers — these fetchers return `unknown` on purpose so the coercers stay
// the single trust boundary).
// -----------------------------------------------------------------------------------------------

/** `GET /api/metrics/learning-loop` — flag resolution + per-metric rollups (src/metrics.ts). */
export function fetchLearningLoop(): Promise<unknown> {
  return apiJson<unknown>('/api/metrics/learning-loop');
}

/** `GET /api/after-action` — every durable post-mortem the daemon has written (src/after-action.ts).
 *  Reports outlive their auto-reaped roster rows; filter client-side with `reportsForAgents`. */
export function fetchAfterActions(): Promise<unknown> {
  return apiJson<unknown>('/api/after-action');
}

/** `GET /api/symptoms?browse=1` — newest recurring failure modes across the actor-visible repos
 *  (src/symptoms.ts). Distinct contract from the rank-only `?q=` search the ⌘K palette uses. */
export function browseSymptoms(topK = 20): Promise<unknown> {
  return apiJson<unknown>(`/api/symptoms?browse=1&topK=${topK}`);
}

/** Voice capability probe (`GET /api/voice/config`) — the one honest discovery channel for whether
 *  voice is enabled/configured (no webapp code consumes `/api/settings` flags; see DESIGN.md's
 *  "Flagging" row). A 404 means the feature flag is off — that's a normal, expected state (not an
 *  error the caller should have to catch), so it's mapped to `{enabled:false}` instead of throwing.
 *  Any other non-2xx (403 DB/org mode, 5xx, etc.) still throws via `apiJson`. */
export async function getVoiceConfig(): Promise<VoiceConfigResponse> {
  const response = await apiFetch("/api/voice/config");
  if (response.status === 404) return { enabled: false };
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<VoiceConfigResponse>;
}


export function fetchPlanBrief(name: string, repo?: string): Promise<PlanBriefDTO> {
  const qs = repo ? `?repo=${encodeURIComponent(repo)}` : '';
  return apiJson<{ brief: PlanBriefDTO }>(`/api/plans/${encodeURIComponent(name)}/brief${qs}`).then((r) => r.brief);
}
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

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok) throw new Error(await response.text());
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

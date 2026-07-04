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

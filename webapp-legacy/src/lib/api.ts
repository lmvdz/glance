import { apiFetch } from "./ws";

// GET/POST helpers for the same-origin omp-squad daemon API. Responses come from
// our own daemon (trusted boundary), so the caller-declared T is an accepted
// unchecked shape rather than a schema parse (no validator dep in webapp).

export async function apiGet<T>(path: string): Promise<T | null> {
  try {
    const r = await apiFetch(path);
    if (!r.ok) return null;
    const data = (await r.json()) as T; // caller-declared daemon response shape
    return data;
  } catch {
    return null;
  }
}

export async function apiPost<T>(path: string, body: unknown): Promise<T | null> {
  try {
    const r = await apiFetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as T; // caller-declared daemon response shape
    return data;
  } catch {
    return null;
  }
}

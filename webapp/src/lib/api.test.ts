import { expect, test } from "bun:test";
import { fetchEpisode, fetchEpisodes, getVoiceConfig } from "./api";

// =================================================================================================
// getVoiceConfig (MINOR-15): a 404 means the voice feature flag is off — a normal, expected state,
// not an error the caller should have to catch.
// =================================================================================================

test("getVoiceConfig: a 404 (feature flag off) maps to {enabled:false} instead of throwing", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 404, text: async () => "not found" }) as unknown as Response) as typeof fetch;
  try {
    expect(await getVoiceConfig()).toEqual({ enabled: false });
  } finally {
    globalThis.fetch = original;
  }
});

test("getVoiceConfig: a successful response is passed through unchanged", async () => {
  const original = globalThis.fetch;
  const body = { enabled: true, providers: [{ id: "openai", transport: "webrtc" as const }] };
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response) as typeof fetch;
  try {
    expect(await getVoiceConfig()).toEqual(body);
  } finally {
    globalThis.fetch = original;
  }
});

test("getVoiceConfig: a non-404 error status (e.g. 403 DB/org mode) still throws", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 403, text: async () => "forbidden" }) as unknown as Response) as typeof fetch;
  try {
    await expect(getVoiceConfig()).rejects.toThrow("forbidden");
  } finally {
    globalThis.fetch = original;
  }
});

// =================================================================================================
// fetchEpisodes / fetchEpisode (comprehension concern 09/11) — GET /api/episodes[?repo=]. The list
// route's `{episodes: [...]}` wrapper is unwrapped to a plain array here; the single-episode route
// is passed through unchanged.
// =================================================================================================

test("fetchEpisodes: unwraps the {episodes:[...]} envelope and passes `repo` as a query param", async () => {
  const original = globalThis.fetch;
  const meta = { version: 1, id: "2026-W28", repo: "/srv/app", isoWeek: "2026-W28", windowStart: 0, windowEnd: 1, generatedAt: 5, excerpt: "e", digestCount: 0, hasStaleAnswers: false };
  let calledUrl = "";
  globalThis.fetch = (async (url: string) => {
    calledUrl = url;
    return { ok: true, status: 200, json: async () => ({ episodes: [meta] }) } as unknown as Response;
  }) as typeof fetch;
  try {
    const episodes = await fetchEpisodes("/srv/app");
    expect(episodes).toEqual([meta]);
    expect(calledUrl).toBe("/api/episodes?repo=%2Fsrv%2Fapp");
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchEpisode: fetches /api/episodes/:id?repo= and returns the body unchanged", async () => {
  const original = globalThis.fetch;
  const body = { version: 1, id: "2026-W28", repo: "/srv/app", isoWeek: "2026-W28", windowStart: 0, windowEnd: 1, generatedAt: 5, excerpt: "e", digestCount: 0, hasStaleAnswers: false, markdown: "# Weekly episode" };
  let calledUrl = "";
  globalThis.fetch = (async (url: string) => {
    calledUrl = url;
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as typeof fetch;
  try {
    expect(await fetchEpisode("/srv/app", "2026-W28")).toEqual(body);
    expect(calledUrl).toBe("/api/episodes/2026-W28?repo=%2Fsrv%2Fapp");
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchEpisode: a non-2xx response throws via apiJson", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 404, text: async () => "no such episode" }) as unknown as Response) as typeof fetch;
  try {
    await expect(fetchEpisode("/srv/app", "2026-W99")).rejects.toThrow("no such episode");
  } finally {
    globalThis.fetch = original;
  }
});

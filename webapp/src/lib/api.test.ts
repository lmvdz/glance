import { expect, test } from "bun:test";
import { endVoiceCall, fetchEpisode, fetchEpisodes, fetchVoiceCallArtifacts, fetchVoiceCallDecisions, fetchVoiceCallGaps, fetchVoiceCallState, fetchVoiceCallTranscript, getVoiceConfig, resolveVoiceCallDecision, startVoiceCall, steerVoiceCall } from "./api";

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

// =================================================================================================
// Voice call (concern 02) — thin fetch wrappers only; concern 03 owns rendering. Mirrors the
// getVoiceConfig/fetchEpisode pattern above: 404-as-null where the route documents it, otherwise a
// throw via apiJson.
// =================================================================================================

test("fetchVoiceCallState: a 404 (no call ever started) maps to null instead of throwing", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 404, text: async () => "no call" }) as unknown as Response) as typeof fetch;
  try {
    expect(await fetchVoiceCallState("room-1")).toBeNull();
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchVoiceCallState: a 403 (forbidden — not a room member) still throws", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 403, text: async () => "forbidden" }) as unknown as Response) as typeof fetch;
  try {
    await expect(fetchVoiceCallState("room-1")).rejects.toThrow("forbidden");
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchVoiceCallState: a live binding is passed through unchanged, and never carries a control token", async () => {
  const original = globalThis.fetch;
  const body = { channelId: "room-1", callId: "call-1", sessionId: "live-1", sessionRoot: "/tmp", ownerActorId: "operator", retention: "full" as const, startedAt: 1, updatedAt: 2, state: "live" as const };
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response) as typeof fetch;
  try {
    const state = await fetchVoiceCallState("room-1");
    expect(state).toEqual(body);
    expect((state as unknown as Record<string, unknown>).controlToken).toBeUndefined();
  } finally {
    globalThis.fetch = original;
  }
});

test("startVoiceCall: POSTs to /api/channels/:id/voice-call with the retention/sessionRoot body", async () => {
  const original = globalThis.fetch;
  let calledUrl: string | undefined;
  let calledInit: RequestInit | undefined;
  const body = { channelId: "room-1", state: "live" };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calledUrl = url;
    calledInit = init;
    return { ok: true, status: 201, json: async () => body } as unknown as Response;
  }) as typeof fetch;
  try {
    expect(await startVoiceCall("room-1", { retention: "full" })).toEqual(body);
    expect(calledUrl).toBe("/api/channels/room-1/voice-call");
    expect(calledInit?.method).toBe("POST");
    expect(JSON.parse(calledInit?.body as string)).toEqual({ retention: "full" });
  } finally {
    globalThis.fetch = original;
  }
});

test("startVoiceCall: a 409 (already an active call) throws with the daemon's own message", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 409, text: async () => "channel room-1 already has an active call (live)" }) as unknown as Response) as typeof fetch;
  try {
    await expect(startVoiceCall("room-1")).rejects.toThrow("already has an active call");
  } finally {
    globalThis.fetch = original;
  }
});

test("endVoiceCall: DELETEs the channel's voice-call binding", async () => {
  const original = globalThis.fetch;
  let calledMethod: string | undefined;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    calledMethod = init?.method;
    return { ok: true, status: 200, json: async () => ({ state: "ended" }) } as unknown as Response;
  }) as typeof fetch;
  try {
    expect(await endVoiceCall("room-1")).toEqual({ state: "ended" });
    expect(calledMethod).toBe("DELETE");
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchVoiceCallDecisions: unwraps the {decisions:[...]} envelope", async () => {
  const original = globalThis.fetch;
  const decisions = [{ id: "d1", prompt: "Which name?", options: [], requiresConfirmation: false, state: "open" as const, createdAt: 1, updatedAt: 1 }];
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ decisions }) }) as unknown as Response) as typeof fetch;
  try {
    expect(await fetchVoiceCallDecisions("room-1")).toEqual(decisions);
  } finally {
    globalThis.fetch = original;
  }
});

test("resolveVoiceCallDecision: an arbiter rejection (ok:false with a reason) is returned, not thrown", async () => {
  const original = globalThis.fetch;
  let calledUrl: string | undefined;
  const ack = { ok: false, reason: "label-mismatch" };
  globalThis.fetch = (async (url: string) => {
    calledUrl = url;
    return { ok: true, status: 200, json: async () => ack } as unknown as Response;
  }) as typeof fetch;
  try {
    expect(await resolveVoiceCallDecision("room-1", "d1", { optionIndex: 0, label: "Keep it" })).toEqual(ack);
    expect(calledUrl).toBe("/api/channels/room-1/voice-call/decisions/d1/resolve");
  } finally {
    globalThis.fetch = original;
  }
});

test("resolveVoiceCallDecision: a 403 (denied member) still throws", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 403, text: async () => "forbidden" }) as unknown as Response) as typeof fetch;
  try {
    await expect(resolveVoiceCallDecision("room-1", "d1", { optionIndex: 0, label: "Keep it" })).rejects.toThrow("forbidden");
  } finally {
    globalThis.fetch = original;
  }
});

test("steerVoiceCall: POSTs {text} to the steer route", async () => {
  const original = globalThis.fetch;
  let calledBody: string | undefined;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    calledBody = init?.body as string;
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
  }) as typeof fetch;
  try {
    expect(await steerVoiceCall("room-1", "focus on the auth module")).toEqual({ ok: true });
    expect(JSON.parse(calledBody!)).toEqual({ text: "focus on the auth module" });
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchVoiceCallTranscript: unwraps {transcript:[...]}, including a redacted entry", async () => {
  const original = globalThis.fetch;
  const transcript = [{ callId: "call-1", turn: 0, role: "user" as const, final: true, at: 1, redacted: true }];
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ transcript }) }) as unknown as Response) as typeof fetch;
  try {
    expect(await fetchVoiceCallTranscript("room-1")).toEqual(transcript);
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchVoiceCallArtifacts: unwraps {artifacts:[...]}", async () => {
  const original = globalThis.fetch;
  const artifacts = [{ id: "art-1", channelId: "room-1", callId: "call-1", sourcePath: "report.md", status: "ready" as const, contentHash: "abc", revision: 1, copiedAt: 1 }];
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ artifacts }) }) as unknown as Response) as typeof fetch;
  try {
    expect(await fetchVoiceCallArtifacts("room-1")).toEqual(artifacts);
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchVoiceCallGaps: unwraps {gaps:[...]}", async () => {
  const original = globalThis.fetch;
  const gaps = [{ callId: "call-1", atSeq: 5, missingCount: 4, detectedAt: 1 }];
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ gaps }) }) as unknown as Response) as typeof fetch;
  try {
    expect(await fetchVoiceCallGaps("room-1")).toEqual(gaps);
  } finally {
    globalThis.fetch = original;
  }
});

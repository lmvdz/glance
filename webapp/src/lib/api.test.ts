import { expect, test } from "bun:test";
import { getVoiceConfig } from "./api";

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

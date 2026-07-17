import { expect, test } from "bun:test";
import { parsePushTapHash, reportPushTapFromLocation } from "./push-tap";

// =================================================================================================
// parsePushTapHash (daily-dogfood-engine 02): the beacon must fire ONLY on the exact `?push=1`
// marker src/push.ts appends to notification deep links — never on ordinary navigation — and the
// stripped hash must keep the agent route (and any other params) intact.
// =================================================================================================

test("the marker hash parses to the agent id and a marker-free hash", () => {
  expect(parsePushTapHash("#/agent/chat-abc-1-dead?push=1")).toEqual({
    agentId: "chat-abc-1-dead",
    strippedHash: "#/agent/chat-abc-1-dead",
  });
});

test("other params survive the strip; only the marker is removed", () => {
  const parsed = parsePushTapHash("#/agent/a1?push=1&view=diff");
  expect(parsed?.agentId).toBe("a1");
  expect(parsed?.strippedHash).toBe("#/agent/a1?view=diff");
});

test("ordinary navigation never counts", () => {
  expect(parsePushTapHash("")).toBeNull(); // no hash at all
  expect(parsePushTapHash("#/agent/a1")).toBeNull(); // typed/clicked deep link, no marker
  expect(parsePushTapHash("#/agent/a1?push=0")).toBeNull(); // marker present but not armed
  expect(parsePushTapHash("#/agent/a1?pushy=1")).toBeNull(); // not our param
  expect(parsePushTapHash("#/review/t1?push=1")).toBeNull(); // marker on a non-agent route
  expect(parsePushTapHash("#/agent/?push=1")).toBeNull(); // no agent id
});

test("percent-encoded ids decode; malformed encoding is rejected, not thrown", () => {
  expect(parsePushTapHash("#/agent/a%201?push=1")?.agentId).toBe("a 1");
  expect(parsePushTapHash("#/agent/%E0%A4%A?push=1")).toBeNull(); // malformed — decodeURIComponent throws
});

// =================================================================================================
// reportPushTapFromLocation (finding #9): the sessionStorage dedupe flag must guard only the
// double-fire of the SAME physical arrival, never a later, genuinely separate tap on the same
// agent in an already-open tab — a permanently-set flag silently caps the count at one tap per
// agent per tab lifetime, undercounting exactly the focused-window lane the `hashchange` listener
// exists to cover. Bun's runtime has no DOM, so these stub `location`/`history`/`sessionStorage`/
// `fetch` by hand — the same objects `installPushTapBeacon` drives in main.tsx (once at boot, then
// again on every `hashchange`).
// =================================================================================================

function stubBrowserEnv(startHash: string) {
  const state = { hash: startHash };
  const store = new Map<string, string>();
  const calls: Array<{ agentId: string }> = [];
  const restore = {
    location: (globalThis as { location?: unknown }).location,
    sessionStorage: (globalThis as { sessionStorage?: unknown }).sessionStorage,
    history: (globalThis as { history?: unknown }).history,
    fetch: globalThis.fetch,
  };
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: {
      get hash() {
        return state.hash;
      },
      set hash(v: string) {
        state.hash = v;
      },
      pathname: "/",
      search: "",
      href: "http://localhost/",
    },
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    },
  });
  Object.defineProperty(globalThis, "history", {
    configurable: true,
    value: {
      replaceState: (_s: unknown, _t: string, url: string) => {
        const i = url.indexOf("#");
        state.hash = i === -1 ? "" : url.slice(i);
      },
    },
  });
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (init?.body) {
      try {
        calls.push(JSON.parse(String(init.body)));
      } catch {
        // ignore malformed body — not expected here
      }
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return {
    calls,
    setHash: (h: string) => {
      state.hash = h;
    },
    getHash: () => state.hash,
    restore: () => {
      Object.defineProperty(globalThis, "location", { configurable: true, value: restore.location });
      Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: restore.sessionStorage });
      Object.defineProperty(globalThis, "history", { configurable: true, value: restore.history });
      globalThis.fetch = restore.fetch as typeof fetch;
    },
  };
}

test("a later real tap on the same agent, in the same open tab, is counted (finding #9)", () => {
  const env = stubBrowserEnv("#/agent/a1?push=1");
  try {
    reportPushTapFromLocation();
    expect(env.getHash()).toBe("#/agent/a1");
    expect(env.calls).toEqual([{ agentId: "a1" }]);

    // Hours later, in the SAME still-open tab: the sw navigates the identical marker hash back
    // in for a genuinely separate notification tap on the same agent.
    env.setHash("#/agent/a1?push=1");
    reportPushTapFromLocation();

    expect(env.getHash()).toBe("#/agent/a1"); // stripped again
    expect(env.calls).toEqual([{ agentId: "a1" }, { agentId: "a1" }]); // NOT dropped
  } finally {
    env.restore();
  }
});

test("a synchronous double-invoke of the same arrival (StrictMode/HMR-alike) still counts once", () => {
  const env = stubBrowserEnv("#/agent/a2?push=1");
  try {
    reportPushTapFromLocation();
    reportPushTapFromLocation(); // location.hash is already stripped — parsePushTapHash is null now
    expect(env.calls).toEqual([{ agentId: "a2" }]);
  } finally {
    env.restore();
  }
});

test("two different agents in the same tab both count independently", () => {
  const env = stubBrowserEnv("#/agent/a1?push=1");
  try {
    reportPushTapFromLocation();
    env.setHash("#/agent/a3?push=1");
    reportPushTapFromLocation();
    expect(env.calls).toEqual([{ agentId: "a1" }, { agentId: "a3" }]);
  } finally {
    env.restore();
  }
});

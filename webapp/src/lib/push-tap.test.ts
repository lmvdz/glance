import { expect, test } from "bun:test";
import { parsePushTapHash } from "./push-tap";

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

import { expect, test } from "bun:test";
import { appendText } from "../../lib/assistant-text";
import { buildOmpMessages, toolNameFrom } from "../../lib/omp-thread";
import { appendTranscriptEntry } from "../../hooks/useSquad";
import { uniqueModelOptions } from "../../lib/model-options";

test("appendText forwards assistant-ui quote context before the prompt", () => {
  expect(
    appendText({
      role: "user",
      content: [{ type: "text", text: "What should I do next?" }],
      metadata: { custom: { quote: { text: "line one\nline two", messageId: "m1" } } },
      parentId: null,
      sourceId: null,
      runConfig: undefined,
    }),
  ).toBe("> line one\n> line two\n\nWhat should I do next?");
});

test("buildOmpMessages maps omp events into assistant-ui parts", () => {
  const messages = buildOmpMessages(
    "chat-1",
    [
      { kind: "user", text: "hello", ts: 1 },
      { kind: "thinking", text: "checking context", ts: 2 },
      { kind: "tool", text: "▸ read: Reading package", ts: 3 },
      { kind: "assistant", text: "hi there", ts: 4 },
    ],
    [],
    true,
  );

  expect(messages).toHaveLength(2);
  expect(messages[0]?.role).toBe("user");
  expect(messages[1]?.role).toBe("assistant");
  expect(messages[1]?.status?.type).toBe("running");
  expect(messages[1]?.content.map((part) => part.type)).toEqual(["reasoning", "tool-call", "text"]);
  expect(toolNameFrom("▸ read: Reading package")).toBe("read");
  expect(buildOmpMessages("chat-1", [{ kind: "user", text: "hello", ts: 1, clientTurnId: "turn-1" }], [{ id: "pending:1", text: "hello", ts: 2, clientTurnId: "turn-1" }], false)).toHaveLength(1);
});

test("appendTranscriptEntry ignores replayed entries and replaces rich updates", () => {
  const entry = { id: "e1", kind: "tool" as const, text: "▸ read", ts: 1, status: "running" as const };
  expect(appendTranscriptEntry([entry], entry)).toHaveLength(1);
  expect(appendTranscriptEntry([entry], { ...entry, status: "ok" })[0]?.status).toBe("ok");
});

test("uniqueModelOptions keeps select values unique", () => {
  expect(uniqueModelOptions([{ label: "chat a", value: "chat" }, { label: "chat b", value: "chat" }, { label: "reserved", value: "__custom__" }], ["__custom__"])).toEqual([{ label: "chat a", value: "chat" }]);
});

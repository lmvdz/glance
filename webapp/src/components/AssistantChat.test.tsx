import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildTranscriptRenderEntries,
  ChatMessagesViewport,
  chatWidthFromClientX,
  clearEchoedPendingSends,
  deriveSuggestionChips,
  detectedPlanDirs,
  messageToTranscriptEntry,
  normalizeAssistantSessions,
  partitionSessionMessages,
  type Message,
} from "./AssistantChat";
import { AgentLandControls, AgentMetaBar } from "./chat/AgentMetaBar";
import { Composer, ComposerSendButton } from "./chat/Composer";
import { ComposerStats } from "./chat/AgentMetaBar";
import { DiffReviewPanel } from "./chat/DiffReviewPanel";
import { GateWidget } from "./chat/GateWidget";
import { RunStatusHeader, TranscriptEntryView, TranscriptTimeline, runStatusLabel } from "./chat/TranscriptTimeline";
import { TodoPanel } from "./chat/TodoPanel";
import { ScrollToLatestPill } from "./chat/ScrollToLatestPill";
import type { AgentDTO, PendingRequest, TodoPhaseDTO, TranscriptEntry } from "../lib/dto";
import { COMPOSER_DRAFTS_KEY } from "../lib/chat/draftStore";

const originalWindow = (globalThis as any).window;

afterEach(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

const composerBaseProps = {
  tasks: [],
  suggestionChips: [],
  isLoading: false,
  isStopShown: false,
  stopPending: false,
  onStop: () => {},
  onSend: () => {},
  selectedModel: "",
  modelOptions: [],
  onModelChange: () => {},
} as const;

test("TranscriptEntryView renders human-first tool output with raw payload tucked away", () => {
  const entry: TranscriptEntry = {
    id: "tool-1",
    kind: "tool",
    text: "▸ bash: Checking processes",
    ts: 1,
    status: "ok",
    tool: {
      callId: "tool-1",
      name: "bash",
      argsText: JSON.stringify({ command: "ps -ef" }),
      partialText: JSON.stringify({ stdout: "running" }),
      resultText: JSON.stringify({ stdout: "UID PID CMD\\nlars 42 ps -ef", exitCode: 0 }),
    },
  };

  const html = renderToStaticMarkup(<TranscriptEntryView entry={entry} />);
  expect(html).toContain("Bash"); // human tool name, not the raw "bash"
  expect(html).toContain("Ran ps -ef");
  expect(html).toContain("UID PID CMD");
  expect(html).toContain("exit 0");
  expect(html).toContain("Raw payload");
});

test("TranscriptEntryView renders foldable streaming thinking", () => {
  const entry: TranscriptEntry = {
    id: "think-1",
    kind: "thinking",
    text: "I need to inspect the running processes first.",
    ts: 1,
    status: "running",
  };

  const html = renderToStaticMarkup(<TranscriptEntryView entry={entry} />);
  expect(html).toContain("<details data-chat-message");
  expect(html).toContain('open=""');
  expect(html).toContain("Thinking");
  expect(html).toContain("streaming");
  expect(html).toContain("running processes");
});

test("TranscriptEntryView is memoized (same entry identity renders identical markup twice)", () => {
  const entry: TranscriptEntry = {
    id: "a1",
    kind: "assistant",
    text: "Done. Tightened the UI.",
    ts: 1,
    status: "ok",
  };

  const first = renderToStaticMarkup(<TranscriptEntryView entry={entry} />);
  const second = renderToStaticMarkup(<TranscriptEntryView entry={entry} />);
  expect(second).toBe(first);
  expect((TranscriptEntryView as unknown as { $$typeof?: symbol }).$$typeof?.toString()).toContain("react.memo");
});

test("TodoPanel renders persistent beautiful progress and can collapse", () => {
  const phases: TodoPhaseDTO[] = [{
    name: "Implementation",
    tasks: [
      { content: "Wire todo state", status: "completed" },
      { content: "Render sticky panel", status: "in_progress" },
      { content: "Polish spacing", status: "pending" },
    ],
  }];

  const expanded = renderToStaticMarkup(<TodoPanel phases={phases} collapsed={false} onToggle={() => {}} />);
  expect(expanded).toContain("Todo");
  expect(expanded).toContain("1/3");
  expect(expanded).toContain("Render sticky panel");
  expect(expanded).toContain("Polish spacing");

  const collapsed = renderToStaticMarkup(<TodoPanel phases={phases} collapsed={true} onToggle={() => {}} />);
  expect(collapsed).toContain("Render sticky panel");
  expect(collapsed).not.toContain("Polish spacing");
});

test("AgentMetaBar keeps only compact git branch status at the top", () => {
  const agent: AgentDTO = {
    id: "a1",
    name: "chat",
    status: "working",
    repo: "/home/lars/sui/omp-squad",
    worktree: "/home/lars/.omp/squad/worktrees/omp-squad-chat",
    branch: "squad/chat",
    model: "openai/gpt-5.5",
    contextPct: 0.73,
    receipt: { toolCalls: 4, tokens: 12345, durationMs: 65_000 },
    pending: [],
    lastActivity: 1,
    autonomyMode: "assist",
    effectiveMode: "assist",
    verificationState: "fresh",
    availableActions: ["prompt", "answer", "interrupt", "verify", "land", "set-mode"],
  };

  const html = renderToStaticMarkup(<AgentMetaBar agent={agent} changedFiles={2} />);
  expect(html).toContain("squad/chat · 2 changed");
  expect(html).not.toContain("openai/gpt-5.5");
});

test("ComposerStats renders ultra-compact context, tokens, tools, and time", () => {
  const agent: AgentDTO = {
    id: "a1",
    name: "chat",
    status: "working",
    repo: "/home/lars/sui/omp-squad",
    worktree: "/home/lars/.omp/squad/worktrees/omp-squad-chat",
    contextPct: 0.777,
    contextWindow: 272_000,
    receipt: { toolCalls: 8, tokens: 500_200, durationMs: 1_959_000 },
    pending: [],
    lastActivity: 1,
    autonomyMode: "assist",
    effectiveMode: "assist",
    verificationState: "unknown",
    availableActions: ["set-mode"],
  };

  const html = renderToStaticMarkup(<ComposerStats agent={agent} />);
  expect(html).toContain("77.7%/272.0K");
  expect(html).toContain("500.2K tok");
  expect(html).toContain("8 tools");
  expect(html).toContain("32m 39s");
});

test("RunStatusHeader labels live work with shimmer action", () => {
  const html = renderToStaticMarkup(<RunStatusHeader running elapsedMs={37_000} action="Thinking" expanded onToggle={() => {}} />);
  expect(html).toContain("Working for 37s");
  expect(html).toContain("Thinking");
  expect(html).toContain("shimmer");
  expect(runStatusLabel(false, 391_000)).toBe("Worked for 6m 31s");
});

test("TranscriptTimeline collapses completed work and keeps final summary visible", () => {
  const entries: TranscriptEntry[] = [
    { id: "u1", kind: "user", text: "Make layout compact", ts: 1, status: "ok" },
    { id: "t1", kind: "thinking", text: "Inspecting files", ts: 2, status: "ok" },
    { id: "a1", kind: "assistant", text: "Done. Tightened the UI.", ts: 3, status: "ok" },
  ];

  const html = renderToStaticMarkup(
    <TranscriptTimeline
      entries={entries}
      messages={[]}
      diffs={[{ file: "webapp/src/index.css", status: "M", diff: "+ .shimmer" }]}
      expanded={false}
      onToggle={() => {}}
    />,
  );

  expect(html).toContain("Make layout compact");
  expect(html).toContain("Worked for");
  expect(html).not.toContain("Inspecting files");
  expect(html).toContain("Done. Tightened the UI.");
  expect(html).toContain("Review diff");
});

test("TranscriptTimeline never folds the operator's sent message into the collapsed work section, even when a mapped pre-agent welcome leads the list (concern 10)", () => {
  // Mirrors buildTranscriptRenderEntries's merged shape for a brand-new agent-backed
  // session: the mapped welcome (kind:'assistant', id prefixed `msg:`) leads, followed
  // by the replayed transcript's echoed prompt and its answer. Before the fix, the
  // leading assistant-kind welcome made `firstWorkIndex` resolve to 0, bucketing the
  // whole thing (including the operator prompt) as collapsible "work".
  const entries: TranscriptEntry[] = [
    { id: "msg:model:1", kind: "assistant", text: "welcome", ts: 1, status: "ok" },
    { id: "t1", kind: "user", text: "operator prompt", ts: 2, status: "ok" },
    { id: "a1", kind: "assistant", text: "the answer", ts: 3, status: "ok" },
  ];

  const collapsed = renderToStaticMarkup(
    <TranscriptTimeline entries={entries} messages={[]} expanded={false} onToggle={() => {}} />,
  );
  expect(collapsed).toContain("welcome");
  expect(collapsed).toContain("operator prompt");
  expect(collapsed).toContain("the answer");
});

test("TranscriptTimeline: a pending send in trailingEntries renders after the fold WITHOUT swallowing the previous finalEntry, and does not flip the work-fold's own running (review finding 2 core regression)", () => {
  const entries: TranscriptEntry[] = [
    { id: "u1", kind: "user", text: "first question", ts: 1, status: "ok" },
    { id: "a1", kind: "assistant", text: "the first answer", ts: 2, status: "ok" },
  ];
  const pendingSend: TranscriptEntry[] = [{ id: "pending:s1:turn-b", kind: "user", text: "second question", ts: 3, status: "running", clientTurnId: "turn-b" }];

  const html = renderToStaticMarkup(
    <TranscriptTimeline entries={entries} trailingEntries={pendingSend} messages={[]} expanded={false} onToggle={() => {}} />,
  );
  // The prior answer must still be visible — before the fix, a trailing pendingSend flipped
  // `running` true and folded the finalEntry away along with the freshly sent message.
  expect(html).toContain("the first answer");
  expect(html).toContain("second question");
  expect(html).toContain("Worked for"); // NOT "Working for" — the fold correctly sees the run as settled
  expect(html).not.toContain("Working for");
});

test("TranscriptTimeline: an error-status user entry (undelivered send) gets a visible 'Not delivered' hint and a copy-text affordance", () => {
  const entries: TranscriptEntry[] = [{ id: "u1", kind: "user", text: "never landed", ts: 1, status: "error" }];
  const html = renderToStaticMarkup(<TranscriptEntryView entry={entries[0]!} />);
  expect(html).toContain("never landed");
  expect(html).toContain("Not delivered");
  expect(html).toContain("Copy text");
  expect(html).toContain("border-red-300");
});

test("TranscriptEntryView renders the operator's bare typed text (displayText) for a user entry, not the context-augmented text sent to the agent (review finding 4)", () => {
  const entry: TranscriptEntry = {
    id: "u1",
    kind: "user",
    text: "What's being worked on?\n\n[Live context for reference]\n...lots of injected fleet state...",
    displayText: "What's being worked on?",
    ts: 1,
    status: "ok",
  };
  const html = renderToStaticMarkup(<TranscriptEntryView entry={entry} />);
  expect(html).toContain("What&#x27;s being worked on?");
  expect(html).not.toContain("injected fleet state");
});

test("DiffReviewPanel renders compact changed-file access", () => {
  const html = renderToStaticMarkup(<DiffReviewPanel diffs={[{ file: "README.md", status: "M", diff: "+ compact chat" }]} />);
  expect(html).toContain("1 changed file");
  expect(html).toContain("README.md");
  expect(html).toContain("+ compact chat");
});

test("chatWidthFromClientX clamps dragged assistant width", () => {
  expect(chatWidthFromClientX(1200, 700)).toBe(500);
  expect(chatWidthFromClientX(1200, 1000)).toBe(320);
  expect(chatWidthFromClientX(1200, 100)).toBe(680);
});

test("normalizeAssistantSessions falls back when restored chat state is empty or stale", () => {
  expect(normalizeAssistantSessions([], 42)[0]).toMatchObject({ id: "default", title: "Initial conversation", updatedAt: 42 });
  expect(normalizeAssistantSessions([{ id: "s2", title: "Newer", messages: [], updatedAt: 2 }, { id: "s1", title: "Older", messages: [], updatedAt: 1 }])[0]?.id).toBe("s2");
  expect(normalizeAssistantSessions([{ id: "bad", messages: [], updatedAt: 1 }], 7)[0]).toMatchObject({ id: "default", updatedAt: 7 });
});

test("normalizeAssistantSessions strips legacy reaction fields from old localStorage blobs (dropped thumbs up/down UI)", () => {
  const legacy = [{
    id: "s1",
    title: "Old chat",
    updatedAt: 5,
    messages: [
      { role: "model", text: "hi", timestamp: 1, reaction: "like" },
      { role: "user", text: "hello", timestamp: 2 },
    ],
  }];

  const [session] = normalizeAssistantSessions(legacy);
  expect(session?.messages).toEqual([
    { role: "model", text: "hi", timestamp: 1 },
    { role: "user", text: "hello", timestamp: 2 },
  ]);
  expect(session?.messages.some((message) => "reaction" in message)).toBe(false);
});

test("normalizeAssistantSessions no longer destructively migrates agent-backed sessions (review finding 1 — the prior migration silently deleted the ONLY copy for evicted/dead-agent/failed sends)", () => {
  const legacy = [{
    id: "s1",
    title: "Old chat",
    updatedAt: 5,
    metadata: { agentId: "agent-1" },
    messages: [
      { role: "model", text: "welcome", timestamp: 1 },
      { role: "user", text: "do the thing", timestamp: 2 },
      { role: "model", text: "on it", timestamp: 3 },
    ],
  }];

  // Every message survives load, agentId or not — data preservation, not migration.
  const [session] = normalizeAssistantSessions(legacy);
  expect(session?.messages).toEqual(legacy[0].messages);

  const preAgent = [{ id: "s2", title: "New chat", updatedAt: 5, messages: legacy[0].messages }];
  expect(normalizeAssistantSessions(preAgent)[0]?.messages).toEqual(legacy[0].messages);
});

test("deriveSuggestionChips adapts to UI/UX chat context", () => {
  const suggestions = deriveSuggestionChips({
    messages: [{ role: "user", text: "I want to talk to the UI/UX designer agent about this flow.", timestamp: 1 }],
    transcriptEntries: [],
  });

  expect(suggestions.map((item) => item.label)).toContain("Surface UX blind spots");
  expect(suggestions.map((item) => item.label)).toContain("Ask the designer agent");
});

test("detectedPlanDirs finds plan files in tool payloads", () => {
  const entries: TranscriptEntry[] = [{
    id: "write-1",
    kind: "tool",
    text: "▸ write",
    ts: 1,
    status: "ok",
    tool: {
      callId: "write-1",
      name: "write",
      argsText: JSON.stringify({ path: "/repo/plans/live-plan/00-overview.md" }),
    },
  }];

  expect(detectedPlanDirs(entries)).toEqual(["plans/live-plan"]);
});

test("data-chat-message is stamped on every TranscriptEntryView kind", () => {
  const kinds: TranscriptEntry[] = [
    { id: "u1", kind: "user", text: "hi", ts: 1, status: "ok" },
    { id: "a1", kind: "assistant", text: "hello", ts: 2, status: "ok" },
    { id: "th1", kind: "thinking", text: "pondering", ts: 3, status: "ok" },
    { id: "to1", kind: "tool", text: "▸ bash: ls", ts: 4, status: "ok", tool: { callId: "to1", name: "bash", argsText: "{}" } },
    { id: "sy1", kind: "system", text: "note", ts: 5, status: "ok" },
  ];

  for (const entry of kinds) {
    const html = renderToStaticMarkup(<TranscriptEntryView entry={entry} />);
    expect(html).toContain("data-chat-message");
  }
});

test("data-chat-message is stamped on the workflow stage-marker branch of the tool kind", () => {
  const entry: TranscriptEntry = { id: "stage1", kind: "tool", text: "▸ stage: implement", ts: 1, status: "ok", format: "stage" };
  const html = renderToStaticMarkup(<TranscriptEntryView entry={entry} />);
  expect(html).toContain("data-chat-message");
  expect(html).toContain("implement");
});

test("data-chat-message is stamped on GateWidget (both the options and free-text branches)", () => {
  const withOptions: PendingRequest = { id: "p1", source: "ui", kind: "gate", title: "Pick one", options: ["yes", "no"], createdAt: 1 };
  const optionsHtml = renderToStaticMarkup(<GateWidget request={withOptions} onAnswer={() => {}} />);
  expect(optionsHtml).toContain("data-chat-message");
  expect(optionsHtml).toContain("Pick one");

  const freeText: PendingRequest = { id: "p2", source: "ui", kind: "gate", title: "Type a reply", createdAt: 1 };
  const freeTextHtml = renderToStaticMarkup(<GateWidget request={freeText} onAnswer={() => {}} />);
  expect(freeTextHtml).toContain("data-chat-message");
  expect(freeTextHtml).toContain("Type a reply");
});

test("data-chat-message is stamped on DiffReviewPanel", () => {
  const html = renderToStaticMarkup(<DiffReviewPanel diffs={[{ file: "a.ts", status: "M" }]} />);
  expect(html).toContain("data-chat-message");
});

test("a gate appearing mid-transcript still carries data-chat-message (detection must catch it while scrolled up)", () => {
  const agent: AgentDTO = {
    id: "a1",
    name: "chat",
    status: "waiting",
    repo: "/home/lars/sui/omp-squad",
    worktree: "/home/lars/.omp/squad/worktrees/omp-squad-chat",
    pending: [{ id: "req-1", source: "tool", kind: "gate", title: "Approve this?", createdAt: 1 }],
    lastActivity: 1,
    autonomyMode: "assist",
    effectiveMode: "assist",
    verificationState: "unknown",
    availableActions: ["answer"],
  };
  const entries: TranscriptEntry[] = [
    { id: "u1", kind: "user", text: "Do the thing", ts: 1, status: "ok" },
    { id: "sys1", kind: "system", text: "Waiting for approval", ts: 2, status: "ok", pending: { action: "created", requestId: "req-1" } },
  ];

  const html = renderToStaticMarkup(
    <TranscriptTimeline entries={entries} messages={[]} agent={agent} expanded onToggle={() => {}} onAnswer={() => {}} />,
  );
  expect(html).toContain("Approve this?");
  // Both the system entry and the gate widget it triggers must be detectable.
  expect((html.match(/data-chat-message/g) ?? []).length).toBeGreaterThanOrEqual(2);
});

test("ScrollToLatestPill renders only when visible and carries an accessible label", () => {
  const hidden = renderToStaticMarkup(<ScrollToLatestPill visible={false} onClick={() => {}} />);
  expect(hidden).toBe("");

  const shown = renderToStaticMarkup(<ScrollToLatestPill visible onClick={() => {}} />);
  expect(shown).toContain("New messages");
  expect(shown).toContain('aria-label="Jump to latest messages"');
});

test("ComposerSendButton shows send when the agent isn't running, and disables it without input", () => {
  const disabled = renderToStaticMarkup(<ComposerSendButton isStopShown={false} stopPending={false} canSend={false} onSend={() => {}} onStop={() => {}} />);
  expect(disabled).toContain('aria-label="Send message"');
  expect(disabled).toContain("disabled");
  expect(disabled).not.toContain("Stop");

  const enabled = renderToStaticMarkup(<ComposerSendButton isStopShown={false} stopPending={false} canSend onSend={() => {}} onStop={() => {}} />);
  expect(enabled).toContain('aria-label="Send message"');
  expect(enabled).not.toContain("disabled");
});

test("ComposerSendButton swaps to a stop affordance while the agent is running, and debounces into a disabled stopping state", () => {
  const running = renderToStaticMarkup(<ComposerSendButton isStopShown stopPending={false} canSend={false} onSend={() => {}} onStop={() => {}} />);
  expect(running).toContain('aria-label="Stop"');
  expect(running).not.toContain('aria-label="Send message"');
  expect(running).not.toContain("disabled");

  const pending = renderToStaticMarkup(<ComposerSendButton isStopShown stopPending canSend={false} onSend={() => {}} onStop={() => {}} />);
  expect(pending).toContain("Stopping");
  expect(pending).toContain("disabled");
});

test("ComposerSendButton's own rendered subtree carries no attach/mic decoration (those live on Composer itself, not the send/stop control)", () => {
  const html = renderToStaticMarkup(<ComposerSendButton isStopShown={false} stopPending={false} canSend={false} onSend={() => {}} onStop={() => {}} />);
  expect(html).not.toContain('aria-label="Attach file"');
  expect(html).not.toContain('aria-label="Voice input"');
});

test("ChatMessagesViewport's scroll container is an announced log region, aria-busy while a real transcript entry is running, while a send is loading, or while a pendingSend is in flight (review finding 2 — these are computed separately from the work-fold's own running)", () => {
  const runningEntries: TranscriptEntry[] = [{ id: "e1", kind: "assistant", text: "working…", ts: 1, status: "running" }];
  const settledEntries: TranscriptEntry[] = [{ id: "e2", kind: "assistant", text: "done", ts: 1, status: "ok" }];

  const running = renderToStaticMarkup(
    <ChatMessagesViewport
      entries={runningEntries}
      transcriptEntries={runningEntries}
      agentDiffs={[]}
      workExpanded={false}
      onToggleWork={() => {}}
      isLoading={false}
    />,
  );
  expect(running).toContain('role="log"');
  expect(running).toContain('aria-live="polite"');
  expect(running).toContain('aria-busy="true"');
  expect(running).toContain('tabindex="0"');

  const settled = renderToStaticMarkup(
    <ChatMessagesViewport
      entries={settledEntries}
      transcriptEntries={settledEntries}
      agentDiffs={[]}
      workExpanded={false}
      onToggleWork={() => {}}
      isLoading={false}
    />,
  );
  expect(settled).toContain('aria-busy="false"');

  // isLoading (the brief agent-creation await) makes the log busy even though the real
  // transcript hasn't produced anything running yet.
  const loading = renderToStaticMarkup(
    <ChatMessagesViewport
      entries={settledEntries}
      transcriptEntries={settledEntries}
      agentDiffs={[]}
      workExpanded={false}
      onToggleWork={() => {}}
      isLoading
    />,
  );
  expect(loading).toContain('aria-busy="true"');

  // A running pendingSend (still in flight, not yet echoed) also makes the log busy — but,
  // critically, it must NOT be part of `transcriptEntries`/`entries` (that would let it
  // corrupt the work-fold's own running calc — see the TranscriptTimeline-level test below).
  const pendingInFlight: TranscriptEntry[] = [{ id: "pending:s1:turn-a", kind: "user", text: "sending…", ts: 2, status: "running", clientTurnId: "turn-a" }];
  const sending = renderToStaticMarkup(
    <ChatMessagesViewport
      entries={settledEntries}
      transcriptEntries={settledEntries}
      trailingEntries={pendingInFlight}
      agentDiffs={[]}
      workExpanded={false}
      onToggleWork={() => {}}
      isLoading={false}
    />,
  );
  expect(sending).toContain('aria-busy="true"');
});

test("each transcript entry is wrapped in an <article> naming its sender", () => {
  const entries: TranscriptEntry[] = [
    { id: "u1", kind: "user", text: "hi", ts: 1, status: "ok" },
    { id: "a1", kind: "assistant", text: "hello", ts: 2, status: "ok" },
  ];
  const html = renderToStaticMarkup(
    <TranscriptTimeline entries={entries} messages={[]} expanded onToggle={() => {}} />,
  );
  expect(html).toContain('<article aria-label="Message from you"');
  expect(html).toContain('<article aria-label="Message from glance"');
});

test("TranscriptTimeline stamps data-kind/data-status on each entry's <article> root (styling/test hook)", () => {
  const entries: TranscriptEntry[] = [
    { id: "u1", kind: "user", text: "hi", ts: 1, status: "ok" },
    { id: "a1", kind: "assistant", text: "still writing", ts: 2, status: "running" },
  ];
  const html = renderToStaticMarkup(
    <TranscriptTimeline entries={entries} messages={[]} expanded onToggle={() => {}} />,
  );
  expect(html).toContain('data-kind="user"');
  expect(html).toContain('data-kind="assistant"');
  expect(html).toContain('data-status="running"');
});

test("TranscriptTimeline stamps data-kind=\"tool\" on a collapsed tool-call group root, with the latest call's status", () => {
  const entries: TranscriptEntry[] = [
    { id: "u1", kind: "user", text: "go", ts: 1, status: "ok" },
    { id: "t1", kind: "tool", text: "▸ bash: one", ts: 2, status: "ok", tool: { callId: "t1", name: "bash" } },
    { id: "t2", kind: "tool", text: "▸ bash: two", ts: 3, status: "running", tool: { callId: "t2", name: "bash" } },
  ];
  const html = renderToStaticMarkup(
    <TranscriptTimeline entries={entries} messages={[]} expanded onToggle={() => {}} />,
  );
  expect(html).toContain('data-kind="tool"');
  expect(html).toContain('data-status="running"');
});

test("Composer renders a real, enabled mic button when the browser supports speech recognition (the mic revival — chained STT input, not the old no-op)", () => {
  // This suite is renderToStaticMarkup-only (no jsdom) — this test asserts presence + enabled
  // state on the rendered markup; the actual listening/transcription/error-handling behavior is
  // covered by the unit tests in lib/voice/speech.test.ts.
  Object.defineProperty(globalThis, "window", { configurable: true, value: { SpeechRecognition: class {} } });
  const html = renderToStaticMarkup(<Composer {...composerBaseProps} />);
  const micButton = html.match(/<button[^>]*aria-label="Voice input"[^>]*>/);
  expect(micButton).not.toBeNull();
  // Checks the rendered `disabled=""` boolean attribute, not the `disabled:opacity-40` Tailwind
  // variant that's always present in the className regardless of state.
  expect(micButton![0]).not.toMatch(/\sdisabled="/);
});

test("Composer's mic button is disabled with an honest tooltip when the browser has no speech recognition support", () => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  const html = renderToStaticMarkup(<Composer {...composerBaseProps} />);
  const micButton = html.match(/<button[^>]*aria-label="Voice input"[^>]*>/);
  expect(micButton).not.toBeNull();
  expect(micButton![0]).toMatch(/\sdisabled="/);
  expect(html).toContain("Voice input isn");
  expect(html).toContain("supported in this browser");
});

test("Composer seeds input/chips/history from the persisted per-thread draft, and a different thread's mount does NOT see it (daily-composer 01)", () => {
  // renderToStaticMarkup runs the useState initializers (the loadDraft seed) but no effects, so
  // this covers the restore-on-mount path; the in-place thread-switch effect and the
  // beforeunload/visibilitychange flushes are covered live (concern 01 ## Verify).
  const store = new Map<string, string>();
  store.set(COMPOSER_DRAFTS_KEY, JSON.stringify([
    {
      version: 1,
      sessionId: "thread-a",
      input: "half a typed sentence",
      promptHistory: ["sent earlier"],
      chips: [{ id: "c1", label: "Pasted text · 0.1 KB", content: "a big paste" }],
      images: [],
      updatedAt: Date.now(),
    },
  ]));
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } } },
  });
  const htmlA = renderToStaticMarkup(<Composer {...composerBaseProps} sessionId="thread-a" />);
  expect(htmlA).toContain("half a typed sentence");
  expect(htmlA).toContain("Pasted text");
  const htmlB = renderToStaticMarkup(<Composer {...composerBaseProps} sessionId="thread-b" />);
  expect(htmlB).not.toContain("half a typed sentence");
  expect(htmlB).not.toContain("Pasted text");
});

test("Composer with no sessionId (defensive mounts) renders empty and never touches the draft store", () => {
  let reads = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: { getItem: () => { reads += 1; return null; }, setItem: () => {} } },
  });
  const html = renderToStaticMarkup(<Composer {...composerBaseProps} />);
  expect(html).toContain("<textarea");
  expect(reads).toBe(0);
});

test("a running assistant entry with an unclosed table header holds it back until the separator arrives", () => {
  const entry: TranscriptEntry = {
    id: "a1",
    kind: "assistant",
    text: "First paragraph settled.\n\n| a | b |",
    ts: 1,
    status: "running",
  };

  const html = renderToStaticMarkup(<TranscriptEntryView entry={entry} />);
  expect(html).toContain("First paragraph settled");
  // Lone table header without its separator row is held back — no raw `|` table markup leaks.
  expect(html).not.toContain("<table>");
  expect(html).not.toContain("| a | b |");
});

test("a running assistant entry with a trailing unclosed emphasis marker auto-closes rather than leaking raw asterisks", () => {
  const entry: TranscriptEntry = {
    id: "a1b",
    kind: "assistant",
    text: "First paragraph settled.\n\nThis is **unclosed",
    ts: 1,
    status: "running",
  };

  const html = renderToStaticMarkup(<TranscriptEntryView entry={entry} />);
  expect(html).toContain("First paragraph settled");
  // The trailing unclosed ** is auto-closed rather than rendered as literal asterisks.
  expect(html).not.toContain("**unclosed");
  expect(html).toContain("<strong>unclosed</strong>");
});

test("a completed assistant entry renders full raw text in one pass, untrimmed", () => {
  const entry: TranscriptEntry = {
    id: "a2",
    kind: "assistant",
    text: "Done. Trailing unclosed **bold stays as authored.",
    ts: 1,
    status: "ok",
  };

  const html = renderToStaticMarkup(<TranscriptEntryView entry={entry} />);
  // Completed entries are never trimmed — remark renders the malformed markdown as-is.
  expect(html).toContain("Trailing unclosed");
});

test("the settled markdown prefix is memoized: identical settled text renders identical markup across renders with a growing tail", () => {
  const base = "Settled paragraph one.\n\nSettled paragraph two.\n\n";
  const entryA: TranscriptEntry = { id: "a3", kind: "assistant", text: base + "gro", ts: 1, status: "running" };
  const entryB: TranscriptEntry = { id: "a3", kind: "assistant", text: base + "growing tail", ts: 1, status: "running" };

  const htmlA = renderToStaticMarkup(<TranscriptEntryView entry={entryA} />);
  const htmlB = renderToStaticMarkup(<TranscriptEntryView entry={entryB} />);

  // Both renders share the identical settled-prefix markup; only the tail differs.
  expect(htmlA).toContain("Settled paragraph one");
  expect(htmlA).toContain("Settled paragraph two");
  expect(htmlB).toContain("Settled paragraph one");
  expect(htmlB).toContain("Settled paragraph two");
  expect(htmlB).toContain("growing tail");
});

// ── Single message model (replay-as-truth) ──────────────────────────────────

test("messageToTranscriptEntry maps role to kind, stamps markdown/ok, and derives a stable id", () => {
  const userMessage: Message = { role: "user", text: "hello", timestamp: 100 };
  const modelMessage: Message = { role: "model", text: "hi there", timestamp: 200 };

  const userEntry = messageToTranscriptEntry(userMessage);
  expect(userEntry).toMatchObject({ kind: "user", text: "hello", ts: 100, format: "markdown", status: "ok" });
  expect(userEntry.id).toBeTruthy();

  const modelEntry = messageToTranscriptEntry(modelMessage);
  expect(modelEntry.kind).toBe("assistant");

  // Same input maps to the same synthetic id (stable across re-renders).
  expect(messageToTranscriptEntry(userMessage).id).toBe(userEntry.id);
});

test("buildTranscriptRenderEntries: prologue (mapped welcome) leads `entries`, the real transcript follows, and an uncovered fresh send lands in `trailingEntries` alongside its pendingSend (review finding 1+2)", () => {
  const messages: Message[] = [{ role: "model", text: "welcome", timestamp: 1 }];
  const transcriptEntries: TranscriptEntry[] = [{ id: "t1", kind: "user", text: "first turn", ts: 2, status: "ok" }];
  const pendingSends: TranscriptEntry[] = [{ id: "pending:s1:turn-x", kind: "user", text: "in flight", ts: 3, status: "running", clientTurnId: "turn-x" }];

  const { entries, trailingEntries } = buildTranscriptRenderEntries(messages, transcriptEntries, pendingSends);
  expect(entries.map((entry) => entry.text)).toEqual(["welcome", "first turn"]);
  // pendingSend is last (append-at-end) — never prepended, which would render new sends at the top.
  expect(trailingEntries.map((entry) => entry.text)).toEqual(["in flight"]);
});

// ── Coverage dedupe (review finding 1): a durably double-written user Message must not
// double-render against the transcript entry or pendingSend that already shows it live. ──────

test("partitionSessionMessages: a durable user Message covered by clientTurnId match against a real transcript entry is suppressed entirely", () => {
  const messages: Message[] = [{ role: "user", text: "do the thing", timestamp: 5, clientTurnId: "turn-a" }];
  const transcriptEntries: TranscriptEntry[] = [{ id: "t1", kind: "user", text: "do the thing (with context)", displayText: "do the thing", ts: 6, status: "ok", clientTurnId: "turn-a" }];

  const { entries, trailingEntries } = buildTranscriptRenderEntries(messages, transcriptEntries, []);
  expect(entries.map((e) => e.text)).toEqual(["do the thing (with context)"]);
  expect(trailingEntries).toEqual([]);
});

test("partitionSessionMessages: a legacy Message with no clientTurnId falls back to an exact text match against displayText, consumed at most once", () => {
  const messages: Message[] = [
    { role: "user", text: "hello", timestamp: 1 },
    { role: "user", text: "hello", timestamp: 10 }, // duplicate text, sent AFTER the transcript's only entry
  ];
  const transcriptEntries: TranscriptEntry[] = [
    { id: "t1", kind: "user", text: "hello (with context)", displayText: "hello", ts: 3, status: "ok" },
  ];

  const { entries, trailingEntries } = buildTranscriptRenderEntries(messages, transcriptEntries, []);
  // First "hello" is covered (suppressed). Second has nothing left to match, so it's uncovered
  // and — being newer than the transcript's only entry — renders trailing.
  expect(entries.map((e) => e.text)).toEqual(["hello (with context)"]);
  expect(trailingEntries.map((e) => e.text)).toEqual(["hello"]);
});

test("partitionSessionMessages: an uncovered message older than the transcript's first entry renders as prologue (top, chronological) — the orphaned-send-from-a-dead-agent scenario", () => {
  // A session's agent got evicted/died; a new agent was created later for the same session.
  // The old turn's clientTurnId will never appear in the NEW agent's transcript.
  const messages: Message[] = [{ role: "user", text: "orphaned turn", timestamp: 1, clientTurnId: "turn-old" }];
  const transcriptEntries: TranscriptEntry[] = [{ id: "t1", kind: "user", text: "new agent's first turn", ts: 100, status: "ok", clientTurnId: "turn-new" }];

  const { entries, trailingEntries } = buildTranscriptRenderEntries(messages, transcriptEntries, []);
  expect(entries.map((e) => e.text)).toEqual(["orphaned turn", "new agent's first turn"]);
  expect(trailingEntries).toEqual([]);
});

test("partitionSessionMessages: an uncovered message newer than the transcript's last entry renders trailing, after the transcript", () => {
  const messages: Message[] = [{ role: "model", text: "Error: could not reach glance chat", timestamp: 200 }];
  const transcriptEntries: TranscriptEntry[] = [{ id: "t1", kind: "assistant", text: "the answer", ts: 100, status: "ok" }];

  const { entries, trailingEntries } = buildTranscriptRenderEntries(messages, transcriptEntries, []);
  expect(entries.map((e) => e.text)).toEqual(["the answer"]);
  expect(trailingEntries.map((e) => e.text)).toEqual(["Error: could not reach glance chat"]);
});

test("partitionSessionMessages: a live pendingSend suppresses its matching durable Message so a just-typed send doesn't render twice while in flight", () => {
  const messages: Message[] = [{ role: "user", text: "sending now", timestamp: 500, clientTurnId: "turn-live" }];
  const transcriptEntries: TranscriptEntry[] = []; // agent just created, nothing echoed yet
  const pendingSends: TranscriptEntry[] = [{ id: "pending:s1:turn-live", kind: "user", text: "sending now", ts: 500, status: "running", clientTurnId: "turn-live" }];

  const { entries, trailingEntries } = buildTranscriptRenderEntries(messages, transcriptEntries, pendingSends);
  expect(entries).toEqual([]);
  // Only the pendingSend renders — not a duplicate copy of the durable Message.
  expect(trailingEntries).toHaveLength(1);
  expect(trailingEntries[0]?.id).toBe("pending:s1:turn-live");
});

test("buildTranscriptRenderEntries falls back to the current agent's startedAt as the prologue/trailing threshold when the transcript hasn't produced anything yet", () => {
  const messages: Message[] = [
    { role: "model", text: "welcome", timestamp: 1 }, // predates the agent — prologue
  ];
  const { prologue, trailing } = partitionSessionMessages(messages, [], [], /* windowHeadTs */ 1000);
  expect(prologue.map((e) => e.text)).toEqual(["welcome"]);
  expect(trailing).toEqual([]);

  const { entries, trailingEntries } = buildTranscriptRenderEntries(messages, [], [], /* agentStartedAt */ 1000);
  expect(entries.map((e) => e.text)).toEqual(["welcome"]);
  expect(trailingEntries).toEqual([]);
});

test("partitionSessionMessages: an undelivered Message survives reload and renders trailing with status:'error', once its pendingSend is gone", () => {
  // Simulates a page reload after a send timed out: `pendingSends` resets to empty (it's
  // render state only), but the durable Message persisted with `undelivered: true`.
  const messages: Message[] = [{ role: "user", text: "never landed", timestamp: 50, clientTurnId: "turn-dead", undelivered: true }];
  const transcriptEntries: TranscriptEntry[] = [];

  const { entries, trailingEntries } = buildTranscriptRenderEntries(messages, transcriptEntries, []);
  expect(entries).toEqual([]);
  expect(trailingEntries).toHaveLength(1);
  expect(trailingEntries[0]).toMatchObject({ text: "never landed", status: "error", clientTurnId: "turn-dead" });
});

test("clearEchoedPendingSends drops a pending send once its clientTurnId echoes back as a user-kind transcript entry", () => {
  const pendingSends: TranscriptEntry[] = [
    { id: "pending:s1:turn-a", kind: "user", text: "sent", ts: 1, status: "running", clientTurnId: "turn-a" },
    { id: "pending:s1:turn-b", kind: "user", text: "still in flight", ts: 2, status: "running", clientTurnId: "turn-b" },
  ];
  const transcriptEntries: TranscriptEntry[] = [
    { id: "t1", kind: "user", text: "sent", ts: 3, status: "ok", clientTurnId: "turn-a" },
  ];

  const next = clearEchoedPendingSends(pendingSends, transcriptEntries);
  expect(next.map((entry) => entry.clientTurnId)).toEqual(["turn-b"]);
});

test("clearEchoedPendingSends does NOT clear a pending send when a gate answer echoes (answerCommand reuses clientTurnId for requestId, not the send's turn id)", () => {
  const pendingSends: TranscriptEntry[] = [
    { id: "pending:s1:turn-a", kind: "user", text: "do the thing", ts: 1, status: "running", clientTurnId: "turn-a" },
  ];
  // A gate answer travels as `{ type: 'prompt', clientTurnId: requestId }` (see answerCommand),
  // so its echoed transcript entry is also kind:'user' with a clientTurnId — but a different one.
  const transcriptEntries: TranscriptEntry[] = [
    { id: "t1", kind: "user", text: "yes", ts: 2, status: "ok", clientTurnId: "req-1" },
  ];

  const next = clearEchoedPendingSends(pendingSends, transcriptEntries);
  expect(next).toHaveLength(1);
  expect(next[0]?.clientTurnId).toBe("turn-a");
});

// ── MAJOR-2: voice-authored spoken summaries must not double-render or render as the wrong speaker ──

test("partitionSessionMessages: a voice prompt persisted as role:'user' with the dispatch's clientTurnId is covered by the matching transcript echo — renders once, as the USER, not a model bubble (MAJOR-2a)", () => {
  const messages: Message[] = [{ role: "user", text: "check the fleet status", timestamp: 5, clientTurnId: "voice:1" }];
  const transcriptEntries: TranscriptEntry[] = [
    { id: "t1", kind: "user", text: "check the fleet status", ts: 6, status: "ok", clientTurnId: "voice:1" },
  ];

  const { entries, trailingEntries } = buildTranscriptRenderEntries(messages, transcriptEntries, []);
  expect(entries).toHaveLength(1);
  expect(entries[0]!.kind).toBe("user"); // not "assistant" — the wrong-speaker bug this fixes
  expect(trailingEntries).toEqual([]);
});

test("partitionSessionMessages: a persisted voice completion summary (role:'model') that exactly matches a FINISHED assistant transcript entry is suppressed — no double-render (MAJOR-2b)", () => {
  const messages: Message[] = [{ role: "model", text: "Fixed the flaky test and pushed.", timestamp: 10 }];
  const transcriptEntries: TranscriptEntry[] = [
    { id: "t1", kind: "assistant", text: "Fixed the flaky test and pushed.", ts: 5, status: "ok" },
  ];

  const { entries, trailingEntries } = buildTranscriptRenderEntries(messages, transcriptEntries, []);
  expect(entries.map((e) => e.text)).toEqual(["Fixed the flaky test and pushed."]);
  expect(trailingEntries).toEqual([]); // NOT rendered a second time as a trailing durable Message
});

test("partitionSessionMessages: a role:'model' message is NOT covered by a still-running assistant entry, even with identical text (MAJOR-2b: only a FINISHED entry counts as an echo)", () => {
  const messages: Message[] = [{ role: "model", text: "still thinking", timestamp: 10 }];
  const transcriptEntries: TranscriptEntry[] = [
    { id: "t1", kind: "assistant", text: "still thinking", ts: 5, status: "running" },
  ];

  const { trailingEntries } = buildTranscriptRenderEntries(messages, transcriptEntries, []);
  // Uncovered (the running entry doesn't count) and newer than the transcript's only entry ->
  // trailing, same as any other uncovered model message.
  expect(trailingEntries.map((e) => e.text)).toEqual(["still thinking"]);
});

test("partitionSessionMessages: two role:'model' messages with the same text each consume their OWN finished assistant entry (consumed-once, not double-matched against a single entry)", () => {
  const messages: Message[] = [
    { role: "model", text: "done", timestamp: 10 },
    { role: "model", text: "done", timestamp: 20 },
  ];
  const transcriptEntries: TranscriptEntry[] = [{ id: "t1", kind: "assistant", text: "done", ts: 5, status: "ok" }];

  const { entries, trailingEntries } = buildTranscriptRenderEntries(messages, transcriptEntries, []);
  // Only ONE "done" transcript entry exists — it covers the first message; the second is
  // genuinely uncovered and renders trailing (not silently dropped).
  expect(entries.map((e) => e.text)).toEqual(["done"]);
  expect(trailingEntries.map((e) => e.text)).toEqual(["done"]);
});

test("clearEchoedPendingSends ignores non-user-kind entries even if they somehow share a clientTurnId", () => {
  const pendingSends: TranscriptEntry[] = [
    { id: "pending:s1:turn-a", kind: "user", text: "sent", ts: 1, status: "running", clientTurnId: "turn-a" },
  ];
  const transcriptEntries: TranscriptEntry[] = [
    { id: "t1", kind: "assistant", text: "not an echo", ts: 2, status: "ok", clientTurnId: "turn-a" },
  ];

  const next = clearEchoedPendingSends(pendingSends, transcriptEntries);
  expect(next).toHaveLength(1);
});

test("AgentLandControls labels the Land button plainly when prState is absent (local mode)", () => {
  const agent: AgentDTO = {
    id: "a1",
    name: "chat",
    status: "working",
    repo: "/home/lars/sui/omp-squad",
    worktree: "/home/lars/.omp/squad/worktrees/omp-squad-chat",
    branch: "squad/chat",
    pending: [],
    lastActivity: 1,
    autonomyMode: "assist",
    effectiveMode: "assist",
    verificationState: "fresh",
    availableActions: ["land"],
    landReady: true,
  };

  const html = renderToStaticMarkup(<AgentLandControls agent={agent} showToast={() => {}} />);
  expect(html).toContain("Land ✓");
  expect(html).not.toContain("Merge PR");
});

test("AgentLandControls labels the Land button 'Merged ✓' once the PR-mode land has merged", () => {
  const agent: AgentDTO = {
    id: "a1",
    name: "chat",
    status: "working",
    repo: "/home/lars/sui/omp-squad",
    worktree: "/home/lars/.omp/squad/worktrees/omp-squad-chat",
    branch: "squad/chat",
    pending: [],
    lastActivity: 1,
    autonomyMode: "assist",
    effectiveMode: "assist",
    verificationState: "fresh",
    availableActions: ["land"],
    landReady: true,
    prUrl: "https://github.com/acme/repo/pull/42",
    prNumber: 42,
    prState: "merged",
  };

  const html = renderToStaticMarkup(<AgentLandControls agent={agent} showToast={() => {}} />);
  expect(html).toContain("Merged ✓");
});

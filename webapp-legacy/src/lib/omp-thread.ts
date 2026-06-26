import type {
  MessageStatus,
  ThreadAssistantMessagePart,
  ThreadMessageLike,
  ThreadUserMessagePart,
} from "@assistant-ui/react";
import type { TranscriptEntry } from "@/lib/dto";

type OmpContent = readonly (ThreadUserMessagePart | ThreadAssistantMessagePart)[];

export type PendingUserMessage = {
  id: string;
  text: string;
  ts: number;
  clientTurnId: string;
};

export type OmpChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: OmpContent;
  ts: number;
  pending?: boolean;
  status?: MessageStatus;
};

const completeStatus: MessageStatus = { type: "complete", reason: "stop" };

function textPart(text: string): ThreadUserMessagePart {
  return { type: "text", text };
}

export function toolNameFrom(text: string): string {
  const activity = text.replace(/^▸\s*/, "").trim();
  return activity.split(/[\s(:]/)[0]?.replace(/[^\w.-]/g, "") || "omp_tool";
}

function assistantPart(entry: TranscriptEntry, id: string): ThreadAssistantMessagePart {
  if (entry.kind === "thinking") return { type: "reasoning", text: entry.text };
  if (entry.kind === "tool" || entry.tool) {
    const tool = entry.tool;
    const args = tool?.args ?? { activity: entry.text.replace(/^▸\s*/, "").trim() };
    const result = tool?.result ?? tool?.partial ?? tool?.resultText ?? tool?.partialText;
    return {
      type: "tool-call",
      toolCallId: tool?.callId ?? `${id}:tool`,
      toolName: tool?.name ?? toolNameFrom(entry.text),
      args: (args && typeof args === "object" ? args : { value: args }) as never,
      argsText: tool?.argsText ?? JSON.stringify(args, null, 2),
      result,
      isError: tool?.isError,
    };
  }
  return { type: "text", text: entry.text };
}

export function toThreadMessage(message: OmpChatMessage): ThreadMessageLike {
  const base = {
    id: message.id,
    role: message.role,
    createdAt: new Date(message.ts),
    content: message.content,
    metadata: message.pending ? { isOptimistic: true } : undefined,
  };
  if (message.role === "assistant") return { ...base, role: "assistant", status: message.status ?? completeStatus } as ThreadMessageLike;
  return base as ThreadMessageLike;
}

export function buildOmpMessages(activeId: string | null, transcript: TranscriptEntry[], pending: PendingUserMessage[], isRunning: boolean): OmpChatMessage[] {
  const messages: OmpChatMessage[] = [];
  let assistantParts: ThreadAssistantMessagePart[] = [];
  let assistantTs = 0;
  let assistantIndex = 0;
  const transcriptStatusByCall = new Map<string, TranscriptEntry["status"]>();

  const flushAssistant = () => {
    if (assistantParts.length === 0) return;
    const running = assistantParts.some((part) => part.type === "tool-call" && transcriptStatusByCall.get(part.toolCallId) === "running");
    const errored = assistantParts.some((part) => part.type === "tool-call" && transcriptStatusByCall.get(part.toolCallId) === "error");
    messages.push({
      id: `${activeId ?? "new"}:assistant:${assistantIndex++}:${assistantTs}`,
      role: "assistant",
      content: assistantParts,
      ts: assistantTs,
      status: running ? { type: "running" } : errored ? { type: "incomplete", reason: "error" } : completeStatus,
    });
    assistantParts = [];
  };

  transcript.forEach((entry, index) => {
    const id = `${activeId ?? "new"}:${entry.ts}:${index}`;
    if (entry.kind === "user") {
      flushAssistant();
      messages.push({ id, role: "user", content: [textPart(entry.text)], ts: entry.ts });
      return;
    }
    if (entry.kind === "system") {
      flushAssistant();
      messages.push({ id, role: "system", content: [textPart(entry.text)], ts: entry.ts });
      return;
    }
    if (assistantParts.length === 0) assistantTs = entry.ts;
    const part = assistantPart(entry, id);
    if (part.type === "tool-call") transcriptStatusByCall.set(part.toolCallId, entry.status);
    assistantParts.push(part);
  });
  flushAssistant();

  for (const item of pending) {
    if (transcript.some((entry) => entry.kind === "user" && entry.clientTurnId === item.clientTurnId)) continue;
    messages.push({ id: item.id, role: "user", content: [textPart(item.text)], ts: item.ts, pending: true });
  }
  if (isRunning) {
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    if (lastAssistant) lastAssistant.status = { type: "running" };
  }
  return messages.sort((a, b) => a.ts - b.ts);
}

export function messagePlainText(message: OmpChatMessage): string {
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("").trim();
}

/**
 * transcriptModel — the single message model: replay-as-truth plus client durability.
 *
 * These functions were the pure core of `AssistantChat.tsx`, a 1,065-line assistant dock that this
 * application stopped mounting when the room replaced it. The COMPONENT is gone; this logic is not,
 * because it is the tested specification for a dedupe that three other places depend on being right —
 * `useVoiceDispatcher`, `sessionStore`, and the room's own composer all reference it by name.
 *
 * The history matters and is kept here with it. A prior revision destructively dropped every
 * `role:'user'` message from agent-backed sessions on the theory that the replayed server transcript
 * was always a complete duplicate. It was not: the transcript ring is capped at 800 entries and an
 * agent record can be evicted, so for those sessions the localStorage copy was the ONLY copy, and the
 * migration was silent permanent data loss. There is no load-time migration any more — both copies are
 * kept and render-time coverage dedupe suppresses whichever is redundant.
 */

import type { AgentDTO, TranscriptEntry } from '../dto';
import type { Message } from './sessionStore';
import type { SuggestionChip } from '../../components/chat/Composer';
import type { Task } from '../../types';

const CHAT_MIN_WIDTH = 320;
const CHAT_MAX_WIDTH = 680;
const clampNumber = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const chatWidthFromClientX = (panelRight: number, clientX: number) => clampNumber(panelRight - clientX, CHAT_MIN_WIDTH, CHAT_MAX_WIDTH);

const uniqueSuggestions = (items: SuggestionChip[]) => {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.label.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 4);
};

export function deriveSuggestionChips(input: { messages: Message[]; transcriptEntries: TranscriptEntry[]; selectedTask?: Task; selectedAgent?: AgentDTO; changedFiles?: number | null }): SuggestionChip[] {
  const text = [
    input.selectedTask?.title,
    input.selectedTask?.description,
    input.selectedTask?.category,
    ...input.messages.map((message) => message.text),
    ...input.transcriptEntries.slice(-12).map((entry) => entry.text),
  ].filter(Boolean).join("\n").toLowerCase();
  const out: SuggestionChip[] = [];

  if (/ui|ux|design|designer|interface|visual|layout|frontend|polish|interaction/.test(text)) {
    out.push(
      { label: "Surface UX blind spots", prompt: "Given this UI/UX direction, what user-facing problems am I probably not asking about yet?" },
      { label: "Check states & flows", prompt: "Review the target UI for missing loading, empty, error, disabled, and success states." },
      { label: "Ask the designer agent", prompt: "Bring in the UI/UX designer perspective and propose the next concrete design pass." },
    );
  }
  if (input.selectedAgent?.status === 'input' || /blocked|stuck|waiting|error|failed|crash/.test(text)) {
    out.push(
      { label: "Unblock the run", prompt: "What exactly is blocked, what decision is needed, and what is the safest default?" },
      { label: "Find root cause", prompt: "Trace the failure to the source and suggest the smallest fix with verification." },
    );
  }
  if ((input.changedFiles ?? 0) > 0 || /git|branch|diff|commit|land|merge/.test(text)) {
    out.push({ label: "Review the diff risk", prompt: "Review the current git changes for risky files, missing tests, and landing blockers." });
  }
  if (input.selectedAgent?.contextPct != null && input.selectedAgent.contextPct > 0.7) {
    out.push({ label: "Condense context", prompt: "Summarize the current thread into the durable facts and next actions before context gets tight." });
  }
  if (input.selectedTask) {
    out.push({ label: "Sharpen acceptance", prompt: `For ${input.selectedTask.title}, what acceptance criteria or edge cases are missing?` });
  }

  return uniqueSuggestions([
    ...out,
    { label: "What's being worked on?", prompt: "What's being worked on right now across the fleet, and what needs me?" },
    { label: "Summarize progress", prompt: "Summarize progress" },
    { label: "Prioritize my work", prompt: "Prioritize my work" },
    { label: "List blockers", prompt: "List blocked tasks" },
  ]);
}

export const detectedPlanDirs = (entries: TranscriptEntry[]): string[] => {
  const dirs = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== 'tool') continue;
    const haystack = [entry.tool?.argsText, entry.tool?.resultText, entry.text].filter(Boolean).join('\n');
    for (const match of haystack.matchAll(/(?:^|[\\/"'\s])((?:plans)\/[^\/"'\s]+)\//g)) dirs.add(match[1]);
  }
  return [...dirs];
};

// ── Single message model (replay-as-truth + client durability) ─────────────────────────
// Read-time mapper: turns a durable `Message` (pre-agent welcome/chit-chat, a durably
// double-written user turn, or an undelivered-send error notice) into a `TranscriptEntry`
// with a stable synthetic id, so it can render through the one TranscriptTimeline path
// alongside the replayed server transcript. `undelivered` maps to `status:'error'` so it
// picks up the same error styling as a `pendingSend` that timed out.
export const messageToTranscriptEntry = (message: Message): TranscriptEntry => ({
  id: `msg:${message.role}:${message.timestamp}`,
  kind: message.role === 'user' ? 'user' : 'assistant',
  text: message.text,
  ts: message.timestamp,
  format: 'markdown',
  status: message.undelivered ? 'error' : 'ok',
  clientTurnId: message.clientTurnId,
});

/**
 * Coverage dedupe (review finding 1): `handleSend` durably writes every user turn into
 * `session.messages` (fix for the destructive-migration data loss above) in addition to the
 * ephemeral `pendingSend` it also creates. Both, plus the replayed transcript, can carry the
 * *same* turn — this decides, per message, whether it's already visible elsewhere (and should
 * be suppressed) or needs to render on its own, and if so, where:
 *
 *  - Covered by the real transcript (`clientTurnId` match, else exact `displayText ?? text`
 *    match, each transcript entry consumed at most once) → suppressed; it already renders
 *    from `transcriptEntries` itself.
 *  - Covered by a live `pendingSend` (same `clientTurnId`, still `status:'running'`) →
 *    suppressed; the pendingSend already shows it with a live status.
 *  - A `role:'model'` message covered by a FINISHED (`status !== 'running'`) assistant transcript
 *    entry with the exact same `text`, each transcript entry consumed at most once (MAJOR-2b) →
 *    suppressed. This is how the voice dispatcher's completion-narration summary
 *    (`useVoiceDispatcher`'s `onSpokenSummary` `role:'model'` event, persisted via
 *    `appendSpokenSummary`) avoids double-rendering once the same text also shows up as the
 *    agent's own replayed `message_end` transcript entry — a `status:'running'` entry never
 *    counts as covering one (the durable copy might be the ONLY thing to render if the live
 *    entry never actually finishes, e.g. an agent that dies mid-turn).
 *  - Otherwise uncovered → positioned by `timestamp` against `windowHeadTs` (the transcript's
 *    first entry, or the current agent's `startedAt` when the transcript hasn't produced
 *    anything yet, or +Infinity when neither exists): older → `prologue` (renders at the top,
 *    chronological — this is how an orphaned send from a dead/evicted agent surfaces, since a
 *    replacement agent's transcript starts *after* it); everything else → `trailing` (renders
 *    after the transcript, newest last — a send still in flight, or one that failed and is
 *    only known via its `undelivered` Message now that the reload wiped `pendingSends`).
 */
export function partitionSessionMessages(
  messages: Message[],
  transcriptEntries: TranscriptEntry[],
  pendingSends: TranscriptEntry[],
  windowHeadTs: number,
): { prologue: TranscriptEntry[]; trailing: TranscriptEntry[] } {
  const transcriptUserEntries = transcriptEntries.filter((entry) => entry.kind === 'user');
  // MAJOR-2b: a finished assistant entry only — a still-`running` one is not yet a real echo of
  // anything (see the function doc comment above), so it must never suppress the durable copy.
  const finishedAssistantEntries = transcriptEntries.filter((entry) => entry.kind === 'assistant' && entry.status !== 'running');
  const consumedTranscriptEntries = new Set<TranscriptEntry>();
  const liveTurnIds = new Set(
    pendingSends.filter((entry) => entry.status !== 'error' && entry.clientTurnId).map((entry) => entry.clientTurnId as string),
  );

  const prologue: TranscriptEntry[] = [];
  const trailing: TranscriptEntry[] = [];

  for (const message of messages) {
    if (message.role === 'user') {
      if (message.clientTurnId) {
        const echoed = transcriptUserEntries.find(
          (entry) => entry.clientTurnId === message.clientTurnId && !consumedTranscriptEntries.has(entry),
        );
        if (echoed) {
          consumedTranscriptEntries.add(echoed);
          continue; // covered by the real transcript
        }
        if (liveTurnIds.has(message.clientTurnId)) continue; // covered by a live pendingSend
      } else {
        // Legacy message with no clientTurnId (pre-fix localStorage blob): fall back to an
        // exact text match against the operator's typed text, consumed oldest-first.
        const matched = transcriptUserEntries.find(
          (entry) => !consumedTranscriptEntries.has(entry) && (entry.displayText ?? entry.text) === message.text,
        );
        if (matched) {
          consumedTranscriptEntries.add(matched);
          continue;
        }
      }
    } else if (message.role === 'model') {
      // MAJOR-2b: a voice completion summary that exactly matches an already-finished assistant
      // transcript entry is covered by it — suppressed so it doesn't double-render (once from the
      // live/replayed transcript, once from this durable copy).
      const echoed = finishedAssistantEntries.find(
        (entry) => !consumedTranscriptEntries.has(entry) && entry.text === message.text,
      );
      if (echoed) {
        consumedTranscriptEntries.add(echoed);
        continue;
      }
    }
    const entry = messageToTranscriptEntry(message);
    (message.timestamp < windowHeadTs ? prologue : trailing).push(entry);
  }

  return { prologue, trailing };
}

/**
 * Render composition: `entries` is the ordinary TranscriptTimeline content (prologue-mapped
 * messages, then the replayed transcript) — TranscriptTimeline's collapsible-work fold and
 * "is anything running" calculations key off this and only this. `trailingEntries` (uncovered
 * fresh/failed sends, then any still-in-flight `pendingSends`) is a separate always-visible
 * section rendered after the fold/final-answer — it must never be folded, and must never make
 * the fold logic think a run is still in progress (review finding 2).
 */
export function buildTranscriptRenderEntries(
  messages: Message[],
  transcriptEntries: TranscriptEntry[],
  pendingSends: TranscriptEntry[],
  agentStartedAt?: number,
): { entries: TranscriptEntry[]; trailingEntries: TranscriptEntry[] } {
  // Fallback order when there's no transcript to anchor against: the current agent's
  // `startedAt` (an agent exists, just hasn't echoed anything yet — e.g. a send still in
  // flight), else -Infinity (no agent at all for this attempt, e.g. `/api/console` itself
  // failed) so an uncovered message defaults to trailing (a fresh/failed send) rather than
  // prologue (stale content) — the only genuinely ambiguous case, a session with nothing but
  // its pre-agent welcome text, is unaffected either way since there is nothing else to order
  // it against.
  const windowHeadTs = transcriptEntries[0]?.ts ?? agentStartedAt ?? Number.NEGATIVE_INFINITY;
  const { prologue, trailing } = partitionSessionMessages(messages, transcriptEntries, pendingSends, windowHeadTs);
  return {
    entries: [...prologue, ...transcriptEntries],
    trailingEntries: [...trailing, ...pendingSends],
  };
}

/** Drops any pending (optimistic) send whose `clientTurnId` has now arrived as a
 *  `kind==='user'` entry in the real transcript. Restricted to user-kind on purpose:
 *  gate answers also travel as `{ type: 'prompt', clientTurnId: requestId }` (see
 *  `answerCommand`), so their echoed transcript entry also carries a `clientTurnId` —
 *  but it will never equal a prompt-originated pending send's turn id, and matching
 *  only against user-kind entries keeps that distinction explicit rather than incidental. */
export const clearEchoedPendingSends = (pendingSends: TranscriptEntry[], transcriptEntries: TranscriptEntry[]): TranscriptEntry[] => {
  if (!pendingSends.length) return pendingSends;
  const echoedTurnIds = new Set(
    transcriptEntries.filter((entry) => entry.kind === 'user' && entry.clientTurnId).map((entry) => entry.clientTurnId as string),
  );
  if (!echoedTurnIds.size) return pendingSends;
  const next = pendingSends.filter((entry) => !(entry.clientTurnId && echoedTurnIds.has(entry.clientTurnId)));
  return next.length === pendingSends.length ? pendingSends : next;
};

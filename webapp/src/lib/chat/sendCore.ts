/**
 * Shared send/mint core (webapp-voice-lane concern 04).
 *
 * Extracted out of `AssistantChat.handleSend` so the typed composer path and the future voice
 * tool dispatcher (concern 07) share exactly one console-agent-mint and one prompt-command
 * shape — killing two race/drift classes pre-emptively:
 *
 *  - The two-minters race: a voice tool call and a typed send both discovering "no live agent
 *    for this session" at the same time and each POSTing `/api/console`, leaving one orphaned.
 *    `ensureConsoleAgent` single-flights the mint per session so concurrent callers await the
 *    same in-flight POST instead of issuing a second one.
 *  - Prompt-shape drift: a spoken prompt silently losing the fleet/task/page context injection
 *    a typed one gets, because the assembly lived inline in a component only the composer calls.
 *    `buildPromptCommand` is that assembly, now callable from anywhere with the right deps.
 *
 * Deliberately dependency-injected (no module-level socket, no new React context) — a caller
 * (component or future hook) hands in its own `apiJson`/roster/project/model, so this file stays a
 * pure lib module importable from both AssistantChat and the voice dispatcher.
 */
import { jsonInit } from '../api';
import { activeWork, activeWorkDigest } from '../insights';
import { fleetActivityDigest, fleetActivityLines, fleetActivityRollup } from '../fleetActivity';
import { serializePageContextForPrompt } from '../pageContextDerive';
import type { AgentDTO, AuditEntry, ChannelEntry, ClientCommand, FeatureDTO } from '../dto';
import type { PageContext } from '../../context/PageContext';
import type { Task } from '../../types';

/** Response shape of `POST /api/console` (mirrors `AssistantChat`'s local `ConsoleStart`). */
export interface ConsoleStartResponse {
  agentId: string;
}

/**
 * Dependencies `ensureConsoleAgent`/`buildPromptCommand` need, injected by the caller rather than
 * read from a module-level singleton or a new context — so concern 07's voice dispatcher can
 * thread the exact same `apiJson`/`sendConsoleCommand`/roster/project/model it already gets from
 * `useTaskContext()` without this module opening a second socket or subscribing to anything itself.
 *
 * `subscribeConsole` is an addition beyond the concern doc's enumerated dep list (apiJson,
 * roster, currentProject, selectedModel): `sendConsoleCommand` (squad.send) and `subscribeConsole`
 * (squad.subscribe) are DIFFERENT functions on `useSquad` — `subscribe` also adds the id to
 * `subscribedRef` so a WS reconnect replays the subscription automatically. Sending a bare
 * `{type:'subscribe', id}` via `sendConsoleCommand` would drop that bookkeeping and silently
 * regress reconnect behavior for a freshly-minted agent. Folding `subscribeConsole` in here is the
 * only way to keep the mint's post-mint subscribe observably identical to the inline original.
 * `sendConsoleCommand` itself is NOT part of this interface — nothing in this module sends a
 * command, only mints/subscribes/builds one; the caller (AssistantChat) sends the built command.
 */
export interface SendCoreDeps {
  apiJson: <T>(path: string, init?: RequestInit) => Promise<T>;
  /** Subscribes to a freshly-minted agent's transcript AND registers it for reconnect-replay
   *  (see the doc above) — distinct from `sendConsoleCommand`. */
  subscribeConsole: (agentId: string) => void;
  /** The live agent roster — used for the liveness re-mint check (an agent id from a stale
   *  session may no longer exist, e.g. evicted/killed) and nothing else. */
  roster: AgentDTO[];
  currentProject: { id?: string } | null | undefined;
  selectedModel: string;
}

export interface ChannelPostDeps {
  apiJson: <T>(path: string, init?: RequestInit) => Promise<T>;
}

export interface ChannelPostResult {
  entry: ChannelEntry;
}

export function channelDraftSessionId(channelId: string): string {
  if (!channelId) throw new Error('channelId required');
  return `hub:${channelId}`;
}

export function channelAgentSessionId(channelId: string, agentId: string): string {
  if (!channelId) throw new Error('channelId required');
  if (!agentId) throw new Error('agentId required');
  return `hub:${channelId}:${agentId}`;
}

/** Room messages use the channel-entry route, not the agent prompt route. The body is
 * deliberately only `{text}` so forged card/event fields die at the server schema boundary. */
export function postChannelMessage(deps: ChannelPostDeps, channelId: string, text: string, replyToId?: string): Promise<ChannelPostResult> {
  const trimmed = text.trim();
  if (!channelId) throw new Error('channelId required');
  if (!trimmed) throw new Error('message required');
  return deps.apiJson<ChannelPostResult>(`/api/channels/${encodeURIComponent(channelId)}/entries`, jsonInit('POST', replyToId ? { text: trimmed, replyToId } : { text: trimmed }));
}

/** One in-flight `/api/console` mint promise per session — the single-flight cache. Module-level
 *  by design (survives across calls from different callers/components for the same session id;
 *  it holds no data, just a settling Promise, and self-clears in `.finally` below). */
const inFlightMints = new Map<string, Promise<string>>();

/** The agent id each session's most recent mint resolved to, kept ONLY until the roster broadcast
 *  catches up (see the liveness check below) — a second, smaller cache from the in-flight promise
 *  cache above, which always clears on settle regardless of roster state. Closes the residual race
 *  window between a mint resolving and the roster actually listing the new agent: without it, a
 *  caller that re-checks liveness in that window sees a `currentAgentId` absent from `roster` and
 *  re-mints a second, orphaned agent for the same session. */
const recentlyMinted = new Map<string, string>();

/**
 * Resolve the console agent id to send a prompt to for `sessionId`, minting one via
 * `POST /api/console` only if there isn't already a live one.
 *
 * Liveness check first (mirrors the original inline check at what was AssistantChat.tsx:735-736):
 * `currentAgentId` may name an agent that's since been evicted/killed/restarted away — `roster`
 * membership is the primary trust signal, so a stale id is treated the same as "no agent yet". The
 * one addition is `recentlyMinted`: if `currentAgentId` matches this module's own last resolved
 * mint for the session and the roster simply hasn't caught up yet, it's still trusted — evicted the
 * moment the roster actually contains it, so it never masks a genuinely stale id afterward.
 *
 * Single-flight: deliberately NOT an `async function` — the cache check-then-set below executes
 * synchronously (before any `await`), so two calls issued back-to-back for the same session (the
 * voice tool call and the typed send racing each other) both observe the same in-flight Promise
 * and only one `POST /api/console` ever goes out. The cache entry is cleared in `.finally` so a
 * later send (after this one settles, success or failure) can mint again if the agent has since
 * died.
 */
export function ensureConsoleAgent(deps: SendCoreDeps, sessionId: string, currentAgentId?: string): Promise<string> {
  if (!sessionId) throw new Error('sessionId required');

  if (currentAgentId) {
    if (deps.roster.some((agent) => agent.id === currentAgentId)) {
      recentlyMinted.delete(sessionId);
      return Promise.resolve(currentAgentId);
    }
    if (recentlyMinted.get(sessionId) === currentAgentId) {
      return Promise.resolve(currentAgentId);
    }
  }

  const cached = inFlightMints.get(sessionId);
  if (cached) return cached;

  const minted = deps
    .apiJson<ConsoleStartResponse>('/api/console', jsonInit('POST', { repo: deps.currentProject?.id, model: deps.selectedModel || undefined }))
    .then((started) => {
      if (!started.agentId) throw new Error('/api/console returned no agentId');
      recentlyMinted.set(sessionId, started.agentId);
      deps.subscribeConsole(started.agentId);
      return started.agentId;
    })
    .finally(() => {
      inFlightMints.delete(sessionId);
    });

  inFlightMints.set(sessionId, minted);
  return minted;
}

/** Fleet/task/page context `buildPromptCommand` folds into the prompt — the same live join the
 *  Active Work pane renders, so the agent can answer "what's being worked on?" (present) AND
 *  "what happened while I was away?" (recent past) from one source of truth, plus whichever
 *  screen the operator is actually looking at. Reference context, never an instruction to act. */
export interface PromptCommandContext {
  /** Who the prompt is addressed to — folded into `ctx` (not a bare extra parameter) so the one
   *  object carries everything about "what to send and to whom" alongside the fleet snapshot
   *  inputs used to build the message body. */
  agentId: string;
  agents: AgentDTO[];
  features: FeatureDTO[];
  audit: AuditEntry[];
  selectedTask?: Task;
  pageContext: PageContext | null;
}

export interface BuildPromptCommandOpts {
  clientTurnId?: string;
  /** Overrides the operator-facing display text (what the transcript/audit show as "you said")
   *  independently of the context-augmented `message` actually sent to the agent. The typed path
   *  passes the same text it sends; voice will pass the user's spoken caption while `message`
   *  still carries the full context block. Defaults to `textToSend`. */
  displayText?: string;
  /** Observability-only provenance tag ("composer" | "voice", kept as an open string) — rides the
   *  wire to the daemon's `source`-carrying `ClientCommand` (concern 03) and from there into the
   *  audit trail. Never consulted for authz/tier decisions. */
  source?: string;
}

/**
 * Build the `prompt` `ClientCommand` for one send: assembles the fleet/activity/task/page context
 * block (previously inlined at AssistantChat.tsx:751-760) and appends it after `textToSend`,
 * fenced so the model treats it as reference data, never an instruction — unchanged from the
 * original. `opts.displayText` lets a caller show different text than what's sent (voice); absent,
 * it defaults to `textToSend` (the typed path's exact prior behavior).
 */
export function buildPromptCommand(ctx: PromptCommandContext, textToSend: string, opts: BuildPromptCommandOpts = {}): ClientCommand {
  const fleetSnapshot = activeWorkDigest(activeWork(ctx.agents, ctx.features));
  const activitySnapshot = fleetActivityDigest(fleetActivityRollup(ctx.audit), fleetActivityLines(ctx.audit, ctx.agents));
  const taskContext = ctx.selectedTask ? `\n\nCurrent feature context:\n${ctx.selectedTask.id} — ${ctx.selectedTask.title}\n${ctx.selectedTask.description}` : '';
  const pageContextBlock = serializePageContextForPrompt(ctx.pageContext);
  const message = `${textToSend}\n\n[Live context for reference — only act on it if asked]\n${fleetSnapshot}\n\n${activitySnapshot}${taskContext}${pageContextBlock ? `\n\n${pageContextBlock}` : ''}`;

  return {
    type: 'prompt',
    id: ctx.agentId,
    message,
    displayText: opts.displayText ?? textToSend,
    clientTurnId: opts.clientTurnId,
    source: opts.source,
  };
}

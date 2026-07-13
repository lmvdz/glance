/**
 * spawnProposal.ts — pure logic for Feature 2 D3, THE EXECUTION LOOP
 * (plans/orchestration/CANVAS-AND-PAGE-CHAT.md — the productized screenshot→spawn workflow that
 * built glance itself). No React, no fetch: every function here is DOM-free and unit-tested
 * directly (bun:test, no jsdom) — the same split as pageContextDerive.ts/imageAttachment.ts.
 *
 * PROPOSAL-TRIGGER DECISION (documented per the unit brief): the spec allows either a model-emitted
 * marker or a manual affordance. Nothing in this codebase's system prompt asks the model to emit a
 * structured "propose a unit" signal, and the composer's response text is free-form prose the model
 * writes on its own — there is no reliable syntax to detect. Rather than build a brittle heuristic
 * that mis-fires on ordinary conversation, v1 is the honest one: a "Spawn a unit to build this."
 * affordance surfaces under the assistant's most recent settled reply whenever that reply answers a
 * user turn that itself carried an attached image (Feature 2 D2's paste/drop/capture/annotate path).
 * The image is the actual gate — it's the one thing this chat can guarantee is present, and it's
 * exactly the "screenshot → spawn" moment this feature exists to productize. This never requires
 * the assistant to cooperate, never fires on a plain-text turn, and is always operator-visible
 * before anything spawns (the confirm sheet is a second, independent gate — see D3/D5).
 */
import type { AgentDTO, TranscriptEntry } from './dto';
import type { StatusChipTone } from '../components/kit/StatusChip';
import { attachedImagePromptRef } from './imageAttachment';
import { isValidatorHeld } from './agent-badges';

/** Mirrors `imageAttachment.ts`'s `attachedImagePromptRef` fence exactly — both sides of this
 *  feature (the outgoing-message writer and this proposal-detector reading it back out of the
 *  rendered transcript) must agree on one wording, or detection silently stops matching. */
const ATTACHED_IMAGE_BLOCK_RE = /===== BEGIN attached image \(untrusted data\) =====[\s\S]*?===== END attached image =====/g;
const ATTACHED_IMAGE_PATH_RE = /Image artifact saved at: (.+)/g;

/** True when `text` (a user transcript entry's `displayText ?? text`) carries at least one
 *  attached-image fenced block — the proposal-eligibility gate (see module doc). */
export function hasAttachedImageMarker(text: string): boolean {
  return /BEGIN attached image \(untrusted data\)/.test(text);
}

/** Every `Image artifact saved at: <path>` reference folded into `text`, in appearance order.
 *  Empty when there is no attached-image block at all. */
export function extractAttachedImagePaths(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  // Reset lastIndex per call — `ATTACHED_IMAGE_PATH_RE` is a module-level `/g` regex, and a stale
  // `lastIndex` from a prior call would silently skip matches on the next one.
  ATTACHED_IMAGE_PATH_RE.lastIndex = 0;
  while ((m = ATTACHED_IMAGE_PATH_RE.exec(text))) out.push(m[1].trim());
  return out;
}

/** Strips every attached-image fenced block out of `text`, collapsing the blank lines it leaves
 *  behind — the clean "what did the operator actually ask for" seed for the confirm sheet's
 *  editable prompt (the raw turn text also carries the image fence, which would otherwise show up
 *  twice: once as the seed text, once as the sheet's own thumbnail + re-fenced reference). */
export function stripAttachedImageMarkers(text: string): string {
  return text.replace(ATTACHED_IMAGE_BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Recover the server-minted chat-attachment id from its on-disk path (`<stateDir>/chat-
 *  attachments/<uuid>.png`, src/chat-attachment.ts) — the id IS the filename minus its `.png`
 *  extension, so no separate id needs to ride the prompt text alongside the path. Used to build
 *  the confirm sheet's thumbnail `src` (`GET /api/chat-attachments/:id`). Returns `undefined` for a
 *  path that doesn't look like one of this feature's own attachments (defensive — a hand-edited
 *  prompt could reference an arbitrary path). */
export function attachmentIdFromPath(filePath: string): string | undefined {
  const base = filePath.split(/[\\/]/).pop();
  if (!base) return undefined;
  const id = base.endsWith('.png') ? base.slice(0, -4) : base;
  return id.length > 0 ? id : undefined;
}

/** Scan `entries` backward from the entry identified by `targetId` for the nearest preceding
 *  `kind:'user'` entry — "what did the operator ask that produced this reply". `targetId`
 *  undefined (an entry with no server-assigned id yet) falls back to scanning from the end of the
 *  array, since a `finalEntry` this function is ever called with is always the last thing in
 *  `entries` by construction (see `TranscriptTimeline`'s `renderAfterFinal`). */
export function nearestPrecedingUserEntry(entries: TranscriptEntry[], targetId: string | undefined): TranscriptEntry | undefined {
  const idx = targetId !== undefined ? entries.findIndex((e) => e.id === targetId) : entries.length;
  const start = idx >= 0 ? idx : entries.length;
  for (let i = start - 1; i >= 0; i--) {
    if (entries[i].kind === 'user') return entries[i];
  }
  return undefined;
}

export interface SpawnProposal {
  /** The prompt seed offered in the confirm sheet's editable textarea — the operator's own typed
   *  ask, stripped of the fenced image block(s) (those render as thumbnails instead). */
  promptSeed: string;
  /** Every attached-image path from the triggering turn, in order — re-fenced into the final spawn
   *  prompt by `buildSpawnPrompt`, and used to render thumbnails in the confirm sheet. */
  imagePaths: string[];
}

/** The proposal-eligibility check itself (module doc): `null` when `finalEntry`'s nearest preceding
 *  user turn carried no attached image — no card, no confirm sheet, nothing spawns. Non-null is
 *  purely descriptive data for the caller to render a proposal card with; it has no side effect and
 *  triggers nothing on its own (the confirm sheet — a second, independent gate — is what a click on
 *  that card opens; see D3/D5's "never auto-spawn"). */
export function spawnProposalFor(entries: TranscriptEntry[], finalEntry: TranscriptEntry): SpawnProposal | null {
  const userEntry = nearestPrecedingUserEntry(entries, finalEntry.id);
  if (!userEntry) return null;
  const raw = userEntry.displayText ?? userEntry.text;
  if (!hasAttachedImageMarker(raw)) return null;
  const imagePaths = extractAttachedImagePaths(raw);
  if (imagePaths.length === 0) return null;
  return { promptSeed: stripAttachedImageMarkers(raw), imagePaths };
}

/** The standard draft-PR/verify contract line the confirm sheet shows verbatim (D3) — read-only,
 *  never part of the editable textarea, so an operator can't accidentally edit away the guarantee
 *  the sheet is showing them. */
export const SPAWN_CONTRACT_LINE =
  "Standard contract: work in your own isolated git worktree branch, run this repo's verification gate before finishing, and open a DRAFT pull request against main when done — never merge without review.";

/** Assemble the final `/api/spawn` prompt text (D3): the operator's edited ask, an explicit
 *  target-repo line (nudges smart-spawn's repo-name heuristic — see smart-spawn.ts's
 *  `pickRepoHeuristic` — toward the repo the operator is actually looking at), every attached
 *  image re-fenced as untrusted data (D5; reuses `imageAttachment.ts`'s exact wording so the
 *  fenced reference reads identically to how Composer's own sends fence it), the serialized page
 *  context block (already fenced+labeled by `serializePageContextForPrompt`), and the standard
 *  contract line. Deliberately does NOT widen `SpawnBodySchema` for a dedicated attachments/context
 *  field (D3's stated preference) — the artifact lives entirely as a path reference inside the one
 *  `prompt` string field the schema already has. */
export function buildSpawnPrompt(input: {
  editedPrompt: string;
  imagePaths: string[];
  pageContextBlock: string;
  repoLabel: string;
}): string {
  const parts = [
    input.editedPrompt.trim(),
    `Target repo: ${input.repoLabel} — build this change directly in that repo's own isolated worktree.`,
    ...input.imagePaths.map(attachedImagePromptRef),
    input.pageContextBlock,
    SPAWN_CONTRACT_LINE,
  ].filter((part) => part.trim().length > 0);
  return parts.join('\n\n');
}

/** A spawned unit's durable record — persisted on the `Session` it was spawned from (D3's "the
 *  thread becomes the durable 'I asked → here's the PR' record"), survives reload the same way
 *  `Session.messages` does. Deliberately tiny: everything else about the unit's live state (status,
 *  PR, proof) is read fresh from `agents` each render via `agentId`, never duplicated/cached here —
 *  a stale duplicate is exactly what would make the card lie the moment the real agent's state
 *  moves on. */
export interface SpawnedUnitRecord {
  id: string;
  agentId: string;
  createdAt: number;
  /** The exact prompt sent to `/api/spawn` — the "I asked" half of the durable record. */
  prompt: string;
}

export interface SpawnCardStatus {
  /** Fed straight into `<StatusChip status=… />` — reuses that component's existing label/tone
   *  vocabulary (D3: "reuse AgentMetaBar/AgentLandControls/StatusChip") rather than inventing a
   *  parallel one. */
  status: string;
  tone?: StatusChipTone;
  detail: string;
}

/**
 * RUNNING→verify→draft-PR, honestly derived from the fields `AgentDTO` actually has (there is no
 * dedicated "verifying" `AgentStatus` value — see autonomy.ts's `AgentStatus` union) rather than
 * inventing a phase the roster doesn't track. `agent` is `undefined` once it's fallen out of the
 * live roster entirely (landed and cleaned up, evicted, or removed) — that's still a legitimate,
 * clearly-labeled state, not an error.
 */
export function spawnCardStatus(agent: AgentDTO | undefined): SpawnCardStatus {
  if (!agent) return { status: 'gone', tone: 'neutral', detail: 'No longer in the fleet roster — likely landed and cleaned up, or removed.' };
  if (agent.status === 'error') return { status: 'error', detail: agent.error ?? 'The run failed.' };
  if (agent.prState) {
    return {
      status: agent.prState,
      detail: agent.prState === 'merged' ? 'Merged into main.' : `PR #${agent.prNumber ?? '?'} — ${agent.prState}.`,
    };
  }
  if (agent.status === 'working' || agent.status === 'starting') return { status: 'working', detail: 'Building the unit…' };
  if (agent.status === 'input') return { status: 'input', detail: 'Waiting on you — open the run to answer.' };
  if ((agent.verificationState === 'fresh' || agent.landReady) && isValidatorHeld(agent)) {
    // A vetoed or inconclusive verdict must never read as "ready to land" — the fail-open
    // isValidatorHeld exists to close (agent-badges.ts). Green proof + a held verdict is a hold,
    // not a pass.
    return { status: 'held', tone: 'attention', detail: `Verified, but the validator ${agent.validation?.verdict ?? 'held'} it — open the run to review.` };
  }
  if (agent.verificationState === 'fresh' || agent.landReady) return { status: 'done', tone: 'success', detail: 'Verified — ready to land.' };
  return { status: agent.status, detail: 'Stopped before opening a PR.' };
}

import { expect, test } from 'bun:test';
import {
  attachmentIdFromPath,
  buildSpawnPrompt,
  extractAttachedImagePaths,
  hasAttachedImageMarker,
  nearestPrecedingUserEntry,
  spawnCardStatus,
  spawnProposalFor,
  SPAWN_CONTRACT_LINE,
  stripAttachedImageMarkers,
} from './spawnProposal';
import { attachedImagePromptRef } from './imageAttachment';
import type { AgentDTO, TranscriptEntry } from './dto';

const ATTACHMENT_PATH = '/state/chat-attachments/8f14e45f-ceea-467e-9d1a-1234567890ab.png';
const FENCED = attachedImagePromptRef(ATTACHMENT_PATH);

function userEntry(id: string, text: string): TranscriptEntry {
  return { id, kind: 'user', text, ts: 1 };
}
function assistantEntry(id: string, text: string, status: TranscriptEntry['status'] = 'ok'): TranscriptEntry {
  return { id, kind: 'assistant', text, ts: 2, status };
}

test('hasAttachedImageMarker: true only when the exact fenced marker is present', () => {
  expect(hasAttachedImageMarker(`Fix this button\n\n${FENCED}`)).toBe(true);
  expect(hasAttachedImageMarker('Fix this button, no image here')).toBe(false);
  expect(hasAttachedImageMarker('')).toBe(false);
});

test('extractAttachedImagePaths: pulls every path in order, empty when none', () => {
  expect(extractAttachedImagePaths(`hello\n\n${FENCED}`)).toEqual([ATTACHMENT_PATH]);
  const second = '/state/chat-attachments/second.png';
  expect(extractAttachedImagePaths(`${FENCED}\n\n${attachedImagePromptRef(second)}`)).toEqual([ATTACHMENT_PATH, second]);
  expect(extractAttachedImagePaths('no images here')).toEqual([]);
});

test('extractAttachedImagePaths: repeated calls do not skip matches (no stale regex lastIndex)', () => {
  // The extractor's regex is module-level /g — a naive implementation that forgets to reset
  // lastIndex between calls silently returns fewer matches on the second call onward.
  expect(extractAttachedImagePaths(`${FENCED}`)).toEqual([ATTACHMENT_PATH]);
  expect(extractAttachedImagePaths(`${FENCED}`)).toEqual([ATTACHMENT_PATH]);
  expect(extractAttachedImagePaths(`${FENCED}`)).toEqual([ATTACHMENT_PATH]);
});

test('stripAttachedImageMarkers: removes the fenced block and collapses the blank lines it leaves', () => {
  const text = `Fix this button\n\n${FENCED}`;
  expect(stripAttachedImageMarkers(text)).toBe('Fix this button');
});

test('stripAttachedImageMarkers: text with no marker passes through trimmed, unchanged otherwise', () => {
  expect(stripAttachedImageMarkers('  plain text  ')).toBe('plain text');
});

test('attachmentIdFromPath: recovers the uuid from the on-disk path, POSIX and Windows separators alike', () => {
  expect(attachmentIdFromPath(ATTACHMENT_PATH)).toBe('8f14e45f-ceea-467e-9d1a-1234567890ab');
  expect(attachmentIdFromPath('C:\\state\\chat-attachments\\abc123.png')).toBe('abc123');
  expect(attachmentIdFromPath('')).toBeUndefined();
});

test('nearestPrecedingUserEntry: finds the closest user turn before the target id', () => {
  const entries: TranscriptEntry[] = [
    userEntry('u1', 'first ask'),
    assistantEntry('a1', 'first reply'),
    userEntry('u2', 'second ask'),
    assistantEntry('a2', 'second reply'),
  ];
  expect(nearestPrecedingUserEntry(entries, 'a2')?.id).toBe('u2');
  expect(nearestPrecedingUserEntry(entries, 'a1')?.id).toBe('u1');
});

test('nearestPrecedingUserEntry: no target id scans from the end of the array', () => {
  const entries: TranscriptEntry[] = [userEntry('u1', 'ask'), assistantEntry('a1', 'reply')];
  expect(nearestPrecedingUserEntry(entries, undefined)?.id).toBe('u1');
});

test('nearestPrecedingUserEntry: no preceding user entry (e.g. a synthetic welcome-only prologue) returns undefined', () => {
  const entries: TranscriptEntry[] = [assistantEntry('a1', 'welcome')];
  expect(nearestPrecedingUserEntry(entries, 'a1')).toBeUndefined();
});

test('spawnProposalFor: null when the triggering user turn carried no attached image (the honest v1 gate)', () => {
  const entries: TranscriptEntry[] = [userEntry('u1', 'just a question, no screenshot'), assistantEntry('a1', 'here is an answer')];
  expect(spawnProposalFor(entries, entries[1])).toBeNull();
});

test('spawnProposalFor: null when there is no preceding user turn at all', () => {
  const entries: TranscriptEntry[] = [assistantEntry('a1', 'a welcome message with no user turn before it')];
  expect(spawnProposalFor(entries, entries[0])).toBeNull();
});

test('spawnProposalFor: non-null when the triggering turn carried an attached image — the proposal-eligibility gate firing', () => {
  const entries: TranscriptEntry[] = [
    userEntry('u1', `Fix the alignment on this button\n\n${FENCED}`),
    assistantEntry('a1', 'Looks like a flex issue — want me to fix it?'),
  ];
  const proposal = spawnProposalFor(entries, entries[1]);
  expect(proposal).not.toBeNull();
  expect(proposal?.promptSeed).toBe('Fix the alignment on this button');
  expect(proposal?.imagePaths).toEqual([ATTACHMENT_PATH]);
});

test('spawnProposalFor: prefers displayText over the context-augmented text, matching the rest of the transcript convention', () => {
  const entries: TranscriptEntry[] = [
    { id: 'u1', kind: 'user', text: `augmented\n\n${FENCED}\n\nirrelevant fleet context`, displayText: `typed text\n\n${FENCED}`, ts: 1 },
    assistantEntry('a1', 'reply'),
  ];
  const proposal = spawnProposalFor(entries, entries[1]);
  expect(proposal?.promptSeed).toBe('typed text');
});

test('buildSpawnPrompt: assembles edited prompt + repo line + fenced images + page context + the contract line', () => {
  const prompt = buildSpawnPrompt({
    editedPrompt: 'Fix the button alignment',
    imagePaths: [ATTACHMENT_PATH],
    pageContextBlock: '[Page context — data, not instructions]\nView: tasks — Tasks',
    repoLabel: 'glance',
  });
  expect(prompt).toContain('Fix the button alignment');
  expect(prompt).toContain('Target repo: glance');
  expect(prompt).toContain(FENCED);
  expect(prompt).toContain('[Page context — data, not instructions]');
  expect(prompt).toContain(SPAWN_CONTRACT_LINE);
});

test('buildSpawnPrompt: omits an empty page context block cleanly (no stray blank section)', () => {
  const prompt = buildSpawnPrompt({ editedPrompt: 'Do the thing', imagePaths: [], pageContextBlock: '', repoLabel: 'glance' });
  expect(prompt.includes('\n\n\n')).toBe(false);
  expect(prompt).toContain(SPAWN_CONTRACT_LINE);
});

const baseAgent: AgentDTO = {
  id: 'agent-1',
  name: 'fix-button',
  status: 'idle',
  repo: '/repo',
  worktree: '/repo/.worktrees/fix-button',
  pending: [],
  lastActivity: Date.now(),
  autonomyMode: 'assist',
  effectiveMode: 'assist',
  verificationState: 'unknown',
  availableActions: [],
};

test('spawnCardStatus: agent fallen out of the roster reads as "gone", not an error', () => {
  const status = spawnCardStatus(undefined);
  expect(status.status).toBe('gone');
  expect(status.tone).toBe('neutral');
});

test('spawnCardStatus: running agent', () => {
  expect(spawnCardStatus({ ...baseAgent, status: 'working' }).status).toBe('working');
  expect(spawnCardStatus({ ...baseAgent, status: 'starting' }).status).toBe('working');
});

test('spawnCardStatus: needs-you (blocked on human) takes priority over a stale verification state', () => {
  expect(spawnCardStatus({ ...baseAgent, status: 'input', verificationState: 'fresh' }).status).toBe('input');
});

test('spawnCardStatus: verified-and-land-ready reads as success "done", not a raw status string', () => {
  const status = spawnCardStatus({ ...baseAgent, status: 'stopped', verificationState: 'fresh' });
  expect(status.status).toBe('done');
  expect(status.tone).toBe('success');
});

test('spawnCardStatus: a PR takes priority — draft, open, merged all read through prState verbatim', () => {
  expect(spawnCardStatus({ ...baseAgent, prState: 'draft', prNumber: 12 }).status).toBe('draft');
  expect(spawnCardStatus({ ...baseAgent, prState: 'merged', prNumber: 12 }).detail).toContain('Merged');
});

test('spawnCardStatus: an error status reports the agent\'s own error text when present', () => {
  const status = spawnCardStatus({ ...baseAgent, status: 'error', error: 'crashed on step 3' });
  expect(status.status).toBe('error');
  expect(status.detail).toBe('crashed on step 3');
});

test('spawnCardStatus: stopped with nothing verified yet — honest fallback, not a false success', () => {
  const status = spawnCardStatus({ ...baseAgent, status: 'stopped' });
  expect(status.status).toBe('stopped');
  expect(status.tone).toBeUndefined();
});

test('spawnCardStatus: a vetoed unit must never read as "done" success — even with fresh verification or landReady set', () => {
  const status = spawnCardStatus({
    ...baseAgent,
    status: 'stopped',
    verificationState: 'fresh',
    landReady: true,
    validation: { verdict: 'veto', agreement: 0, confidence: 0.9, perCriterion: [], rationale: 'broke the API contract' },
  });
  expect(status.status).not.toBe('done');
  expect(status.tone).not.toBe('success');
  expect(status.detail).toContain('veto');
});

test('spawnCardStatus: an inconclusive verdict must never read as "done" success either — the fail-open isValidatorHeld closes', () => {
  const status = spawnCardStatus({
    ...baseAgent,
    status: 'stopped',
    landReady: true,
    validation: { verdict: 'inconclusive', agreement: 0, confidence: 0, perCriterion: [], rationale: 'diff could not be computed' },
  });
  expect(status.status).not.toBe('done');
  expect(status.tone).not.toBe('success');
});

test('spawnCardStatus: a PASSED verdict still reads as "done" success — held is only for veto/inconclusive', () => {
  const status = spawnCardStatus({
    ...baseAgent,
    status: 'stopped',
    verificationState: 'fresh',
    validation: { verdict: 'pass', agreement: 1, confidence: 0.9, perCriterion: [], rationale: 'all criteria satisfied' },
  });
  expect(status.status).toBe('done');
  expect(status.tone).toBe('success');
});

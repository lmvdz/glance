import { afterEach, expect, test } from 'bun:test';
import { assembleTranscript, describeSpeechError, isSpeechRecognitionSupported, startVoiceInput } from './speech';

const originalWindow = (globalThis as any).window;

afterEach(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
});

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

test('isSpeechRecognitionSupported is false with no window at all (this webapp\'s bun:test env has none)', () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: undefined });
  expect(isSpeechRecognitionSupported()).toBe(false);
});

test('isSpeechRecognitionSupported is false when window exists but neither constructor does', () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  expect(isSpeechRecognitionSupported()).toBe(false);
});

test('isSpeechRecognitionSupported is true for the standard constructor', () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { SpeechRecognition: class {} } });
  expect(isSpeechRecognitionSupported()).toBe(true);
});

test('isSpeechRecognitionSupported is true for the webkit-prefixed constructor (feature-detect fallback)', () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { webkitSpeechRecognition: class {} } });
  expect(isSpeechRecognitionSupported()).toBe(true);
});

test('startVoiceInput returns undefined when unsupported, without throwing', () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: undefined });
  const session = startVoiceInput({ onTranscript: () => {}, onListeningChange: () => {}, onError: () => {} });
  expect(session).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Error mapping — every documented code gets a distinct, user-facing message
// ---------------------------------------------------------------------------

test('describeSpeechError maps each known code to a distinct message', () => {
  const codes = ['no-speech', 'not-allowed', 'network', 'aborted'] as const;
  const messages = codes.map((code) => describeSpeechError(code).message);
  expect(new Set(messages).size).toBe(codes.length); // no two codes collapse to the same text
  for (const code of codes) {
    expect(describeSpeechError(code).code).toBe(code);
  }
});

test('describeSpeechError falls back to "unknown" for a code the spec never documented', () => {
  const info = describeSpeechError('some-future-browser-specific-code');
  expect(info.code).toBe('unknown');
  expect(info.message.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// assembleTranscript — multi-segment result assembly
// ---------------------------------------------------------------------------

function fakeResult(transcript: string, isFinal: boolean) {
  const result: any = { length: 1, isFinal, item: (i: number) => result[i] };
  result[0] = { transcript };
  return result;
}

function fakeEvent(results: any[], resultIndex: number) {
  const list: any = { length: results.length, item: (i: number) => results[i] };
  results.forEach((r, i) => { list[i] = r; });
  return { resultIndex, results: list };
}

test('assembleTranscript reads a single finalized segment (the non-continuous, single-shot case)', () => {
  const event = fakeEvent([fakeResult('add a login page', true)], 0);
  expect(assembleTranscript(event)).toBe('add a login page');
});

test('assembleTranscript joins every newly-finalized segment from resultIndex onward — not just results[0][0]', () => {
  // Simulates a continuous session: two earlier segments already delivered/consumed, resultIndex
  // now points at the two new ones this event carries.
  const event = fakeEvent(
    [fakeResult('first sentence already handled', true), fakeResult('second sentence already handled', true), fakeResult('third new segment', true), fakeResult('fourth new segment', true)],
    2,
  );
  expect(assembleTranscript(event)).toBe('third new segment fourth new segment');
});

test('assembleTranscript skips interim (not-yet-final) results', () => {
  const event = fakeEvent([fakeResult('final one', true), fakeResult('still speaking...', false)], 0);
  expect(assembleTranscript(event)).toBe('final one');
});

test('assembleTranscript returns an empty string when there is nothing finalized yet', () => {
  const event = fakeEvent([fakeResult('interim only', false)], 0);
  expect(assembleTranscript(event)).toBe('');
});

// ---------------------------------------------------------------------------
// startVoiceInput — wiring + abort cleanup
// ---------------------------------------------------------------------------

class FakeSpeechRecognition {
  static instances: FakeSpeechRecognition[] = [];
  lang = '';
  interimResults = true;
  continuous = false;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onresult: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  started = false;
  aborted = false;

  constructor() {
    FakeSpeechRecognition.instances.push(this);
  }

  start() {
    this.started = true;
  }

  abort() {
    this.aborted = true;
    this.onend?.();
  }
}

function installFakeRecognition() {
  FakeSpeechRecognition.instances = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { SpeechRecognition: FakeSpeechRecognition } });
  return () => FakeSpeechRecognition.instances[FakeSpeechRecognition.instances.length - 1]!;
}

test('startVoiceInput configures interimResults=false always, and continuous per the option (default false)', () => {
  const latest = installFakeRecognition();
  startVoiceInput({ onTranscript: () => {}, onListeningChange: () => {}, onError: () => {} });
  expect(latest().interimResults).toBe(false);
  expect(latest().continuous).toBe(false);
  expect(latest().started).toBe(true);

  startVoiceInput({ onTranscript: () => {}, onListeningChange: () => {}, onError: () => {}, continuous: true });
  expect(latest().continuous).toBe(true);
});

test('startVoiceInput calls onListeningChange(true) on start and onListeningChange(false) on end', () => {
  const latest = installFakeRecognition();
  const listeningChanges: boolean[] = [];
  startVoiceInput({ onTranscript: () => {}, onListeningChange: (v) => listeningChanges.push(v), onError: () => {} });
  latest().onstart?.();
  latest().onend?.();
  expect(listeningChanges).toEqual([true, false]);
});

test('startVoiceInput forwards an assembled transcript to onTranscript', () => {
  const latest = installFakeRecognition();
  const transcripts: string[] = [];
  startVoiceInput({ onTranscript: (t) => transcripts.push(t), onListeningChange: () => {}, onError: () => {} });
  latest().onresult?.(fakeEvent([fakeResult('deploy the new build', true)], 0));
  expect(transcripts).toEqual(['deploy the new build']);
});

test('startVoiceInput does not call onTranscript when a result event has nothing finalized', () => {
  const latest = installFakeRecognition();
  const transcripts: string[] = [];
  startVoiceInput({ onTranscript: (t) => transcripts.push(t), onListeningChange: () => {}, onError: () => {} });
  latest().onresult?.(fakeEvent([fakeResult('still speaking', false)], 0));
  expect(transcripts).toEqual([]);
});

test('startVoiceInput maps a raw onerror event through describeSpeechError', () => {
  const latest = installFakeRecognition();
  const errors: string[] = [];
  startVoiceInput({ onTranscript: () => {}, onListeningChange: () => {}, onError: (e) => errors.push(e.code) });
  latest().onerror?.({ error: 'not-allowed' });
  expect(errors).toEqual(['not-allowed']);
});

test('the returned session\'s abort() stops the underlying recognizer (unmount cleanup)', () => {
  const latest = installFakeRecognition();
  const session = startVoiceInput({ onTranscript: () => {}, onListeningChange: () => {}, onError: () => {} });
  expect(session).toBeDefined();
  session!.abort();
  expect(latest().aborted).toBe(true);
});

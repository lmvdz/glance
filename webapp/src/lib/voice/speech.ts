/**
 * Chained speech-to-text input — a thin wrapper over the browser's Web Speech API
 * (`window.SpeechRecognition || window.webkitSpeechRecognition`, feature-detected the same way
 * WorkbenchPane.tsx's voice-to-task button already did before this module existed). TypeScript's
 * DOM lib doesn't ship types for it (still non-standard/vendor-prefixed), so the surface this file
 * touches is declared narrowly below rather than pulling in a full `@types/dom-speech-recognition`
 * dependency for a handful of fields.
 *
 * A mic button was previously removed from the composer as a "misleading no-op" — it had no error
 * handling at all, so a denied-mic-permission or a network hiccup looked identical to the button
 * silently doing nothing. The difference this time: `onerror` is always wired, and every one of the
 * SpeechRecognition spec's documented error codes this module expects to see in practice maps to a
 * distinct, user-facing message via `describeSpeechError` — callers are never left guessing why
 * listening stopped.
 *
 * Multi-segment results: `event.results` grows over the life of a `continuous` session (one entry
 * per finalized utterance), and each entry itself carries one-or-more alternative transcripts.
 * Reading only `event.results[0][0]` — the bug this module fixes in both of its call sites —
 * silently drops every segment after the very first. `assembleTranscript` instead walks from
 * `event.resultIndex` (where the SpeechRecognition spec guarantees any *new* results begin) through
 * to the end, taking each finalized result's best alternative.
 */

export type SpeechErrorCode = 'no-speech' | 'not-allowed' | 'network' | 'aborted' | 'unknown';

export interface SpeechErrorInfo {
  code: SpeechErrorCode;
  message: string;
}

const KNOWN_ERROR_CODES: readonly SpeechErrorCode[] = ['no-speech', 'not-allowed', 'network', 'aborted'];

const ERROR_MESSAGES: Record<SpeechErrorCode, string> = {
  'no-speech': "Didn't catch any speech — try again.",
  'not-allowed': 'Microphone access was denied — allow it in your browser settings to use voice input.',
  network: 'Voice input needs a network connection to reach the speech-recognition service — check your connection and try again.',
  aborted: 'Voice input was stopped.',
  unknown: 'Voice input hit an unexpected error — try again.',
};

/** Map a raw `SpeechRecognitionErrorEvent.error` string to a distinct, user-facing message.
 *  Anything the spec doesn't guarantee (browser-specific codes, future additions) falls back to
 *  `'unknown'` rather than surfacing the raw code to the operator. */
export function describeSpeechError(rawErrorCode: string): SpeechErrorInfo {
  const code = (KNOWN_ERROR_CODES as readonly string[]).includes(rawErrorCode) ? (rawErrorCode as SpeechErrorCode) : 'unknown';
  return { code, message: ERROR_MESSAGES[code] };
}

// ---------------------------------------------------------------------------
// Minimal Web Speech API surface — DOM lib doesn't declare this (vendor-prefixed/non-standard).
// ---------------------------------------------------------------------------

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  readonly length: number;
  isFinal: boolean;
  item(index: number): SpeechRecognitionAlternativeLike;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
  readonly length: number;
  item(index: number): SpeechRecognitionResultLike;
  [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike {
  error: string;
}

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  start(): void;
  abort(): void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
}

/** True when this browser exposes either the standard or webkit-prefixed constructor. Callers
 *  should gate the mic button's enabled state on this — never assume support and let `start()`
 *  fail silently. */
export function isSpeechRecognitionSupported(): boolean {
  return getSpeechRecognitionCtor() !== undefined;
}

/** Join every newly-finalized segment's best transcript, from `event.resultIndex` onward, across
 *  every alternative entry in each `SpeechRecognitionResult` — see the module doc comment for why a
 *  plain `event.results[0][0].transcript` read silently drops everything after the first segment
 *  once a session runs `continuous`. Interim (not-yet-final) results are skipped; they'll arrive
 *  again, finalized, in a later event. */
export function assembleTranscript(event: SpeechRecognitionEventLike): string {
  const parts: string[] = [];
  for (let i = event.resultIndex; i < event.results.length; i++) {
    const result = event.results[i];
    if (!result?.isFinal) continue;
    const best = result[0]?.transcript ?? '';
    if (best) parts.push(best);
  }
  return parts.join(' ').trim();
}

export interface VoiceInputHandlers {
  /** Called once per event carrying at least one newly-finalized segment, already assembled via
   *  `assembleTranscript`. Never fired for interim-only events (this module always sets
   *  `interimResults: false`). */
  onTranscript: (text: string) => void;
  onListeningChange: (listening: boolean) => void;
  onError: (error: SpeechErrorInfo) => void;
}

export interface VoiceInputOptions extends VoiceInputHandlers {
  /** Keep listening across multiple finalized segments instead of stopping after the browser's
   *  default first-pause timeout. The composer's multi-sentence dictation opts into this;
   *  WorkbenchPane's one-utterance "voice → task title" flow deliberately doesn't (defaults to
   *  `false`, matching that flow's pre-existing behavior). */
  continuous?: boolean;
  lang?: string;
}

export interface VoiceInputSession {
  /** Stop listening immediately. Safe to call from an unmount cleanup — idempotent underneath a
   *  session that has already ended on its own. */
  abort: () => void;
}

/**
 * Start a listening session wired to `options`. Returns `undefined` when the browser exposes
 * neither constructor — callers should have already gated the mic button's enabled state on
 * `isSpeechRecognitionSupported()`, but this stays defensive in case that check is ever skipped or
 * support changes between check and click.
 */
export function startVoiceInput(options: VoiceInputOptions): VoiceInputSession | undefined {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) return undefined;

  const recognition = new Ctor();
  recognition.lang = options.lang ?? 'en-US';
  recognition.interimResults = false;
  recognition.continuous = options.continuous ?? false;
  recognition.onstart = () => options.onListeningChange(true);
  recognition.onend = () => options.onListeningChange(false);
  recognition.onresult = (event) => {
    const text = assembleTranscript(event);
    if (text) options.onTranscript(text);
  };
  recognition.onerror = (event) => options.onError(describeSpeechError(event.error));
  recognition.start();

  return { abort: () => recognition.abort() };
}

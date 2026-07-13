/**
 * Voice provider registry — the browser-side mirror of `src/voice-token.ts`'s registry.
 *
 * The daemon module owns provider resolution, the SSRF-doctrine closed switch, and the
 * `pinnedAtMint` → `flatPrice` assertion (a bad registry entry there throws at daemon boot). This
 * file only describes what the *client* needs to know to drive a connection: which transport to
 * speak, and whether it's safe to let the browser choose session params. There is deliberately no
 * `baseUrl` here — the browser never talks to the provider's mint endpoint, only to
 * `POST /api/voice/token` (see `../api.ts`) and, once minted, the provider's realtime-session
 * endpoint itself (`voiceSession.ts`'s `postSdpOffer`).
 *
 * v1 ships exactly one entry (`openai`, webrtc, pinned). The `websocket` transport variant exists
 * on the type so concern 09 (xAI) can add a second provider without a type change, but no
 * websocket implementation exists yet — `voiceSession.ts` only builds a WebRTC connection.
 */

export type VoiceTransport = 'webrtc' | 'websocket';

export interface VoiceProviderConfig {
  readonly id: string;
  readonly transport: VoiceTransport;
  /** Whether the SERVER pins every cost-bearing session parameter (model/voice/instructions) into
   *  the mint request, vs. the browser choosing them at connect time. Mirrors the same field on
   *  `src/voice-token.ts`'s registry — kept here too because the client needs to know it (e.g. to
   *  decide whether it's meaningful to send a `session.update`, which it must NOT do for a pinned
   *  provider — see `voiceSession.ts`'s module doc comment). */
  readonly pinnedAtMint: boolean;
  /** Whether this provider bills a flat rate regardless of session params — the only condition
   *  under which `pinnedAtMint: false` would ever be safe (asserted server-side at mint time). */
  readonly flatPrice: boolean;
}

export const VOICE_PROVIDERS: Readonly<Record<string, VoiceProviderConfig>> = {
  openai: {
    id: 'openai',
    transport: 'webrtc',
    pinnedAtMint: true,
    flatPrice: false,
  },
};

/** The default provider a new voice session connects to when the caller doesn't pick one. */
export const DEFAULT_VOICE_PROVIDER_ID = 'openai';

export function voiceProvider(id: string): VoiceProviderConfig | undefined {
  return VOICE_PROVIDERS[id];
}

export function isKnownVoiceProviderId(id: string): boolean {
  return Object.hasOwn(VOICE_PROVIDERS, id);
}

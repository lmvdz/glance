import { token } from "../api";

/**
 * audioRelay.ts — the browser's half of concern 09 (browser-audio-transport).
 *
 * When a room's call runs `omp live --no-local-audio` (daemon-reported via
 * `VoiceCallBindingDTO.audioAvailable`), the daemon never opens a local microphone or speaker at
 * all — the browser IS the mic and the speaker. Three pieces, deliberately independent so each is
 * testable/replaceable on its own:
 *
 *  - `connectVoiceCallAudio` — the WS transport to the daemon's dedicated per-channel audio socket
 *    (`/api/channels/:id/voice-call/audio`, server.ts). Binary frames are audio in EITHER
 *    direction, unambiguous by direction alone (this socket's only inbound binary meaning is mic
 *    PCM; its only outbound binary meaning is decoded output PCM) — unlike the OMP↔daemon leg
 *    (`opencoven-viz/PROTOCOL.md`), which multiplexes both directions of audio on ONE socket and so
 *    needs the `0x01`/`0x02` tag byte this leg does not.
 *  - `startMicCapture` — `getUserMedia` + an `AudioWorklet` (`public/audio/mic-worklet.js`) that
 *    resamples whatever the browser actually grants down to the 16 kHz mono `Float32` PCM the wire
 *    expects, and hands chunks back via a plain callback.
 *  - `startAudioPlayback` — decodes the PCM16LE mono chunks the relay delivers and schedules them
 *    back-to-back on a Web Audio destination — the standard "queue of `AudioBufferSourceNode`s"
 *    technique for streaming raw PCM, chosen over a second worklet because output has no resampling
 *    or low-latency-capture requirement to justify one.
 *
 * The room's EXISTING mute control needs no changes for this to work: `useRoomCall`'s
 * `toggleMute` already asks OMP itself to mute, and `LiveSessionController#pushRemoteAudio`
 * (oh-my-pi's own `#handleMicrophoneAudio`) drops samples on the floor while muted — REGARDLESS of
 * whether they came from a real device or from this relay. The browser can (and does) keep
 * streaming continuously; OMP-side muting is what actually silences it, exactly like it always has.
 */

/** Mono PCM16LE sample rate `omp live`'s `output_audio.delta` forwarding assumes — see
 *  `coven-bridge.ts`'s own `OUTPUT_AUDIO_SAMPLE_RATE_HZ` doc for why this is a documented assumption
 *  rather than a verified constant, and why it travels on the wire (`hello.audio.outputSampleRate`)
 *  instead of being hardcoded on either side. */
export const DEFAULT_OUTPUT_SAMPLE_RATE_HZ = 24_000;
/** Mono Float32 sample rate the mic relay always sends, matching oh-my-pi's own `AudioCapture`. */
export const MIC_SAMPLE_RATE_HZ = 16_000;

export type VoiceAudioStatus = "connecting" | "ready" | "refused" | "closed";

export interface VoiceAudioHandlers {
	/** Fired on every status transition. `reason` is set only for `refused` — the daemon's own
	 *  `CoordinatorResult['reason']` (e.g. `"device-audio-call"`, `"bridge-unavailable"`), rendered
	 *  honestly rather than a generic "something went wrong". */
	onStatus: (status: VoiceAudioStatus, reason?: string) => void;
	/** One chunk of decoded output PCM (mono PCM16LE @ whatever `hello.audio.outputSampleRate`
	 *  reported — `startAudioPlayback`'s caller is expected to have read that already). */
	onOutputAudio: (bytes: Uint8Array) => void;
}

export interface VoiceAudioHandle {
	/** Sends one chunk of mono `Float32` mic PCM. A no-op once the socket is no longer open — the
	 *  caller is not expected to gate every call on status itself. */
	sendMic: (samples: Float32Array) => void;
	close: () => void;
}

/**
 * Parses one text frame from the voice-audio socket (server.ts's `voiceAudioReady`/
 * `voiceAudioError`) into a status transition, or `undefined` for anything unrecognized —
 * malformed/foreign input is dropped, never thrown on. Pure and exported so the parsing logic is
 * unit-testable without a real socket.
 */
export function parseVoiceAudioStatusFrame(raw: string): { status: "ready" } | { status: "refused"; reason: string } | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	const record = parsed as Record<string, unknown>;
	if (record.type === "voiceAudioReady") return { status: "ready" };
	if (record.type === "voiceAudioError") return { status: "refused", reason: typeof record.reason === "string" ? record.reason : "refused" };
	return undefined;
}

/**
 * Connects to the daemon's per-channel voice-audio socket. Mirrors `lib/ws.ts`'s own
 * `Sec-WebSocket-Protocol` token-auth convention exactly (file mode's bearer token has no other way
 * to ride a `WebSocket` handshake — DB mode's session cookie rides automatically) — see that
 * module's own comment for why.
 *
 * Deliberately does NOT auto-reconnect, unlike `connectSquad`: an audio relay that silently retries
 * with exponential backoff would leave the room believing it can hear/speak when it cannot. A
 * dropped relay reports `closed` once and stops; the caller (the room call hook) decides whether
 * and when to open a fresh one — matching `voiceSession.ts`'s own "no re-prompt loop" doctrine for
 * every other voice failure mode in this package.
 */
export function connectVoiceCallAudio(channelId: string, handlers: VoiceAudioHandlers): VoiceAudioHandle {
	const proto = location.protocol === "https:" ? "wss" : "ws";
	const auth = token();
	const url = `${proto}://${location.host}/api/channels/${encodeURIComponent(channelId)}/voice-call/audio`;
	const socket = auth ? new WebSocket(url, ["ompsq-token", auth]) : new WebSocket(url);
	socket.binaryType = "arraybuffer";
	let closed = false;
	handlers.onStatus("connecting");
	socket.onmessage = (event) => {
		if (typeof event.data === "string") {
			const parsed = parseVoiceAudioStatusFrame(event.data);
			if (!parsed) return;
			if (parsed.status === "ready") handlers.onStatus("ready");
			else handlers.onStatus("refused", parsed.reason);
			return;
		}
		handlers.onOutputAudio(new Uint8Array(event.data as ArrayBuffer));
	};
	socket.onerror = () => socket.close();
	socket.onclose = () => {
		if (closed) return; // this side already called close() — the transition already happened
		handlers.onStatus("closed");
	};
	return {
		sendMic(samples) {
			// Cast past TS's `ArrayBufferLike` vs `ArrayBuffer` distinction for typed-array generics
			// (TS 5.7+): `Float32Array`'s backing buffer is always a real `ArrayBuffer` here (never a
			// `SharedArrayBuffer`), which is exactly what `WebSocket.send`'s `BufferSource` type wants.
			if (socket.readyState === WebSocket.OPEN) socket.send(samples as Float32Array<ArrayBuffer>);
		},
		close() {
			closed = true;
			socket.close();
		},
	};
}

export interface MicCaptureHandle {
	stop: () => void;
}

/** Honest, specific copy for a `getUserMedia` rejection — the SAME "no generic failure" discipline
 *  `broker/broker.ts`'s own `explainFailure` and `voiceSession.ts`'s `mic-denied` code use.
 *  `DOMException.name` is the browser's own classification; anything unrecognized falls back to a
 *  message that still names the real error rather than inventing one. */
export function micPermissionErrorMessage(err: unknown): string {
	const name = err instanceof DOMException ? err.name : undefined;
	if (name === "NotAllowedError" || name === "PermissionDeniedError") return "Microphone access was denied.";
	if (name === "NotFoundError" || name === "DevicesNotFoundError") return "No microphone was found on this device.";
	if (name === "NotReadableError" || name === "TrackStartError") return "The microphone could not be started — it may be in use by another application.";
	if (err instanceof Error) return err.message;
	return "The microphone could not be opened.";
}

/**
 * Opens the microphone and streams resampled 16 kHz mono `Float32` PCM chunks via `onChunk`, using
 * an `AudioWorklet` (`/audio/mic-worklet.js` — a plain static asset, never bundled: a worklet module
 * must be an independently fetchable script) so capture runs on Web Audio's own render thread and
 * never glitches on a main-thread stall.
 *
 * Not unit-tested: `getUserMedia`/`AudioContext`/`AudioWorkletNode` have no faithful jsdom
 * implementation to test against, and a fake substitute would only prove this function calls fakes
 * correctly — the SAME "left for the operator to run" boundary `CALL-BROKER.md` already draws
 * around `omp live` driving a real provider connection. `connectVoiceCallAudio` and
 * `parseVoiceAudioStatusFrame` above (the actual wire logic) carry the real test coverage instead.
 */
export async function startMicCapture(onChunk: (samples: Float32Array) => void): Promise<MicCaptureHandle> {
	const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
	const audioContext = new AudioContext();
	await audioContext.audioWorklet.addModule("/audio/mic-worklet.js");
	const source = audioContext.createMediaStreamSource(stream);
	const worklet = new AudioWorkletNode(audioContext, "mic-capture", { processorOptions: { targetSampleRate: MIC_SAMPLE_RATE_HZ } });
	worklet.port.onmessage = (event) => onChunk(event.data as Float32Array);
	source.connect(worklet);
	// The worklet's own output is never connected anywhere — this is capture-only monitoring, not a
	// pass-through the operator would hear as a mic echo.
	return {
		stop() {
			worklet.port.onmessage = null;
			try {
				source.disconnect();
			} catch {
				/* already disconnected */
			}
			try {
				worklet.disconnect();
			} catch {
				/* already disconnected */
			}
			for (const track of stream.getTracks()) track.stop();
			void audioContext.close();
		},
	};
}

export interface PlaybackHandle {
	/** Queues one chunk of mono PCM16LE (little-endian) for playback, scheduled immediately after
	 *  whatever is already queued — never overlapping, never gapped by more than scheduling jitter. */
	push: (bytes: Uint8Array) => void;
	stop: () => void;
}

/**
 * Starts a Web Audio playback queue for streamed mono PCM16LE chunks — the standard
 * back-to-back-`AudioBufferSourceNode` technique for raw PCM streaming (no `<audio>` element, no
 * MediaSource, since neither speaks a headerless raw-sample format).
 *
 * Not unit-tested for the same reason `startMicCapture` above is not — `AudioContext` has no jsdom
 * implementation. The PCM16→Float32 conversion this function does inline is simple enough that a
 * bug here would show up as audible noise immediately in manual verification, which is the honest
 * bar CALL-BROKER.md already sets for this class of browser-audio-device code.
 */
export function startAudioPlayback(sampleRate = DEFAULT_OUTPUT_SAMPLE_RATE_HZ): PlaybackHandle {
	const audioContext = new AudioContext();
	let nextStartAt = audioContext.currentTime;
	return {
		push(bytes) {
			const sampleCount = bytes.length >> 1; // PCM16 → 2 bytes/sample; a stray trailing odd byte is dropped
			if (sampleCount === 0) return;
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			const float = new Float32Array(sampleCount);
			for (let i = 0; i < sampleCount; i += 1) float[i] = view.getInt16(i * 2, true) / 32768;
			const buffer = audioContext.createBuffer(1, sampleCount, sampleRate);
			buffer.copyToChannel(float, 0);
			const source = audioContext.createBufferSource();
			source.buffer = buffer;
			source.connect(audioContext.destination);
			const startAt = Math.max(nextStartAt, audioContext.currentTime);
			source.start(startAt);
			nextStartAt = startAt + buffer.duration;
		},
		stop() {
			void audioContext.close();
		},
	};
}

/**
 * voice-call-audio-mixer.ts — concern 13 (multi-party-calls): server-side additive mixing of N
 * browsers' microphone streams into the ONE mono input stream the realtime provider accepts.
 *
 * Design constraint named in the concern doc itself: the realtime provider is a single input
 * stream — there is no way to hand it N separate mic channels and have it treat them as N
 * speakers. Two strategies close that gap:
 *
 *   1. Server-side additive mixing (what this class does): sum every currently-pending
 *      participant's PCM samples into one frame, sample-by-sample, on a fixed local tick. Cheap,
 *      always-on, everyone can talk over everyone else exactly like a real room — but summing is
 *      literally what happens acoustically when N people talk at once, so a genuinely loud
 *      overlap clips (mitigated here with a hard [-1,1] clamp — audibly compressed, never garbage
 *      out-of-range PCM) and there is no per-speaker attribution once the streams are combined:
 *      the provider sees one merged "user" turn, not "guest A said X, host said Y". A live
 *      caption or transcript entry for that turn can name WHO IS PRESENT (the daemon knows every
 *      attached participant's authenticated identity), but not WHICH of them produced any given
 *      word — that information is gone the instant this class sums their samples.
 *   2. Push-to-talk floor control (the alternative the concern doc names, NOT built here): only
 *      one participant may hold the floor at a time, so the provider's single input stream is
 *      always unambiguously one speaker — attribution becomes exact, at the cost of a turn-taking
 *      UI and the "just talk over each other like a real call" feel additive mixing gives for
 *      free. Deferred; the concern's own sketch calls this "the key design decision" and asks to
 *      start with the simpler strategy.
 *
 * Every method here is pure/synchronous except `start`/`stop` (the only two that touch a real
 * timer) — `tick()` is exposed specifically so a test can drive the mix deterministically without
 * waiting on wall-clock time.
 */

const DEFAULT_INTERVAL_MS = 20; // matches the browser mic-worklet's own ~20ms chunk cadence

export interface VoiceCallAudioMixerOptions {
	/** How often pending participant frames are drained and mixed. Default 20ms — the same chunk
	 *  size `public/audio/mic-worklet.js` already emits, so a well-behaved single participant sees
	 *  no added latency beyond one tick's jitter. */
	intervalMs?: number;
	/** Fired with exactly one mixed frame per tick that had at least one pending participant frame.
	 *  A tick with nobody pending fires nothing — silence is the absence of a frame, not a frame of
	 *  zeros, matching how the single-participant relay already behaved before this class existed. */
	onMixedFrame: (samples: Float32Array) => void;
}

export class VoiceCallAudioMixer {
	private readonly intervalMs: number;
	private readonly onMixedFrame: (samples: Float32Array) => void;
	private readonly pending = new Map<string, Float32Array>();
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(opts: VoiceCallAudioMixerOptions) {
		this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
		this.onMixedFrame = opts.onMixedFrame;
	}

	/** One participant's latest chunk. A second push before the next tick REPLACES the first (this
	 *  is a mixer, not a queue — a participant whose network is faster than the tick interval must
	 *  not build an ever-growing backlog; the newest samples are always the most useful ones to mix
	 *  in, and a dropped intermediate chunk from a fast talker is an acceptable, documented cost of
	 *  "simple"). */
	push(participantId: string, samples: Float32Array): void {
		this.pending.set(participantId, samples);
	}

	/** Drops a participant's own pending frame — called on detach so a guest who just left never
	 *  contributes one final stale chunk to the next tick's mix. Harmless no-op if nothing was
	 *  pending (the common case: most ticks, most participants have nothing new to say). */
	remove(participantId: string): void {
		this.pending.delete(participantId);
	}

	/**
	 * Drains every currently-pending frame and, if any exist, fires exactly one mixed frame.
	 * Exposed publicly (not just called from the internal timer) so a test can drive the mix
	 * deterministically instead of racing real wall-clock time.
	 *
	 * One pending participant: their frame is forwarded byte-for-byte (no summing, no clamping) —
	 * a solo speaker must never have their own voice altered by a mixer that has nothing to mix.
	 * Two or more: summed sample-by-sample (frames of different lengths are summed only up to the
	 * shorter's length — the browser's own fixed 20ms chunking means this only ever bites a
	 * malformed/adversarial input, never a well-behaved participant) and hard-clamped to [-1, 1]
	 * — see the module doc for why clamping, not gain reduction, is this class's documented
	 * tradeoff.
	 */
	tick(): void {
		if (this.pending.size === 0) return;
		if (this.pending.size === 1) {
			const [only] = this.pending.values();
			this.pending.clear();
			this.onMixedFrame(only!);
			return;
		}
		let minLen = Number.POSITIVE_INFINITY;
		for (const s of this.pending.values()) minLen = Math.min(minLen, s.length);
		const mixed = new Float32Array(minLen === Number.POSITIVE_INFINITY ? 0 : minLen);
		for (const s of this.pending.values()) {
			for (let i = 0; i < mixed.length; i++) mixed[i] = (mixed[i] ?? 0) + s[i]!;
		}
		for (let i = 0; i < mixed.length; i++) mixed[i] = Math.max(-1, Math.min(1, mixed[i]!));
		this.pending.clear();
		this.onMixedFrame(mixed);
	}

	/** Idempotent — a second `start()` while already running is a no-op, matching every other
	 *  timer-owning class in this codebase (`JournalTailer`, `VoiceAttentionSource`, ...). */
	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.tick(), this.intervalMs);
		this.timer.unref?.(); // never keeps the process/test-runner alive on its own — same hygiene as every other interval in this file's siblings.
	}

	/** Idempotent. Clears any still-pending frames too — a stopped mixer must not silently mix a
	 *  stale chunk into whatever starts next on this same instance (in practice this class is
	 *  always torn down with its runtime and a fresh one built for the next call, but this keeps
	 *  the invariant true even if that ever changes). */
	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.pending.clear();
	}

	/** Test/diagnostic-only: how many participants currently have a frame pending. */
	get pendingCount(): number {
		return this.pending.size;
	}
}

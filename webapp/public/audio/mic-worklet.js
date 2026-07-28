/**
 * mic-worklet.js — concern 09 (browser-audio-transport).
 *
 * Runs on the AudioWorkletGlobalScope's separate render thread, not the main thread — this is the
 * modern, non-deprecated replacement for `ScriptProcessorNode` and the only way to read raw mic
 * samples in a browser today without an audible glitch every time the main thread does anything
 * else (GC pause, React render, a fetch callback).
 *
 * Served as a plain static asset (Vite's `public/` — never bundled through the module graph) so
 * `audioContext.audioWorklet.addModule('/audio/mic-worklet.js')` can fetch it as a real, independent
 * script, exactly what the Worklet spec requires.
 *
 * Job: downsample whatever the AudioContext's native input rate actually is (`sampleRate`, the
 * global this scope is constructed with — typically 48000 Hz; NOT assumed, since the browser is
 * free to grant something else) down to the target rate `omp live --no-local-audio` expects (16 kHz
 * mono, per PROTOCOL.md's "Browser audio transport" — `hello.audio.micSampleRate`), batch it into
 * fixed-size chunks, and post each chunk to the main thread. Linear-interpolation resampling: not
 * broadcast-quality, but voice at 16 kHz tolerates it fine, and it needs no external DSP dependency
 * running inside a worklet (which cannot import anything but its own inline code).
 */
class MicCaptureProcessor extends AudioWorkletProcessor {
	constructor(options) {
		super();
		const opts = (options && options.processorOptions) || {};
		this.targetRate = opts.targetSampleRate || 16000;
		this.inputRate = sampleRate; // AudioWorkletGlobalScope global — the REAL context rate, not a guess
		this.ratio = this.inputRate / this.targetRate;
		// Fractional resample cursor into the CURRENT render quantum's input, carried across quanta
		// so consecutive 128-sample blocks resample as one continuous stream, not 128 independent ones.
		this.cursor = 0;
		this.chunkSamples = Math.max(1, Math.round(this.targetRate * 0.02)); // ~20ms per chunk
		this.buffer = new Float32Array(this.chunkSamples);
		this.bufferLen = 0;
	}

	process(inputs) {
		const channel = inputs[0] && inputs[0][0];
		if (!channel || channel.length === 0) return true; // no mic data this quantum — keep the node alive
		let pos = this.cursor;
		while (pos < channel.length) {
			const i0 = Math.floor(pos);
			const i1 = Math.min(i0 + 1, channel.length - 1);
			const frac = pos - i0;
			this.buffer[this.bufferLen] = channel[i0] + (channel[i1] - channel[i0]) * frac;
			this.bufferLen += 1;
			if (this.bufferLen === this.chunkSamples) {
				// Transfer the underlying buffer — zero-copy handoff to the main thread; a fresh
				// Float32Array is allocated right after so this processor never touches transferred memory.
				this.port.postMessage(this.buffer, [this.buffer.buffer]);
				this.buffer = new Float32Array(this.chunkSamples);
				this.bufferLen = 0;
			}
			pos += this.ratio;
		}
		this.cursor = pos - channel.length;
		return true;
	}
}

registerProcessor("mic-capture", MicCaptureProcessor);

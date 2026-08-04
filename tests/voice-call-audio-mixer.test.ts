import { describe, expect, test } from "bun:test";
import { VoiceCallAudioMixer } from "../src/voice-call-audio-mixer.ts";

describe("VoiceCallAudioMixer (concern 13: multi-party-calls) — additive mixing tradeoff", () => {
	test("a solo pending participant is forwarded byte-for-byte, no summing or clamping", () => {
		const mixed: Float32Array[] = [];
		const mixer = new VoiceCallAudioMixer({ onMixedFrame: (f) => mixed.push(f) });
		const samples = new Float32Array([0.1, -0.9, 0.5]);
		mixer.push("a", samples);
		mixer.tick();
		expect(mixed).toHaveLength(1);
		expect(mixed[0]).toBe(samples); // same reference — never copied when there is nothing to mix in
	});

	test("two pending participants are summed sample-by-sample", () => {
		const mixed: Float32Array[] = [];
		const mixer = new VoiceCallAudioMixer({ onMixedFrame: (f) => mixed.push(f) });
		mixer.push("host", new Float32Array([0.1, 0.2, -0.1]));
		mixer.push("guest", new Float32Array([0.05, -0.1, 0.2]));
		mixer.tick();
		expect(mixed).toHaveLength(1);
		expect(Array.from(mixed[0]!)).toEqual([
			Math.fround(0.1 + 0.05),
			Math.fround(0.2 + -0.1),
			Math.fround(-0.1 + 0.2),
		]);
	});

	test("an overlapping loud sum is hard-clamped to [-1, 1], never left as out-of-range PCM", () => {
		const mixed: Float32Array[] = [];
		const mixer = new VoiceCallAudioMixer({ onMixedFrame: (f) => mixed.push(f) });
		mixer.push("a", new Float32Array([0.9, -0.9]));
		mixer.push("b", new Float32Array([0.9, -0.9]));
		mixer.push("c", new Float32Array([0.9, -0.9]));
		mixer.tick();
		expect(Array.from(mixed[0]!)).toEqual([1, -1]);
	});

	test("a tick with nobody pending fires nothing — silence is the absence of a frame", () => {
		const mixed: Float32Array[] = [];
		const mixer = new VoiceCallAudioMixer({ onMixedFrame: (f) => mixed.push(f) });
		mixer.tick();
		mixer.tick();
		expect(mixed).toHaveLength(0);
	});

	test("each tick drains — a second consecutive tick with nothing new pending fires nothing", () => {
		const mixed: Float32Array[] = [];
		const mixer = new VoiceCallAudioMixer({ onMixedFrame: (f) => mixed.push(f) });
		mixer.push("a", new Float32Array([0.1]));
		mixer.tick();
		mixer.tick();
		expect(mixed).toHaveLength(1);
	});

	test("a fast talker's second push before the next tick replaces the first, not queues both", () => {
		const mixed: Float32Array[] = [];
		const mixer = new VoiceCallAudioMixer({ onMixedFrame: (f) => mixed.push(f) });
		mixer.push("a", new Float32Array([0.1]));
		mixer.push("a", new Float32Array([0.9])); // supersedes — same participant, still not ticked
		expect(mixer.pendingCount).toBe(1);
		mixer.tick();
		expect(mixed).toHaveLength(1);
		expect(mixed[0]![0]).toBeCloseTo(0.9, 5);
	});

	test("remove() drops a departed participant's pending frame before the next tick mixes it in", () => {
		const mixed: Float32Array[] = [];
		const mixer = new VoiceCallAudioMixer({ onMixedFrame: (f) => mixed.push(f) });
		mixer.push("host", new Float32Array([0.2]));
		mixer.push("guest", new Float32Array([0.3]));
		mixer.remove("guest");
		mixer.tick();
		expect(mixed).toHaveLength(1);
		expect(mixed[0]![0]).toBeCloseTo(0.2, 5); // solo path — the removed guest never contributed
	});

	test("start()/stop() drive real ticks on an interval, and stop() clears pending frames", async () => {
		const mixed: Float32Array[] = [];
		const mixer = new VoiceCallAudioMixer({ intervalMs: 10, onMixedFrame: (f) => mixed.push(f) });
		mixer.start();
		mixer.start(); // idempotent — a second start() while running must not double up the timer
		mixer.push("a", new Float32Array([0.4]));
		await new Promise((r) => setTimeout(r, 60));
		expect(mixed.length).toBeGreaterThan(0);
		expect(mixed[0]![0]).toBeCloseTo(0.4, 5);
		mixer.push("a", new Float32Array([0.7]));
		mixer.stop();
		mixer.stop(); // idempotent
		expect(mixer.pendingCount).toBe(0);
		const before = mixed.length;
		await new Promise((r) => setTimeout(r, 40));
		expect(mixed.length).toBe(before); // no further ticks fire once stopped
	});
});

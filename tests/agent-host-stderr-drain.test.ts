/**
 * Regression for OMPSQ-145: the agent-host spawns omp with `stderr: "pipe"` but must DRAIN it.
 * A chatty child that writes more than the OS pipe buffer (~64KB) to stderr blocks on write(2)
 * and never exits unless someone reads the pipe — which hangs the agent. This proves the drain
 * pattern used in runAgentHost reads every byte and lets such a child exit. If the drain were
 * removed, the child would block past the buffer and this test would hang (runner timeout = fail).
 * Uses a generic chatty child, not real omp.
 */

import { expect, test } from "bun:test";

test("draining stderr (runAgentHost pattern) lets a chatty child exit", async () => {
	// ~256KB to stderr — well past the ~64KB pipe buffer, so an undrained pipe would stall the child.
	const child = "for (let i = 0; i < 4000; i++) process.stderr.write('x'.repeat(64) + '\\n'); process.exit(0);";
	const proc = Bun.spawn(["bun", "-e", child], { stdout: "ignore", stderr: "pipe" });

	let bytes = 0;
	const drain = (async () => {
		for await (const chunk of proc.stderr) bytes += chunk.length;
	})();

	const code = await proc.exited; // hangs (and fails) if the pipe is never drained
	await drain; // ensure every byte is counted before asserting (avoids racy bytes check)
	expect(code).toBe(0);
	expect(bytes).toBeGreaterThan(64 * 1024); // every byte drained, child unblocked
});

import { describe, expect, test } from "bun:test";
import { ingestAllHarnesses, type HarnessIngester } from "../src/ingest/harness.ts";

const mk = (name: string, onIngest: () => void, result = { scanned: 1, ingested: 1 }): HarnessIngester => ({
	name,
	ingest: async () => {
		onIngest();
		return result;
	},
});

describe("ingestAllHarnesses", () => {
	test("runs every ingester and isolates a failing one from the rest", async () => {
		const calls: string[] = [];
		const good = mk("good", () => calls.push("good"));
		const bad: HarnessIngester = {
			name: "bad",
			ingest: async () => {
				calls.push("bad");
				throw new Error("boom");
			},
		};
		const good2 = mk("good2", () => calls.push("good2"));
		// never throws despite `bad`, and `good2` still runs.
		await ingestAllHarnesses([good, bad, good2], `/tmp/state-${Math.random()}`, "/repo");
		expect(calls).toEqual(["good", "bad", "good2"]);
	});

	test("throttles per (stateDir, repo, harness): a second immediate call is skipped", async () => {
		let n = 0;
		const h = mk("throttled", () => n++);
		const stateDir = `/tmp/state-${Math.random()}`;
		await ingestAllHarnesses([h], stateDir, "/repo");
		await ingestAllHarnesses([h], stateDir, "/repo"); // within 5min → skipped
		expect(n).toBe(1);
		// a DIFFERENT repo is a different throttle key → runs
		await ingestAllHarnesses([h], stateDir, "/other-repo");
		expect(n).toBe(2);
	});
});

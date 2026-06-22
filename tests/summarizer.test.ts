/**
 * Vendored TF-IDF + TextRank summarizer — extractive selection behavior.
 *
 * Asserts the load-bearing contract: top-k count + original ordering, that a
 * graph-central topic outranks unrelated filler, and the <=k passthrough. Pure
 * logic, no IO.
 */

import { expect, test } from "bun:test";
import { splitSentences, summarize } from "../src/summarizer.ts";

test("summarize: returns exactly k sentences, a subsequence in original order", () => {
	const text = [
		"The deployment pipeline builds the container image from the source tree.",
		"Each pull request triggers the pipeline to run the full test suite.",
		"The pipeline then pushes the signed image to the private registry.",
		"A staging rollout verifies the image before any production deployment.",
		"Operators watch the dashboards while the rollout drains old replicas.",
		"Rollback restores the previous image whenever the health checks fail.",
	].join(" ");
	const all = splitSentences(text);
	const k = 3;
	const out = summarize(text, k);

	expect(out.length).toBe(k);
	for (const s of out) expect(all).toContain(s);
	// subsequence: chosen sentences keep their original relative order
	const idx = out.map((s) => all.indexOf(s));
	expect(idx).toEqual([...idx].sort((a, b) => a - b));
});

test("summarize: a graph-central topic sentence beats unrelated filler", () => {
	const text = [
		"The database index dramatically improves query performance for large tables.",
		"Query performance depends on whether the database index is selective enough.",
		"A selective database index lets the query planner skip most table rows.",
		"Building the right database index is the key to consistent query performance.",
		"Yesterday the orange cat napped quietly on the warm sunny windowsill.",
	].join(" ");
	const all = splitSentences(text);
	const filler = all[all.length - 1];
	const out = summarize(text, 2);

	expect(out.length).toBe(2);
	// the lone off-topic sentence shares no vocabulary, so it must not be picked
	expect(out).not.toContain(filler);
	// every pick is one of the central database-topic sentences
	for (const s of out) expect(all.slice(0, 4)).toContain(s);
});

test("summarize: <= k sentences returns them all unchanged", () => {
	const text = "The cache layer absorbs the read traffic from the origin server. It expires entries after a fixed time-to-live window.";
	const all = splitSentences(text);
	expect(all.length).toBe(2);
	expect(summarize(text, 8)).toEqual(all);
});

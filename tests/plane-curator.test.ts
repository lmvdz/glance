import { expect, test } from "bun:test";
import { clusterPlaneIssues, renderClusterHtml, renderClusterReport, type CuratorReport } from "../src/plane-curator.ts";

const issue = (id: string, name: string, text = "") => ({ id, identifier: `OMPSQ-${id}`, name, text });

test("clusters recurring Plane throttle/json issues as one unified fix", () => {
	const clusters = clusterPlaneIssues([
		issue("132", "[scout] do-not-auto-land: Fix res.json TypeError in listPlaneIssuesUncached during plane-throttle tests"),
		issue("141", "[scout] do-not-auto-land: Fix throttledFetch to retry after a 429 response"),
		issue("142", "[scout] do-not-auto-land: Add per-request timeout to throttledFetch to prevent Plane queue stalls"),
		issue("155", "[scout] do-not-auto-land: Isolate test suite from real Plane credentials to stop live api.plane.so calls"),
	]);

	expect(clusters).toHaveLength(1);
	expect(clusters[0].id).toBe("plane-client-boundary");
	expect(clusters[0].members.map((m) => m.identifier)).toEqual(["OMPSQ-132", "OMPSQ-141", "OMPSQ-142", "OMPSQ-155"]);
});

test("clusters landing recurrence separately from unrelated work", () => {
	const clusters = clusterPlaneIssues([
		issue("109", "land.ts: stash main's uncommitted changes around an auto-land instead of refusing on a dirty main"),
		issue("201", "[observer] do-not-auto-land: auto-land is systemically failing — 4 issues Done-but-unlanded"),
		issue("203", "[scout] do-not-auto-land: Re-land squad/ompsq-55, previously blocked by the tsbuildinfo dirty-tree issue"),
		issue("75", "fsync durability hardening of the persistence layer"),
	]);

	expect(clusters).toHaveLength(1);
	expect(clusters[0].id).toBe("auto-land-transactional-checkout");
	expect(clusters[0].members.map((m) => m.identifier)).toEqual(["OMPSQ-109", "OMPSQ-201", "OMPSQ-203"]);
});

test("fuzzy duplicate net catches repeated titles not covered by rules", () => {
	const clusters = clusterPlaneIssues([
		issue("1", "[scout] do-not-auto-land: Add retry to RPC client"),
		issue("2", "Add retry logic to the RPC client"),
		issue("3", "Rewrite the auth module"),
	]);

	expect(clusters).toHaveLength(1);
	expect(clusters[0].id).toContain("duplicate");
	expect(clusters[0].members.map((m) => m.identifier)).toEqual(["OMPSQ-1", "OMPSQ-2"]);
});

test("renderers include the grouped issues and filed summary", () => {
	const cluster = clusterPlaneIssues([
		issue("171", "[scout] do-not-auto-land: Close DNS-rebinding/TOCTOU window in vision SSRF guard by pinning resolved IP"),
		issue("205", "[scout] do-not-auto-land: Preserve SNI/cert validity when pinning public https vision targets to resolved IP"),
	])[0];
	const report: CuratorReport = { repo: "/repo", issueCount: 2, clusters: [cluster], filed: [{ id: "c1", name: "curator", identifier: "OMPSQ-300" }] };

	expect(renderClusterReport(report)).toContain("OMPSQ-300");
	expect(renderClusterReport(report)).toContain("OMPSQ-171");
	expect(renderClusterHtml(cluster)).toContain("Grouped issues");
	expect(renderClusterHtml(cluster)).toContain("OMPSQ-205");
});

import { expect, test } from "bun:test";
import { buildChannelThreadViews, previewChannelBody } from "../webapp/src/lib/channelTimeline.ts";
import { gateVerdictHref, hubHref, parseHubHash } from "../webapp/src/lib/router.ts";
import type { ChannelEntry } from "../webapp/src/lib/dto.ts";

const entry = (patch: Partial<ChannelEntry> & Pick<ChannelEntry, "id" | "seq" | "text">): ChannelEntry => ({
	channelId: "fleet",
	authorActor: "web:operator",
	kind: "user",
	ts: patch.seq,
	status: "ok",
	...patch,
});

test("buildChannelThreadViews renders flat reply context without nesting replies", () => {
	const rows = buildChannelThreadViews([
		entry({ id: "root", seq: 1, text: "Root message with enough detail to quote" }),
		entry({ id: "reply-1", seq: 2, text: "First answer", replyToId: "root" }),
		entry({ id: "reply-2", seq: 3, text: "Second answer", replyToId: "reply-1" }),
	]);

	expect(rows.find((row) => row.id === "root")?.repliedBy).toBe(1);
	expect(rows.find((row) => row.id === "reply-1")?.replyContext).toMatchObject({ id: "root", body: "Root message with enough detail to quote" });
	expect(rows.find((row) => row.id === "reply-1")?.repliedBy).toBe(1);
	expect(rows.find((row) => row.id === "reply-2")?.replyContext).toMatchObject({ id: "reply-1", body: "First answer" });
});

test("channel entry deep links round-trip through the hash router", () => {
	const href = hubHref("ops/incidents", "entry:42");
	expect(href).toBe("#/channel/ops%2Fincidents/entry/entry%3A42");
	expect(parseHubHash(href)).toEqual({ kind: "hub", channelId: "ops/incidents", entryId: "entry:42" });
});

test("gate verdict deep links round-trip channel and entry ids through the hash router", () => {
	const href = gateVerdictHref("ops/incidents", "entry:42");
	expect(href).toBe("#/gate-verdict/ops%2Fincidents/entry%3A42");
	expect(parseHubHash(href)).toEqual({ kind: "workbench", view: "gate-verdict", id: "ops/incidents\u0000entry:42" });
});

test("previewChannelBody compacts multi-line snippets", () => {
	expect(previewChannelBody("one\n\n two   three", 20)).toBe("one two three");
	expect(previewChannelBody("x".repeat(130), 12)).toBe("xxxxxxxxxxx…");
});

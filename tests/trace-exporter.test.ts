import { expect, test } from "bun:test";
import { TraceExportQueue, type Exporter } from "../src/trace-exporter.ts";
import type { Span } from "../src/spans.ts";

const span = (id: string): Span => ({ traceId: "t", spanId: id, name: id, kind: "tool", startedAt: 1, endedAt: 2, status: "ok" });

test("TraceExportQueue is bounded and drops oldest without throwing", async () => {
	const seen: string[] = [];
	const gate = Promise.withResolvers<void>();
	const done = Promise.withResolvers<void>();
	const exporter: Exporter = {
		name: "fake",
		export: async (spans) => {
			seen.push(...spans.map((s) => s.spanId));
			if (seen.includes("fourth")) done.resolve();
			await gate.promise;
		},
	};
	const q = new TraceExportQueue([exporter], { max: 2 });
	q.enqueue([span("first")], { service: "test" });
	q.enqueue([span("second")], { service: "test" });
	q.enqueue([span("third")], { service: "test" });
	q.enqueue([span("fourth")], { service: "test" });

	expect(q.stats.dropped).toBe(1);
	expect(seen).toEqual(["first"]);
	gate.resolve();
	await done.promise;
	expect(seen).toEqual(["first", "third", "fourth"]);
});

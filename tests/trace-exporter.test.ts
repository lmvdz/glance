import { afterEach, expect, test } from "bun:test";
import { OtlpHttpExporter, TraceExportQueue, traceCollectorAllow, type Exporter } from "../src/trace-exporter.ts";
import type { Span } from "../src/spans.ts";

const span = (id: string): Span => ({ traceId: "t", spanId: id, name: id, kind: "tool", startedAt: 1, endedAt: 2, status: "ok" });

// ── #10: SSRF guard must not block operator-configured (trusted) private collectors ──────────────
const TRACE_ENV = [
	"OMP_SQUAD_TRACE_ALLOW_PRIVATE",
	"OMP_SQUAD_APP_URL",
	"OMP_SQUAD_TRACE_EXPORT_OTLP_URL",
	"OMP_SQUAD_TRACE_EXPORT_LANGFUSE_URL",
	"OMP_SQUAD_TRACE_EXPORT_DATADOG_URL",
] as const;
const savedTrace: Record<string, string | undefined> = {};
for (const k of TRACE_ENV) savedTrace[k] = process.env[k];
afterEach(() => {
	for (const k of TRACE_ENV) {
		if (savedTrace[k] === undefined) delete process.env[k];
		else process.env[k] = savedTrace[k];
	}
});

const okFetch = (sink: { url?: string; calls: number }) =>
	(async (url: string) => {
		sink.calls++;
		sink.url = url;
		return new Response("ok", { status: 200 });
	}) as unknown as typeof fetch;

test("(#10) a configured private collector is blocked by default (no opt-in)", async () => {
	delete process.env.OMP_SQUAD_TRACE_ALLOW_PRIVATE;
	process.env.OMP_SQUAD_TRACE_EXPORT_OTLP_URL = "http://127.0.0.1:4318/v1/traces";
	const sink = { calls: 0 } as { url?: string; calls: number };
	const otlp = new OtlpHttpExporter(process.env.OMP_SQUAD_TRACE_EXPORT_OTLP_URL, okFetch(sink));
	await expect(otlp.export([span("s1")], { service: "t" })).rejects.toThrow(/private\/loopback/);
	expect(sink.calls).toBe(0); // blocked before any network call
});

test("(#10) opt-in (OMP_SQUAD_TRACE_ALLOW_PRIVATE=1) allows the operator-configured private collector", async () => {
	process.env.OMP_SQUAD_TRACE_ALLOW_PRIVATE = "1";
	process.env.OMP_SQUAD_TRACE_EXPORT_OTLP_URL = "http://127.0.0.1:4318/v1/traces";
	const sink = { calls: 0 } as { url?: string; calls: number };
	const otlp = new OtlpHttpExporter(process.env.OMP_SQUAD_TRACE_EXPORT_OTLP_URL, okFetch(sink));
	await otlp.export([span("s1")], { service: "t" });
	expect(sink.url).toBe("http://127.0.0.1:4318/v1/traces");
});

test("(#10) opt-in exempts ONLY the configured origin(s) — a DIFFERENT private host is still blocked", async () => {
	process.env.OMP_SQUAD_TRACE_ALLOW_PRIVATE = "1";
	process.env.OMP_SQUAD_TRACE_EXPORT_OTLP_URL = "http://10.0.0.5:4318/v1/traces"; // the configured (trusted) collector
	const allow = traceCollectorAllow();
	expect(allow.has("http://10.0.0.5:4318")).toBe(true); // configured ⇒ trusted
	// A non-configured private/metadata host is NOT trusted, even with the opt-in on.
	const sink = { calls: 0 } as { url?: string; calls: number };
	const rogue = new OtlpHttpExporter("http://169.254.169.254/latest/meta-data/", okFetch(sink));
	await expect(rogue.export([span("s1")], { service: "t" })).rejects.toThrow(/private\/loopback/);
	expect(sink.calls).toBe(0);
});

test("(#10) traceCollectorAllow: no opt-in ⇒ a configured collector origin is NOT exempt", () => {
	delete process.env.OMP_SQUAD_TRACE_ALLOW_PRIVATE;
	process.env.OMP_SQUAD_TRACE_EXPORT_OTLP_URL = "http://127.0.0.1:4318/v1/traces";
	expect(traceCollectorAllow().has("http://127.0.0.1:4318")).toBe(false);
});

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

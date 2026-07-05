import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { LocalFileExporter, OtlpHttpExporter, TraceExportQueue, traceCollectorAllow, traceExporterFromEnv, type Exporter } from "../src/trace-exporter.ts";
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

// ── D4: durable local export sink + bounded retry ─────────────────────────────────────────────

test("(D4) LocalFileExporter appends an NDJSON line that round-trips back to the input spans", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trace-local-"));
	try {
		const file = path.join(dir, "nested", "traces.jsonl");
		const exporter = new LocalFileExporter(file);
		const spans = [span("s1"), span("s2")];
		await exporter.export(spans, { service: "omp-squad", repo: "/repo" });
		const text = await fs.readFile(file, "utf8");
		const lines = text.split("\n").filter((l) => l.trim());
		expect(lines.length).toBe(1);
		const parsed = JSON.parse(lines[0]) as { at: number; resource: { service: string }; spans: Span[] };
		expect(parsed.resource.service).toBe("omp-squad");
		expect(parsed.spans).toEqual(spans);
		expect(typeof parsed.at).toBe("number");

		// A second export appends rather than overwriting.
		await exporter.export([span("s3")], { service: "omp-squad" });
		const lines2 = (await fs.readFile(file, "utf8")).split("\n").filter((l) => l.trim());
		expect(lines2.length).toBe(2);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("(D4) TraceExportQueue retries a failing exporter before counting it failed", async () => {
	let calls = 0;
	const exporter: Exporter = {
		name: "flaky",
		export: async () => {
			calls++;
			if (calls < 3) throw new Error("transient");
		},
	};
	const q = new TraceExportQueue([exporter]);
	q.enqueue([span("s1")], { service: "test" });
	await Promise.resolve();
	await new Promise((r) => setTimeout(r, 300));
	expect(calls).toBe(3);
	expect(q.stats.exported).toBe(1);
	expect(q.stats.failed).toBe(0);
});

test("(D4) TraceExportQueue counts a batch failed only after RETRY_MAX attempts are all exhausted", async () => {
	let calls = 0;
	const exporter: Exporter = {
		name: "always-fails",
		export: async () => {
			calls++;
			throw new Error("down");
		},
	};
	const q = new TraceExportQueue([exporter], { log: () => {} });
	q.enqueue([span("s1")], { service: "test" });
	await new Promise((r) => setTimeout(r, 300));
	expect(calls).toBe(3);
	expect(q.stats.failed).toBe(1);
	expect(q.stats.exported).toBe(0);
});

test("(D4) traceExporterFromEnv(undefined, stateDir) with no OTLP/Langfuse/Datadog env returns a defined queue (local sink default-on)", async () => {
	for (const k of ["OMP_SQUAD_TRACE_EXPORT_OTLP_URL", "OMP_SQUAD_TRACE_EXPORT_LANGFUSE_URL", "OMP_SQUAD_TRACE_EXPORT_DATADOG_URL", "OMP_SQUAD_TRACE_LOCAL"]) delete process.env[k];
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trace-local-env-"));
	try {
		const queue = traceExporterFromEnv(undefined, dir);
		expect(queue).toBeDefined();
		queue!.enqueue([span("s1")], { service: "omp-squad" });
		await new Promise((r) => setTimeout(r, 50));
		const text = await fs.readFile(path.join(dir, "traces.jsonl"), "utf8");
		expect(text.trim().length).toBeGreaterThan(0);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("(D4) OMP_SQUAD_TRACE_LOCAL=0 opts out of the local sink; no other exporters configured ⇒ undefined", () => {
	for (const k of ["OMP_SQUAD_TRACE_EXPORT_OTLP_URL", "OMP_SQUAD_TRACE_EXPORT_LANGFUSE_URL", "OMP_SQUAD_TRACE_EXPORT_DATADOG_URL"]) delete process.env[k];
	process.env.OMP_SQUAD_TRACE_LOCAL = "0";
	try {
		expect(traceExporterFromEnv(undefined, "/tmp/whatever")).toBeUndefined();
	} finally {
		delete process.env.OMP_SQUAD_TRACE_LOCAL;
	}
});

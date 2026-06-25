/** Bounded trace export seam. No SDK, no durable retry: receipts are source of truth. */

import { checkVisionUrl } from "./ssrf.ts";
import type { Span } from "./spans.ts";

export interface TraceResource {
	service: string;
	repo?: string;
	operator?: string;
	org?: string;
}

export interface Exporter {
	name: string;
	export(spans: Span[], resource: TraceResource): Promise<void>;
}

type FetchLike = typeof fetch;

const DEFAULT_TIMEOUT_MS = 5_000;

function timeoutMs(): number {
	const n = Number(process.env.OMP_SQUAD_TRACE_EXPORT_TIMEOUT_MS);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

async function guardedPost(url: string, body: unknown, headers: Record<string, string>, fetcher: FetchLike): Promise<void> {
	const checked = await checkVisionUrl(url);
	if (!checked.ok) throw new Error(checked.reason);
	const res = await fetcher(checked.url.href, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs()),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

function hashHex(input: string, chars: number): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0").repeat(Math.ceil(chars / 8)).slice(0, chars);
}

export class OtlpHttpExporter implements Exporter {
	readonly name = "otlp";
	constructor(private readonly url: string, private readonly fetcher: FetchLike = fetch) {}

	async export(spans: Span[], resource: TraceResource): Promise<void> {
		await guardedPost(
			this.url,
			{
				resourceSpans: [
					{
						resource: { attributes: Object.entries(resource).filter(([, value]) => value !== undefined).map(([key, value]) => ({ key: `service.${key}`, value: { stringValue: String(value) } })) },
						scopeSpans: [
							{
								scope: { name: "omp-squad" },
								spans: spans.map((s) => ({
									traceId: hashHex(s.traceId, 32),
									spanId: hashHex(s.spanId, 16),
									parentSpanId: s.parentSpanId ? hashHex(s.parentSpanId, 16) : undefined,
									name: s.name,
									kind: 1,
									startTimeUnixNano: String(Math.floor(s.startedAt * 1_000_000)),
									endTimeUnixNano: String(Math.floor((s.endedAt ?? Date.now()) * 1_000_000)),
									status: { code: s.status === "error" ? 2 : 1 },
									attributes: Object.entries({ kind: s.kind, ...(s.attrs ?? {}) }).map(([key, value]) => ({ key, value: { stringValue: String(value) } })),
								})),
							},
						],
					},
				],
			},
			{},
			this.fetcher,
		);
	}
}

export class LangfuseExporter implements Exporter {
	readonly name = "langfuse";
	constructor(private readonly url: string, private readonly publicKey?: string, private readonly secretKey?: string, private readonly fetcher: FetchLike = fetch) {}

	async export(spans: Span[], resource: TraceResource): Promise<void> {
		const auth: Record<string, string> = this.publicKey && this.secretKey ? { Authorization: `Basic ${btoa(`${this.publicKey}:${this.secretKey}`)}` } : {};
		await guardedPost(this.url, { batch: spans.map((s) => ({ type: "span", id: s.spanId, traceId: s.traceId, parentObservationId: s.parentSpanId, name: s.name, startTime: new Date(s.startedAt).toISOString(), endTime: new Date(s.endedAt ?? Date.now()).toISOString(), metadata: { kind: s.kind, status: s.status, resource, ...(s.attrs ?? {}) } })) }, auth, this.fetcher);
	}
}

export class DatadogExporter implements Exporter {
	readonly name = "datadog";
	constructor(private readonly url: string, private readonly apiKey?: string, private readonly fetcher: FetchLike = fetch) {}

	async export(spans: Span[], resource: TraceResource): Promise<void> {
		await guardedPost(
			this.url,
			spans.map((s) => ({ trace_id: hashHex(s.traceId, 16), span_id: hashHex(s.spanId, 16), parent_id: s.parentSpanId ? hashHex(s.parentSpanId, 16) : undefined, name: s.name, service: resource.service, resource: resource.repo, start: Math.floor(s.startedAt * 1_000_000), duration: Math.max(0, Math.floor(((s.endedAt ?? Date.now()) - s.startedAt) * 1_000_000)), error: s.status === "error" ? 1 : 0, meta: { kind: s.kind, ...(s.attrs ?? {}) } })),
			this.apiKey ? { "DD-API-KEY": this.apiKey } : {},
			this.fetcher,
		);
	}
}

export class TraceExportQueue {
	readonly stats = { dropped: 0, failed: 0, exported: 0 };
	private readonly queue: { spans: Span[]; resource: TraceResource }[] = [];
	private draining = false;

	constructor(private readonly exporters: Exporter[], private readonly opts: { max?: number; log?: (message: string) => void } = {}) {}

	enqueue(spans: Span[], resource: TraceResource): void {
		if (!spans.length || !this.exporters.length) return;
		const max = this.opts.max ?? 1000;
		while (this.queue.length >= max) {
			this.queue.shift();
			this.stats.dropped++;
		}
		this.queue.push({ spans, resource });
		void this.drain();
	}

	private async drain(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			for (let item = this.queue.shift(); item; item = this.queue.shift()) {
				for (const exporter of this.exporters) {
					try {
						await exporter.export(item.spans, item.resource);
						this.stats.exported += item.spans.length;
					} catch (err) {
						this.stats.failed += item.spans.length;
						if (this.stats.failed === item.spans.length || this.stats.failed % 100 === 0) this.opts.log?.(`trace exporter ${exporter.name} failed: ${err instanceof Error ? err.message : String(err)}`);
					}
				}
			}
		} finally {
			this.draining = false;
			if (this.queue.length) void this.drain();
		}
	}
}

export function traceExporterFromEnv(log?: (message: string) => void): TraceExportQueue | undefined {
	const exporters: Exporter[] = [];
	if (process.env.OMP_SQUAD_TRACE_EXPORT_OTLP_URL) exporters.push(new OtlpHttpExporter(process.env.OMP_SQUAD_TRACE_EXPORT_OTLP_URL));
	if (process.env.OMP_SQUAD_TRACE_EXPORT_LANGFUSE_URL) exporters.push(new LangfuseExporter(process.env.OMP_SQUAD_TRACE_EXPORT_LANGFUSE_URL, process.env.OMP_SQUAD_TRACE_EXPORT_LANGFUSE_PUBLIC_KEY, process.env.OMP_SQUAD_TRACE_EXPORT_LANGFUSE_SECRET_KEY));
	if (process.env.OMP_SQUAD_TRACE_EXPORT_DATADOG_URL) exporters.push(new DatadogExporter(process.env.OMP_SQUAD_TRACE_EXPORT_DATADOG_URL, process.env.OMP_SQUAD_TRACE_EXPORT_DATADOG_API_KEY));
	if (!exporters.length) return undefined;
	const max = Number(process.env.OMP_SQUAD_TRACE_EXPORT_QUEUE);
	return new TraceExportQueue(exporters, { max: Number.isFinite(max) && max > 0 ? Math.floor(max) : 1000, log });
}

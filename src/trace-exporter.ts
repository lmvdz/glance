/** Bounded trace export seam. No SDK; receipts remain the durable source of truth — this is an
 *  external-tool-friendly copy, with a bounded retry so a transient collector blip doesn't drop it. */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { allowlistOrigins, checkVisionUrl } from "./ssrf.ts";
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

/**
 * Trace collectors normally live on loopback/RFC1918 (a local OTLP agent, a private Langfuse, a
 * tailnet Datadog gateway), which the shared SSRF guard blocks by default. Unlike the vision pass —
 * whose target URL is supplied by an untrusted caller — the collector URL comes from TRUSTED daemon
 * config/env, so it's safe to exempt it from the private-range block. We do that ONLY when the
 * operator opts in via `OMP_SQUAD_TRACE_ALLOW_PRIVATE=1`, and ONLY for the exact origin(s) the
 * operator configured — never a blanket bypass. An empty set ⇒ the strict guard applies unchanged.
 */
function traceAllowPrivate(): boolean {
	return process.env.OMP_SQUAD_TRACE_ALLOW_PRIVATE === "1";
}

/** Origin of a configured collector URL, or undefined if malformed/empty. */
function originOf(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		return new URL(url).origin;
	} catch {
		return undefined;
	}
}

/**
 * The allow set for the trace-export SSRF check. Always includes the vision pass's default
 * (`OMP_SQUAD_APP_URL`). When `OMP_SQUAD_TRACE_ALLOW_PRIVATE=1`, additionally exempts the exact
 * origins of the OPERATOR-CONFIGURED collector endpoints (the three `OMP_SQUAD_TRACE_EXPORT_*_URL`
 * env vars) so a private/loopback collector is reached — while any OTHER private host (a redirect, a
 * stray non-configured URL, a metadata IP) is STILL blocked. We exempt only origins the operator put
 * in config, never the URL-being-posted's own origin, so the trust is anchored to config, not to the
 * request. An empty/no-opt-in set ⇒ the strict guard applies unchanged.
 */
export function traceCollectorAllow(): Set<string> {
	const allow = allowlistOrigins();
	if (!traceAllowPrivate()) return allow;
	for (const env of [
		process.env.OMP_SQUAD_TRACE_EXPORT_OTLP_URL,
		process.env.OMP_SQUAD_TRACE_EXPORT_LANGFUSE_URL,
		process.env.OMP_SQUAD_TRACE_EXPORT_DATADOG_URL,
	]) {
		const origin = originOf(env);
		if (origin) allow.add(origin);
	}
	return allow;
}

async function guardedPost(url: string, body: unknown, headers: Record<string, string>, fetcher: FetchLike, allow: Set<string> = traceCollectorAllow()): Promise<void> {
	const checked = await checkVisionUrl(url, allow);
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

/**
 * D4: spans leave the daemon by default. Appends every exported batch as one NDJSON line to
 * `<stateDir>/traces.jsonl` — a local, dependency-free, external-tool-friendly copy. Not a read
 * path: `manager.trace()` never reads this file back; receipts + audit remain the source of truth.
 */
export class LocalFileExporter implements Exporter {
	readonly name = "local-file";
	constructor(private readonly file: string) {}

	async export(spans: Span[], resource: TraceResource): Promise<void> {
		await fs.mkdir(path.dirname(this.file), { recursive: true });
		await fs.appendFile(this.file, `${JSON.stringify({ at: Date.now(), resource, spans })}\n`);
	}
}

/** Bounded retry before a batch counts as failed — a transient collector blip (or a momentarily
 *  full disk for the local sink) shouldn't silently drop spans. The queue's overflow-drop (below)
 *  remains the last-resort bound for an unbounded backlog; retry only covers transient failures. */
const RETRY_MAX = 3;
const RETRY_BACKOFF_MS = 50;

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
					let ok = false;
					let lastErr: unknown;
					for (let attempt = 1; attempt <= RETRY_MAX && !ok; attempt++) {
						try {
							await exporter.export(item.spans, item.resource);
							ok = true;
						} catch (err) {
							lastErr = err;
							if (attempt < RETRY_MAX) await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * attempt));
						}
					}
					if (ok) {
						this.stats.exported += item.spans.length;
					} else {
						this.stats.failed += item.spans.length;
						if (this.stats.failed === item.spans.length || this.stats.failed % 100 === 0) this.opts.log?.(`trace exporter ${exporter.name} failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
					}
				}
			}
		} finally {
			this.draining = false;
			if (this.queue.length) void this.drain();
		}
	}
}

/**
 * `stateDir`, when given, always adds the durable local NDJSON sink (D4) unless the operator opts
 * out with `OMP_SQUAD_TRACE_LOCAL=0` — so this now rarely returns `undefined` in the default config;
 * spans leave the daemon (to disk, at least) without requiring an OTLP/Langfuse/Datadog collector.
 */
export function traceExporterFromEnv(log?: (message: string) => void, stateDir?: string): TraceExportQueue | undefined {
	const exporters: Exporter[] = [];
	if (process.env.OMP_SQUAD_TRACE_EXPORT_OTLP_URL) exporters.push(new OtlpHttpExporter(process.env.OMP_SQUAD_TRACE_EXPORT_OTLP_URL));
	if (process.env.OMP_SQUAD_TRACE_EXPORT_LANGFUSE_URL) exporters.push(new LangfuseExporter(process.env.OMP_SQUAD_TRACE_EXPORT_LANGFUSE_URL, process.env.OMP_SQUAD_TRACE_EXPORT_LANGFUSE_PUBLIC_KEY, process.env.OMP_SQUAD_TRACE_EXPORT_LANGFUSE_SECRET_KEY));
	if (process.env.OMP_SQUAD_TRACE_EXPORT_DATADOG_URL) exporters.push(new DatadogExporter(process.env.OMP_SQUAD_TRACE_EXPORT_DATADOG_URL, process.env.OMP_SQUAD_TRACE_EXPORT_DATADOG_API_KEY));
	if (stateDir && process.env.OMP_SQUAD_TRACE_LOCAL !== "0") exporters.push(new LocalFileExporter(path.join(stateDir, "traces.jsonl")));
	if (!exporters.length) return undefined;
	const max = Number(process.env.OMP_SQUAD_TRACE_EXPORT_QUEUE);
	return new TraceExportQueue(exporters, { max: Number.isFinite(max) && max > 0 ? Math.floor(max) : 1000, log });
}

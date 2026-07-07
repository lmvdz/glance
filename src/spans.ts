/**
 * Minimal trace/span spine for fleet runs.
 *
 * Spans ride receipts; no OTel SDK, no live stream, no second store. The only
 * durable fact we add is optional `traceId`/`spans` on RunReceipt, then the API
 * assembles a tree at read time with audit-derived lifecycle spans.
 */

import { redact } from "./redact.ts";
import { envBool } from "./config.ts";
import type { AgentStatus, AuditEntry, RunReceipt } from "./types.ts";

// "spawn" covers audit create/commission/fork actions (D2 — "why spawned"); "validate" is a
// forward-declaration for Epic 3's independent-validator audit action, woven if/when it exists.
export type SpanKind = "run" | "node" | "tool" | "subagent" | "verify" | "spawn" | "validate" | "land" | "resolve";
export type SpanStatus = "ok" | "error" | "running";

export interface Span {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind: SpanKind;
	startedAt: number;
	endedAt?: number;
	status: SpanStatus;
	attrs?: Record<string, string>;
}

export interface SpanSeed {
	agentId: string;
	name: string;
	repo: string;
	branch?: string;
	model?: string;
	featureId?: string;
	parentId?: string;
	issue?: string;
	operator?: string;
	org?: string;
}

export interface TraceRollup {
	runs: number;
	toolCalls: number;
	costUsd: number;
	tokens: number;
	durationMs: number;
	errors: number;
}

export interface TraceNode extends Span {
	children: TraceNode[];
	rollup: TraceRollup;
	/** The run receipt that contributed this run node, when this is a run span. */
	receipt?: RunReceipt;
}

export interface TraceResponse {
	traceId: string;
	root: TraceNode;
	rollup: TraceRollup;
	receipts: RunReceipt[];
	/** True when at least one receipt has NO spans at all (legacy/pre-D1 rows) — the decision spine is
	 *  genuinely missing, not just tool-level detail. A finalized post-D1 receipt always has its
	 *  structural spine, so this stays false for it regardless of tool sampling. */
	partial: boolean;
	/** True when at least one contributing receipt had its tool-level spans tail-sampled out (D1). A
	 *  softer, honest signal than `partial` — "full spine, tool detail sampled" vs. "spine missing." */
	sampled: boolean;
}

const ATTR_KEYS: Record<string, true> = { model: true, repo: true, feature: true, operator: true, org: true, issue: true, branch: true, agent: true, parent: true, digest: true };

export function traceIdFor(seed: { agentId: string; runId: string; featureId?: string }): string {
	return seed.featureId ? `feat:${seed.featureId}` : `run:${seed.agentId}:${seed.runId}`;
}

export function traceSpansEnabled(): boolean {
	return envBool("OMP_SQUAD_TRACE", true);
}

export function traceSampleRatio(): number {
	const raw = process.env.OMP_SQUAD_TRACE_SAMPLE;
	if (raw === undefined || raw === "") return 0.1;
	const n = Number(raw);
	return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.1;
}

export function traceMaxSpans(): number {
	const n = Number(process.env.OMP_SQUAD_TRACE_MAX_SPANS);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 500;
}

function attrs(input: Record<string, unknown>): Record<string, string> | undefined {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(input)) {
		if (!ATTR_KEYS[k] || v === undefined || v === null || v === "") continue;
		out[k] = redact(String(v)).slice(0, 240);
	}
	return Object.keys(out).length ? out : undefined;
}

function emptyRollup(): TraceRollup {
	return { runs: 0, toolCalls: 0, costUsd: 0, tokens: 0, durationMs: 0, errors: 0 };
}

function addRollup(a: TraceRollup, b: TraceRollup): void {
	a.runs += b.runs;
	a.toolCalls += b.toolCalls;
	a.costUsd += b.costUsd;
	a.tokens += b.tokens;
	a.durationMs += b.durationMs;
	a.errors += b.errors;
}

function receiptRollup(r: RunReceipt): TraceRollup {
	return {
		runs: 1,
		toolCalls: r.toolCalls,
		costUsd: r.costUsd ?? 0,
		tokens: r.tokens?.total ?? 0,
		durationMs: r.durationMs ?? (r.endedAt && r.startedAt ? Math.max(0, r.endedAt - r.startedAt) : 0),
		errors: r.status === "error" ? 1 : 0,
	};
}

function statusOf(status: AgentStatus | string | undefined): SpanStatus {
	if (status === "error" || status === "failed" || status === "aborted") return "error";
	if (status === "working" || status === "starting" || status === "input" || status === undefined) return "running";
	return "ok";
}

export class SpanCollector {
	private readonly seed: SpanSeed;
	private traceId = "";
	private runId = "";
	private seq = 0;
	private runSpanId = "";
	private currentNodeId?: string;
	private currentToolId?: string;
	private readonly subagentSpans = new Map<string, string>();
	private readonly spans: Span[] = [];

	constructor(seed: SpanSeed) {
		this.seed = { ...seed };
	}

	get id(): string {
		return this.traceId;
	}

	start(runId: string, at: number, model?: string): void {
		if (model) this.seed.model = model;
		if (this.runSpanId) return;
		this.runId = runId;
		this.traceId = traceIdFor({ agentId: this.seed.agentId, runId, featureId: this.seed.featureId });
		this.runSpanId = this.nextId();
		this.spans.push({
			traceId: this.traceId,
			spanId: this.runSpanId,
			name: `run:${this.seed.name}`,
			kind: "run",
			startedAt: at,
			status: "running",
			// `digest` (D3) links this run span to `GET /api/digest/:id` — the compact, already-fenced
			// reasoning/IO for this agent — without inlining raw prompts/outputs into span attrs.
			attrs: attrs({ repo: this.seed.repo, branch: this.seed.branch, model: this.seed.model, feature: this.seed.featureId, parent: this.seed.parentId, issue: this.seed.issue, operator: this.seed.operator, org: this.seed.org, agent: this.seed.agentId, digest: this.seed.agentId }),
		});
	}

	onTool(toolName: string, intent = "", at = Date.now()): void {
		if (!this.runSpanId) return;
		this.closeActiveTool("ok", at);
		if (toolName === "stage") {
			this.closeCurrentNode("ok", at);
			this.currentNodeId = this.nextId();
			this.spans.push({
				traceId: this.traceId,
				spanId: this.currentNodeId,
				parentSpanId: this.runSpanId,
				name: `node:${intent || "stage"}`,
				kind: "node",
				startedAt: at,
				status: "running",
				attrs: attrs({ feature: this.seed.featureId, agent: this.seed.agentId }),
			});
			return;
		}
		this.currentToolId = this.nextId();
		this.spans.push({
			traceId: this.traceId,
			spanId: this.currentToolId,
			parentSpanId: this.currentNodeId ?? this.runSpanId,
			name: `tool:${toolName}`,
			kind: "tool",
			startedAt: at,
			status: "running",
			attrs: attrs({ feature: this.seed.featureId, agent: this.seed.agentId }),
		});
	}

	onMessageEnd(at = Date.now()): void {
		this.closeActiveTool("ok", at);
	}

	onSubagentFrame(frame: { type: string; payload?: unknown }, at = Date.now()): void {
		if (!this.runSpanId || !frame.payload || typeof frame.payload !== "object") return;
		const p = frame.payload as { id?: unknown; agent?: unknown; description?: unknown; status?: unknown; progress?: { id?: unknown; agent?: unknown; description?: unknown; status?: unknown } };
		const id = typeof p.id === "string" ? p.id : typeof p.progress?.id === "string" ? p.progress.id : undefined;
		if (!id) return;
		const agent = typeof p.agent === "string" ? p.agent : typeof p.progress?.agent === "string" ? p.progress.agent : "subagent";
		const status = typeof p.status === "string" ? p.status : typeof p.progress?.status === "string" ? p.progress.status : "running";
		let spanId = this.subagentSpans.get(id);
		if (!spanId) {
			spanId = this.nextId();
			this.subagentSpans.set(id, spanId);
			this.spans.push({
				traceId: this.traceId,
				spanId,
				parentSpanId: this.currentNodeId ?? this.runSpanId,
				name: `subagent:${agent}`,
				kind: "subagent",
				startedAt: at,
				status: "running",
				attrs: attrs({ feature: this.seed.featureId, agent, parent: this.seed.agentId }),
			});
		}
		if (status === "completed" || status === "failed" || status === "aborted") this.end(spanId, statusOf(status), at);
	}

	finish(status: AgentStatus, at: number): void {
		const s = statusOf(status);
		this.closeActiveTool(s === "error" ? "error" : "ok", at);
		this.closeCurrentNode(s === "error" ? "error" : "ok", at);
		for (const spanId of this.subagentSpans.values()) this.end(spanId, s === "error" ? "error" : "ok", at);
		if (this.runSpanId) this.end(this.runSpanId, s === "running" ? "ok" : s, at);
	}

	snapshot(maxSpans = traceMaxSpans()): Span[] {
		return capSpans(this.spans.map((s) => ({ ...s, attrs: s.attrs ? { ...s.attrs } : undefined })), maxSpans);
	}

	/** D1: the structural spine only (everything but `tool`) — never sampled, no cap needed (the spine
	 *  is small by construction). Lets a finalized receipt always carry run/node/subagent spans even
	 *  when tool-level detail is tail-sampled away. */
	structuralSnapshot(): Span[] {
		return this.spans.filter((s) => s.kind !== "tool").map((s) => ({ ...s, attrs: s.attrs ? { ...s.attrs } : undefined }));
	}

	/** True when this run produced at least one `tool` span — distinguishes "tool detail was sampled
	 *  out" from "there was never any tool detail to sample" for `RunReceipt.sampled` (D1). */
	hasToolSpans(): boolean {
		return this.spans.some((s) => s.kind === "tool");
	}

	hasError(): boolean {
		return this.spans.some((s) => s.status === "error");
	}

	private nextId(): string {
		return `${this.runId}:${this.seq++}`;
	}

	private closeActiveTool(status: SpanStatus, at: number): void {
		if (!this.currentToolId) return;
		this.end(this.currentToolId, status, at);
		this.currentToolId = undefined;
	}

	private closeCurrentNode(status: SpanStatus, at: number): void {
		if (!this.currentNodeId) return;
		this.end(this.currentNodeId, status, at);
		this.currentNodeId = undefined;
	}

	private end(spanId: string, status: SpanStatus, at: number): void {
		const span = this.spans.find((s) => s.spanId === spanId);
		if (!span || span.endedAt !== undefined) return;
		span.endedAt = Math.max(at, span.startedAt);
		span.status = status;
	}
}

export function shouldKeepSpans(status: AgentStatus, spansHaveError: boolean, ratio = traceSampleRatio(), random: () => number = Math.random): boolean {
	if (!traceSpansEnabled()) return false;
	if (status === "error" || spansHaveError) return true;
	return ratio >= 1 || (ratio > 0 && random() < ratio);
}

export function capSpans(spans: Span[], max = traceMaxSpans()): Span[] {
	if (spans.length <= max) return spans;
	const keep = spans.filter((s) => s.kind !== "tool" || s.status === "error");
	const room = Math.max(0, max - keep.length);
	const tools = room === 0 ? [] : spans.filter((s) => s.kind === "tool" && s.status !== "error").slice(-room);
	const ids = new Set([...keep, ...tools].map((s) => s.spanId));
	return spans.filter((s) => ids.has(s.spanId)).slice(0, max);
}

function receiptTraceId(r: RunReceipt): string {
	return r.traceId ?? traceIdFor({ agentId: r.agentId, runId: r.runId, featureId: r.featureId });
}

export function normalizeTraceId(id: string, receipts: RunReceipt[], featureIds: Iterable<string> = []): string {
	const decoded = decodeURIComponent(id);
	if (decoded.startsWith("feat:") || decoded.startsWith("run:")) return decoded;
	for (const fid of featureIds) if (fid === decoded) return `feat:${decoded}`;
	if (receipts.some((r) => r.featureId === decoded || r.traceId === `feat:${decoded}`)) return `feat:${decoded}`;
	const byRun = receipts.find((r) => r.runId === decoded || `${r.agentId}:${r.runId}` === decoded);
	return byRun ? receiptTraceId(byRun) : decoded;
}

function matchesTrace(traceId: string, r: RunReceipt): boolean {
	if (receiptTraceId(r) === traceId) return true;
	if (traceId.startsWith("feat:") && r.featureId === traceId.slice(5)) return true;
	if (traceId.startsWith("run:") && traceId === `run:${r.agentId}:${r.runId}`) return true;
	return false;
}

function fallbackRunSpan(r: RunReceipt, traceId: string): Span {
	return {
		traceId,
		spanId: `${r.runId}:0`,
		name: `run:${r.name}`,
		kind: "run",
		startedAt: r.startedAt,
		endedAt: r.endedAt,
		status: statusOf(r.status) === "running" ? "ok" : statusOf(r.status),
		attrs: attrs({ repo: r.repo, branch: r.branch, model: r.model, feature: r.featureId, parent: r.parentId, agent: r.agentId, digest: r.agentId }),
	};
}

/** D2: map an audit action to the causal-spine span kind it weaves as, or `undefined` for actions
 *  that aren't part of the spine (e.g. "prompt", "restart"). `validate` is forward-declared for
 *  Epic 3's independent validator — woven only if/when that action is actually recorded. */
function auditSpanKind(action: string): SpanKind | undefined {
	if (action === "land") return "land";
	if (action.includes("resolve")) return "resolve";
	if (action === "verify") return "verify";
	if (action === "validate") return "validate";
	if (action === "create" || action === "commission" || action === "fork") return "spawn";
	return undefined;
}

function auditSpans(traceId: string, receipts: RunReceipt[], audits: AuditEntry[]): Span[] {
	const featureId = traceId.startsWith("feat:") ? traceId.slice(5) : undefined;
	const targets = new Set(receipts.map((r) => r.agentId));
	if (featureId) targets.add(featureId);
	// D2: parent each verify/spawn/validate/land/resolve span under the RUN span of its target agent
	// (composite key `${agentId}:${runSpanId}`, matching how buildTrace keys receipt-span nodes) so the
	// tree reads run→verify→land instead of a flat sibling list. No match (target unknown, a feature-id
	// target, or an agent whose receipt carries no run span) ⇒ parentSpanId stays unset, falling back to
	// root exactly as before this weave existed.
	const runSpanIdByAgent = new Map<string, string>();
	for (const r of receipts) runSpanIdByAgent.set(r.agentId, r.spans?.find((s) => s.kind === "run")?.spanId ?? `${r.runId}:0`);
	return audits
		.slice()
		.reverse()
		.filter((a) => auditSpanKind(a.action) && (!a.target || targets.has(a.target)))
		.map((a): Span => {
			const kind = auditSpanKind(a.action)!;
			const runSpanId = a.target ? runSpanIdByAgent.get(a.target) : undefined;
			return {
				traceId,
				spanId: `audit:${a.id}`,
				parentSpanId: runSpanId ? `${a.target}:${runSpanId}` : undefined,
				name: a.action,
				kind,
				startedAt: a.at,
				endedAt: a.at,
				status: a.outcome === "error" ? "error" : "ok",
				attrs: attrs({ operator: a.actor, feature: featureId, agent: a.target }),
			};
		});
}

export function buildTrace(rawTraceId: string, allReceipts: RunReceipt[], audits: AuditEntry[] = [], featureIds: Iterable<string> = []): TraceResponse {
	const traceId = normalizeTraceId(rawTraceId, allReceipts, featureIds);
	const receipts = allReceipts.filter((r) => matchesTrace(traceId, r)).sort((a, b) => a.startedAt - b.startedAt || a.runId.localeCompare(b.runId));
	const root: TraceNode = {
		traceId,
		spanId: `${traceId}:root`,
		name: traceId,
		kind: "run",
		startedAt: receipts[0]?.startedAt ?? Date.now(),
		endedAt: receipts.every((r) => r.endedAt !== undefined) ? receipts.reduce<number | undefined>((m, r) => Math.max(m ?? 0, r.endedAt ?? 0), undefined) : undefined,
		status: receipts.some((r) => r.status === "error") ? "error" : receipts.some((r) => r.status === "working" || r.status === "starting" || r.status === "input") ? "running" : "ok",
		children: [],
		rollup: emptyRollup(),
	};
	const nodes = new Map<string, TraceNode>([[root.spanId, root]]);
	const parentKeyByNodeKey = new Map<string, string>();
	const runNodeByAgent = new Map<string, TraceNode>();
	const seenRunNodes = new Set<string>();
	let partial = false;

	for (const r of receipts) {
		const rTraceId = receiptTraceId(r);
		const spans = r.spans?.length ? r.spans : [fallbackRunSpan(r, rTraceId)];
		if (!r.spans?.length) partial = true;
		for (const s of spans) {
			const node: TraceNode = { ...s, attrs: s.attrs ? { ...s.attrs } : undefined, children: [], rollup: emptyRollup() };
			const key = `${r.agentId}:${s.spanId}`;
			if (s.parentSpanId) parentKeyByNodeKey.set(key, `${r.agentId}:${s.parentSpanId}`);
			if (s.kind === "run" && !seenRunNodes.has(`${r.agentId}:${r.runId}`)) {
				node.receipt = r;
				addRollup(node.rollup, receiptRollup(r));
				runNodeByAgent.set(r.agentId, node);
				seenRunNodes.add(`${r.agentId}:${r.runId}`);
			}
			nodes.set(key, node);
		}
	}

	for (const s of auditSpans(traceId, receipts, audits)) {
		nodes.set(s.spanId, { ...s, children: [], rollup: emptyRollup() });
		// auditSpans already resolved parentSpanId to the composite `${agentId}:${runSpanId}` key
		// receipt-span nodes are keyed by, so this parents the audit span directly under its target's
		// run node — no unset parentSpanId means it falls through to root as before.
		if (s.parentSpanId) parentKeyByNodeKey.set(s.spanId, s.parentSpanId);
	}

	for (const [key, node] of nodes) {
		if (node === root) continue;
		let parent: TraceNode | undefined;
		const parentKey = parentKeyByNodeKey.get(key);
		if (parentKey) parent = nodes.get(parentKey);
		if (!parent && node.kind === "run" && node.receipt?.parentId) parent = runNodeByAgent.get(node.receipt.parentId);
		(parent ?? root).children.push(node);
	}

	const sort = (n: TraceNode): void => {
		n.children.sort((a, b) => a.startedAt - b.startedAt || a.spanId.localeCompare(b.spanId));
		for (const c of n.children) sort(c);
	};
	const fold = (n: TraceNode): TraceRollup => {
		for (const c of n.children) addRollup(n.rollup, fold(c));
		return n.rollup;
	};
	sort(root);
	fold(root);
	return { traceId, root, rollup: root.rollup, receipts, partial, sampled: receipts.some((r) => r.sampled === true) };
}

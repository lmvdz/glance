/**
 * openrouter ingest — account-level spend from OpenRouter's usage API.
 *
 * Unlike the local-log harnesses (claude-code, codex), OpenRouter is a PROVIDER: its
 * `GET /api/v1/activity` returns per-DAY usage grouped by model, in real billed USD —
 * better than a rate-table estimate — but carries NO cwd/repo. So account spend can't
 * be split across repos from the data alone.
 *
 * To avoid double-attributing the whole account's spend to EVERY repo, this ingester
 * is opt-in and self-gates to ONE repo: it runs only when `OPENROUTER_API_KEY` is set
 * AND `OPENROUTER_ATTRIBUTION_REPO` resolves to the repo being ingested. On a
 * single-repo self-host that's just "point it at your repo"; multi-repo operators who
 * want per-repo OpenRouter attribution should tag requests and use a log-based harness
 * instead (documented limitation).
 *
 * Only COMPLETE past days are ingested (today's row is still accumulating), and a
 * cursor records which (date, model) rows were already receipted, so re-runs add only
 * new days. The HTTP fetch is injected so the parse/cursor logic is unit-testable
 * without a live key.
 */

import * as path from "node:path";
import { getStorageBackend } from "../dal/storage.ts";
import { appendReceipt } from "../receipts.ts";
import type { RunReceipt } from "../types.ts";
import type { HarnessIngester, HarnessIngestResult } from "./harness.ts";

/** One row of GET /api/v1/activity — fields read defensively (schema may add more). */
export interface OpenRouterActivityRow {
	date: string; // "YYYY-MM-DD"
	model?: string;
	model_permaslug?: string;
	usage?: number; // billed USD
	cost?: number; // alt field name
	requests?: number;
	prompt_tokens?: number;
	completion_tokens?: number;
}

export type FetchActivity = (apiKey: string) => Promise<OpenRouterActivityRow[]>;

/** Default fetcher: OpenRouter's real activity endpoint. */
const realFetchActivity: FetchActivity = async (apiKey) => {
	const res = await fetch("https://openrouter.ai/api/v1/activity", { headers: { Authorization: `Bearer ${apiKey}` } });
	if (!res.ok) throw new Error(`openrouter activity HTTP ${res.status}`);
	const body = (await res.json()) as { data?: OpenRouterActivityRow[] } | OpenRouterActivityRow[];
	return Array.isArray(body) ? body : (body.data ?? []);
};

const rowCost = (r: OpenRouterActivityRow): number => r.usage ?? r.cost ?? 0;
const rowModel = (r: OpenRouterActivityRow): string | undefined => r.model ?? r.model_permaslug;
const rowKey = (r: OpenRouterActivityRow): string => `${r.date}|${rowModel(r) ?? "?"}`;
/** UTC midnight of a "YYYY-MM-DD" day. */
const dayStart = (date: string): number => Date.parse(`${date}T00:00:00Z`);

/** Today's date string in UTC — its activity row is still growing, so we skip it. */
export function todayUTC(now: number): string {
	return new Date(now).toISOString().slice(0, 10);
}

/** A complete-day activity row as a fleet receipt. Pure. Cost is REAL (billed), not estimated. */
export function rowToReceipt(r: OpenRouterActivityRow, repo: string): RunReceipt {
	const model = rowModel(r);
	const start = dayStart(r.date);
	const slug = (model ?? "unknown").replace(/[^a-z0-9]+/gi, "-").slice(0, 24);
	const input = r.prompt_tokens ?? 0;
	const output = r.completion_tokens ?? 0;
	return {
		agentId: `or-${r.date}-${slug}`,
		name: `openrouter ${model ?? "usage"} ${r.date}`,
		repo,
		model,
		runId: `${r.date}.${slug}`,
		startedAt: start,
		endedAt: start + 24 * 3_600_000 - 1,
		durationMs: 24 * 3_600_000 - 1,
		status: "stopped",
		toolCalls: 0,
		toolTally: {},
		tokens: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output },
		costUsd: rowCost(r),
		filesTouched: [],
		harness: "openrouter",
	};
}

interface Cursor {
	[dateModelKey: string]: true;
}

export interface OpenRouterIngestOpts {
	stateDir: string;
	repo: string;
	now?: number;
	/** overrides for tests: the resolved attribution repo, the api key, and the fetcher. */
	attributionRepo?: string;
	apiKey?: string;
	fetchActivity?: FetchActivity;
}

/**
 * Ingest complete-day OpenRouter activity rows as receipts for the attribution repo.
 * No-op (scanned 0) unless the key + attribution repo are configured and match `repo`.
 */
export async function ingestOpenRouter(opts: OpenRouterIngestOpts): Promise<HarnessIngestResult> {
	const now = opts.now ?? Date.now();
	const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
	const attrRepoRaw = opts.attributionRepo ?? process.env.OPENROUTER_ATTRIBUTION_REPO;
	if (!apiKey || !attrRepoRaw) return { scanned: 0, ingested: 0 };
	if (path.resolve(attrRepoRaw) !== path.resolve(opts.repo)) return { scanned: 0, ingested: 0 };

	const fetchActivity = opts.fetchActivity ?? realFetchActivity;
	let rows: OpenRouterActivityRow[];
	try {
		rows = await fetchActivity(apiKey);
	} catch (err) {
		throw new Error(`openrouter activity fetch: ${err instanceof Error ? err.message : String(err)}`);
	}

	const cursorFile = path.join(opts.stateDir, "ingest", "openrouter.json");
	let cursor: Cursor = {};
	const cursorRaw = await getStorageBackend().readText(cursorFile);
	if (cursorRaw !== undefined) {
		try {
			cursor = JSON.parse(cursorRaw) as Cursor;
		} catch {
			// corrupt — first run
		}
	}

	const today = todayUTC(now);
	let scanned = 0;
	let ingested = 0;
	for (const r of rows) {
		if (!r.date || !Number.isFinite(dayStart(r.date))) continue;
		scanned++;
		if (r.date >= today) continue; // still-accumulating day — wait until it's complete
		const key = rowKey(r);
		if (cursor[key]) continue; // already receipted
		cursor[key] = true;
		if (rowCost(r) <= 0) continue; // nothing billable
		await appendReceipt(opts.stateDir, rowToReceipt(r, opts.repo));
		ingested++;
	}

	await getStorageBackend().writeDurable(cursorFile, JSON.stringify(cursor));
	return { scanned, ingested };
}

export const openRouterIngester: HarnessIngester = {
	name: "openrouter",
	ingest: (o) => ingestOpenRouter(o),
};

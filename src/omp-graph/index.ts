/**
 * omp-graph — a normalized, source-agnostic temporal graph for the living dashboard.
 *
 * Public surface:
 *   - schema.ts   : the wire format (GraphDoc + the five track primitives)
 *   - adapter.ts  : the SourceAdapter contract + AdapterContext
 *   - compose.ts  : run adapters → one GraphDoc
 *   - adapters/*  : the first three bindings (git, receipts, automation)
 *
 * Structured as an extractable package: schema/adapter/compose are app-agnostic;
 * only the adapters and this default set know about omp-squad. Add a source by
 * writing one SourceAdapter — nothing else changes.
 */

export * from "./schema.ts";
export * from "./adapter.ts";
export { composeGraph, type ComposeOptions } from "./compose.ts";

import type { GraphDoc, TimeRange } from "./schema.ts";
import { lastDays } from "./schema.ts";
import type { AdapterContext, SourceAdapter } from "./adapter.ts";
import { composeGraph } from "./compose.ts";
import { gitAdapter } from "./adapters/git-adapter.ts";
import { receiptsAdapter } from "./adapters/receipts-adapter.ts";
import { automationAdapter } from "./adapters/automation-adapter.ts";

export { gitAdapter, receiptsAdapter, automationAdapter };

/** The default omp-squad adapter set (fleet dev + cost + automation). */
export const DEFAULT_ADAPTERS: SourceAdapter[] = [gitAdapter, receiptsAdapter, automationAdapter];

/**
 * Convenience for hosts: build a GraphDoc for the last `days` using the default
 * adapters. `now` is injectable so callers/tests stay deterministic.
 */
export async function buildGraph(
	ctx: AdapterContext,
	opts: { days?: number; now?: number; range?: TimeRange; adapters?: SourceAdapter[] } = {},
): Promise<GraphDoc> {
	const now = opts.now ?? Date.now();
	const range = opts.range ?? lastDays(opts.days ?? 7, now);
	return composeGraph(range, ctx, opts.adapters ?? DEFAULT_ADAPTERS, { now });
}

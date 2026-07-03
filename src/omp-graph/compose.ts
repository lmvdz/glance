/**
 * omp-graph compose — run every adapter over a range and merge into one GraphDoc.
 *
 * The host's only job is to pick a range + adapters and call this. Adapter
 * failures degrade to zero tracks (never throw), so one broken source can't take
 * down the dashboard — the Felton dossier just misses that lane.
 */

import type { GraphDoc, GraphGroup, GraphTrack, TimeRange } from "./schema.ts";
import type { AdapterContext, SourceAdapter } from "./adapter.ts";

/** Injectable clock so callers/tests control `generatedAt` (mirrors the codebase convention). */
export interface ComposeOptions {
	now?: number;
}

export async function composeGraph(
	range: TimeRange,
	ctx: AdapterContext,
	adapters: SourceAdapter[],
	opts: ComposeOptions = {},
): Promise<GraphDoc> {
	const settled = await Promise.all(
		adapters.map(async (a) => {
			try {
				return { adapter: a, tracks: await a.tracks(range, ctx) };
			} catch {
				return { adapter: a, tracks: [] as GraphTrack[] };
			}
		}),
	);

	const groups = new Map<string, GraphGroup>();
	const tracks: GraphTrack[] = [];
	const sources: string[] = [];

	for (const { adapter, tracks: emitted } of settled) {
		sources.push(adapter.id);
		// Only surface a group once at least one of its adapters actually produced a track.
		if (emitted.length && !groups.has(adapter.group.id)) groups.set(adapter.group.id, adapter.group);
		tracks.push(...emitted);
	}

	const orderedGroups = [...groups.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label));

	return {
		range,
		groups: orderedGroups,
		tracks,
		sources,
		generatedAt: opts.now ?? Date.now(),
	};
}

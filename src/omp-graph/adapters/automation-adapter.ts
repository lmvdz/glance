/**
 * automation adapter — the background loops (Scout/Observer/Dispatch/Opportunity)
 * as omp-graph tracks, read from the daemon's automation.jsonl.
 *
 * Emits:
 *   - events : each meaningful loop tick (filed / spawned / found / skipped)
 *   - bars   : LLM one-shots per hour (the automation cost signal)
 *
 * Pure transform exported for tests; only the adapter reads the log file.
 */

import type { GraphGroup, GraphTrack, TimeRange } from "../schema.ts";
import { bucketSums, HOUR_MS, inRange } from "../schema.ts";
import type { AdapterContext, SourceAdapter } from "../adapter.ts";
import type { AutomationEvent } from "../../types.ts";
import { automationPath, isMeaningful } from "../../automation-log.ts";

/** One-line human summary of a loop tick for the event mark. Pure. */
export function summarizeAutomation(e: AutomationEvent): string {
	if (e.filed) return `${e.loop} · filed ${e.filed}`;
	if (e.spawned) return `${e.loop} · spawned ${e.spawned}`;
	if (e.found) return `${e.loop} · found ${e.found}`;
	if (e.skipReason) return `${e.loop} · skip: ${e.skipReason}`;
	return `${e.loop}`;
}

/** Turn automation events into omp-graph tracks. Pure. */
export function automationTracks(events: AutomationEvent[], range: TimeRange, group: string, source: string, limit = 60): GraphTrack[] {
	const inWindow = events.filter((e) => inRange(e.at, range));

	const meaningful = inWindow
		.filter((e) => isMeaningful(e))
		.sort((a, b) => b.at - a.at)
		.slice(0, limit)
		.sort((a, b) => a.at - b.at);

	const marks: GraphTrack = {
		id: "automation.loops",
		label: "LOOPS",
		group,
		source,
		type: "events",
		marks: meaningful.map((e) => ({
			t: e.at,
			label: summarizeAutomation(e),
			kind: e.loop,
			value: e.llmCalls ?? 0,
			meta: {
				loop: e.loop,
				...(e.repo ? { repo: e.repo } : {}),
				...(e.filed ? { filed: e.filed } : {}),
				...(e.spawned ? { spawned: e.spawned } : {}),
			},
		})),
	};

	const llm: GraphTrack = {
		id: "automation.llm",
		label: "LLM / HR",
		group,
		source,
		unit: "calls",
		type: "bars",
		binMs: HOUR_MS,
		scale: "linear",
		bins: bucketSums(range, HOUR_MS, inWindow.map((e) => ({ t: e.at, v: e.llmCalls ?? 0 }))),
	};

	return [marks, llm];
}

const GROUP: GraphGroup = { id: "automation", label: "AUTOMATION & EVENTS", order: 1 };

/** Read + parse automation.jsonl for a state dir. Returns [] when absent. */
async function readAutomationEvents(stateDir: string): Promise<AutomationEvent[]> {
	const text = await Bun.file(automationPath(stateDir))
		.text()
		.catch(() => "");
	if (!text.trim()) return [];
	const out: AutomationEvent[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as AutomationEvent);
		} catch {
			// tolerate a torn last line
		}
	}
	return out;
}

export const automationAdapter: SourceAdapter = {
	id: "automation",
	label: "Automation",
	group: GROUP,
	async tracks(range, ctx: AdapterContext): Promise<GraphTrack[]> {
		if (!ctx.stateDir) return [];
		const events = await readAutomationEvents(ctx.stateDir);
		if (!events.length) return [];
		return automationTracks(events, range, GROUP.id, "automation", ctx.limit ?? 60);
	},
};

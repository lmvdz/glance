import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { AutomationRecorder } from "./automation-log.ts";
import type { FabricHotAreaFact, FabricScoutFact } from "./fabric.ts";
import { jaccard, titleTokens } from "./scout.ts";
import type { IssueRef } from "./types.ts";

export interface OpportunityDeps {
	listIssues: () => Promise<IssueRef[] | null>;
	fileIssue: (title: string, descriptionHtml: string) => Promise<IssueRef | null>;
	scoutFacts: () => Promise<FabricScoutFact[]>;
	hotAreas: () => Promise<FabricHotAreaFact[]>;
	stateDir: string;
	seenFile?: string;
	now?: () => number;
	log?: (msg: string) => void;
	/** Observability sink — one report per tick (a no-cluster tick is a heartbeat proving the loop is alive). */
	record?: AutomationRecorder;
}

interface SeenEntry {
	title: string;
	issueId: string;
	filedAt: number;
}
type SeenMap = Record<string, SeenEntry>;

interface Cluster {
	fingerprint: string;
	title: string;
	items: FabricScoutFact[];
	hotFiles: FabricHotAreaFact[];
}

const OPPORTUNITY_TAG = "[opportunity]";
const TRIAGE_MARKER = "do-not-auto-land";
const DEDUP_THRESHOLD = 0.6;

function opportunityEnabled(): boolean {
	return process.env.OMP_SQUAD_OPPORTUNITY !== "0";
}

function opportunityMin(): number {
	return Number(process.env.OMP_SQUAD_OPPORTUNITY_MIN) || 3;
}

function opportunityMax(): number {
	return Number(process.env.OMP_SQUAD_OPPORTUNITY_MAX) || 5;
}

function opportunityWindow(): number {
	return Number(process.env.OMP_SQUAD_OPPORTUNITY_WINDOW) || 50;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");

function fingerprint(items: FabricScoutFact[]): string {
	const toks = new Set<string>();
	for (const item of items) for (const token of titleTokens(item.title)) toks.add(token);
	return [...toks].sort().join(" ") || items.map((i) => i.issue.id).sort().join(" ");
}

function clusterTitle(items: FabricScoutFact[]): string {
	const counts = new Map<string, number>();
	for (const item of items) for (const token of titleTokens(item.title)) counts.set(token, (counts.get(token) ?? 0) + 1);
	const words = [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 6)
		.map(([word]) => word);
	return words.length ? `Investigate recurring ${words.join(" / ")}` : `Investigate recurring scout pattern`;
}

function pathTokens(file: string): Set<string> {
	return new Set(file.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1));
}

function relatedHotFiles(items: FabricScoutFact[], hotAreas: FabricHotAreaFact[]): FabricHotAreaFact[] {
	const tokens = new Set<string>();
	for (const item of items) for (const token of titleTokens(item.title)) tokens.add(token);
	return hotAreas.filter((h) => jaccard(tokens, pathTokens(h.file)) > 0).slice(0, 5);
}

export function opportunityClusters(scout: FabricScoutFact[], hotAreas: FabricHotAreaFact[], min = opportunityMin()): Cluster[] {
	const windowed = scout.slice().sort((a, b) => (b.filedAt ?? 0) - (a.filedAt ?? 0)).slice(0, opportunityWindow());
	const clusters: FabricScoutFact[][] = [];
	for (const item of windowed) {
		const tokens = titleTokens(item.title);
		const cluster = clusters.find((c) => c.some((other) => jaccard(tokens, titleTokens(other.title)) >= DEDUP_THRESHOLD));
		if (cluster) cluster.push(item);
		else clusters.push([item]);
	}
	return clusters
		.filter((items) => {
			const provenance = new Set(items.map((i) => i.source.runId ?? i.source.agentId ?? i.issue.id));
			return items.length >= min && provenance.size >= min;
		})
		.map((items) => ({ fingerprint: fingerprint(items), title: clusterTitle(items), items, hotFiles: relatedHotFiles(items, hotAreas) }));
}

function buildBody(cluster: Cluster): string {
	const issueList = cluster.items
		.map((i) => `<li><code>${esc(i.issue.identifier ?? i.issue.id)}</code> ${esc(i.title)}${i.source.agentId ? ` — <code>${esc(i.source.agentId)}</code>` : ""}${i.source.runId ? ` / <code>${esc(i.source.runId)}</code>` : ""}</li>`)
		.join("");
	const hot = cluster.hotFiles.length ? `<p><strong>Hot files:</strong> ${cluster.hotFiles.map((h) => `<code>${esc(h.file)}</code>`).join(", ")}</p>` : "";
	return `<p><strong>Opportunity</strong> — recurring scout pattern across ${cluster.items.length} distinct runs/agents. Verify before acting.</p><ul>${issueList}</ul>${hot}<p><em>Auto-clustered from [scout] issues and receipt hot areas; do not auto-land.</em></p>`;
}

export class Opportunity {
	private readonly deps: OpportunityDeps;
	private readonly seenPath: string;
	private seen: SeenMap;
	private timer?: Timer;
	private running = false;

	constructor(deps: OpportunityDeps) {
		this.deps = deps;
		this.seenPath = path.join(deps.stateDir, deps.seenFile ?? "opportunity-seen.json");
		this.seen = this.loadSeen();
	}

	start(intervalMs = 60_000): void {
		if (this.timer || !opportunityEnabled()) return;
		this.timer = setInterval(() => void this.tick().catch((e) => (this.deps.log ?? (() => {}))(`tick error (contained): ${e instanceof Error ? e.message : String(e)}`)), intervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	async tick(): Promise<void> {
		if (!opportunityEnabled() || this.running) return;
		this.running = true;
		const log = this.deps.log ?? (() => {});
		const clock = this.deps.now ?? Date.now;
		const t0 = clock();
		let found = 0;
		let filed = 0;
		try {
			const open = (await this.deps.listIssues().catch(() => null)) ?? [];
			let openOpportunity = open.filter((i) => i.name.includes(OPPORTUNITY_TAG)).length;
			const max = opportunityMax();
			const clusters = opportunityClusters(await this.deps.scoutFacts(), await this.deps.hotAreas());
			found = clusters.length;
			let changed = false;
			for (const cluster of clusters) {
				if (this.seen[cluster.fingerprint]) continue;
				if (openOpportunity >= max) {
					log(`opportunity cap reached (${max} open) — skipping ${cluster.fingerprint}`);
					break;
				}
				const title = `${OPPORTUNITY_TAG} ${TRIAGE_MARKER}: ${cluster.title}`;
				const ref = await this.deps.fileIssue(title, buildBody(cluster)).catch(() => null);
				if (!ref) {
					log(`file failed for ${cluster.fingerprint}`);
					continue;
				}
				openOpportunity++;
				filed++;
				changed = true;
				this.seen[cluster.fingerprint] = { title: cluster.title, issueId: ref.id, filedAt: clock() };
				log(`filed opportunity ${ref.identifier ?? ref.id}: ${cluster.title}`);
			}
			if (changed) this.saveSeen();
		} finally {
			this.running = false;
			// One report per tick — clusters surfaced/filed are the work; a no-cluster tick is a heartbeat (ring-only).
			this.deps.record?.({ durationMs: (this.deps.now ?? Date.now)() - t0, found, filed, deduped: Math.max(0, found - filed) });
		}
	}

	private loadSeen(): SeenMap {
		try {
			if (!existsSync(this.seenPath)) return {};
			const raw = JSON.parse(readFileSync(this.seenPath, "utf8")) as unknown;
			return raw && typeof raw === "object" ? (raw as SeenMap) : {};
		} catch {
			return {};
		}
	}

	private saveSeen(): void {
		try {
			writeFileSync(this.seenPath, JSON.stringify(this.seen));
		} catch (e) {
			(this.deps.log ?? (() => {}))(`persist failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
}

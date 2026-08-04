/**
 * C5 passive miss counter (plans/research-long-horizon-agent-memory/VALIDATION.md): every
 * zero-result `squad_kb_search` is recorded with its query REGIME so the add-a-dense-channel
 * decision is made on the semantic-gap share, never on aggregate miss volume. The classifier is
 * a cheap heuristic by design — the calibration step hand-labels a sample against it, so what
 * these tests pin is the REGIME BOUNDARY the counter reports, not retrieval quality.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { classifyQueryShape } from "../src/memory/fabric-search.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { MetricEvent } from "../src/metrics.ts";

const tmps: string[] = [];
const managers: SquadManager[] = [];

afterEach(async () => {
	for (const m of managers) await m.stop().catch(() => {});
	managers.length = 0;
	for (const t of tmps) await fs.rm(t, { recursive: true, force: true }).catch(() => {});
	tmps.length = 0;
});

describe("classifyQueryShape", () => {
	test("entity-carrying queries: identifiers of every supported kind", () => {
		for (const q of [
			"where is src/fabric-search.ts",
			"failing at commit 7f9a2b1c9",
			"release lock e9a2b841-7c3d-42ef-a110-891d2c67bc94",
			"what does --no-verify do here",
			"status of OMPSQ-12",
			"who calls buildContextPrimer",
			"grep for retry_budget_cap",
			"is OMP_SQUAD_FAILURE_MEMORY on",
			"open token.ts",
		]) {
			expect(classifyQueryShape(q)).toBe("entity");
		}
	});

	test("semantic-gap queries: natural language with no identifier vocabulary", () => {
		for (const q of [
			"why is the deploy slow",
			"how do we handle retries when the network flakes",
			"what was decided about error handling",
			"previous discussion of the login flow",
		]) {
			expect(classifyQueryShape(q)).toBe("semantic");
		}
	});
});

describe("kb-retrieval-miss metric", () => {
	async function mgr(): Promise<{ mgr: SquadManager; repo: string }> {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "kbmiss-state-"));
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "kbmiss-repo-"));
		tmps.push(stateDir, repo);
		const m = new SquadManager({ stateDir });
		managers.push(m);
		const pf = m.createFeature({ title: "Auth tokens", repo, planDir: "plans/auth" });
		await m.updateFeature(pf.id, { repo, decisions: [{ id: "d1", text: "Use rotating refresh tokens with a 15-minute access TTL.", source: "human" }] });
		return { mgr: m, repo };
	}

	function fakeRec(repo: string, capture: { tool?: { text: string; isError: boolean } }) {
		return {
			dto: { id: "fake-1", name: "fake", status: "working", repo, worktree: "/w", pending: [], lastActivity: 0 },
			agent: { respondHostTool: (_id: string, text: string, isError = false) => { capture.tool = { text, isError }; } },
			options: { repo, name: "fake" },
			transcript: [],
			assistantBuf: "",
			thinkingBuf: "",
			streaming: false,
			subs: {},
			toolEntries: new Map(),
		} as never;
	}

	function misses(m: SquadManager): MetricEvent[] {
		return (m as unknown as { learningMetrics: { recent: (q: object) => MetricEvent[] } }).learningMetrics.recent({ name: "kb-retrieval-miss" });
	}

	test("a zero-result search records one miss, tagged with regime and the truncated query", async () => {
		const { mgr: m, repo } = await mgr();
		const cap: { tool?: { text: string; isError: boolean } } = {};
		await (m as unknown as { handleKbSearchTool: (r: unknown, c: unknown) => Promise<void> })
			.handleKbSearchTool(fakeRec(repo, cap), { id: "c1", arguments: { query: "why is the deploy slow" } });
		expect(cap.tool!.text).toContain("No matching context");
		const events = misses(m);
		expect(events).toHaveLength(1);
		expect(events[0]!.tags).toMatchObject({ shape: "semantic", query: "why is the deploy slow" });
	});

	test("a hit records nothing — this counts misses, not traffic", async () => {
		const { mgr: m, repo } = await mgr();
		const cap: { tool?: { text: string; isError: boolean } } = {};
		await (m as unknown as { handleKbSearchTool: (r: unknown, c: unknown) => Promise<void> })
			.handleKbSearchTool(fakeRec(repo, cap), { id: "c2", arguments: { query: "refresh token rotation" } });
		expect(cap.tool!.text).toContain("rotating refresh tokens");
		expect(misses(m)).toHaveLength(0);
	});

	test("PascalCase symbol names are entity-shaped (blind-review: they under-fired before)", () => {
		expect(classifyQueryShape("where does SquadManager adopt features")).toBe("entity");
	});

	test("a retry-looping agent cannot swamp the share: identical (agent, query) misses dedupe within the window", async () => {
		const { mgr: m, repo } = await mgr();
		const cap: { tool?: { text: string; isError: boolean } } = {};
		const h = m as unknown as { handleKbSearchTool: (r: unknown, c: unknown) => Promise<void> };
		for (let i = 0; i < 5; i++) await h.handleKbSearchTool(fakeRec(repo, cap), { id: `r${i}`, arguments: { query: "why is the deploy slow" } });
		expect(misses(m)).toHaveLength(1); // five identical retries, one recorded miss

		// A DIFFERENT query from the same agent still records — dedupe is per (agent, query), not per agent.
		await h.handleKbSearchTool(fakeRec(repo, cap), { id: "r9", arguments: { query: "how do retries backoff under load" } });
		expect(misses(m)).toHaveLength(2);
	});

	test("the persisted query is redacted and carries agent attribution", async () => {
		const { mgr: m, repo } = await mgr();
		const cap: { tool?: { text: string; isError: boolean } } = {};
		// Assembled at runtime so this source file holds no secret-shaped literal — the repo's
		// redact corpus-fence test asserts redact() leaves committed source unchanged.
		const fakeSecret = ["ghp", "0123456789abcdefghijklmnopqrstuvwxyzAB"].join("_");
		await (m as unknown as { handleKbSearchTool: (r: unknown, c: unknown) => Promise<void> })
			.handleKbSearchTool(fakeRec(repo, cap), { id: "c9", arguments: { query: `why does login keep breaking ${fakeSecret}` } });
		const events = misses(m);
		expect(events).toHaveLength(1);
		expect(events[0]!.tags?.agentId).toBe("fake-1");
		expect(events[0]!.tags?.query).not.toContain(fakeSecret.slice(0, 14)); // secret-shaped content never persists
	});

	test("an entity-shaped miss is tagged entity — the regime split the C5 kill criterion keys on", async () => {
		const { mgr: m, repo } = await mgr();
		const cap: { tool?: { text: string; isError: boolean } } = {};
		await (m as unknown as { handleKbSearchTool: (r: unknown, c: unknown) => Promise<void> })
			.handleKbSearchTool(fakeRec(repo, cap), { id: "c3", arguments: { query: "commit 9f8e7d6c5b4a" } });
		const events = misses(m);
		expect(events).toHaveLength(1);
		expect(events[0]!.tags?.shape).toBe("entity");
	});
});

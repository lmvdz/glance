/**
 * Memory-harness seam-level scenarios (plans/research-long-horizon-agent-memory/HARNESS-SPEC.md
 * §3, corpus G01–G12). Deterministic: no real time, no LLM calls, no network. G06/G07/G09/G10 are
 * already covered — see tests/decision-supersession.test.ts and the "primer regions" describe block
 * in tests/fabric-search.test.ts. This file covers the remaining seam-level scenarios that are
 * reachable without a room-threads node-summary fixture (G02/G11 need a scoped worker-kill/handoff
 * replay this repo doesn't yet expose a deterministic unit-test seam for — see
 * tests/memory-harness-COVERAGE.md).
 *
 * Each describe block names its scenario id and the error class (HARNESS-SPEC §2) it guards.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildDigest } from "../src/digest.ts";
import { buildFabricSnapshot } from "../src/fabric.ts";
import { buildContextPrimer } from "../src/fabric-search.ts";
import { appendReceipt, readReceipts } from "../src/receipts.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SubagentTracker } from "../src/subagents.ts";
import type { AgentDTO, FeatureDecision, PersistedAgent, PersistedFeature, RunReceipt, TranscriptEntry } from "../src/types.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tmpDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanups.push(async () => fs.rm(dir, { recursive: true, force: true }));
	return dir;
}

// ── shared helpers (copied from tests/decision-supersession.test.ts, house pattern) ────────────────

function seededManager(dir: string, decisions: FeatureDecision[] = []): { mgr: SquadManager; store: Map<string, PersistedFeature> } {
	const mgr = new SquadManager({ stateDir: dir });
	const store = (mgr as unknown as { featureStore: Map<string, PersistedFeature> }).featureStore;
	store.set("f", { id: "f", repo: "/repo", title: "feat-f", archived: false, decisions, createdAt: 1, updatedAt: 1 } as unknown as PersistedFeature);
	return { mgr, store };
}

const dec = (id: string, text: string, extra: Partial<FeatureDecision> = {}): FeatureDecision => ({ id, text, source: "agent", createdAt: 1000, ...extra });

// ── shared onHostTool harness (copied from tests/agent-context-fabric.test.ts, extended with
//    toolGrants — the capability tool-grant allow-list G03/G03b/G12 gate on). ────────────────────────

interface TestDriver {
	prompt(message: string): Promise<void>;
	abort(): Promise<void>;
	stop(): Promise<void>;
	detach?(): void;
	respondHostTool(callId: string, text: string, isError?: boolean): void;
}

interface TestRecord {
	dto: AgentDTO;
	agent: TestDriver;
	options: PersistedAgent;
	transcript: TranscriptEntry[];
	assistantBuf: string;
	streaming: boolean;
	subs: SubagentTracker;
	/** Capability tool-grant allow-list (squad-manager.ts's `AgentRecord.toolGrants`) — absent means
	 *  unscoped (full tool access, the historical default); present means hard-deny anything outside it. */
	toolGrants?: string[];
}

interface HostToolHarness {
	onHostTool(rec: TestRecord, call: { id: string; toolName: string; arguments: unknown }): void;
}

function dto(id: string, over: Partial<AgentDTO> = {}): AgentDTO {
	return {
		id,
		name: id,
		status: "idle",
		kind: "omp-operator",
		repo: "/repo",
		worktree: `/wt/${id}`,
		approvalMode: "write",
		pending: [],
		lastActivity: 0,
		messageCount: 0,
		...over,
	};
}

function record(agent: AgentDTO, replies: Array<{ callId: string; text: string; isError?: boolean }> = [], toolGrants?: string[]): TestRecord {
	return {
		dto: agent,
		agent: {
			async prompt() {},
			async abort() {},
			async stop() {},
			detach() {},
			respondHostTool(callId, text, isError) {
				replies.push({ callId, text, isError });
			},
		},
		options: { id: agent.id, name: agent.name, repo: agent.repo, worktree: agent.worktree, approvalMode: agent.approvalMode },
		transcript: [],
		assistantBuf: "",
		streaming: false,
		subs: new SubagentTracker(),
		toolGrants,
	};
}

function addRecord(mgr: SquadManager, rec: TestRecord): void {
	// Test seam: SquadManager.AgentRecord is intentionally private, but these fields are the runtime shape used by applyCommand/onHostTool.
	(mgr.agents as unknown as Map<string, TestRecord>).set(rec.dto.id, rec);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// G01 supersede-endpoint (E_anach, E_contra)
// ═════════════════════════════════════════════════════════════════════════════════════════════════

describe("G01 supersede-endpoint (E_anach) — a decision reversal must never leave the OLD endpoint reachable through the projection an agent actually reads", () => {
	/**
	 * The anachronism this guards: a spawned agent that resumes work after `target=staging→prod` must
	 * see `prod`, and it must NEVER see `staging` anywhere in the cold-start primer it's handed — not
	 * as a labeled-stale annotation, not as a residual match, nothing (arXiv 2607.10608's compliance
	 * trap: a stale fact reachable ANYWHERE in context gets adopted at the first decision point
	 * regardless of labeling). The write path (recordAgentDecision) must ALSO keep full history on the
	 * feature record — invalidated, never deleted — so the reversal itself remains auditable even
	 * though the projection excludes it.
	 */
	test("prod supersedes staging: primer surfaces only prod (exclusion, not annotation); feature history keeps staging, stamped", async () => {
		const dir = await tmpDir("g01-");
		const { mgr, store } = seededManager(dir, [dec("d-endpoint", "target = staging.api.internal")]);

		const outcome = await mgr.recordAgentDecision("f", dec("d-endpoint-2", "target = prod.api.internal", { supersedes: "d-endpoint" }));
		expect(outcome).toBe("recorded");

		// History intact: the OLD decision is still on the feature record, invalidated but legible.
		const decisions = store.get("f")?.decisions ?? [];
		expect(decisions).toHaveLength(2);
		const stale = decisions.find((d) => d.id === "d-endpoint")!;
		expect(stale.text).toBe("target = staging.api.internal");
		expect(stale.supersededBy).toBe("d-endpoint-2");
		expect(typeof stale.supersededAt).toBe("number");

		// Projection: build the fabric snapshot + cold-start primer a freshly-spawned agent would
		// actually receive, and assert the staging text is excluded EVERYWHERE, not merely un-ranked.
		const feature = store.get("f")!;
		const humanActor = { id: "web:admin", origin: "local" as const, role: "admin" as const };
		const snapshot = await buildFabricSnapshot({ actor: humanActor, agents: [], stateDir: dir, features: [feature], now: () => 5000 });
		expect(snapshot.decisions).toHaveLength(1);
		expect(snapshot.decisions[0]?.text).toBe("target = prod.api.internal");
		expect(JSON.stringify(snapshot)).not.toContain("staging.api.internal");

		const primer = buildContextPrimer(snapshot, "target endpoint", { now: 5000 });
		expect(primer).toContain("prod.api.internal");
		expect(primer).not.toContain("staging.api.internal"); // exclusion, not annotation — HARNESS-SPEC's kill condition
	});
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// G03 / G03b / G12 — capability tool-grant enforcement at the onHostTool action gate (E_gov_breach,
// E_gov_halt guard). All three share the same seam: `rec.toolGrants` and `onHostTool`
// (src/squad-manager.ts, "Capability tool-grant enforcement (#3)").
// ═════════════════════════════════════════════════════════════════════════════════════════════════

describe("G03 revoke-then-tempt (E_gov_breach) — the very next tempting call after an out-of-band revocation must be hard-denied, not surfaced for approval", () => {
	test("granted: the call is NOT hard-denied (it becomes a pending host approval, no error reply)", async () => {
		const mgr = new SquadManager({ stateDir: await tmpDir("g03-grant-") });
		const replies: Array<{ callId: string; text: string; isError?: boolean }> = [];
		const rec = record(dto("a"), replies, ["deploy_prod"]);
		addRecord(mgr, rec);
		const harness = mgr as unknown as HostToolHarness;

		harness.onHostTool(rec, { id: "call-1", toolName: "deploy_prod", arguments: { env: "prod" } });

		// Not hard-denied: no error reply was sent synchronously, and a pending host-approval was
		// created instead — the "surfaces as a pending approval" path the spec explicitly allows.
		expect(replies).toEqual([]);
		expect(rec.dto.pending).toHaveLength(1);
		expect(rec.dto.pending[0]?.kind).toBe("deploy_prod");
	});

	test("revoked: the SAME call is hard-denied — deny reply, no pending approval created", async () => {
		const mgr = new SquadManager({ stateDir: await tmpDir("g03-revoke-") });
		const replies: Array<{ callId: string; text: string; isError?: boolean }> = [];
		const rec = record(dto("a"), replies, ["deploy_prod"]);
		addRecord(mgr, rec);
		const harness = mgr as unknown as HostToolHarness;

		// Out-of-band revocation: the grant list is mutated directly (no other state change) —
		// exactly the "authority is never frozen" resolution HARNESS-SPEC §6 describes: the runtime
		// gate takes revocations effective immediately, out-of-band, with nothing else in context
		// having changed.
		rec.toolGrants = [];

		harness.onHostTool(rec, { id: "call-2", toolName: "deploy_prod", arguments: { env: "prod" } });

		expect(rec.dto.pending).toEqual([]); // hard-deny never creates a pending approval
		expect(replies).toHaveLength(1);
		expect(replies[0]?.isError).toBe(true);
		expect(replies[0]?.text).toContain("not granted");
		expect(replies[0]?.text).toContain("allowed:"); // denial names the (now-empty) grant list
	});
});

describe("G03b restore-then-tempt (E_gov_halt guard) — the revocation's revocation is honored: restoring the grant lifts the halt on the very next call", () => {
	test("revoke then restore then call again: the restored grant is NOT hard-denied — no spurious permanent halt", async () => {
		const mgr = new SquadManager({ stateDir: await tmpDir("g03b-") });
		const replies: Array<{ callId: string; text: string; isError?: boolean }> = [];
		const rec = record(dto("a"), replies, ["deploy_prod"]);
		addRecord(mgr, rec);
		const harness = mgr as unknown as HostToolHarness;

		// Revoke, confirm hard-deny (mirrors G03's second case).
		rec.toolGrants = [];
		harness.onHostTool(rec, { id: "call-1", toolName: "deploy_prod", arguments: {} });
		expect(replies.at(-1)?.isError).toBe(true);

		// Restore the grant — the revocation's revocation.
		rec.toolGrants = ["deploy_prod"];
		harness.onHostTool(rec, { id: "call-2", toolName: "deploy_prod", arguments: {} });

		// The restored call must NOT be hard-denied: no second error reply was appended for call-2,
		// and it instead surfaced as a pending approval — the halt lifts, it does not stick forever.
		const call2Reply = replies.find((r) => r.callId === "call-2");
		expect(call2Reply).toBeUndefined(); // no error reply for call-2 — not hard-denied
		expect(rec.dto.pending.some((p) => p.id === "call-2")).toBe(true);
	});
});

describe("G12 mid-turn-revoke-gate (E_gov_breach, authority-at-the-gate probe) — a revocation landing between two consecutive calls with NO other state change still blocks the second", () => {
	test("same tool, same call shape, only the grant list changes between calls — second call is denied and the denial names the grant list", async () => {
		const mgr = new SquadManager({ stateDir: await tmpDir("g12-") });
		const replies: Array<{ callId: string; text: string; isError?: boolean }> = [];
		const rec = record(dto("a"), replies, ["deploy_prod"]);
		addRecord(mgr, rec);
		const harness = mgr as unknown as HostToolHarness;

		// Call 1: granted, before any revocation — establishes the "nothing about context changed"
		// baseline (same agent record, same tool name, same argument shape as call 2 below).
		harness.onHostTool(rec, { id: "turn-1", toolName: "deploy_prod", arguments: { env: "prod" } });
		expect(replies.find((r) => r.callId === "turn-1")).toBeUndefined(); // not denied

		// Mid-turn revocation: ONLY the grant list changes. No other field on rec/dto is touched —
		// the context the agent believes it's operating under is frozen; only authority moved.
		rec.toolGrants = [];

		// Call 2: identical shape to call 1. The gate — not the (unchanged) context — must catch it.
		harness.onHostTool(rec, { id: "turn-2", toolName: "deploy_prod", arguments: { env: "prod" } });
		const denial = replies.find((r) => r.callId === "turn-2");
		expect(denial?.isError).toBe(true);
		expect(denial?.text).toContain("allowed:"); // denial text names the grant list (now empty)
		expect(rec.dto.pending.some((p) => p.id === "turn-2")).toBe(false); // no pending for the denied call
	});
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// G04 exact-identifier-drilldown (E_abstract, E_halluc guard)
// ═════════════════════════════════════════════════════════════════════════════════════════════════

describe("G04 exact-identifier-drilldown (E_abstract) — an exact token must never be altered; if the lossy digest drops it, the raw/durable source must still hold it byte-exact", () => {
	const TOKEN = "e9a2b841-7c3d-42ef-a110-891d2c67bc94";

	/**
	 * The durable, addressable raw source: a receipt persisted via appendReceipt/readReceipts is exact
	 * JSONL round-trip serialization — no summarization touches it. This is the drill-down target a
	 * release-gate action would actually query for the lock token, and it is where the guarantee
	 * "never accept an altered token" is enforceable byte-exact.
	 */
	test("a receipt's filesTouched carries the exact token through an append/read round-trip, byte-exact", async () => {
		const dir = await tmpDir("g04-receipt-");
		const receipt: RunReceipt = {
			agentId: "a1",
			name: "a1",
			repo: "/repo",
			runId: "run-1",
			startedAt: 100,
			endedAt: 200,
			status: "idle",
			toolCalls: 1,
			toolTally: {},
			filesTouched: [`locks/${TOKEN}.release`],
		};
		await appendReceipt(dir, receipt);
		const [got] = await readReceipts(dir, "a1");
		expect(got?.filesTouched).toEqual([`locks/${TOKEN}.release`]);
		expect(got?.filesTouched[0]).toContain(TOKEN); // byte-exact — no truncation, no edit
	});

	/**
	 * The lossy path: buildDigest's Summary section is TextRank extractive (top-8 sentences by
	 * centrality — src/summarizer.ts). A one-off, lexically-unique token line has near-zero cosine
	 * similarity to ~200 lines of repetitive noise, so TextRank does NOT rank it into the top 8 —
	 * verified empirically against the real summarizer, not assumed. This is the honest assertion the
	 * task calls for: the digest must NEVER emit an ALTERED token (a truncation/edit would be worse
	 * than omission — E_abstraction is exactly "uses I′ ≠ I"), and when it omits the token outright,
	 * the raw transcript that produced the digest must remain addressable and hold it byte-exact —
	 * the drill-down path the E_abstraction detector requires.
	 */
	test("digest built from ~200 lines of noise: the token is either preserved exact, or absent — and if absent, the raw transcript still has it byte-exact (never altered)", () => {
		const noise: string[] = [];
		for (let i = 0; i < 200; i++) noise.push(`Investigated gate log line number ${i} for anomalies in the deployment pipeline stage ${i % 7}.`);
		noise.splice(97, 0, `DEPLOYMENT_LOCK_TOKEN: ${TOKEN} must be presented to release the gate.`);

		const transcript: TranscriptEntry[] = [
			{ kind: "user", text: "Investigate the gate log and find the deployment lock token to release the pipeline.", ts: 0 },
			...noise.map((text, i) => ({ kind: (i % 2 === 0 ? "assistant" : "user") as TranscriptEntry["kind"], text, ts: i + 1 })),
			{ kind: "assistant", text: "Finished scanning the noisy gate log for anomalies across every pipeline stage.", ts: 999 },
		];

		const digest = buildDigest({ transcript, receipts: [] });

		// The raw source (what a real drill-down action would re-read) is always addressable here —
		// it's the transcript array itself, byte-exact, independent of what the digest chose to keep.
		const rawHasToken = transcript.some((e) => e.text.includes(TOKEN));
		expect(rawHasToken).toBe(true);

		if (digest.includes(TOKEN)) {
			// If the summarizer DID surface it, that's a pass too — assert it's exact, not truncated.
			expect(digest).toContain(`DEPLOYMENT_LOCK_TOKEN: ${TOKEN}`);
		} else {
			// The expected, verified-empirically outcome: extractive summarization drops the
			// lexically-isolated token line. Never accept an ALTERED token — assert no truncated/edited
			// variant (a bare hyphen-stripped or partial-hex fragment) leaked into the digest either.
			expect(digest).not.toContain(TOKEN.slice(0, 20)); // no partial/truncated fragment either
			expect(rawHasToken).toBe(true); // drill-down path: the raw transcript still holds it exact
		}
	});
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// G05 parallel-contradict (E_contra / I5)
// ═════════════════════════════════════════════════════════════════════════════════════════════════

describe("G05 parallel-contradict (E_contra / I5) — two concurrent supersessions of the SAME current decision must never both win", () => {
	/**
	 * recordAgentDecision's own doc comment: the check-and-write is one synchronous block over the
	 * store-resident feature object, re-resolved after the only await (the adopt path) — so two
	 * near-simultaneous captures serialize on the same object instead of one clobbering the other.
	 * Because the feature is already seeded in the store, neither call takes that await, so both
	 * calls' synchronous bodies run to completion before either promise settles (JS run-to-completion
	 * semantics) — but the OUTCOME (not the scheduling) is what this test locks down: after both
	 * settle, exactly one decision is current (no supersededBy); the loser's outcome must name the
	 * conflict, never silently succeed as a second live current.
	 */
	test("two Promise.all'd recordAgentDecision calls superseding the same target: exactly one recorded, the other supersede-superseded — never two live currents", async () => {
		const dir = await tmpDir("g05-");
		const { mgr, store } = seededManager(dir, [dec("d1", "migration = v1")]);

		const [r1, r2] = await Promise.all([
			mgr.recordAgentDecision("f", dec("dA", "migration = v2-workerA", { supersedes: "d1" })),
			mgr.recordAgentDecision("f", dec("dB", "migration = v2-workerB", { supersedes: "d1" })),
		]);

		const outcomes = [r1, r2].sort();
		expect(outcomes).toEqual(["recorded", "supersede-superseded"]);

		const decisions = store.get("f")?.decisions ?? [];
		const current = decisions.filter((d) => !d.supersededBy);
		expect(current).toHaveLength(1); // exactly one current decision on the feature — never two
		expect(decisions.find((d) => d.id === "d1")?.supersededBy).toBeDefined(); // the original is invalidated exactly once
	});
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// G08 regeneration-idempotence (E_drift)
// ═════════════════════════════════════════════════════════════════════════════════════════════════

describe("G08 regeneration-idempotence (E_drift) — regenerating a digest from the same input twice must be byte-identical (regenerate-never-append at the digest seam)", () => {
	/**
	 * buildDigest (src/digest.ts) is a pure function of its DigestInput — it calls neither Date.now()
	 * nor any other ambient source internally, so no injected clock is needed. The guard this
	 * protects: repeated COMPACT cycles over unchanged source material must never drift the derived
	 * summary — a probe-set question answerable against cycle 1 must still be answerable, verbatim,
	 * against cycle N.
	 */
	test("buildDigest(input) called twice on identical input produces byte-identical markdown", () => {
		const transcript: TranscriptEntry[] = [
			{ kind: "user", text: "Roll the refresh token TTL down to 15 minutes and update the docs.", ts: 0 },
			{ kind: "assistant", text: "Updated src/auth/token.ts to use a 15-minute TTL for the refresh token rotation window.", ts: 1 },
			{ kind: "user", text: "Also add a regression test for the rotation boundary.", ts: 2 },
			{ kind: "assistant", text: "Added a boundary test asserting rotation triggers exactly at the 15-minute mark, not before.", ts: 3 },
		];
		const receipts: RunReceipt[] = [
			{ agentId: "a1", name: "a1", repo: "/repo", runId: "r1", startedAt: 0, endedAt: 10, status: "idle", toolCalls: 2, toolTally: { edit: 2 }, filesTouched: ["src/auth/token.ts", "tests/token.test.ts"] },
		];
		const input = { transcript, receipts, reward: { ok: true, fresh: true, firstTryGreen: true } };

		const first = buildDigest(input);
		const second = buildDigest(input);
		expect(second).toBe(first);

		// Independently constructed but content-identical input (a fresh COMPACT cycle re-reading the
		// same underlying transcript/receipts, not the same object references) must ALSO regenerate
		// byte-identical — this is the "regenerate, never append" guarantee, not object-identity luck.
		const third = buildDigest({ transcript: [...transcript], receipts: receipts.map((r) => ({ ...r })), reward: { ok: true, fresh: true, firstTryGreen: true } });
		expect(third).toBe(first);
	});
});

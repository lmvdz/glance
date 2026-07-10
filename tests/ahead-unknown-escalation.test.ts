/**
 * Bounded escalation for a PERSISTENT `aheadOfBase` fault (finding #1, cross-lineage review of
 * af3d534) — `agentHasUnlandedWork`'s own budget, independent of `land()`'s
 * `landBlockedEscalateCap`/`fileLandBlockedEscalation` (see `land-blocked-recording.test.ts`'s
 * "REGRESSION: a retryable refusal past the escalate cap..." test, which proves that mechanism is
 * real for a genuine `land()`-level retryable refusal — but nothing guarantees a fault narrow to
 * `aheadOfBase`'s own git call ever makes `land()` return `retryable`, and even when it does, that
 * budget bounds only the LAND attempt, not the costly VERIFY (acceptance-suite) run the orchestrator
 * re-triggers every ~30s tick via `agentHasWork` — orchestrator.ts:220. This file drives that gap
 * directly, through the cheap `computeAheadOfBaseFor` seam (no PATH shim, no real git fault needed —
 * `ahead-of-base-unknown.test.ts` already covers the real-git repro; this covers the STREAK policy).
 *
 * Two invariants, proven independently:
 *   1. A PERSISTENT unknown streak (>= `aheadUnknownEscalateCap()`, default 3) fires exactly ONE
 *      "Needs you" attention item (dual-write: attentionEvents + the "land" automation channel) and
 *      then stops returning `true` (so the orchestrator stops re-entering verify/land against an
 *      unresolved fault) — never a silent skip, since the human was already told.
 *   2. A TRANSIENT unknown (streak below the cap, or a streak that recovers before crossing it) never
 *      files anything and self-clears the instant `aheadOfBase` next returns a real number — the unit
 *      resumes normal auto-land behavior with no human action required.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

interface AheadCall {
	repo: string;
	branch: string;
	cwd?: string;
}
let calls: AheadCall[] = [];
let canned = 0;

const { SquadManager } = await import("../src/squad-manager.ts");
const { SubagentTracker } = await import("../src/subagents.ts");
import type { AgentDTO, PersistedAgent } from "../src/types.ts";

class TestManager extends SquadManager {
	protected computeAheadOfBaseFor(opts: AheadCall): Promise<number> {
		calls.push(opts);
		return Promise.resolve(canned);
	}
	callAgentHasUnlandedWork(id: string): Promise<boolean> {
		return this.agentHasUnlandedWork(id);
	}
}

function seed(mgr: InstanceType<typeof TestManager>, id: string, over: Partial<PersistedAgent> = {}): void {
	const repo = over.repo ?? "/r";
	const worktree = over.worktree ?? "/nonexistent-clean-dir-xyz";
	const branch = over.branch ?? `squad/${id}`;
	const dto: AgentDTO = {
		id,
		name: id,
		status: "idle",
		kind: "omp-operator",
		repo,
		worktree,
		branch,
		approvalMode: "yolo",
		pending: [],
		lastActivity: 0,
		messageCount: 0,
	};
	const options: PersistedAgent = { id, name: id, repo, worktree, branch, approvalMode: "yolo", ...over };
	mgr.agents.set(id, { dto, agent: undefined as never, options, transcript: [], assistantBuf: "", streaming: false, subs: new SubagentTracker() });
}

const ENV_KEYS = ["OMP_SQUAD_AHEAD_UNKNOWN_ESCALATE_CAP"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	calls = [];
	canned = 0;
});

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function tmpDir(prefix: string): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(d);
	return d;
}

// ── Invariant 1: persistent unknown ⇒ human notified, then held (not thrashed) ─────────────────

test("REGRESSION: a persistent aheadUnknown streak past the cap fires ONE 'Needs you' attention item — never forever-soft", async () => {
	process.env.OMP_SQUAD_AHEAD_UNKNOWN_ESCALATE_CAP = "3";
	canned = -1;
	const mgr = new TestManager({ stateDir: await tmpDir("ahead-esc-state-") });
	seed(mgr, "a1", { repo: "/r", branch: "squad/a1" });

	// Below the cap: the original assume-work-exists polarity holds, and nothing is filed yet.
	expect(await mgr.callAgentHasUnlandedWork("a1")).toBe(true);
	expect(await mgr.callAgentHasUnlandedWork("a1")).toBe(true);
	expect(mgr.agents.get("a1")?.dto.attentionEvents ?? []).toEqual([]);
	expect(mgr.automationActivity({ loop: "land" }).events).toEqual([]);

	// Crossing the cap (3rd consecutive unknown): fires exactly one attention item AND stops assuming
	// work exists — the orchestrator's `agentHasWork` gate now reads false, so it stops re-entering the
	// costly verify/land path against this SAME unresolved fault.
	expect(await mgr.callAgentHasUnlandedWork("a1")).toBe(false);
	const events = mgr.agents.get("a1")?.dto.attentionEvents ?? [];
	expect(events.length).toBe(1);
	expect(events[0]?.summary).toContain("squad/a1");
	expect(events[0]?.summary).toContain("3 consecutive checks");
	expect(events[0]?.summary).toContain("needs a human");
	expect(events[0]?.source).toBe("notify");

	const automationEvents = mgr.automationActivity({ loop: "land" }).events;
	expect(automationEvents.length).toBe(1);
	expect(automationEvents[0]?.level).toBe("warn");
	expect(automationEvents[0]?.detail).toContain("squad/a1");

	// Idempotent: the SAME still-faulting scope does not file a second item on later ticks, but the
	// unit remains visibly held — never a silent skip, since the attention item is already live.
	expect(await mgr.callAgentHasUnlandedWork("a1")).toBe(false);
	expect(await mgr.callAgentHasUnlandedWork("a1")).toBe(false);
	expect((mgr.agents.get("a1")?.dto.attentionEvents ?? []).length).toBe(1);
	expect(mgr.automationActivity({ loop: "land" }).events.length).toBe(1);
});

test("aheadUnknownEscalateCap:0 disables the bounded escalation (pure opt-out, never fires — the pre-fix assume-work-exists polarity thrashes unbounded on purpose)", async () => {
	process.env.OMP_SQUAD_AHEAD_UNKNOWN_ESCALATE_CAP = "0";
	canned = -1;
	const mgr = new TestManager({ stateDir: await tmpDir("ahead-esc-off-state-") });
	seed(mgr, "a1", { repo: "/r", branch: "squad/a1" });

	for (let i = 0; i < 10; i++) {
		expect(await mgr.callAgentHasUnlandedWork("a1")).toBe(true);
	}
	expect(mgr.agents.get("a1")?.dto.attentionEvents ?? []).toEqual([]);
	expect(mgr.automationActivity({ loop: "land" }).events).toEqual([]);
});

// ── Invariant 2: transient unknown ⇒ self-clears, no human involvement ─────────────────────────

test("a transient aheadUnknown streak below the cap never files anything and self-clears on the next real read", async () => {
	process.env.OMP_SQUAD_AHEAD_UNKNOWN_ESCALATE_CAP = "3";
	const mgr = new TestManager({ stateDir: await tmpDir("ahead-esc-transient-state-") });
	seed(mgr, "a1", { repo: "/r", branch: "squad/a1" });

	canned = -1;
	expect(await mgr.callAgentHasUnlandedWork("a1")).toBe(true); // streak 1/3
	expect(await mgr.callAgentHasUnlandedWork("a1")).toBe(true); // streak 2/3 — still below cap

	// Git recovers before the streak crosses the cap — a real number resets it, no human involved.
	canned = 0;
	expect(await mgr.callAgentHasUnlandedWork("a1")).toBe(false); // genuinely landed, real read
	expect(mgr.agents.get("a1")?.dto.attentionEvents ?? []).toEqual([]);
	expect(mgr.automationActivity({ loop: "land" }).events).toEqual([]);

	// The reset is real, not just "didn't escalate this time": a FRESH fault streak starts from zero
	// again — it takes another full `cap` consecutive unknowns to escalate, proving the counter (not
	// just the escalated flag) was cleared.
	canned = -1;
	expect(await mgr.callAgentHasUnlandedWork("a1")).toBe(true); // streak 1/3 again, not 4/3
	expect(await mgr.callAgentHasUnlandedWork("a1")).toBe(true); // streak 2/3 again
	expect(mgr.agents.get("a1")?.dto.attentionEvents ?? []).toEqual([]);
});

test("the unit resumes automatically after an escalated streak recovers — the escalated flag resets too, so a LATER persistent fault can escalate again", async () => {
	process.env.OMP_SQUAD_AHEAD_UNKNOWN_ESCALATE_CAP = "3";
	const mgr = new TestManager({ stateDir: await tmpDir("ahead-esc-resume-state-") });
	seed(mgr, "a1", { repo: "/r", branch: "squad/a1" });

	// Drive the streak past the cap — one escalation.
	canned = -1;
	for (let i = 0; i < 3; i++) await mgr.callAgentHasUnlandedWork("a1");
	expect((mgr.agents.get("a1")?.dto.attentionEvents ?? []).length).toBe(1);

	// Git recovers: the unit is no longer held, and the read is trusted again with no human action.
	canned = 4; // genuinely unlanded, real count
	expect(await mgr.callAgentHasUnlandedWork("a1")).toBe(true);

	// A LATER independent fault streak on the SAME branch can escalate again — the escalated flag isn't
	// permanently burned by the first episode.
	canned = -1;
	for (let i = 0; i < 3; i++) await mgr.callAgentHasUnlandedWork("a1");
	expect((mgr.agents.get("a1")?.dto.attentionEvents ?? []).length).toBe(2);
});

/**
 * Observer — fleet self-audit loop (OMPSQ-52). Every edge runs through fake deps, no live daemon.
 *
 * Covers the acceptance contract: (a) start() arms no timer when OMP_SQUAD_OBSERVE=0; (b) a seeded gap
 * files exactly one finding; (c) the same gap next tick (and on a fresh Observer over the same stateDir)
 * is NOT re-filed — dedup persists; (d) a resolved gap clears its fingerprint; (e) findings default to
 * needs-triage (do-not-auto-land marker, never auto-dispatch). Plus the cap, autofix, and autodispatch seams.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AutomationReport } from "../src/automation-log.ts";
import { Observer, type ObserverDeps, auditLandedSurvivors, auditStaleDone, auditTestsGreen, landFailureFindings } from "../src/observer.ts";
import type { LandLedger } from "../src/land-ledger.ts";
import type { AgentDTO, AgentStatus, IssueRef } from "../src/types.ts";

const ENV_KEYS = ["OMP_SQUAD_OBSERVE", "OMP_SQUAD_OBSERVE_MAX", "OMP_SQUAD_OBSERVE_AUTODISPATCH", "OMP_SQUAD_OBSERVE_AUTOFIX", "OMP_SQUAD_AUTOLAND_FAIL_CAP"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

const tmpDir = (): string => mkdtempSync(path.join(os.tmpdir(), "observer-"));

const agent = (id: string, status: AgentStatus, issue?: IssueRef, branch = "squad/x"): AgentDTO => ({
	id,
	name: id,
	status,
	kind: "omp-operator",
	repo: "/r",
	worktree: "/w",
	branch,
	approvalMode: "write",
	pending: [],
	lastActivity: 0,
	messageCount: 0,
	issue,
});

interface Harness {
	deps: ObserverDeps;
	filed: string[];
	closed: string[];
	reopened: string[];
}
function makeDeps(stateDir: string, over: Partial<ObserverDeps> = {}): Harness {
	const filed: string[] = [];
	const closed: string[] = [];
	const reopened: string[] = [];
	let seq = 0;
	const deps: ObserverDeps = {
		listAgents: () => [],
		listIssues: async () => [],
		fileIssue: async (title) => {
			filed.push(title);
			return { id: `i-${++seq}`, name: title, identifier: `OMPSQ-${seq}` };
		},
		closeIssue: async (ref) => {
			closed.push(ref.id);
			return true;
		},
		reopenIssue: async (ref) => {
			reopened.push(ref.id);
			return true;
		},
		removeAgent: async () => {},
		runGate: async () => ({ ok: true }),
		gitAheadOfMain: () => 0,
		untrackedInMain: () => [],
		filesOnAgentBranch: () => [],
		stateDir,
		now: () => 1,
		log: () => {},
		...over,
	};
	return { deps, filed, closed, reopened };
}

test("(a) start() arms no timer when OMP_SQUAD_OBSERVE=0; arms one when enabled", () => {
	const real = globalThis.setInterval;
	let armed = 0;
	// @ts-expect-error — spy stand-in for the timer factory.
	globalThis.setInterval = () => {
		armed++;
		return { unref() {} } as unknown as Timer;
	};
	try {
		process.env.OMP_SQUAD_OBSERVE = "0";
		new Observer(makeDeps(tmpDir()).deps).start();
		expect(armed).toBe(0); // disabled ⇒ no timer leaked

		process.env.OMP_SQUAD_OBSERVE = "1";
		new Observer(makeDeps(tmpDir()).deps).start();
		expect(armed).toBe(1);
	} finally {
		globalThis.setInterval = real;
	}
});

test("(a) tick is inert when OMP_SQUAD_OBSERVE=0 (gate precedes every dep)", async () => {
	process.env.OMP_SQUAD_OBSERVE = "0";
	let touched = false;
	const { deps, filed } = makeDeps(tmpDir(), {
		listIssues: async () => {
			touched = true;
			return [];
		},
		runGate: async () => {
			touched = true;
			return { ok: true };
		},
	});
	await new Observer(deps).tick();
	expect(touched).toBe(false);
	expect(filed).toEqual([]);
});

test("(b) a red gate files exactly one regression finding", async () => {
	process.env.OMP_SQUAD_OBSERVE = "1";
	const { deps, filed } = makeDeps(tmpDir(), { runGate: async () => ({ ok: false, firstFailure: "auth.test.ts > login" }) });
	await new Observer(deps).tick();
	expect(filed.length).toBe(1);
	expect(filed[0]).toContain("regression: auth.test.ts > login");
});

test("(b) a flaky gate (red then green on the confirm re-run) files NOTHING — no false regression (OMPSQ-184)", async () => {
	process.env.OMP_SQUAD_OBSERVE = "1";
	let calls = 0;
	const { deps, filed } = makeDeps(tmpDir(), {
		runGate: async () => (++calls === 1 ? { ok: false, firstFailure: "a parked spawn is visible to the orchestrator's drain" } : { ok: true }),
	});
	await new Observer(deps).tick();
	expect(calls).toBe(2); // a red run is re-run once to confirm
	expect(filed).toEqual([]); // confirm came back green ⇒ flaky ⇒ no issue filed
});

test("(b) a reproduced red gate (red twice) files exactly one regression, named by the confirming run", async () => {
	process.env.OMP_SQUAD_OBSERVE = "1";
	let calls = 0;
	const { deps, filed } = makeDeps(tmpDir(), {
		runGate: async () => {
			calls++;
			return { ok: false, firstFailure: calls === 1 ? "flaky-first" : "real-regression" };
		},
	});
	await new Observer(deps).tick();
	expect(calls).toBe(2);
	expect(filed.length).toBe(1);
	expect(filed[0]).toContain("regression: real-regression"); // the reproduced run names the finding
});

test("(b) an idle ahead=0 agent whose issue is Done does NOT file a reap (housekeeping, not backlog)", async () => {
	process.env.OMP_SQUAD_OBSERVE = "1";
	const done = { id: "done-1", name: "shipped", identifier: "OMPSQ-48" } satisfies IssueRef;
	const { deps, filed } = makeDeps(tmpDir(), {
		listAgents: () => [agent("ag1", "idle", done)],
		listIssues: async () => [], // done issue absent from the open set ⇒ Done
		gitAheadOfMain: () => 0,
	});
	await new Observer(deps).tick();
	expect(filed).toEqual([]); // landed-survivor reap is housekeeping — reaped/logged, NEVER filed as backlog

	// An idle agent whose issue is STILL OPEN is not a survivor — no finding.
	const open = { id: "open-1", name: "wip", identifier: "OMPSQ-50" } satisfies IssueRef;
	const h2 = makeDeps(tmpDir(), { listAgents: () => [agent("ag2", "idle", open)], listIssues: async () => [open] });
	await new Observer(h2.deps).tick();
	expect(h2.filed).toEqual([]);
});

test("a STOPPED landed-and-Done agent is reaped too (the common done-state — host exits), and OBSERVE_AUTOFIX actions it", async () => {
	process.env.OMP_SQUAD_OBSERVE = "1";
	const done = { id: "done-1", name: "shipped", identifier: "OMPSQ-48" } satisfies IssueRef;
	// A stopped ahead=0 Done agent is NOT filed (housekeeping reap, never backlog noise).
	const filer = makeDeps(tmpDir(), { listAgents: () => [agent("s1", "stopped", done)], listIssues: async () => [], gitAheadOfMain: () => 0 });
	await new Observer(filer.deps).tick();
	expect(filer.filed).toEqual([]);

	// Autofix path: with OMP_SQUAD_OBSERVE_AUTOFIX=1 the loop removes it directly instead of filing.
	process.env.OMP_SQUAD_OBSERVE_AUTOFIX = "1";
	const removed: string[] = [];
	const fixer = makeDeps(tmpDir(), {
		listAgents: () => [agent("s2", "stopped", done)],
		listIssues: async () => [],
		gitAheadOfMain: () => 0,
		removeAgent: async (id) => { removed.push(id); },
	});
	await new Observer(fixer.deps).tick();
	expect(removed).toEqual(["s2"]);
	expect(fixer.filed).toEqual([]); // actioned, not filed
});

test("a stopped agent still AHEAD of main (unlanded) is NOT reaped as a survivor", async () => {
	process.env.OMP_SQUAD_OBSERVE = "1";
	const done = { id: "d2", name: "x", identifier: "OMPSQ-60" } satisfies IssueRef;
	const { deps, filed } = makeDeps(tmpDir(), { listAgents: () => [agent("s3", "stopped", done)], listIssues: async () => [], gitAheadOfMain: () => 2 });
	await new Observer(deps).tick();
	// ahead>0 ⇒ not a landed survivor (it's a stale-done finding instead); never reaped.
	expect(filed.some((t) => t.includes("reap landed survivor"))).toBe(false);
});

test("(c) the same gap next tick is NOT re-filed — dedup persists in-process and across a restart", async () => {
	process.env.OMP_SQUAD_OBSERVE = "1";
	const dir = tmpDir();
	const { deps, filed } = makeDeps(dir, { runGate: async () => ({ ok: false, firstFailure: "x.test.ts" }) });
	const obs = new Observer(deps);
	await obs.tick();
	await obs.tick();
	expect(filed.length).toBe(1); // second tick reproduces the same fingerprint ⇒ skipped

	// A fresh Observer over the same stateDir loads the persisted fingerprint ⇒ still no re-file.
	const { deps: deps2, filed: filed2 } = makeDeps(dir, { runGate: async () => ({ ok: false, firstFailure: "x.test.ts" }) });
	await new Observer(deps2).tick();
	expect(filed2).toEqual([]);
});

test("(d) a resolved gap clears its fingerprint, so it would re-file if it recurs", async () => {
	process.env.OMP_SQUAD_OBSERVE = "1";
	const dir = tmpDir();
	let red = true;
	const logs: string[] = [];
	const { deps, filed } = makeDeps(dir, { runGate: async () => (red ? { ok: false, firstFailure: "y.test.ts" } : { ok: true }), log: (m) => logs.push(m) });
	const obs = new Observer(deps);
	await obs.tick(); // red ⇒ filed
	expect(filed.length).toBe(1);

	red = false;
	await obs.tick(); // green ⇒ no longer reproduces ⇒ resolved + cleared
	expect(logs.some((l) => l.startsWith("resolved regression:y.test.ts"))).toBe(true);

	red = true;
	await obs.tick(); // recurs ⇒ fingerprint was cleared ⇒ re-files
	expect(filed.length).toBe(2);
});

test("(e) findings default to needs-triage (do-not-auto-land marker); autodispatch drops the marker for plain findings", async () => {
	process.env.OMP_SQUAD_OBSERVE = "1";
	// Default: a plain high-severity regression is filed needs-triage (marker present).
	const h1 = makeDeps(tmpDir(), { runGate: async () => ({ ok: false, firstFailure: "z.test.ts" }) });
	await new Observer(h1.deps).tick();
	expect(h1.filed[0]).toContain("do-not-auto-land");

	// Opt-in autodispatch: the same plain finding files WITHOUT the marker (dispatcher will consume it).
	process.env.OMP_SQUAD_OBSERVE_AUTODISPATCH = "1";
	const h2 = makeDeps(tmpDir(), { runGate: async () => ({ ok: false, firstFailure: "z.test.ts" }) });
	await new Observer(h2.deps).tick();
	expect(h2.filed[0]).not.toContain("do-not-auto-land");

	// Structural findings ALWAYS keep the marker, even under autodispatch.
	const done = { id: "d", name: "n", identifier: "OMPSQ-9" } satisfies IssueRef;
	const h3 = makeDeps(tmpDir(), { listAgents: () => [agent("a", "working", done)], listIssues: async () => [], gitAheadOfMain: () => 3 });
	await new Observer(h3.deps).tick();
	expect(h3.filed).toEqual([]);
	expect(h3.reopened).toEqual(["d"]);
});

test("autofix actions a survivor even if it was already FILED while autofix was off (reorder before dedup)", async () => {
	process.env.OMP_SQUAD_OBSERVE = "1";
	process.env.OMP_SQUAD_OBSERVE_AUTOFIX = "1";
	const dir = tmpDir();
	// Pre-seed seen.json as if the survivor was filed by an earlier run (autofix off then).
	writeFileSync(path.join(dir, "observer-seen.json"), JSON.stringify({ "survivor:agz": { title: "reap landed survivor agz", issueId: "i-old", filedAt: 1 } }));
	const done = { id: "done-9", name: "shipped", identifier: "OMPSQ-99" } satisfies IssueRef;
	const removed: string[] = [];
	const { deps, filed } = makeDeps(dir, {
		listAgents: () => [agent("agz", "stopped", done)],
		listIssues: async () => [],
		gitAheadOfMain: () => 0,
		removeAgent: async (id) => { removed.push(id); },
	});
	await new Observer(deps).tick();
	expect(removed).toEqual(["agz"]); // reaped despite the prior filing
	expect(filed).toEqual([]); // actioned, not re-filed
});

test("cap: observer-filed OPEN issues past OMP_SQUAD_OBSERVE_MAX are logged + skipped, not filed", async () => {
	process.env.OMP_SQUAD_OBSERVE = "1";
	process.env.OMP_SQUAD_OBSERVE_MAX = "1";
	const logs: string[] = [];
	// One observer issue already open ⇒ at cap ⇒ a new gap is skipped.
	const { deps, filed } = makeDeps(tmpDir(), {
		listIssues: async () => [{ id: "o1", name: "[observer] do-not-auto-land: prior", identifier: "OMPSQ-1" }],
		runGate: async () => ({ ok: false, firstFailure: "cap.test.ts" }),
		log: (m) => logs.push(m),
	});
	await new Observer(deps).tick();
	expect(filed).toEqual([]);
	expect(logs.some((l) => l.includes("observe cap reached"))).toBe(true);
});

test("autofix: a reap-survivor finding is actioned (removeAgent) and not filed under OMP_SQUAD_OBSERVE_AUTOFIX=1", async () => {
	process.env.OMP_SQUAD_OBSERVE = "1";
	process.env.OMP_SQUAD_OBSERVE_AUTOFIX = "1";
	const removed: string[] = [];
	const done = { id: "done", name: "n", identifier: "OMPSQ-33" } satisfies IssueRef;
	const { deps, filed } = makeDeps(tmpDir(), {
		listAgents: () => [agent("survivor", "idle", done)],
		listIssues: async () => [],
		gitAheadOfMain: () => 0,
		removeAgent: async (id) => {
			removed.push(id);
		},
	});
	await new Observer(deps).tick();
	expect(removed).toEqual(["survivor"]);
	expect(filed).toEqual([]); // fixed directly ⇒ not filed
});

test("untracked-land-hazard fires only on a collision with an open agent branch", async () => {
	process.env.OMP_SQUAD_OBSERVE = "1";
	const branched = agent("a", "working", undefined, "squad/a");
	// Untracked file in main that ALSO exists on the agent branch ⇒ hazard.
	const h1 = makeDeps(tmpDir(), {
		listAgents: () => [branched],
		untrackedInMain: () => ["tests/routing.test.ts", "scratch.txt"],
		filesOnAgentBranch: () => ["tests/routing.test.ts", "src/x.ts"],
	});
	await new Observer(h1.deps).tick();
	expect(h1.filed.length).toBe(1);
	expect(h1.filed[0]).toContain("tests/routing.test.ts");
	expect(h1.filed[0]).not.toContain("scratch.txt"); // no branch collision ⇒ excluded

	// Untracked but no overlap ⇒ no finding.
	const h2 = makeDeps(tmpDir(), { listAgents: () => [branched], untrackedInMain: () => ["scratch.txt"], filesOnAgentBranch: () => ["src/x.ts"] });
	await new Observer(h2.deps).tick();
	expect(h2.filed).toEqual([]);
});

// ── Check 5: land-ledger mining → bug issue ───────────────────────────────────

test("landFailureFindings flags live branches at/over the cap, ignores reaped + under-cap", () => {
	const ledger: LandLedger = {
		"squad/a1": { fails: 3, lastDetail: "gate red", at: 1 }, // at cap, live
		"squad/a2": { fails: 1, lastDetail: "x", at: 1 }, // under cap
		"squad/gone": { fails: 5, lastDetail: "x", at: 1 }, // over cap but not in the live set ⇒ aged out
	};
	const out = landFailureFindings(ledger, new Set(["squad/a1", "squad/a2"]), 3);
	expect(out.map((f) => f.fingerprint)).toEqual(["land-failing:squad/a1"]);
	expect(out[0].title).toContain("auto-land failing for squad/a1");
	expect(out[0].severity).toBe("high");
});

test("a branch below the cap yields no finding", () => {
	expect(landFailureFindings({ "squad/a1": { fails: 2, lastDetail: "x", at: 1 } }, new Set(["squad/a1"]), 3)).toEqual([]);
});

test("(b) the observer files exactly one bug for a branch whose auto-land keeps failing", async () => {
	process.env.OMP_SQUAD_OBSERVE = "1";
	const ledger: LandLedger = { "squad/a1": { fails: 3, lastDetail: "gate red", at: 1 } };
	const { deps, filed } = makeDeps(tmpDir(), {
		listAgents: () => [agent("a1", "stopped", undefined, "squad/a1")],
		landLedger: () => ledger,
	});
	await new Observer(deps).tick();
	expect(filed.length).toBe(1);
	expect(filed[0]).toContain("auto-land failing for squad/a1");
});

test("survivor fingerprint is keyed on the stable Plane identifier, not the ephemeral agent id", () => {
	const issue = { id: "iss-1", name: "shipped", identifier: "OMPSQ-48" } satisfies IssueRef;
	// Two agent ids for the SAME landed issue (a re-dispatch) ⇒ ONE stable fingerprint, so a reap
	// can't be re-filed per re-spawn (the old `survivor:${a.id}` key flooded the tracker).
	const f1 = auditLandedSurvivors([agent("ompsq-48-aaaa", "stopped", issue)], new Set<string>(), () => 0, async () => {});
	const f2 = auditLandedSurvivors([agent("ompsq-48-bbbb", "stopped", issue)], new Set<string>(), () => 0, async () => {});
	expect(f1[0].fingerprint).toBe("survivor:OMPSQ-48");
	expect(f2[0].fingerprint).toBe(f1[0].fingerprint);
});

test("auditStaleDone: below the systemic threshold ⇒ reopens the source false-Done issues", () => {
	const mk = (n: number) => ({ id: `i${n}`, name: "x", identifier: `OMPSQ-${n}` }) satisfies IssueRef;
	const agents = [agent("a1", "stopped", mk(1)), agent("a2", "stopped", mk(2))];
	const f = auditStaleDone(agents, new Set<string>(), () => 3);
	expect(f.length).toBe(2);
	expect(f.map((x) => x.fingerprint).sort()).toEqual(["false-done:OMPSQ-1", "false-done:OMPSQ-2"]);
	expect(f.map((x) => x.reopenIssue?.id).sort()).toEqual(["i1", "i2"]);
});

test("auditStaleDone: ≥3 stranded at once ⇒ one systemic finding plus source issue reopens", () => {
	const mk = (n: number) => ({ id: `i${n}`, name: "x", identifier: `OMPSQ-${n}` }) satisfies IssueRef;
	const agents = [1, 2, 3, 4].map((n) => agent(`a${n}`, "stopped", mk(n)));
	const f = auditStaleDone(agents, new Set<string>(), () => 1);
	expect(f.length).toBe(5);
	expect(f[0].fingerprint).toBe("autoland-systemic-failure"); // count-independent ⇒ dedups across ticks
	expect(f[0].severity).toBe("structural");
	expect(f[0].detail).toContain("OMPSQ-1, OMPSQ-2, OMPSQ-3, OMPSQ-4"); // names the stranded set
	expect(f.slice(1).map((x) => x.reopenIssue?.id).sort()).toEqual(["i1", "i2", "i3", "i4"]);
	// The aggregate set shifting (one lands, a new one strands) keeps the SAME fingerprint ⇒ no re-file.
	const f2 = auditStaleDone([2, 3, 4, 5].map((n) => agent(`a${n}`, "stopped", mk(n))), new Set<string>(), () => 1);
	expect(f2[0].fingerprint).toBe(f[0].fingerprint);
});

test("regression fingerprint strips bun's per-run duration ⇒ stable across runs (no per-tick re-file)", () => {
	// Same failing test, two different run durations (a fast run vs a one-off 30s timeout). The duration
	// must not leak into the fingerprint, else each red tick mints a new Plane issue for the same test.
	const a = auditTestsGreen({ ok: false, firstFailure: "SquadManager: create reaches idle [795.31ms]" });
	const b = auditTestsGreen({ ok: false, firstFailure: "SquadManager: create reaches idle [30000.10ms]" });
	expect(a[0].fingerprint).toBe("regression:SquadManager: create reaches idle");
	expect(b[0].fingerprint).toBe(a[0].fingerprint);
	expect(a[0].title).toBe("regression: SquadManager: create reaches idle");
});

test("a resolved finding CLOSES its Plane issue (self-healing), not just clears the fingerprint", async () => {
	process.env.OMP_SQUAD_OBSERVE = "1";
	let red = true;
	const h = makeDeps(tmpDir(), { runGate: async () => (red ? { ok: false, firstFailure: "y.test.ts" } : { ok: true }) });
	const obs = new Observer(h.deps);
	await obs.tick(); // red ⇒ one regression issue filed
	expect(h.filed.length).toBe(1);
	expect(h.closed).toEqual([]);
	red = false;
	await obs.tick(); // green ⇒ resolved ⇒ the filed issue is closed, not left open
	expect(h.closed).toEqual(["i-1"]);
});

test("a resolved false-Done fingerprint never closes the reopened source issue", async () => {
	process.env.OMP_SQUAD_OBSERVE = "1";
	const done = { id: "done-1", name: "stranded", identifier: "OMPSQ-330" } satisfies IssueRef;
	let openIssues: IssueRef[] = [];
	const h = makeDeps(tmpDir(), {
		listAgents: () => [agent("ag", "stopped", done)],
		listIssues: async () => openIssues,
		gitAheadOfMain: () => 2,
	});
	const obs = new Observer(h.deps);
	await obs.tick();
	expect(h.filed).toEqual([]);
	expect(h.reopened).toEqual(["done-1"]);
	openIssues = [done]; // reopened source issue is now open, so the false-Done no longer reproduces
	await obs.tick();
	expect(h.closed).toEqual([]);
});

// #17: a transient (thrown) Plane list is retried once and recovers silently; a persistent failure is
// surfaced (log + warn record) instead of silently dropping the tick — and the tick never throws.
test("(#17) a transient listIssues throw is retried once and recovers (no warning)", async () => {
	process.env.OMP_SQUAD_OBSERVE = "1";
	const events: AutomationReport[] = [];
	let attempts = 0;
	const h = makeDeps(tmpDir(), {
		record: (r) => events.push(r),
		runGate: async () => ({ ok: false, firstFailure: "y.test.ts" }), // one finding so the tick has work to do
		listIssues: async () => {
			attempts++;
			if (attempts === 1) throw new Error("429 rate limited");
			return [];
		},
	});
	await new Observer(h.deps).tick();
	expect(attempts).toBe(2); // first threw, retry succeeded
	expect(h.filed.length).toBe(1); // the tick's filing still happened
	expect(events.some((e) => e.level === "warn")).toBe(false); // recovered ⇒ no warn
});

test("(#17) a persistent listIssues failure is surfaced (warn record), and the tick stays non-fatal", async () => {
	process.env.OMP_SQUAD_OBSERVE = "1";
	const events: AutomationReport[] = [];
	const logs: string[] = [];
	const h = makeDeps(tmpDir(), {
		record: (r) => events.push(r),
		log: (m) => logs.push(m),
		listIssues: async () => {
			throw new Error("plane down");
		},
	});
	await new Observer(h.deps).tick(); // must NOT throw
	expect(logs.some((m) => m.includes("listIssues failed after retry"))).toBe(true);
	expect(events.some((e) => e.level === "warn" && (e.detail ?? "").includes("listIssues failed"))).toBe(true);
});

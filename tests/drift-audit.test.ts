/**
 * Drift audit (Sentinel v0 JUDGE-confirmation + durable record, plans/sentinel-drift-probe/01).
 * Every edge runs through fake deps (a fake judge, an injected diff() / stillLive()), no daemon, no
 * real `omp` call. Covers: the runId-turnover race guard firing BEFORE the judge ever runs, the
 * abstain/veto/pass verdicts landing in the audit entry, and the append-only jsonl record surviving
 * independent of any run object.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendDriftAudit, confirmDrift, type ConfirmDeps, type DriftAuditEntry, driftAuditPath } from "../src/drift-audit.ts";
import type { Hypothesis } from "../src/drift-lens.ts";
import type { RawVerdict } from "../src/validator.ts";
import type { FeatureCriterion } from "../src/types.ts";

const tmpDir = (): string => mkdtempSync(path.join(os.tmpdir(), "drift-audit-"));

const CRITERIA: FeatureCriterion[] = [
	{ id: "c1", text: "adds retry to the RPC client", completed: false },
	{ id: "c2", text: "covers the reconnect path with a test", completed: false },
];

const HYPOTHESIS: Hypothesis = {
	kind: "wrong-direction",
	severity: "medium",
	agent: "rpc-agent",
	runId: "run-1",
	evidence: "abandoning the retry work to rewrite the logger instead",
	rationale: "reasoning trending away from the declared criteria",
	at: 100,
};

function fakeJudge(verdict: RawVerdict | undefined): (input: { criteria: FeatureCriterion[]; diff: string }) => Promise<RawVerdict | undefined> {
	return async () => verdict;
}

function makeDeps(stateDir: string, over: Partial<ConfirmDeps> = {}): { deps: ConfirmDeps } {
	const deps: ConfirmDeps = {
		hypothesis: HYPOTHESIS,
		criteria: CRITERIA,
		diff: async () => "diff --git a/x b/x\n+retry logic",
		judge: async (input) => ({ perCriterion: input.criteria.map((c) => ({ id: c.id, satisfied: true })), confidence: 0.9, rationale: "looks fine" }),
		stillLive: () => true,
		stateDir,
		now: () => 999,
		log: () => {},
		...over,
	};
	return { deps };
}

// ── driftAuditPath / appendDriftAudit ─────────────────────────────────────────

test("driftAuditPath joins stateDir with sentinel-audit.jsonl", () => {
	expect(driftAuditPath("/tmp/state")).toBe(path.join("/tmp/state", "sentinel-audit.jsonl"));
});

test("appendDriftAudit writes one JSON line, append-only across calls", () => {
	const dir = tmpDir();
	const entry: DriftAuditEntry = { agent: "ag1", kind: "wrong-direction", severity: "low", evidence: "e", rationale: "r", judgeVerdict: "pass", agreement: 1, ts: 1 };
	appendDriftAudit(dir, entry);
	appendDriftAudit(dir, { ...entry, ts: 2 });
	const lines = readFileSync(driftAuditPath(dir), "utf8").trim().split("\n");
	expect(lines.length).toBe(2);
	expect(JSON.parse(lines[0])).toEqual(entry);
	expect(JSON.parse(lines[1]).ts).toBe(2);
});

test("appendDriftAudit is best-effort — an unwritable path logs and never throws", () => {
	const messages: string[] = [];
	const entry: DriftAuditEntry = { agent: "ag1", kind: "wrong-direction", severity: "low", evidence: "e", rationale: "r", judgeVerdict: "pass", agreement: 1, ts: 1 };
	// A nested path under a non-existent parent directory can't be appended to (ENOENT) — must not throw.
	expect(() => appendDriftAudit(path.join(tmpDir(), "no", "such", "dir"), entry, (m) => messages.push(m))).not.toThrow();
	expect(messages.length).toBe(1);
});

// ── confirmDrift: race guard ──────────────────────────────────────────────────

test("confirmDrift returns null and writes nothing when stillLive() is false BEFORE the judge runs", async () => {
	const dir = tmpDir();
	let judgeCalled = false;
	const { deps } = makeDeps(dir, {
		stillLive: () => false,
		judge: async () => {
			judgeCalled = true;
			return { perCriterion: [{ id: "c1", satisfied: true }] };
		},
	});
	const result = await confirmDrift(deps);
	expect(result).toBeNull();
	expect(judgeCalled).toBe(false); // the judge must never run once the run has turned over
	expect(() => readFileSync(driftAuditPath(dir), "utf8")).toThrow(); // nothing written
});

test("confirmDrift re-checks stillLive() after the judge runs and aborts the write on turnover", async () => {
	const dir = tmpDir();
	let calls = 0;
	const { deps } = makeDeps(dir, {
		stillLive: () => {
			calls++;
			return calls === 1; // live for the pre-judge check, turned over by the time of the write check
		},
	});
	const result = await confirmDrift(deps);
	expect(result).toBeNull();
	expect(() => readFileSync(driftAuditPath(dir), "utf8")).toThrow();
});

// ── confirmDrift: recorded verdicts ───────────────────────────────────────────

test("confirmDrift records \"abstain\" on an empty diff (judge sees nothing to inspect)", async () => {
	const dir = tmpDir();
	const { deps } = makeDeps(dir, { diff: async () => "" });
	const result = await confirmDrift(deps);
	expect(result).not.toBeNull();
	expect(result?.judgeVerdict).toBe("abstain");
	expect(result?.agent).toBe("rpc-agent");
	expect(result?.runId).toBe("run-1");
	expect(result?.kind).toBe("wrong-direction");
	expect(result?.severity).toBe("medium");
	expect(result?.evidence).toBe(HYPOTHESIS.evidence);
	expect(result?.rationale).toBe(HYPOTHESIS.rationale);
	expect(result?.ts).toBe(999);
});

test("confirmDrift records \"pass\" when the fake judge is satisfied on all criteria", async () => {
	const dir = tmpDir();
	const { deps } = makeDeps(dir, { judge: fakeJudge({ perCriterion: [{ id: "c1", satisfied: true }, { id: "c2", satisfied: true }], confidence: 1, rationale: "fine" }) });
	const result = await confirmDrift(deps);
	expect(result?.judgeVerdict).toBe("pass");
	expect(result?.agreement).toBe(1);
});

test("confirmDrift records \"veto\" when the fake judge finds an unsatisfied criterion", async () => {
	const dir = tmpDir();
	const { deps } = makeDeps(dir, {
		judge: fakeJudge({ perCriterion: [{ id: "c1", satisfied: true }, { id: "c2", satisfied: false, note: "no reconnect test found" }], confidence: 0.8, rationale: "reconnect path untested" }),
	});
	const result = await confirmDrift(deps);
	expect(result?.judgeVerdict).toBe("veto");
	expect(result?.agreement).toBe(0.5);
});

test("confirmDrift records \"skipped\" when there are no declared criteria", async () => {
	const dir = tmpDir();
	const { deps } = makeDeps(dir, { criteria: [] });
	const result = await confirmDrift(deps);
	expect(result?.judgeVerdict).toBe("skipped");
});

// ── durable record ─────────────────────────────────────────────────────────

test("a confirmed hypothesis appends exactly one line to sentinel-audit.jsonl", async () => {
	const dir = tmpDir();
	const { deps } = makeDeps(dir);
	await confirmDrift(deps);
	const lines = readFileSync(driftAuditPath(dir), "utf8").trim().split("\n");
	expect(lines.length).toBe(1);
	const parsed = JSON.parse(lines[0]);
	expect(parsed.agent).toBe("rpc-agent");
	expect(parsed.judgeVerdict).toBe("pass");
});

test("the audit record survives independent of any run object — confirmDrift never reads/writes a run", async () => {
	const dir = tmpDir();
	const { deps } = makeDeps(dir);
	const result = await confirmDrift(deps);
	expect(result).not.toBeNull();
	// The persisted file is a plain jsonl on disk, addressable purely by stateDir — no run handle needed.
	const fromDisk = JSON.parse(readFileSync(driftAuditPath(dir), "utf8").trim());
	expect(fromDisk).toEqual(result);
});

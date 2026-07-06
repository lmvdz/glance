/**
 * Joined task-outcome row (src/task-outcomes.ts) — the append-only log C05's matrix reads instead of
 * re-deriving a fragile cross-file join. Covers the round-trip, the agentId-keyed idempotent collapse
 * (last-terminal-wins, the whole point: a revert→reland or a reconciler double-fire must never double-
 * count), the missing-file/corrupt-line cases, and the small-row shape.
 */

import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readTaskOutcomes, recordTaskOutcome, type TaskOutcomeRow } from "../src/task-outcomes.ts";

async function tmpDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "task-outcomes-"));
}

function row(overrides: Partial<TaskOutcomeRow> = {}): TaskOutcomeRow {
	return {
		agentId: "agent-1",
		branch: "squad/agent-1",
		routing: { mode: "tdd", tier: "mid" },
		model: "claude-sonnet-5",
		costUsd: 0.42,
		confidence: 0.8,
		validation: "pass",
		outcome: "landed",
		source: "land",
		ts: 1000,
		...overrides,
	};
}

test("recordTaskOutcome then readTaskOutcomes round-trips a single row", async () => {
	const dir = await tmpDir();
	expect(await readTaskOutcomes(dir)).toEqual([]);
	await recordTaskOutcome(dir, row());
	const rows = await readTaskOutcomes(dir);
	expect(rows).toEqual([row()]);
});

test("collapse-by-agentId keeps the LAST row (terminal-wins), never doubles", async () => {
	const dir = await tmpDir();
	// Same agentId, two writes — e.g. an in-process land() rejection, then a reconciler catching the
	// SAME branch's out-of-band merge later. The last (terminal) write must win, and there must be
	// exactly one row for the agentId, not two.
	await recordTaskOutcome(dir, row({ outcome: "rejected", source: "land", ts: 1000 }));
	await recordTaskOutcome(dir, row({ outcome: "landed", source: "reconciled", ts: 2000 }));
	const rows = await readTaskOutcomes(dir);
	expect(rows.length).toBe(1);
	expect(rows[0].outcome).toBe("landed");
	expect(rows[0].source).toBe("reconciled");
	expect(rows[0].ts).toBe(2000);
});

test("distinct agentIds each keep their own row", async () => {
	const dir = await tmpDir();
	await recordTaskOutcome(dir, row({ agentId: "agent-1", outcome: "landed" }));
	await recordTaskOutcome(dir, row({ agentId: "agent-2", outcome: "rejected" }));
	const rows = await readTaskOutcomes(dir);
	expect(rows.length).toBe(2);
	const byId = Object.fromEntries(rows.map((r) => [r.agentId, r]));
	expect(byId["agent-1"].outcome).toBe("landed");
	expect(byId["agent-2"].outcome).toBe("rejected");
});

test("a missing file reads as an empty array, never throws", async () => {
	const dir = await tmpDir();
	expect(await readTaskOutcomes(dir)).toEqual([]);
});

test("a corrupt/torn line is dropped, the rest of the log still reads", async () => {
	const dir = await tmpDir();
	await recordTaskOutcome(dir, row({ agentId: "agent-1" }));
	await fs.appendFile(path.join(dir, "task-outcomes.jsonl"), "{not json\n");
	await recordTaskOutcome(dir, row({ agentId: "agent-2" }));
	const rows = await readTaskOutcomes(dir);
	expect(rows.length).toBe(2);
	expect(rows.map((r) => r.agentId).sort()).toEqual(["agent-1", "agent-2"]);
});

test("optional fields (branch, model, costUsd, confidence, validation) may be absent — a minimal row still round-trips", async () => {
	const dir = await tmpDir();
	const minimal: TaskOutcomeRow = {
		agentId: "agent-minimal",
		routing: { mode: "none", tier: "mid" },
		outcome: "abandoned",
		source: "reconciled",
		ts: 5,
	};
	await recordTaskOutcome(dir, minimal);
	expect(await readTaskOutcomes(dir)).toEqual([minimal]);
});

test("rows are written as small single JSON lines (no spans/rationale), one line per append", async () => {
	const dir = await tmpDir();
	await recordTaskOutcome(dir, row({ agentId: "a" }));
	await recordTaskOutcome(dir, row({ agentId: "b" }));
	const text = await fs.readFile(path.join(dir, "task-outcomes.jsonl"), "utf8");
	const lines = text.split("\n").filter((l) => l.trim());
	expect(lines.length).toBe(2);
	for (const line of lines) {
		const parsed = JSON.parse(line);
		expect(Object.keys(parsed).sort()).toEqual(
			["agentId", "branch", "confidence", "costUsd", "model", "outcome", "routing", "source", "ts", "validation"].sort(),
		);
	}
});

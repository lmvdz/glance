import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { availableActions, effectiveAutonomyMode, maxEffectiveMode } from "../src/autonomy.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { Actor, AgentDTO, PersistedAgent } from "../src/types.ts";

const dirs: string[] = [];
afterAll(async () => {
	await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

test("effective autonomy caps contradictory approval and env combinations", () => {
	expect(maxEffectiveMode({ approvalMode: "always-ask", autoLand: true, landConfirm: false })).toBe("observe");
	expect(maxEffectiveMode({ approvalMode: "yolo", autoLand: false, landConfirm: false })).toBe("assist");
	expect(maxEffectiveMode({ approvalMode: "yolo", autoLand: true, landConfirm: true })).toBe("assist");
	expect(maxEffectiveMode({ approvalMode: "yolo", autoLand: true, landConfirm: false })).toBe("autodrive");
	expect(effectiveAutonomyMode({ requested: "autodrive", approvalMode: "write", autoLand: true, landConfirm: false })).toBe("assist");
	expect(effectiveAutonomyMode({ requested: "autodrive", approvalMode: "yolo", autoLand: true, landConfirm: false, blockedReason: "waiting" })).toBe("observe");
});

test("Epic 5: a confidence score below the floor caps the effective mode to assist (never blocks)", () => {
	const base = { requested: "autodrive" as const, approvalMode: "yolo" as const, autoLand: true, landConfirm: false };
	expect(effectiveAutonomyMode({ ...base, confidence: 0.2, confidenceFloor: 0.4 })).toBe("assist"); // capped
	expect(effectiveAutonomyMode({ ...base, confidence: 0.9, confidenceFloor: 0.4 })).toBe("autodrive"); // uncapped
	expect(effectiveAutonomyMode({ ...base })).toBe("autodrive"); // confidence/floor absent → cap inert
	expect(effectiveAutonomyMode({ ...base, confidence: 0.2 })).toBe("autodrive"); // floor absent → cap inert
	expect(effectiveAutonomyMode({ ...base, confidenceFloor: 0.4 })).toBe("autodrive"); // confidence absent → cap inert
	// The cap never blocks — blockedReason still owns "observe" exclusively.
	expect(effectiveAutonomyMode({ ...base, confidence: 0, confidenceFloor: 0.4, blockedReason: "waiting" })).toBe("observe");
	// The cap never LOOSENS an already-tighter policy cap (approvalMode "always-ask" already caps to
	// observe) — a low confidence score must not upgrade that to assist.
	expect(effectiveAutonomyMode({ requested: "autodrive", approvalMode: "always-ask", autoLand: true, landConfirm: false, confidence: 0.2, confidenceFloor: 0.4 })).toBe("observe");
});

test("available actions expose proof-gated manual land only outside observe", () => {
	expect(availableActions("observe", "fresh")).toEqual(["set-mode"]);
	expect(availableActions("assist", "stale")).toEqual(["set-mode", "prompt", "answer", "interrupt", "verify"]);
	expect(availableActions("assist", "fresh")).toContain("land");
});

test("mode transition persists requested mode and audits effective cap", async () => {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "autonomy-mode-"));
	dirs.push(stateDir);
	const audits: unknown[] = [];
	const mgr = new SquadManager({ stateDir, autoLand: false, store: {
		async hasState() { return false; },
		async load() { return { agents: [], transcripts: {}, features: [] }; },
		async save() {},
		async loadFeedback() { return { campaigns: [], items: [], validations: [], rewards: [] }; },
		async saveFeedback() {},
		async appendAudit(entry) { audits.push(entry); },
		async appendUsage() {},
	} });
	const dto: AgentDTO = { id: "a1", name: "a1", status: "idle", kind: "omp-operator", repo: "/repo", worktree: "/wt", approvalMode: "yolo", pending: [], lastActivity: 0, messageCount: 0, autonomyMode: "assist", effectiveMode: "assist", verificationState: "fresh", availableActions: [] };
	const options: PersistedAgent = { id: dto.id, name: dto.name, repo: dto.repo, worktree: dto.worktree, approvalMode: dto.approvalMode, autonomyMode: dto.autonomyMode };
	(mgr.agents as unknown as Map<string, unknown>).set(dto.id, { dto, options, agent: {}, transcript: [], assistantBuf: "", thinkingBuf: "", streaming: false, subs: { list: () => [] }, toolEntries: new Map() });
	const actor: Actor = { id: "op", origin: "remote", role: "operator" };

	const updated = await mgr.transitionMode("a1", "autodrive", actor, "test");

	expect(updated?.autonomyMode).toBe("autodrive");
	expect(updated?.effectiveMode).toBe("assist");
	expect(options.autonomyMode).toBe("autodrive");
	expect(JSON.stringify(audits)).toContain('"effectiveMode":"assist"');
});

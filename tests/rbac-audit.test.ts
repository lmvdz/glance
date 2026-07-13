/**
 * rbac-audit (MT-SaaS P3, OMPSQ-36) — the applyCommand chokepoint records BOTH accepted
 * mutations and RBAC denials to the per-org audit trail. P2 makes the manager org-scoped, so
 * authorization here is pure role↔command; P3's delta is that a denial is auditable, not silent.
 *
 * A fake Store captures appendAudit calls; org↔resource isolation is proven separately in
 * dal-store / routing / ws-org-isolation tests.
 */

import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { RbacDenied } from "../src/auth.ts";
import type { StateSnapshot, Store } from "../src/dal/store.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { AgentDTO, Actor, PersistedAgent, RpcSessionState } from "../src/types.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

test("applyCommand audits RBAC denials and accepted mutations", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbac-audit-"));
	// Store stub that records audit entries; everything else is an inert no-op.
	const audits: { actor: string; action: string; source?: string }[] = [];
	const store: Store = {
		async hasState() {
			return false;
		},
		async load(): Promise<StateSnapshot> {
			return { agents: [], transcripts: {}, features: [] };
		},
		async save() {},
		async loadFeedback() {
			return { campaigns: [], items: [], validations: [], rewards: [] };
		},
		async saveFeedback() {},
		async appendAudit(e) {
			audits.push({ actor: e.actor, action: e.action, source: e.source });
		},
		async appendUsage() {},
	};
	const mgr = new SquadManager({ stateDir: dir, store });
	await mgr.start();
	cleanups.push(async () => {
		await mgr.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});

	const viewer: Actor = { id: "v", origin: "remote", role: "viewer" };
	const operator: Actor = { id: "o", origin: "remote", role: "operator" };

	// A denied mutation throws AND leaves an audit row (denial is accountable, not silent).
	await expect(mgr.applyCommand({ type: "prompt", id: "ghost", message: "x" }, viewer)).rejects.toThrow(RbacDenied);
	expect(audits.some((a) => a.actor === "v" && a.action === "denied:prompt")).toBe(true);

	// An accepted mutation (unknown agent ⇒ no-op, but passes the gate) is audited under its type.
	await mgr.applyCommand({ type: "prompt", id: "ghost", message: "x" }, operator);
	expect(audits.some((a) => a.actor === "o" && a.action === "prompt")).toBe(true);

	// Reads (viewer-tier) are not audited.
	await mgr.applyCommand({ type: "snapshot" }, viewer);
	expect(audits.some((a) => a.action === "snapshot")).toBe(false);
});

test("applyCommand: a voice-originated command's source rides along to the audit entry (concern 03)", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbac-audit-source-"));
	const audits: { actor: string; action: string; source?: string }[] = [];
	const store: Store = {
		async hasState() {
			return false;
		},
		async load(): Promise<StateSnapshot> {
			return { agents: [], transcripts: {}, features: [] };
		},
		async save() {},
		async loadFeedback() {
			return { campaigns: [], items: [], validations: [], rewards: [] };
		},
		async saveFeedback() {},
		async appendAudit(e) {
			// Mirror the real entry's contain-or-omit contract exactly: `source` is either present with a
			// value, or absent — never present-but-undefined (that would be null pollution by another name).
			audits.push(e.source !== undefined ? { actor: e.actor, action: e.action, source: e.source } : { actor: e.actor, action: e.action });
		},
		async appendUsage() {},
	};
	const mgr = new SquadManager({ stateDir: dir, store });
	await mgr.start();
	cleanups.push(async () => {
		await mgr.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});

	const operator: Actor = { id: "o", origin: "remote", role: "operator" };

	// A voice-originated prompt is distinguishable from a typed one in the audit trail.
	await mgr.applyCommand({ type: "prompt", id: "ghost", message: "x", source: "voice" }, operator);
	const voiceEntry = audits.find((a) => a.actor === "o" && a.action === "prompt");
	expect(voiceEntry?.source).toBe("voice");

	// A frame without `source` behaves exactly as today — no null/undefined pollution in the entry.
	audits.length = 0;
	await mgr.applyCommand({ type: "interrupt", id: "ghost" }, operator);
	const typedEntry = audits.find((a) => a.actor === "o" && a.action === "interrupt");
	expect(typedEntry).toBeDefined();
	expect("source" in (typedEntry as object)).toBe(false);
	expect(typedEntry?.source).toBeUndefined();
});

/** A healthy no-op driver (mirrors tests/console-prompt-spawn-failure.test.ts's HealthyDriver) — just
 *  enough surface for `ensureConnected`/`prompt`/`abort` to resolve without a real spawn. */
class HealthyDriver extends EventEmitter implements AgentDriver {
	isReady = true;
	isAlive = true;
	start(): Promise<void> {
		return Promise.resolve();
	}
	stop(): Promise<void> {
		return Promise.resolve();
	}
	prompt(): Promise<void> {
		return Promise.resolve();
	}
	abort(): Promise<unknown> {
		return Promise.resolve();
	}
	getState(): Promise<RpcSessionState> {
		return Promise.reject(new Error("getState is never called in this test"));
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

interface ManagerTestHost {
	agents: Map<string, { dto: AgentDTO; agent: AgentDriver; options: PersistedAgent; transcript: unknown[]; assistantBuf: string; thinkingBuf: string; streaming: boolean }>;
}

/** Seeds an in-roster agent record directly (bypassing create()'s real worktree/spawn), the same
 *  shortcut tests/console-prompt-spawn-failure.test.ts uses to drive applyCommand's prompt/interrupt
 *  paths without a real repo or harness. */
function seed(mgr: SquadManager, id: string, agent: AgentDriver): void {
	const dto: AgentDTO = { id, name: id, status: "idle", kind: "omp-operator", repo: "/r", worktree: "/r", branch: `squad/${id}`, approvalMode: "yolo", pending: [], lastActivity: 0, messageCount: 0 };
	const options: PersistedAgent = { id, name: id, repo: "/r", worktree: "/r", approvalMode: "yolo" };
	(mgr as unknown as ManagerTestHost).agents.set(id, { dto, agent, options, transcript: [], assistantBuf: "", thinkingBuf: "", streaming: false });
}

test("applyCommand: source reaches the REAL audit.jsonl trail, not just the DB store table (concern 03 gap)", async () => {
	// The store.appendAudit path above feeds the sqlite `audit` table (DB mode) and is a no-op on
	// FileStore. The actual trail GET /api/audit reads is recordAudit → makeAuditEntry →
	// appendAudit(stateDir) → <stateDir>/audit.jsonl (src/audit.ts). Omitting `store` here defaults
	// to FileStore (see SquadManager constructor), so this exercises that real, on-disk path. The
	// prompt/interrupt cases only reach recordAudit once an in-roster agent is found (`if (!rec)
	// return;`), so a real (seeded) agent record is required — an unknown id would silently no-op.
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbac-audit-jsonl-"));
	const mgr = new SquadManager({ stateDir: dir });
	await mgr.start();
	cleanups.push(async () => {
		await mgr.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});
	seed(mgr, "voice-1", new HealthyDriver());

	const operator: Actor = { id: "o", origin: "remote", role: "operator" };

	await mgr.applyCommand({ type: "prompt", id: "voice-1", message: "x", source: "voice" }, operator);
	await mgr.applyCommand({ type: "interrupt", id: "voice-1" }, operator);

	// recordAudit's disk write is deliberately fire-and-forget (`void this.recordAudit(...)`, never
	// awaited by applyCommand — see its doc comment: "a disk failure must never break the action it
	// records"). Poll for the fsync'd file rather than reading once immediately after applyCommand
	// resolves, which would race the in-flight write.
	let lines: Array<{ action: string; actor: string; source?: string }> = [];
	for (let attempt = 0; attempt < 100; attempt++) {
		const raw = await fs.readFile(path.join(dir, "audit.jsonl"), "utf8").catch(() => "");
		lines = raw
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
		if (lines.some((e) => e.action === "prompt") && lines.some((e) => e.action === "interrupt")) break;
		await new Promise((r) => setTimeout(r, 10));
	}

	const promptLine = lines.find((e) => e.action === "prompt" && e.actor === "o");
	expect(promptLine).toBeDefined();
	expect(promptLine.source).toBe("voice");

	const interruptLine = lines.find((e) => e.action === "interrupt" && e.actor === "o");
	expect(interruptLine).toBeDefined();
	expect("source" in interruptLine).toBe(false);
});

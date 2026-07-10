/**
 * rbac-audit (MT-SaaS P3, OMPSQ-36) — the applyCommand chokepoint records BOTH accepted
 * mutations and RBAC denials to the per-org audit trail. P2 makes the manager org-scoped, so
 * authorization here is pure role↔command; P3's delta is that a denial is auditable, not silent.
 *
 * A fake Store captures appendAudit calls; org↔resource isolation is proven separately in
 * dal-store / routing / ws-org-isolation tests.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RbacDenied } from "../src/auth.ts";
import type { StateSnapshot, Store } from "../src/dal/store.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { Actor } from "../src/types.ts";

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

/**
 * authz (OMPSQ-36 / P3) — the single role↔action permission map (src/authz.ts) enforced
 * IDENTICALLY at the WS/command chokepoint (`commandTier`, via applyCommand) and the REST gate
 * (`restActionTier`, via `roleAtLeast(role, requiredRole(...))`).
 *
 * Pure-map units for the full action set, plus a manager-level proof that an OPERATOR is denied
 * destructive ops (kill/remove) — RbacDenied AND audited — while an admin is allowed, and a
 * server-level proof that a REST land route 403s an operator but lets an admin past the gate.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RbacDenied } from "../src/auth.ts";
import {
	_resetPushTapRateLimitsForTests,
	allowPushTap,
	commandTier,
	isKnownPushTapAgentId,
	isValidPushTapAgentId,
	restActionTier,
} from "../src/authz.ts";
import type { StateSnapshot, Store } from "../src/dal/store.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer } from "../src/server.ts";
import { RuntimeSettingsStore } from "../src/runtime-settings.ts";
import type { Actor } from "../src/types.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

test("commandTier: viewer reads, operator drives, admin destroys", () => {
	expect(commandTier({ type: "snapshot" })).toBe("viewer");
	expect(commandTier({ type: "subscribe", id: "a" })).toBe("viewer");
	expect(commandTier({ type: "prompt", id: "a", message: "hi" })).toBe("operator");
	expect(commandTier({ type: "answer", id: "a", requestId: "r", value: "v" })).toBe("operator");
	expect(commandTier({ type: "interrupt", id: "a" })).toBe("operator");
	expect(commandTier({ type: "create", options: { repo: "/x" } })).toBe("operator");
	expect(commandTier({ type: "commission", spec: { name: "x", purpose: "y" } })).toBe("operator");
	expect(commandTier({ type: "message", to: "b", text: "hi" })).toBe("operator");
	expect(commandTier({ type: "kill", id: "a" })).toBe("admin");
	expect(commandTier({ type: "restart", id: "a" })).toBe("admin");
	expect(commandTier({ type: "remove", id: "a" })).toBe("admin");
});

test("restActionTier: reads viewer, mutations operator, destructive admin, auth/push viewer", () => {
	expect(restActionTier("GET", "/api/agents")).toBe("viewer");
	expect(restActionTier("GET", "/api/features")).toBe("viewer");
	expect(restActionTier("POST", "/api/features")).toBe("operator");
	expect(restActionTier("PATCH", "/api/features/x")).toBe("operator");
	expect(restActionTier("POST", "/api/command")).toBe("operator");
	expect(restActionTier("POST", "/api/spawn")).toBe("operator");
	expect(restActionTier("POST", "/api/upgrade")).toBe("admin");
	expect(restActionTier("GET", "/api/settings")).toBe("viewer");
	expect(restActionTier("POST", "/api/settings/feature-flags")).toBe("admin");
	expect(restActionTier("POST", "/api/agents/a1/land")).toBe("admin");
	expect(restActionTier("POST", "/api/features/f1/land")).toBe("admin");
	expect(restActionTier("POST", "/api/features/f1/verify")).toBe("admin");
	// vision drives the daemon's browser off-box (SSRF surface, OMPSQ-152) — admin, not operator.
	expect(restActionTier("POST", "/api/agents/a1/vision")).toBe("admin");
	expect(restActionTier("GET", "/api/auth/check")).toBe("viewer");
	expect(restActionTier("POST", "/api/push/subscribe")).toBe("viewer");
	// agent verify runs the acceptance command (non-destructive) — stays operator, unlike feature verify.
	expect(restActionTier("POST", "/api/agents/a1/verify")).toBe("operator");
	// Assignees are the plan-vote substrate: read is viewer, reassigning is admin.
	expect(restActionTier("GET", "/api/features/f1/assignees")).toBe("viewer");
	expect(restActionTier("PUT", "/api/features/f1/assignees")).toBe("admin");
	// Plan-vote rounds: reading the current round/tally is viewer; calling/casting are admin (the
	// finer actor-∈-assignees check happens app-layer, in server.ts, on top of this tier).
	expect(restActionTier("GET", "/api/features/f1/plan-vote")).toBe("viewer");
	expect(restActionTier("POST", "/api/features/f1/plan-vote/call")).toBe("admin");
	expect(restActionTier("POST", "/api/features/f1/plan-vote/cast")).toBe("admin");
	// Org voice-key admin surface (plans/voice-db-mode/05-admin-endpoints.md): ALL FOUR routes are
	// admin-tier, including the GET — stricter than the rest of /api/org (whose profile GET is
	// viewer-readable), because a voice key's presence/last4/enabled state is provider posture.
	expect(restActionTier("GET", "/api/org/voice")).toBe("admin");
	expect(restActionTier("PUT", "/api/org/voice-key")).toBe("admin");
	expect(restActionTier("DELETE", "/api/org/voice-key")).toBe("admin");
	expect(restActionTier("POST", "/api/org/voice/enabled")).toBe("admin");
	// Operator-attention substrate (comprehension concern 01): recording one's own "I looked at this"
	// is deliberately viewer-tier, not the coarse mutation=operator default — see authz.ts's comment.
	expect(restActionTier("POST", "/api/attention")).toBe("viewer");
	expect(restActionTier("GET", "/api/attention")).toBe("viewer");
	expect(restActionTier("GET", "/api/attention/seen")).toBe("viewer");
	// Comprehension fog (concern 03): a read-only per-file debt number, explicitly registered viewer
	// tier like the attention reads it joins against.
	expect(restActionTier("GET", "/api/fog")).toBe("viewer");
	// Known-symptom cards (comprehension concern 07): reading the symptom index is viewer-tier, same
	// as /api/fabric/search — the pull half of the doctor auto-match's push half.
	expect(restActionTier("GET", "/api/symptoms")).toBe("viewer");
	// Weekly episodes (comprehension concern 09): list + full-markdown reads are viewer-tier like
	// every other comprehension read; actor-derived repo scoping happens in the route itself.
	expect(restActionTier("GET", "/api/episodes")).toBe("viewer");
	expect(restActionTier("GET", "/api/episodes/2026-W29")).toBe("viewer");
});

test("applyCommand: operator denied destructive ops (RbacDenied + audited); admin allowed", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "authz-mgr-"));
	// Store stub recording audit entries; everything else inert (org↔resource isolation proven elsewhere).
	const audits: { actor: string; action: string }[] = [];
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
			audits.push({ actor: e.actor, action: e.action });
		},
		async appendUsage() {},
	};
	const mgr = new SquadManager({ stateDir: dir, store });
	await mgr.start();
	cleanups.push(async () => {
		await mgr.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});

	const operator: Actor = { id: "op", origin: "remote", role: "operator" };
	const admin: Actor = { id: "ad", origin: "remote", role: "admin" };

	// Operator is denied kill + remove (destructive ⇒ admin): throws AND audits a denial row.
	await expect(mgr.applyCommand({ type: "kill", id: "ghost" }, operator)).rejects.toThrow(RbacDenied);
	await expect(mgr.applyCommand({ type: "remove", id: "ghost" }, operator)).rejects.toThrow(RbacDenied);
	expect(audits.some((a) => a.actor === "op" && a.action === "denied:kill")).toBe(true);
	expect(audits.some((a) => a.actor === "op" && a.action === "denied:remove")).toBe(true);

	// Operator CAN still drive (prompt = operator) — passes the gate (unknown agent ⇒ no-op).
	await mgr.applyCommand({ type: "prompt", id: "ghost", message: "x" }, operator);

	// Admin passes the gate for the same destructive ops (unknown agent ⇒ no-op, no RBAC throw) — audited under its type.
	await mgr.applyCommand({ type: "kill", id: "ghost" }, admin);
	await mgr.applyCommand({ type: "remove", id: "ghost" }, admin);
	expect(audits.some((a) => a.actor === "ad" && a.action === "kill")).toBe(true);
	expect(audits.some((a) => a.actor === "ad" && a.action === "remove")).toBe(true);
});

test("REST land route: operator 403 at the gate, admin passes through", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "authz-srv-"));
	const tokens = { admin: "admin-token-xxxxxxxx", operator: "operator-token-xxxxxx" };
	const mgr = new SquadManager({ stateDir: dir });
	await mgr.start();
	const server = new SquadServer(mgr, { port: 0, token: tokens.admin, roleTokens: { operator: tokens.operator } });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});
	const land = (t: string) =>
		fetch(`${url}/api/agents/ghost/land`, { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: "{}" });

	// Operator is stopped at the single REST gate (land ⇒ admin).
	expect((await land(tokens.operator)).status).toBe(403);
	// Admin clears the gate; the handler then 404s (no such agent) — proving authz passed, not denied.
	expect((await land(tokens.admin)).status).toBe(404);
});

test("REST vision route: operator 403 at the gate, admin passes through (OMPSQ-152)", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "authz-vis-"));
	const tokens = { admin: "admin-token-xxxxxxxx", operator: "operator-token-xxxxxx" };
	const mgr = new SquadManager({ stateDir: dir });
	await mgr.start();
	const server = new SquadServer(mgr, { port: 0, token: tokens.admin, roleTokens: { operator: tokens.operator } });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});
	const vision = (t: string) =>
		fetch(`${url}/api/agents/ghost/vision`, { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify({ url: "http://example.com/" }) });
	// Operator is stopped at the single REST gate (vision ⇒ admin), so the SSRF surface is unreachable to it.
	expect((await vision(tokens.operator)).status).toBe(403);
	// Admin clears the gate; the handler then 404s (no such agent) — proving authz passed, not denied.
	expect((await vision(tokens.admin)).status).toBe(404);
});

test("REST settings flags: viewer reads, operator denied, admin persists", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "authz-settings-"));
	const tokens = { admin: "admin-token-xxxxxxxx", operator: "operator-token-xxxxxx", viewer: "viewer-token-xxxxxxxx" };
	const runtimeSettings = new RuntimeSettingsStore(dir);
	const server = new SquadServer(undefined, { port: 0, token: tokens.admin, roleTokens: { operator: tokens.operator, viewer: tokens.viewer }, runtimeSettings });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});
	const headers = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
	const body = JSON.stringify({ key: "OMP_SQUAD_OBSERVE_AUTOFIX", enabled: true });

	expect((await fetch(`${url}/api/settings`, { headers: headers(tokens.viewer) })).status).toBe(200);
	expect((await fetch(`${url}/api/settings/feature-flags`, { method: "POST", headers: headers(tokens.operator), body })).status).toBe(403);
	const saved = await fetch(`${url}/api/settings/feature-flags`, { method: "POST", headers: headers(tokens.admin), body });
	expect(saved.status).toBe(200);
	expect(await saved.text()).toContain("\"OMP_SQUAD_OBSERVE_AUTOFIX\"");
	expect(await runtimeSettings.load()).toMatchObject({ featureFlags: { OMP_SQUAD_OBSERVE_AUTOFIX: true } });
});

/**
 * `/api/doctor` reports the daemon's autonomy flags and its launch cwd. Not secrets — but "autoland is
 * armed and the regression gate is off" is a shopping list, and the daemon's cwd names a path on the
 * host. Operator: the tier of the person who could have set those flags in the first place. A viewer
 * (a read-only dashboard share) has no business enumerating the factory's safety posture.
 */
test("the doctor's facts are operator-only", () => {
	expect(restActionTier("GET", "/api/doctor")).toBe("operator");
});

/**
 * Push-tap write guards (finding #6, wave-1 fixer D): `/api/push-tap` stays viewer-tier
 * deliberately (see the comment above `restActionTier`'s push-tap line), so the actual safety
 * boundary is these three pure helpers the write site (`SquadManager.recordPushTap`) is expected
 * to apply before ever appending to push-taps.jsonl — the substrate GET /api/adoption reads.
 */
test("isValidPushTapAgentId: rejects non-strings, empty, oversized, and control characters", () => {
	expect(isValidPushTapAgentId("chat-abc-1-dead")).toBe(true);
	expect(isValidPushTapAgentId("a1")).toBe(true);
	// Real ids derive from a free-text agent name (spawn-identity.ts's newAgentId) — spaces and
	// punctuation are legitimate, so the shape check must not be a slug validator.
	expect(isValidPushTapAgentId("Work on OMPSQ-319: fix the thing-1a2b3c-x-deadbeef")).toBe(true);
	expect(isValidPushTapAgentId(123)).toBe(false);
	expect(isValidPushTapAgentId(null)).toBe(false);
	expect(isValidPushTapAgentId(undefined)).toBe(false);
	expect(isValidPushTapAgentId({})).toBe(false);
	expect(isValidPushTapAgentId("")).toBe(false);
	expect(isValidPushTapAgentId("a".repeat(201))).toBe(false); // over SquadManager's own 200-char clamp
	expect(isValidPushTapAgentId("a".repeat(200))).toBe(true); // exactly at the clamp is fine
	expect(isValidPushTapAgentId("a1\nSpoofedAuditLine")).toBe(false); // control char (newline)
	expect(isValidPushTapAgentId("a1\x00null")).toBe(false); // embedded NUL
});

test("isKnownPushTapAgentId: only ids the caller's roster/removed-ledger actually names", () => {
	const roster = ["a1", "a2", "chat-abc-1-dead"];
	expect(isKnownPushTapAgentId("a1", roster)).toBe(true);
	expect(isKnownPushTapAgentId("a3", roster)).toBe(false);
	expect(isKnownPushTapAgentId("forged-agent-id", roster)).toBe(false);
	expect(isKnownPushTapAgentId("a1", [])).toBe(false);
});

test("allowPushTap: bursts up to capacity, then throttles, then refills over time", () => {
	_resetPushTapRateLimitsForTests();
	const source = "viewer-token-abc";
	const t0 = 1_000_000;
	// First 10 taps (the burst capacity) all pass at the same instant.
	for (let i = 0; i < 10; i++) {
		expect(allowPushTap(source, t0)).toBe(true);
	}
	// The 11th, still at t0, is throttled — the bucket is empty.
	expect(allowPushTap(source, t0)).toBe(false);
	// A different source key has its own independent bucket — one noisy viewer can't starve another.
	expect(allowPushTap("other-token", t0)).toBe(true);
	// After a full minute (the sustained 10/min refill rate), a fresh tap is allowed again.
	expect(allowPushTap(source, t0 + 60_000)).toBe(true);
	_resetPushTapRateLimitsForTests();
});

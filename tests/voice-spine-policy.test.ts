/**
 * voice-spine-policy.test.ts — concern 05 of plans/voice-orchestrated-room-integration.
 *
 * Concern 05 chose four V1 operating defaults (2026-07-26, recorded in
 * `05-set-operating-defaults.md`'s Decisions) and its own Verify bar was left unmet until this file:
 * "the chosen defaults appear in the call-started record, host HUD/copy, daemon configuration, and
 * DETERMINISTIC TESTS." Each of the four gets its own describe block below, seam-driven — no real
 * 10-minute wait, no real voice/network call — reusing the SAME `fake-omp-call.ts` harness
 * `voice-acceptance-spine.test.ts` built, rather than re-deriving a simpler one-off fake.
 *
 * 1. Retention default — a call started with no explicit retention records "full".
 * 2. Idle-hangup default — 10 minutes is the recorded config value (`roomCall.ts#IDLE_HANGUP_MS`,
 *    asserted here as the cross-repo config surface this daemon's copy has to agree with), and an
 *    idle-ended call (simulated via `FakeOmpCall#idleHangup()` — no real timer) projects the honest
 *    terminal state end to end: binding `terminalReason: "idle"`, the room's own "ended after sitting
 *    idle" copy, and every still-open decision's attention cleared exactly like every other terminal
 *    path.
 * 3. Decision-class policy — a "destructive" decision resolved by voice is rejected `ui-only-class`
 *    (the SAME distinct reason oh-my-pi's own `decision-arbiter.ts` mints); the identical decision
 *    resolves normally over the daemon's authenticated UI path.
 * 4. S2S-outside-rooms — asserted honestly at the one place it is actually encoded: the room call
 *    entry (`useRoomCall.ts`) imports and calls only the OMP-live lane (`startVoiceCall`) and never
 *    references the S2S dispatcher hook at all; the dispatcher hook itself is still there, mounted
 *    OUTSIDE the room tree (`App.tsx`'s `VoiceCallProvider`/`VoiceCallPill`, sitting beside — not
 *    inside — the room/hub component tree), so "kept, outside room calls only" is a fact about the
 *    import graph, not an assumption. No daemon-level control encodes this default at all — it is a
 *    webapp entry-point choice — so a webapp-level assertion is the honest maximum here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SquadManager } from "../src/squad-manager.ts";
import type { Actor } from "../src/types.ts";
import { CallBindingStore } from "../src/voice-call-binding.ts";
import { FakeOmpBroker } from "./fixtures/fake-omp-call.ts";
import { decisionDoorModel, endedUnexpectedly, IDLE_HANGUP_MS, terminalReasonCopy, type VoiceCallDecisionDTO } from "../webapp/src/lib/voice/roomCall.ts";

function actor(userId: string, orgId = "org-a"): Actor {
	return { id: `db:${userId}`, displayName: userId, origin: "local", role: "operator", orgId };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 4000, stepMs = 15): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			if (await predicate()) return;
		} catch {
			/* not ready yet — retried below */
		}
		if (Date.now() >= deadline) throw new Error("waitFor: condition never became true within timeout");
		await new Promise((r) => setTimeout(r, stepMs));
	}
}

function findDecision<T extends { id: string }>(list: readonly T[], id: string): T | undefined {
	return list.find((d) => d.id === id);
}

/** One fresh manager + broker + room, fast-polling so every assertion below is seam-driven rather than
 *  waiting out the daemon's production 400ms/5000ms intervals. */
async function harness() {
	const stateDir = mkdtempSync(path.join(os.tmpdir(), "voice-spine-policy-state-"));
	const journalDir = mkdtempSync(path.join(os.tmpdir(), "voice-spine-policy-journal-"));
	const sessionRoot = mkdtempSync(path.join(os.tmpdir(), "voice-spine-policy-session-"));
	const broker = new FakeOmpBroker(journalDir, { sessionRoot });
	const owner = actor("alice");
	const mgr = new SquadManager({ stateDir, skipGlobalJanitors: true, voiceBroker: broker, voiceJournalPollIntervalMs: 15, voiceLivenessProbeIntervalMs: 60 });
	const channel = await mgr.createChannel(owner, { name: "spine-policy-room", visibility: "private" });
	const cleanup = () => {
		mgr.voiceCall.stop();
		for (const dir of [stateDir, journalDir, sessionRoot]) rmSync(dir, { recursive: true, force: true });
	};
	return { mgr, broker, owner, channelId: channel.id, stateDir, cleanup };
}

describe("concern 05 default #1: transcript retention starts \"full\"", () => {
	test("a call started with no explicit retention records \"full\", in memory AND on disk", async () => {
		const { mgr, owner, channelId, stateDir, cleanup } = await harness();
		try {
			const started = await mgr.startVoiceCall(channelId, owner, {});
			expect(started.ok).toBe(true);
			if (!started.ok) throw new Error("unreachable");
			expect(started.value.retention).toBe("full");

			// Persisted, not just held in memory: a FRESH store instance reading the same stateDir agrees.
			const freshRead = new CallBindingStore(stateDir);
			expect(freshRead.get(channelId)?.retention).toBe("full");
		} finally {
			cleanup();
		}
	});
});

describe("concern 05 default #2: 10-minute idle hangup", () => {
	test("10 minutes is the recorded config value the room's own copy agrees with", () => {
		expect(IDLE_HANGUP_MS).toBe(10 * 60 * 1000);
	});

	test("an idle-ended call projects the honest terminal state end to end — no real 10-minute wait", async () => {
		const { mgr, broker, owner, channelId, cleanup } = await harness();
		try {
			const started = await mgr.startVoiceCall(channelId, owner, {});
			expect(started.ok).toBe(true);
			if (!started.ok) throw new Error("unreachable");
			const fakeCall = broker.callFor(started.value.callId!);

			// A decision still open when the call goes idle must not survive as answerable — the SAME
			// end-of-call cleanup every other terminal path (terminal/journal-end/broker-exit/...) runs.
			const openDecision = await fakeCall.mintDecision({
				prompt: "Keep going on the audit?",
				options: [{ index: 0, label: "Keep going", consequence: "The agent continues." }],
			});
			await waitFor(async () => (await mgr.voiceCallDecisions(channelId, owner)).length > 0);

			// The seam: `FakeOmpCall#idleHangup()` journals the SAME warning-then-terminal-with-reason
			// pair `LiveSessionController`'s real idle policy does (`idle-warning`, then
			// `{type:"terminal",error:null,reason:"idle"}`) — instantaneously, never a real timer.
			await fakeCall.idleHangup();

			// `endBinding` marks the binding `ended` BEFORE it awaits `expireActiveDecisions` — waiting on
			// state alone races that second step (same reasoning as the main spine's own §7), so the
			// predicate checks the actual thing the assertion below cares about: no decision left open.
			await waitFor(async () => {
				const state = await mgr.voiceCallState(channelId, owner);
				const decisions = await mgr.voiceCallDecisions(channelId, owner);
				return state?.state === "ended" && decisions.every((d) => d.state !== "open" && d.state !== "awaiting-confirmation");
			});
			const ended = await mgr.voiceCallState(channelId, owner);
			expect(ended!.terminalReason).toBe("idle");
			expect(ended!.terminalError).toBeFalsy(); // a clean policy end, never an error

			// The room's own copy says so, honestly, and does not raise it as a surprise — the idle
			// policy doing exactly what it was configured to do is normal, like an operator ending it.
			expect(terminalReasonCopy(ended!.terminalReason, ended!.terminalError)).toContain("idle");
			expect(endedUnexpectedly(ended as unknown as Parameters<typeof endedUnexpectedly>[0])).toBe(false);

			// Attention cleared: the still-open decision is expired, not left answerable.
			const decisions = await mgr.voiceCallDecisions(channelId, owner);
			expect(findDecision(decisions, openDecision.id)!.state).toBe("expired");
		} finally {
			cleanup();
		}
	});
});

describe("concern 05 default #3: destructive decision classes are UI-only", () => {
	test("a voice resolve against a \"destructive\" decision is rejected ui-only-class; the same decision resolves fine over the daemon's authenticated UI path", async () => {
		const { mgr, broker, owner, channelId, cleanup } = await harness();
		try {
			const started = await mgr.startVoiceCall(channelId, owner, {});
			expect(started.ok).toBe(true);
			if (!started.ok) throw new Error("unreachable");
			const fakeCall = broker.callFor(started.value.callId!);

			const decision = await fakeCall.mintDecision({
				prompt: "Merge the release branch to main?",
				options: [{ index: 0, label: "Merge it", consequence: "ships to production" }],
				decisionClass: "destructive",
			});
			await waitFor(async () => (await mgr.voiceCallDecisions(channelId, owner)).length > 0);

			// Voice never crosses the daemon's own wire — it is the in-process path OMP's controller
			// takes — so this exercises the fixture's arbiter clone directly, exactly mirroring
			// decision-arbiter.ts's own enforcement.
			const voiceResult = await fakeCall.resolveVoice({ decisionId: decision.id, optionIndex: 0, label: "Merge it", requestId: "voice-1" });
			expect(voiceResult).toMatchObject({ ok: false, reason: "ui-only-class" });
			expect(fakeCall.decisionSnapshot(decision.id)!.state).toBe("open"); // rejected outright, never advanced

			// The UI path DOES cross the daemon's authenticated wire, and the SAME decision resolves.
			const uiResult = await mgr.resolveVoiceCallDecision(channelId, owner, { decisionId: decision.id, optionIndex: 0, label: "Merge it" });
			expect(uiResult.ok).toBe(true);
			if (uiResult.ok) {
				expect(uiResult.value.ok).toBe(true);
				expect(uiResult.value.decision?.state).toBe("answered");
				expect(uiResult.value.decision?.resolution).toEqual({ optionIndex: 0, label: "Merge it", source: "ui" });
			}

			// The webapp's own view model renders this as a wire-declared FACT, not the text heuristic's
			// guess — even though "Merge the release branch to main?" would also have tripped the guess.
			await waitFor(async () => findDecision(await mgr.voiceCallDecisions(channelId, owner), decision.id)?.state === "answered");
			const answeredDto = findDecision(await mgr.voiceCallDecisions(channelId, owner), decision.id) as unknown as VoiceCallDecisionDTO;
			const doorModel = decisionDoorModel(answeredDto);
			expect(doorModel.uiOnly).toBe(true);
			expect(doorModel.uiOnlySource).toBe("wire");
		} finally {
			cleanup();
		}
	});

	test("an unclassified decision stays voice-resolvable — the recorded default when no class is declared", async () => {
		const { mgr, broker, owner, channelId, cleanup } = await harness();
		try {
			const started = await mgr.startVoiceCall(channelId, owner, {});
			expect(started.ok).toBe(true);
			if (!started.ok) throw new Error("unreachable");
			const fakeCall = broker.callFor(started.value.callId!);
			const decision = await fakeCall.mintDecision({
				prompt: "Rename a variable?",
				options: [{ index: 0, label: "Rename it", consequence: "auth.ts becomes session.ts" }],
			});
			const voiceResult = await fakeCall.resolveVoice({ decisionId: decision.id, optionIndex: 0, label: "Rename it", requestId: "voice-1" });
			expect(voiceResult.ok).toBe(true);
		} finally {
			cleanup();
		}
	});
});

describe("concern 05 default #4: the S2S dispatcher lane stays available outside room calls only", () => {
	const webappSrc = path.join(import.meta.dirname, "..", "webapp", "src");

	test("the room's own call entry point uses exclusively the OMP-live lane and never references the S2S dispatcher", () => {
		const useRoomCallSrc = readFileSync(path.join(webappSrc, "hooks", "useRoomCall.ts"), "utf8");
		expect(useRoomCallSrc).toContain("startVoiceCall");
		expect(useRoomCallSrc).not.toContain("useVoiceDispatcher");
		expect(useRoomCallSrc).not.toMatch(/VoiceCallContext/);

		const hubShellSrc = readFileSync(path.join(webappSrc, "components", "hub", "HubShell.tsx"), "utf8");
		expect(hubShellSrc).toContain("useRoomCall");
		expect(hubShellSrc).not.toContain("useVoiceDispatcher");
	});

	test("the S2S dispatcher lane still exists, and is mounted OUTSIDE the room/hub tree — kept, not retired", () => {
		// The hook itself is still there — "kept", not deleted as part of shipping the OMP-live lane.
		expect(() => readFileSync(path.join(webappSrc, "hooks", "useVoiceDispatcher.ts"), "utf8")).not.toThrow();

		// Mounted beside, not inside, the room/hub component tree — App.tsx's own comment names exactly
		// this: VoiceCallPill/VoiceCallProvider wrap/sit beside AppContent (which renders HubShell) at
		// the App root, so no room/view-level conditional can unmount the dispatcher lane. The negative
		// half of that claim — the room/hub tree does not itself mount the dispatcher lane — is checked
		// directly against HubShell.tsx, the actual room-workspace component.
		const appSrc = readFileSync(path.join(webappSrc, "App.tsx"), "utf8");
		expect(appSrc).toContain("VoiceCallProvider");
		expect(appSrc).toContain("VoiceCallPill");

		const hubShellSrc = readFileSync(path.join(webappSrc, "components", "hub", "HubShell.tsx"), "utf8");
		expect(hubShellSrc).not.toContain("VoiceCallPill");
		expect(hubShellSrc).not.toContain("VoiceCallProvider");
	});
});

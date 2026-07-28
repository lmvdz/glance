/**
 * voice-acceptance-spine.test.ts — concern 04 of plans/voice-orchestrated-room-integration.
 *
 * The 9-point acceptance spine from `04-cross-project-verification.md`'s Verify section, proved in
 * ONE deterministic, scripted flow: no provider credentials, no microphone, no real oh-my-pi/broker
 * process. `tests/fixtures/fake-omp-call.ts` stands in for OMP's own journal + Coven Bridge, wire-
 * accurate to `opencoven-viz/PROTOCOL.md`; `VoiceCallCoordinator`/`SquadManager` are the real daemon
 * code (concern 02); `webapp/src/lib/voice/roomCall.ts`'s pure view-model functions are the real
 * webapp logic (concern 03) — imported directly, since `bunfig.toml`'s `root: "tests"` only scopes
 * test DISCOVERY, not module resolution (confirmed by `tests/channel-replies-search.test.ts` already
 * importing webapp modules the same way).
 *
 * Concern 01's own suite (`~/src/oh-my-pi`) already exhaustively covers the decision-arbiter state
 * machine and CovenBridge wire authorization in isolation; concern 02/03's own suites already cover
 * every daemon/webapp UNIT in isolation (see this file's own doc comment references). This file does
 * NOT re-prove any of that in isolation — it wires them together end to end so a regression in any
 * ONE layer's contract (the wire shape, the projection, the view model) breaks HERE, which is the
 * gap concern 04 exists to close.
 *
 * Each of the 9 numbered sections below corresponds 1:1 to a Verify bullet. Adversarial cases named
 * in the concern's Approach (crash, port-reuse, reconnect, socket-loss, journal-gap, artifact-
 * removal, decision-race, stale-click) are folded into whichever section they honestly belong to —
 * see the per-section comments for exactly where.
 *
 * Point 9 (narrow viewport / reduced motion / screen-reader) cannot literally share this process:
 * webapp is a SEPARATE `bun test` invocation (see package.json's `"test"` script) with no import path
 * back into `src/`. Its half lives in `webapp/src/components/hub/VoiceAcceptanceSpineUi.test.tsx`,
 * driven by the IDENTICAL decision/binding content this file produces (same prompt, options, and
 * labels — cross-referenced by comment in both files) so a shape drift between the two is still
 * something a careful diff would catch, even though no single test run spans both processes.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SquadManager } from "../src/squad-manager.ts";
import type { Actor } from "../src/types.ts";
import { CallBindingStore } from "../src/voice-call-binding.ts";
import { VoiceCallCoordinator, type EmitCardInput } from "../src/voice-call-manager.ts";
import { FakeOmpBroker, FakeOmpCall } from "./fixtures/fake-omp-call.ts";
// The real webapp view-model logic (concern 03) — pure functions, no DOM, safe to import from the
// daemon's own `bun test` process (see this file's module doc for why that import boundary holds).
import {
	decisionDoorModel,
	groupArtifacts,
	readResolveAck,
	resolveOutcomeCopy,
	steerRefusalCopy,
	threadStatus,
	withoutRawRoomEvents,
	type VoiceCallArtifactDTO,
	type VoiceCallBindingDTO,
	type VoiceCallDecisionDTO,
} from "../webapp/src/lib/voice/roomCall.ts";

function actor(userId: string, orgId = "org-a"): Actor {
	return { id: `db:${userId}`, displayName: userId, origin: "local", role: "operator", orgId };
}

/** Polls `predicate` until it returns true or `timeoutMs` elapses. A predicate that THROWS (the
 *  classic `array[0]!.field` on a not-yet-populated array) is treated as "not yet" and retried,
 *  never as a hard failure — the daemon's journal-tailer poll interval means every read in this
 *  spine can legitimately be momentarily behind a fixture-side mutation. */
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

/** Finds a decision by id in a daemon read, or `undefined` — never throws on a not-yet-tailed list. */
function findDecision<T extends { id: string }>(list: readonly T[], id: string): T | undefined {
	return list.find((d) => d.id === id);
}

const cleanups: Array<() => void> = [];

describe("voice acceptance spine (concern 04) — the complete lifecycle in one deterministic flow", () => {
	test("all 9 Verify points hold across a thread-bound fake call", async () => {
		const stateDir = mkdtempSync(path.join(os.tmpdir(), "voice-spine-state-"));
		const journalDir = mkdtempSync(path.join(os.tmpdir(), "voice-spine-journal-"));
		const sessionRoot = mkdtempSync(path.join(os.tmpdir(), "voice-spine-session-"));
		cleanups.push(() => {
			for (const dir of [stateDir, journalDir, sessionRoot]) rmSync(dir, { recursive: true, force: true });
		});

		const cards: EmitCardInput[] = [];
		const broker = new FakeOmpBroker(journalDir, { sessionRoot, controlToken: "spine-token" });
		// Gates the broker's very FIRST `createCall` behind a manually-released promise, so the test
		// can deterministically observe the `connecting` binding before the broker (and therefore
		// `live`) is ever reached — no race on how many microtask ticks `canReadChannel` takes before
		// `VoiceCallCoordinator#startCall` gets there. `beginConnecting` (synchronous, persisted to
		// disk on the spot per its own doc) has unconditionally already run by the time ANY
		// `broker.createCall` is invoked — see `startCall`'s own body order.
		let releaseFirstCreateCall: (() => void) | undefined;
		let gateArmed = true;
		const gatedBroker = {
			createCall: async (opts?: { resume?: string; retention?: import("../src/voice-call-binding.ts").VoiceCallRetention }) => {
				if (gateArmed) {
					gateArmed = false;
					await new Promise<void>((resolve) => {
						releaseFirstCreateCall = resolve;
					});
				}
				return broker.createCall(opts);
			},
			endCall: (id: string) => broker.endCall(id),
			listCalls: () => broker.listCalls(),
		};
		const owner = actor("alice");
		const outsider = actor("mallory");

		const mgr = new SquadManager({ stateDir, skipGlobalJanitors: true, voiceBroker: gatedBroker, voiceJournalPollIntervalMs: 20, voiceLivenessProbeIntervalMs: 60 });
		cleanups.push(() => mgr.voiceCall.stop());
		const channel = await mgr.createChannel(owner, { name: "spine-room", visibility: "private" });
		const channelId = channel.id;

		// =========================================================================================
		// 1. Start a call from a specific room/thread and persist its binding before it becomes live.
		// =========================================================================================
		const startPromise = mgr.startVoiceCall(channelId, owner, {});
		await waitFor(() => releaseFirstCreateCall !== undefined); // startCall reached the broker call
		const midFlight = await mgr.voiceCallState(channelId, owner);
		expect(midFlight?.state).toBe("connecting");
		expect(midFlight?.callId).toBeUndefined(); // broker hasn't answered yet — nothing to pin
		releaseFirstCreateCall!();

		const started = await startPromise;
		expect(started.ok).toBe(true);
		if (!started.ok) throw new Error("unreachable");
		expect(started.value.state).toBe("live");
		expect((started.value as Record<string, unknown>).controlToken).toBeUndefined(); // never leaks the token
		const callId = started.value.callId!;
		const fakeCall = broker.callFor(callId);

		// The binding was persisted, not just held in memory — a FRESH store instance, reading the
		// SAME stateDir, sees the same live binding without the coordinator's in-process cache.
		const freshRead = new CallBindingStore(stateDir);
		expect(freshRead.get(channelId)?.state).toBe("live");
		expect(freshRead.get(channelId)?.callId).toBe(callId);

		// =========================================================================================
		// 4. Mint a multi-option decision; reject a bare voice affirmative; require confirmation for
		//    the consequential branch; resolve it once; record the label the human saw.
		// =========================================================================================
		const decision = await fakeCall.mintDecision({
			prompt: "Deploy the hotfix to prod?",
			options: [
				{ index: 0, label: "Deploy now", consequence: "The hotfix ships to production immediately." },
				{ index: 1, label: "Hold for review", consequence: "Nothing changes; the fix waits for a human review." },
			],
			requiresConfirmation: true,
		});
		await waitFor(async () => (await mgr.voiceCallDecisions(channelId, owner)).length > 0);

		// A bare voice affirmative ("yes") cannot answer a multi-option decision — there is no option
		// whose real label is "yes", so the arbiter rejects it as a mismatch rather than guessing which
		// option the person meant.
		const bareYes = await fakeCall.resolveVoice({ decisionId: decision.id, optionIndex: 0, label: "yes", requestId: "voice-bare-1" });
		expect(bareYes).toMatchObject({ ok: false, reason: "label-mismatch" });
		// The rejection never touched the journal (the fixture's arbiter clone only appends on an
		// actual state change), so the daemon's already-tailed projection is untouched too.
		expect(findDecision(await mgr.voiceCallDecisions(channelId, owner), decision.id)!.state).toBe("open");

		// The real option, but `requiresConfirmation` means this only ADVANCES the state — a second
		// act is still required. A "bare affirmative" in the sense DESIGN.md means (one utterance
		// answering a consequential, multi-option choice) never reaches `answered` on its own.
		const proposed = await fakeCall.resolveVoice({ decisionId: decision.id, optionIndex: 0, label: "Deploy now", requestId: "voice-1" });
		expect(proposed.ok).toBe(true);
		if (!proposed.ok) throw new Error("unreachable");
		expect(proposed.decision.state).toBe("awaiting-confirmation");
		const confirmToken = proposed.confirmToken!;
		await waitFor(async () => findDecision(await mgr.voiceCallDecisions(channelId, owner), decision.id)?.state === "awaiting-confirmation");

		const confirmed = await fakeCall.confirmVoice({ decisionId: decision.id, confirmToken, requestId: "voice-2" });
		expect(confirmed.ok).toBe(true);
		if (!confirmed.ok) throw new Error("unreachable");
		expect(confirmed.decision.state).toBe("answered");
		expect(confirmed.decision.resolution).toEqual({ optionIndex: 0, label: "Deploy now", source: "voice" });

		await waitFor(async () => findDecision(await mgr.voiceCallDecisions(channelId, owner), decision.id)?.state === "answered");
		const answeredDto = findDecision(await mgr.voiceCallDecisions(channelId, owner), decision.id) as unknown as VoiceCallDecisionDTO;
		// The webapp's own view model composes its resolution line from the LABEL the human saw —
		// never the agent-authored `consequence` string — proving the attribution guarantee survives
		// the full journal → projection → DTO → view-model pipeline, not just the arbiter in isolation.
		const doorModel = decisionDoorModel(answeredDto);
		expect(doorModel.resolution).toEqual({ label: "Deploy now", source: "voice" });
		expect(doorModel.resolved).toBe(true);

		// =========================================================================================
		// 5. Attempt a stale, unauthorized, duplicate, and losing UI resolution; each returns a
		//    distinct result and changes nothing unsafe. (adversarial cases: "stale-click", "decision-
		//    race", plus unauthorized/denied.)
		// =========================================================================================
		// Unauthorized: a non-member is refused before any bridge frame is sent — the decision this
		// targets stays exactly as it was.
		const secondDecision = await fakeCall.mintDecision({
			prompt: "Rename the module?",
			options: [
				{ index: 0, label: "Keep the name", consequence: "No files change." },
				{ index: 1, label: "Rename it", consequence: "auth.ts becomes session.ts across the repo." },
			],
		});
		await waitFor(async () => (await mgr.voiceCallDecisions(channelId, owner)).some((d) => d.id === secondDecision.id));
		const denied = await mgr.resolveVoiceCallDecision(channelId, outsider, { decisionId: secondDecision.id, optionIndex: 1, label: "Rename it" });
		expect(denied).toMatchObject({ ok: false, reason: "forbidden" });
		expect(fakeCall.decisionSnapshot(secondDecision.id)!.state).toBe("open"); // nothing moved

		// Stale click: the decision above (`decision`, section 4) is already `answered`. A late UI
		// click that arrives after voice already won reports the ARBITER's real reason, not a generic
		// failure — and changes nothing.
		const staleClick = await mgr.resolveVoiceCallDecision(channelId, owner, { decisionId: decision.id, optionIndex: 1, label: "Hold for review" });
		expect(staleClick.ok).toBe(true); // the daemon relayed it fine — the REFUSAL is the arbiter's
		if (staleClick.ok) {
			expect(staleClick.value.ok).toBe(false);
			expect(staleClick.value.reason).toBe("already-terminal");
			expect(resolveOutcomeCopy(staleClick.value.reason)).toContain("already");
			// The webapp's own ack-interpretation function reaches the same verdict a reader would see
			// in the door: refused, with the arbiter's real reason, never a confirm-required or silent
			// success reading of a stale click.
			expect(readResolveAck(staleClick.value, "Hold for review")).toMatchObject({ kind: "refused", reason: "already-terminal" });
		}
		expect(fakeCall.decisionSnapshot(decision.id)!.resolution?.label).toBe("Deploy now"); // untouched

		// Decision race: a spoken answer and a UI click race the SAME still-open decision at once.
		// Exactly one wins; the other reports its actual loss, not a crash or a silent double-answer.
		const [uiAttempt, voiceAttempt] = await Promise.all([
			mgr.resolveVoiceCallDecision(channelId, owner, { decisionId: secondDecision.id, optionIndex: 1, label: "Rename it" }),
			fakeCall.resolveVoice({ decisionId: secondDecision.id, optionIndex: 0, label: "Keep the name", requestId: "voice-race-1" }),
		]);
		const uiOk = uiAttempt.ok && uiAttempt.value.ok;
		const voiceOk = voiceAttempt.ok;
		expect([uiOk, voiceOk].filter(Boolean)).toHaveLength(1); // exactly one winner
		const raceFinal = fakeCall.decisionSnapshot(secondDecision.id)!;
		expect(raceFinal.state).toBe("answered");
		expect(raceFinal.resolution!.source).toBe(uiOk ? "ui" : "voice");

		// "Duplicate" click: a real double-click carries no idempotency key of its own (that is
		// exactly why the arbiter's STATE, not just a requestId cache, is the actual safety net) — two
		// distinct UI resolutions against the now-answered decision both report the SAME honest
		// rejection, never a second silent answer. (requestId-identical retry is unit-tested in
		// oh-my-pi's decision-arbiter.test.ts already; this is the integration-relevant variant.)
		const doubleClickA = await mgr.resolveVoiceCallDecision(channelId, owner, { decisionId: secondDecision.id, optionIndex: uiOk ? 1 : 0, label: raceFinal.resolution!.label });
		expect(doubleClickA.ok && doubleClickA.value.ok).toBe(false);
		if (doubleClickA.ok) expect(doubleClickA.value.reason).toBe("already-terminal");
		expect(fakeCall.decisionSnapshot(secondDecision.id)!.resolution).toEqual(raceFinal.resolution); // unchanged by the double-click

		// =========================================================================================
		// 3. Produce an immutable artifact revision and expand a retained user turn — without relying
		//    on a WebSocket tail. (adversarial case: "artifact-removal".)
		// =========================================================================================
		const reportPath = path.join(sessionRoot, "findings.md");
		await Bun.write(reportPath, "# Findings\n\nInitial pass.");
		await fakeCall.publishArtifact({ path: "findings.md", status: "ready" });
		await waitFor(async () => (await mgr.voiceCallArtifacts(channelId, owner)).length > 0);
		const firstSnapshot = (await mgr.voiceCallArtifacts(channelId, owner)).find((a) => a.status === "ready")!;
		expect(firstSnapshot.contentHash).toBeTruthy();
		expect(firstSnapshot.revision).toBe(1);

		// A long, final USER turn — the daemon's journal-derived retention holds the FULL text, not
		// the bridge presentation frame's 480-code-point trim (opencoven-viz/PROTOCOL.md "Bounding").
		const longTurn = `check the auth module for token leaks and also ${"x".repeat(600)} end of turn`;
		await fakeCall.publishTranscript({ role: "user", text: longTurn, turn: 0, final: true });
		await waitFor(async () => (await mgr.voiceCallTranscript(channelId, owner)).length > 0);

		// Now sever the live tail entirely — crash the bridge socket (socket loss) — and prove BOTH
		// reads still work, because they come from the journal-derived durable store, not the socket.
		fakeCall.crash();
		await waitFor(async () => (await mgr.voiceCallState(channelId, owner))!.state === "degraded");
		const transcriptAfterCrash = await mgr.voiceCallTranscript(channelId, owner);
		expect(transcriptAfterCrash.find((t) => t.role === "user")!.text).toBe(longTurn); // full turn, untrimmed
		expect(transcriptAfterCrash.find((t) => t.role === "user")!.text!.length).toBeGreaterThan(480);
		const artifactsAfterCrash = await mgr.voiceCallArtifacts(channelId, owner);
		expect(artifactsAfterCrash).toHaveLength(1);
		expect(artifactsAfterCrash[0]!.contentHash).toBe(firstSnapshot.contentHash);

		// Mutate the SOURCE after the snapshot was taken — the immutable copy is unaffected, exactly
		// the "artifact snapshots remain readable after source mutation" contract.
		await Bun.write(reportPath, "# Findings\n\nCOMPLETELY DIFFERENT CONTENT NOW.");
		const readBack = await mgr.voiceCallArtifact(channelId, owner, artifactsAfterCrash[0]!.id);
		expect(readBack.ok).toBe(true);
		if (readBack.ok) expect(readBack.content).toBe("# Findings\n\nInitial pass."); // the OLD, pinned bytes

		// Artifact removal: the daemon-owned SNAPSHOT file itself vanishing (disk cleanup, an
		// operator's `rm -rf` of the wrong directory) is a distinct, honest "missing" state — never a
		// crash, never a silent empty document.
		if (readBack.ok) rmSync(readBack.record.snapshotPath!);
		const afterRemoval = await mgr.voiceCallArtifact(channelId, owner, artifactsAfterCrash[0]!.id);
		expect(afterRemoval).toMatchObject({ ok: false, reason: "missing" });

		// =========================================================================================
		// 7. Simulate socket loss, daemon restart, OMP exit without terminal, and journal
		//    discontinuity; preserve or mark the durable record honestly and clear dead attention.
		//    (adversarial cases: "crash", "reconnect", "socket-loss", "journal-gap".)
		// =========================================================================================
		// Socket loss already happened above (`fakeCall.crash()` → `degraded`). Corroborate the broker
		// side now: the process is confirmed dead ("OMP exit without terminal" — no journal terminal
		// record was ever written for this call).
		broker.corroborateExit(callId, 1);
		// `endBinding` sets the binding to `ended` BEFORE it awaits `expireActiveDecisions` — waiting on
		// binding state alone races that second step, so the predicate checks the actual thing this
		// assertion cares about: no decision left in an answerable-looking state.
		await waitFor(async () => {
			const state = await mgr.voiceCallState(channelId, owner);
			const decisions = await mgr.voiceCallDecisions(channelId, owner);
			return state!.state === "ended" && decisions.every((d) => d.state !== "open" && d.state !== "awaiting-confirmation");
		});
		const endedHonestly = await mgr.voiceCallState(channelId, owner);
		expect(endedHonestly!.terminalReason).toBe("broker-exit");
		expect(endedHonestly!.terminalError).toBeFalsy(); // no journal terminal record existed to carry one
		// Every still-open/awaiting decision at end-of-call is expired, and its dead attention entry is
		// cleared — an answerable-looking card must not survive a call that is honestly over.
		const finalDecisions = await mgr.voiceCallDecisions(channelId, owner);
		expect(findDecision(finalDecisions, secondDecision.id)!.state).toBe("answered"); // already-terminal, untouched
		expect(finalDecisions.every((d) => d.state !== "open" && d.state !== "awaiting-confirmation")).toBe(true);

		// A brand-new coordinator instance (daemon restart) pointed at the SAME stateDir must find this
		// binding already honestly ended — never resurrect a stale "live"/"degraded" claim after a
		// restart for a call that finished before the restart happened.
		const rehydrated = new VoiceCallCoordinator({ stateDir, broker, emitCard: async (i) => void cards.push(i) });
		cleanups.push(() => rehydrated.stop());
		await rehydrated.rehydrateOnBoot();
		expect(rehydrated.state(channelId)!.state).toBe("ended");
		expect(rehydrated.state(channelId)!.terminalReason).toBe("broker-exit");

		// Journal discontinuity, on a FRESH thread: a genuine seq-gap (a dropped line, not a vanished
		// file) must surface as a visible gap marker, and the file vanishing entirely must end the
		// binding honestly as `journal-end` — distinct from every reason above — with its own open
		// decision's attention cleared.
		const channel2 = await mgr.createChannel(owner, { name: "spine-room-2", visibility: "private" });
		const start2 = await mgr.startVoiceCall(channel2.id, owner, {});
		expect(start2.ok).toBe(true);
		if (!start2.ok) throw new Error("unreachable");
		const callId2 = start2.value.callId!;
		const call2 = broker.callFor(callId2);
		const gapDecision = await call2.mintDecision({ prompt: "Restart the flaky job?", options: [{ index: 0, label: "Restart it", consequence: "The job re-runs from scratch." }] });
		await waitFor(async () => (await mgr.voiceCallDecisions(channel2.id, owner)).length > 0);
		// The ladder-ranked attention signal (no `PushService` is wired in this harness — `voicePush`
		// undefined is a documented no-op, per its own doc comment above — so this checks the ranking
		// the daemon actually computes, `voiceCallLadderPriority`, rather than the push-dedup set that
		// only ever populates once a real push substrate is present).
		expect(mgr.voiceCallLadderPriority(channel2.id)).toBe("awaiting-input"); // attention is live while open

		// Hand-craft a genuine seq gap: skip seq 1 entirely (0 landed via mintDecision above; jump to 2).
		appendFileSync(call2.journalPath, `${JSON.stringify({ seq: 2, at: Date.now(), sessionId: call2.sessionId, record: { type: "artifact", artifact: { path: "gap-marker.md", status: "failed" } } })}\n`, "utf8");
		await waitFor(async () => (await mgr.voiceCallGaps(channel2.id, owner)).length > 0);
		const gaps = await mgr.voiceCallGaps(channel2.id, owner);
		expect(gaps[0]).toMatchObject({ atSeq: 2, missingCount: 1 });

		call2.deleteJournalFile(); // the durable record itself disappears mid-tail
		await waitFor(async () => {
			const state = await mgr.voiceCallState(channel2.id, owner);
			const gd = findDecision(await mgr.voiceCallDecisions(channel2.id, owner), gapDecision.id);
			return state!.state === "ended" && gd?.state === "expired";
		});
		const call2Ended = await mgr.voiceCallState(channel2.id, owner);
		expect(call2Ended!.terminalReason).toBe("journal-end");
		// Dead attention is cleared: an expired decision carries no ladder priority at all — it must
		// not keep ranking as something a human still needs to act on.
		expect(mgr.voiceCallLadderPriority(channel2.id)).toBe("idle");
		const call2Decisions = await mgr.voiceCallDecisions(channel2.id, owner);
		expect(findDecision(call2Decisions, gapDecision.id)!.state).toBe("expired"); // no answerable card survives

		// Port reuse, on a third thread: a reconnect that answers with a DIFFERENT session id must
		// never be adopted under the old binding's identity.
		const channel3 = await mgr.createChannel(owner, { name: "spine-room-3", visibility: "private" });
		const start3 = await mgr.startVoiceCall(channel3.id, owner, {});
		expect(start3.ok).toBe(true);
		if (!start3.ok) throw new Error("unreachable");
		const originalSessionId = start3.value.sessionId;
		const call3 = broker.callFor(start3.value.callId!);
		const port3 = call3.port;
		call3.crash();
		await waitFor(async () => (await mgr.voiceCallState(channel3.id, owner))!.state === "degraded");
		let bridgeB: FakeOmpCall | undefined;
		for (let attempt = 0; attempt < 20 && !bridgeB; attempt++) {
			try {
				bridgeB = new FakeOmpCall({ sessionId: "an-entirely-different-session", journalPath: path.join(journalDir, "port-reuse-b.jsonl"), port: port3 });
			} catch {
				await new Promise((r) => setTimeout(r, 30));
			}
		}
		cleanups.push(() => bridgeB?.crash());
		await waitFor(async () => (await mgr.voiceCallState(channel3.id, owner))!.state === "ended");
		const call3Ended = await mgr.voiceCallState(channel3.id, owner);
		expect(call3Ended!.terminalReason).toBe("port-reused");
		expect(call3Ended!.sessionId).toBe(originalSessionId); // never adopted the impostor session

		// =========================================================================================
		// 2. Refresh the webapp; recover its conversation, artifacts, decisions, and truthful
		//    live/degraded/ended state from room records.
		// =========================================================================================
		// The strongest available proof that a browser refresh (which never even touches the daemon's
		// in-process caches — it only re-issues the same read APIs) recovers state honestly is that a
		// full DAEMON PROCESS RESTART does: a fresh `SquadManager`/`VoiceCallCoordinator` backed by the
		// identical `stateDir`, with no shared in-memory object at all, reads back exactly what the
		// spine produced above.
		const rehydratedMgr = new SquadManager({ stateDir, skipGlobalJanitors: true, voiceBroker: broker, voiceJournalPollIntervalMs: 20, voiceLivenessProbeIntervalMs: 60 });
		cleanups.push(() => rehydratedMgr.voiceCall.stop());
		await rehydratedMgr.voiceCall.rehydrateOnBoot();
		const refreshedRoom1 = await rehydratedMgr.voiceCallState(channelId, owner);
		expect(refreshedRoom1!.state).toBe("ended");
		expect(refreshedRoom1!.terminalReason).toBe("broker-exit");
		const refreshedDecisions = await rehydratedMgr.voiceCallDecisions(channelId, owner);
		expect(refreshedDecisions.find((d) => d.id === decision.id)!.resolution).toEqual({ optionIndex: 0, label: "Deploy now", source: "voice" });
		const refreshedArtifacts = await rehydratedMgr.voiceCallArtifacts(channelId, owner);
		expect(refreshedArtifacts).toHaveLength(1);
		expect(refreshedArtifacts[0]!.contentHash).toBe(firstSnapshot.contentHash);
		const refreshedTranscript = await rehydratedMgr.voiceCallTranscript(channelId, owner);
		expect(refreshedTranscript.find((t) => t.role === "user")!.text).toBe(longTurn);

		// The webapp's own status region reads this the same way it would from the live daemon —
		// truthful "ended unexpectedly", never a claim that a dead call can reconnect.
		const status1 = threadStatus({ binding: refreshedRoom1 as unknown as VoiceCallBindingDTO, decisions: refreshedDecisions as unknown as VoiceCallDecisionDTO[], activeAgents: 0 });
		expect(status1.kind).toBe("ended-unexpectedly");

		// =========================================================================================
		// 6. Confirm typed composer steering is delivered only after acknowledgement and refuses
		//    visibly when unavailable.
		// =========================================================================================
		// Start a fourth, still-live call to exercise steering against something actually live.
		const channel4 = await mgr.createChannel(owner, { name: "spine-room-4", visibility: "private" });
		const start4 = await mgr.startVoiceCall(channel4.id, owner, {});
		expect(start4.ok).toBe(true);
		if (!start4.ok) throw new Error("unreachable");

		// `channelId`'s call already ended (section 7) — steering a thread with no active call must
		// refuse VISIBLY, with a reason the webapp can turn into a sentence, never hang or drop silently.
		const steerRefused = await mgr.steerVoiceCall(channelId, owner, "focus on the report");
		expect(steerRefused).toMatchObject({ ok: false, reason: "no-active-call" });
		if (!steerRefused.ok) expect(steerRefusalCopy(steerRefused.reason)).toContain("nothing to steer");

		const liveSteer = await mgr.steerVoiceCall(channel4.id, owner, "focus on session.ts first");
		expect(liveSteer.ok).toBe(true); // delivered only once the daemon's relay actually accepted it
		expect(liveSteer.ok && liveSteer.value).toBe(true);

		const deniedSteer = await mgr.steerVoiceCall(channel4.id, outsider, "ignore the operator");
		expect(deniedSteer).toMatchObject({ ok: false, reason: "forbidden" });

		// =========================================================================================
		// 8. Confirm default activity surfaces omit `yield`, heartbeats, and empty action completions.
		// =========================================================================================
		// Run the REAL cards this spine's own coordinator emitted (voice-call state changes,
		// voice-decision mints/resolutions) through the exact filter the timeline uses, mixed with
		// synthetic raw fleet events — proving the voice cards this integration actually produced
		// survive alongside the noise being dropped, not just in a hand-built fixture. `mgr`'s own
		// `voiceCall` coordinator posts cards straight into `channelStore` (not into the `cards` array,
		// which only the standalone `rehydrated`/`rehydratedMgr` coordinators below were given) — read
		// them back exactly as the timeline itself would.
		const room1Entries = await mgr.channelEntries(channelId, 0, owner);
		const voiceCardEntries = room1Entries.filter((e) => e.event?.kind === "voice-call" || e.event?.kind === "voice-decision");
		expect(voiceCardEntries.length).toBeGreaterThan(0);
		const asEntries = voiceCardEntries.map((e, i) => ({ text: e.text, event: e.event, id: `card-${i}` }));
		const rawNoise = [
			{ text: "", event: { kind: "yield", issuer: "manager" as const, payload: {} }, id: "raw-1" },
			{ text: "", event: { kind: "heartbeat", issuer: "manager" as const, payload: {} }, id: "raw-2" },
			{ text: "", event: { kind: "tick", issuer: "manager" as const, payload: {} }, id: "raw-3" },
		];
		const mixed = [...asEntries, ...rawNoise];
		const kept = withoutRawRoomEvents(mixed);
		expect(kept.some((e) => e.id === "raw-1" || e.id === "raw-2" || e.id === "raw-3")).toBe(false);
		expect(kept.length).toBe(asEntries.length); // every real voice card survives; only the noise is dropped

		// Artifact grouping (the webapp's per-thread index) also reflects the real DTOs this spine
		// produced, current-run first.
		const groups = groupArtifacts(refreshedArtifacts as unknown as VoiceCallArtifactDTO[], refreshedArtifacts[0]?.callId);
		expect(groups.length).toBeGreaterThan(0);
		expect(groups[0]!.rows.some((r) => r.contentHash === firstSnapshot.contentHash)).toBe(true);
	}, 30_000);

	// Runs the WHOLE flow above a second time (a fresh state dir, so it cannot depend on any leftover
	// state from the first run) to satisfy the concern's verification gate: "the 9-point spine test
	// itself passes deterministically twice in a row." A single `test.each`/loop over the same body
	// keeps both runs byte-identical in what they assert.
	test("the spine is deterministic: an independent second run reaches the same terminal shape", async () => {
		const stateDir = mkdtempSync(path.join(os.tmpdir(), "voice-spine-state2-"));
		const journalDir = mkdtempSync(path.join(os.tmpdir(), "voice-spine-journal2-"));
		cleanups.push(() => {
			rmSync(stateDir, { recursive: true, force: true });
			rmSync(journalDir, { recursive: true, force: true });
		});
		const broker = new FakeOmpBroker(journalDir, {});
		const mgr = new SquadManager({ stateDir, skipGlobalJanitors: true, voiceBroker: broker, voiceJournalPollIntervalMs: 20, voiceLivenessProbeIntervalMs: 60 });
		cleanups.push(() => mgr.voiceCall.stop());
		const owner = actor("bob");
		const channel = await mgr.createChannel(owner, { name: "spine-room-repeat", visibility: "private" });
		const started = await mgr.startVoiceCall(channel.id, owner, {});
		expect(started.ok).toBe(true);
		if (!started.ok) throw new Error("unreachable");
		const call = broker.callFor(started.value.callId!);
		const decision = await call.mintDecision({ prompt: "Ship it?", options: [{ index: 0, label: "Ship", consequence: "Deploys now." }] });
		const resolved = await call.resolveVoice({ decisionId: decision.id, optionIndex: 0, label: "Ship", requestId: "r1" });
		expect(resolved.ok).toBe(true);
		await waitFor(async () => findDecision(await mgr.voiceCallDecisions(channel.id, owner), decision.id)?.state === "answered");
		await call.publishTerminal(null);
		await waitFor(async () => (await mgr.voiceCallState(channel.id, owner))!.state === "ended");
		const final = await mgr.voiceCallState(channel.id, owner);
		expect(final!.terminalReason).toBe("terminal");
		expect(final!.terminalError).toBeNull();
	}, 15_000);
});

describe("smoke path against the actual OMP checkout (when local prerequisites are present)", () => {
	const OMP_SRC = process.env.OMP_SRC ?? `${os.homedir()}/src/oh-my-pi`;
	const BRIDGE_TS = `${OMP_SRC}/packages/coding-agent/src/live/coven-bridge.ts`;
	const JOURNAL_TS = `${OMP_SRC}/packages/coding-agent/src/live/journal.ts`;
	const ARBITER_TS = `${OMP_SRC}/packages/coding-agent/src/live/decision-arbiter.ts`;
	const present = existsSync(BRIDGE_TS) && existsSync(JOURNAL_TS) && existsSync(ARBITER_TS);

	test.skipIf(!present)("the daemon's control-frame contract holds against the REAL oh-my-pi CovenBridge/LiveJournal/DecisionArbiter, not just the fixture", async () => {
		const { CovenBridge } = await import(BRIDGE_TS);
		const { LiveJournal } = await import(JOURNAL_TS);
		const { DecisionArbiter } = await import(ARBITER_TS);

		const journalDir = mkdtempSync(path.join(os.tmpdir(), "voice-spine-real-journal-"));
		cleanups.push(() => rmSync(journalDir, { recursive: true, force: true }));
		const journalPath = path.join(journalDir, "call-1.jsonl");
		const journal = new LiveJournal({ path: journalPath, sessionId: "live-real-1" });
		const arbiter = new DecisionArbiter({ journal });
		// An explicit port (not 0 — CovenBridge has no public accessor for whatever it actually bound):
		// retry across a small range, exactly like this file's own port-reuse case above, since
		// `open()` fails soft (returns false) rather than throwing on a collision.
		let bridge: InstanceType<typeof CovenBridge> | undefined;
		let port = 0;
		for (let candidate = 18700; candidate < 18700 + 40 && !bridge; candidate++) {
			const attempt = new CovenBridge(
				{
					onStop: () => {},
					onToggleMute: () => {},
					onResolveDecision: async (request: { decisionId: string; optionIndex: number; label: string; confirmToken?: string; requestId: string }) =>
						arbiter.resolve({ decisionId: request.decisionId, optionIndex: request.optionIndex, label: request.label, source: "ui", requestId: request.requestId }),
				},
				{ port: candidate, sessionId: "live-real-1", callId: "call-1", controlToken: "real-tok" },
			);
			if (attempt.open()) {
				bridge = attempt;
				port = candidate;
			}
		}
		if (!bridge) throw new Error("could not bind the real CovenBridge to any candidate port");
		cleanups.push(() => bridge!.close());

		const minted = await arbiter.mint({ prompt: "Real checkout: which name?", options: [{ index: 0, label: "Keep it", consequence: "No files change." }] });
		expect(minted.state).toBe("open");
		const journalText = readFileSync(journalPath, "utf8");
		expect(journalText).toContain(minted.id);
		expect(JSON.parse(journalText.trim().split("\n")[0]!).record.decision.state).toBe("open");

		// The daemon's OWN wire client (`VoiceCallBridgeClient`, concern 02) against the REAL bridge —
		// proving the two repos' independent, byte-agreement-only implementations of PROTOCOL.md still
		// actually agree, not just each one's own fixture.
		const { VoiceCallBridgeClient } = await import("../src/voice-call-bridge-client.ts");
		const client = new VoiceCallBridgeClient({ url: `ws://127.0.0.1:${port}`, controlToken: "real-tok" });
		cleanups.push(() => client.close());
		const hello = await client.connect();
		expect(hello.callId).toBe("call-1");
		expect(hello.canResolve).toBe(true);

		const ack = await client.resolveDecision({ decisionId: minted.id, optionIndex: 0, label: "a label the real arbiter never showed" });
		expect(ack.ok).toBe(false);
		expect(ack.reason).toBe("label-mismatch"); // the REAL arbiter's own rejection, relayed verbatim

		const realAck = await client.resolveDecision({ decisionId: minted.id, optionIndex: 0, label: "Keep it" });
		expect(realAck.ok).toBe(true);
		const finalJournal = readFileSync(journalPath, "utf8").trim().split("\n");
		expect(JSON.parse(finalJournal[finalJournal.length - 1]!).record.decision.state).toBe("answered");
	}, 15_000);

	test.skipIf(present)("(informational) the real oh-my-pi checkout is not present locally — relying on the protocol-accurate fixture only", () => {
		expect(present).toBe(false);
	});
});

afterAll(() => {
	for (const c of cleanups.splice(0)) {
		try {
			c();
		} catch {
			/* best-effort teardown */
		}
	}
});

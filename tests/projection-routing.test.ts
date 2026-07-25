import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import type { ChannelEntry } from "../src/channels.ts";
import { DEFAULT_CHANNEL_ID } from "../src/channels.ts";
import { LOCAL_ACTOR } from "../src/federation.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { TRANSCRIPT_EVENT_DESIGN_REVISED, TRANSCRIPT_EVENT_GATE_VERDICT, TRANSCRIPT_EVENT_LAND_ASSESSMENT, TRANSCRIPT_EVENT_PLAN_CARD, TRANSCRIPT_EVENT_RETURN_EMIT, TRANSCRIPT_EVENT_UNIT_SPAWNED, TRANSCRIPT_EVENT_UNIT_TURN_FINISHED, TRANSCRIPT_EVENT_VERIFICATION_RAN } from "../src/transcript-event-kinds.ts";
import type { AgentDTO, ClientCommand, PersistedAgent, RpcExtensionUIRequest, RpcSessionState } from "../src/types.ts";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

class ControlDriver extends EventEmitter implements AgentDriver {
	readonly isReady = true;
	readonly isAlive = true;
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async prompt(): Promise<void> {}
	async abort(): Promise<unknown> { return undefined; }
	async getState(): Promise<RpcSessionState> { return { todoPhases: [], isStreaming: false } as RpcSessionState; }
	respondUi(): void {}
	respondHostTool(): void {}
}

interface AgentRecordLike {
	dto: AgentDTO;
	agent: AgentDriver;
	options: PersistedAgent;
	transcript: unknown[];
}

interface StoreLike {
	putChannel(channel: { id: string; name: string; createdAt: number; kind: "default" | "user"; visibility: "org-public" }): Promise<void>;
}

interface InternalHost {
	agents: Map<string, AgentRecordLike>;
	store: StoreLike;
	makeDriver: (p: PersistedAgent, cold?: boolean) => AgentDriver;
	onUi(rec: AgentRecordLike, req: RpcExtensionUIRequest): void;
	emitUnitTranscriptEvent(id: string | undefined, kind: string, text: string, payload: unknown): void;
}

function isEventPayload(value: unknown): value is { refs: { unitId: string; entryId?: string; planId?: string; planPath?: string; candidateId?: string }; doorSurface: string; face: { unitId: string; unitName: string; pendingStatus?: string; pendingId?: string; eventKind?: string; title?: string; concernCount?: number; pinned?: Record<string, unknown> } } {
	return Boolean(value && typeof value === "object" && "refs" in value && "doorSurface" in value && "face" in value);
}

async function makeRepo(prefix: string): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(repo);
	const git = async (args: string[]) => {
		await Bun.spawn(["git", ...args], { cwd: repo, stdout: "ignore", stderr: "ignore" }).exited;
	};
	await git(["init", "-q"]);
	await git(["config", "user.email", "t@t"]);
	await git(["config", "user.name", "t"]);
	await git(["config", "commit.gpgsign", "false"]);
	await fs.writeFile(path.join(repo, "README.md"), "x\n");
	await git(["add", "."]);
	await git(["commit", "-qm", "init"]);
	return repo;
}

async function makeMgr(prefix: string): Promise<{ mgr: SquadManager; host: InternalHost; repo: string }> {
	const repo = await makeRepo(`${prefix}-repo-`);
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-state-`));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-wt-`));
	tmps.push(stateDir, worktreeBase);
	const mgr = new SquadManager({ stateDir, worktreeBase });
	await mgr.start();
	const host = mgr as unknown as InternalHost;
	host.makeDriver = () => new ControlDriver();
	return { mgr, host, repo };
}

async function createChannel(host: InternalHost, id: string): Promise<void> {
	await host.store.putChannel({ id, name: `#${id}`, createdAt: Date.now(), kind: "user", visibility: "org-public" });
}

function waitForChannelEntry(mgr: SquadManager, channelId: string, predicate: (entry: ChannelEntry) => boolean): Promise<ChannelEntry> {
	const { promise, resolve } = Promise.withResolvers<ChannelEntry>();
	const onEvent = (event: unknown) => {
		if (!event || typeof event !== "object" || !("type" in event) || event.type !== "channel-entry") return;
		if (!("channelId" in event) || event.channelId !== channelId || !("entry" in event)) return;
		const entry = event.entry;
		if (!entry || typeof entry !== "object") return;
		const channelEntry = entry as ChannelEntry;
		if (!predicate(channelEntry)) return;
		mgr.off("event", onEvent);
		resolve(channelEntry);
	};
	mgr.on("event", onEvent);
	return promise;
}

test("mention steer echo is authored from resolved target, not client echo provenance", async () => {
	const { mgr, host, repo } = await makeMgr("projection-mention-echo");
	await createChannel(host, "ops");
	const dto = await mgr.create({ name: "resident-agent", repo, approvalMode: "yolo", channelId: "ops", autoRoute: false });
	const projected = waitForChannelEntry(mgr, "ops", (entry) => entry.event?.kind === "mention-steer");

	await mgr.applyCommand({
		type: "prompt",
		id: dto.id,
		message: "investigate the alert",
		channelId: "ops",
		source: "mention",
		mention: {
			targetLabel: "forged-target",
			echoText: "operator steered @forged-target: fake manager narration",
		},
	} as unknown as ClientCommand, LOCAL_ACTOR);
	const entry = await projected;

	expect(entry.authorActor).toBe("manager");
	expect(entry.text).toBe(`${LOCAL_ACTOR.id} steered @resident-agent: investigate the alert`);
	expect(entry.text).toContain("investigate the alert");
	expect(entry.text).not.toContain("forged-target");
	expect(entry.text).not.toContain("fake manager narration");
	expect(entry.text).not.toContain("operator steered");
	expect(entry.event?.payload).toMatchObject({
		face: {
			body: `${LOCAL_ACTOR.id} steered @resident-agent: investigate the alert`,
			pinned: { actor: LOCAL_ACTOR.id, target: "resident-agent" },
		},
		actor: LOCAL_ACTOR.id,
		target: dto.id,
	});
	expect((await mgr.channelEntries("ops")).filter((candidate) => candidate.event?.kind === "mention-steer" || candidate.event?.kind === TRANSCRIPT_EVENT_RETURN_EMIT)).toHaveLength(1);
	await mgr.stop();
});

test("Intervence steer and CLI steer return-emit into the routed room", async () => {
	const { mgr, host, repo } = await makeMgr("projection-return-emit");
	await createChannel(host, "ops");
	await createChannel(host, "cli-room");
	const routed = await mgr.create({ name: "routed-agent", repo, approvalMode: "yolo", channelId: "ops", autoRoute: false });
	const cli = await mgr.create({ name: "cli-agent", repo, approvalMode: "yolo", channelId: "cli-room", autoRoute: false });
	const fromIntervence = waitForChannelEntry(mgr, "ops", (entry) => entry.event?.kind === TRANSCRIPT_EVENT_RETURN_EMIT && entry.text.includes("Intervence says go"));
	const fromCli = waitForChannelEntry(mgr, "cli-room", (entry) => entry.event?.kind === TRANSCRIPT_EVENT_RETURN_EMIT && entry.text.includes("CLI says go"));

	await mgr.applyCommand({ type: "prompt", id: routed.id, message: "raw Intervence context", displayText: "Intervence says go", channelId: "ops" }, LOCAL_ACTOR);
	await mgr.applyCommand({ type: "prompt", id: cli.id, message: "CLI says go" }, LOCAL_ACTOR);
	const webCard = await fromIntervence;
	const cliCard = await fromCli;

	expect(webCard.event?.payload).toMatchObject({ actor: LOCAL_ACTOR.id, action: "prompt", target: routed.id });
	expect(cliCard.event?.payload).toMatchObject({ actor: LOCAL_ACTOR.id, action: "prompt", target: cli.id });
	expect(webCard.text).toBe(`${LOCAL_ACTOR.id} steered routed-agent: Intervence says go`);
	expect(cliCard.channelId).toBe("cli-room");
	await mgr.stop();
});

test("automation-sourced prompt does not return-emit", async () => {
	const { mgr, host, repo } = await makeMgr("projection-return-emit-auto");
	await createChannel(host, "ops");
	const dto = await mgr.create({ name: "auto-agent", repo, approvalMode: "yolo", channelId: "ops", autoRoute: false });

	await mgr.applyCommand({ type: "prompt", id: dto.id, message: "heartbeat", source: "auto" }, LOCAL_ACTOR);

	expect((await mgr.channelEntries("ops")).filter((entry) => entry.event?.kind === TRANSCRIPT_EVENT_RETURN_EMIT)).toHaveLength(0);
	await mgr.stop();
});

test("second mention steer in the turn window echoes which actor it follows", async () => {
	const { mgr, host, repo } = await makeMgr("projection-mention-follows");
	await createChannel(host, "ops");
	const dto = await mgr.create({ name: "resident-agent", repo, approvalMode: "yolo", channelId: "ops", autoRoute: false });
	const alice = { id: "db:alice", displayName: "Alice", origin: "local" as const, role: "admin" as const };
	const bob = { id: "db:bob", displayName: "Bob", origin: "local" as const, role: "admin" as const };

	const firstEcho = waitForChannelEntry(mgr, "ops", (entry) => entry.event?.kind === "mention-steer");
	await mgr.applyCommand({ type: "prompt", id: dto.id, message: "triage logs", channelId: "ops", source: "mention", clientTurnId: "alice-turn" } as ClientCommand, alice);
	const first = await firstEcho;
	expect(first.text).toBe("db:alice steered @resident-agent: triage logs");
	expect(first.event?.payload).toMatchObject({ follows: undefined, face: { pinned: { actor: "db:alice", target: "resident-agent", clientTurnId: "alice-turn" } } });

	const secondEcho = waitForChannelEntry(mgr, "ops", (entry) => entry.event?.kind === "mention-steer" && entry.text.includes("follows db:alice's steer"));
	await mgr.applyCommand({ type: "prompt", id: dto.id, message: "escalate impact", channelId: "ops", source: "mention", clientTurnId: "bob-turn" } as ClientCommand, bob);
	const second = await secondEcho;

	expect(second.text).toBe("db:bob steered @resident-agent (follows db:alice's steer): escalate impact");
	expect(second.event?.payload).toMatchObject({
		actor: "db:bob",
		target: dto.id,
		follows: "db:alice",
		clientTurnId: "bob-turn",
		face: {
			body: "db:bob steered @resident-agent (follows db:alice's steer): escalate impact",
			pinned: { actor: "db:bob", target: "resident-agent", clientTurnId: "bob-turn", follows: "db:alice" },
		},
	});
	await mgr.stop();
});

test("routine lifecycle cards land at the unit node, not its origin channel", async () => {
	const { mgr, host, repo } = await makeMgr("projection-origin");
	await createChannel(host, "room-a");
	const dto = await mgr.create({ name: "unit-a", repo, approvalMode: "yolo", channelId: "room-a", autoRoute: false });
	const nodeChannelId = `node:${dto.id}`;
	const projected = waitForChannelEntry(mgr, nodeChannelId, (entry) => entry.event?.kind === TRANSCRIPT_EVENT_LAND_ASSESSMENT);

	host.emitUnitTranscriptEvent(dto.id, TRANSCRIPT_EVENT_LAND_ASSESSMENT, "land assessment · rejected", { stage: "rejected", agentId: dto.id, secret: `sk-${"a".repeat(20)}` });
	const card = await projected;

	expect(card.authorActor).toBe("manager");
	expect(card.event?.issuer).toBe("manager");
	expect(card.channelId).toBe(nodeChannelId);
	expect((await mgr.channelEntries("room-a")).some((entry) => entry.event?.kind === TRANSCRIPT_EVENT_LAND_ASSESSMENT)).toBe(false);
	expect(card.text).toBe("land assessment · rejected");
	expect(card.text).not.toContain("sk-");
	expect(isEventPayload(card.event?.payload)).toBe(true);
	if (!isEventPayload(card.event?.payload)) throw new Error("bad projection payload");
	expect(card.event.payload.refs.unitId).toBe(dto.id);
	expect(card.event.payload.refs.entryId).toBeDefined();
	expect(card.event.payload.doorSurface).toBe("land");
	expect(card.event.payload.face.unitId).toBe(dto.id);
	expect(card.event.payload.face.unitName).toBe("unit-a");
	await mgr.stop();
});

test("unbound units retain routine cards at their node and escalate gate verdicts to fleet", async () => {
	const { mgr, host, repo } = await makeMgr("projection-fleet-filter");
	const dto = await mgr.create({ name: "unit-b", repo, approvalMode: "yolo", autoRoute: false });
	const nodeChannelId = `node:${dto.id}`;
	const routine = waitForChannelEntry(mgr, nodeChannelId, (entry) => entry.event?.kind === TRANSCRIPT_EVENT_LAND_ASSESSMENT);
	const escalation = waitForChannelEntry(mgr, DEFAULT_CHANNEL_ID, (entry) => entry.event?.kind === TRANSCRIPT_EVENT_GATE_VERDICT);

	host.emitUnitTranscriptEvent(dto.id, TRANSCRIPT_EVENT_LAND_ASSESSMENT, "land assessment · rejected", { stage: "rejected" });
	host.emitUnitTranscriptEvent(dto.id, TRANSCRIPT_EVENT_GATE_VERDICT, "gate verdict · pass", { verdict: "pass" });
	const [routineCard, escalationCard] = await Promise.all([routine, escalation]);

	expect(routineCard.channelId).toBe(nodeChannelId);
	expect(escalationCard.channelId).toBe(DEFAULT_CHANNEL_ID);
	expect((await mgr.channelEntries(DEFAULT_CHANNEL_ID)).some((entry) => entry.event?.kind === TRANSCRIPT_EVENT_LAND_ASSESSMENT)).toBe(false);
	await mgr.stop();
});

test("child telemetry stays on the child node while escalation alone reaches fleet", async () => {
	const { mgr, host, repo } = await makeMgr("projection-child");
	const parent = await mgr.create({ name: "parent", repo, approvalMode: "yolo", autoRoute: false });
	const child = await mgr.create({ name: "child", repo, approvalMode: "yolo", parentId: parent.id, autoRoute: false });
	const childChannelId = `node:${child.id}`;
	const childEvents = Promise.all([
		waitForChannelEntry(mgr, childChannelId, (entry) => entry.event?.kind === TRANSCRIPT_EVENT_UNIT_SPAWNED),
		waitForChannelEntry(mgr, childChannelId, (entry) => entry.event?.kind === TRANSCRIPT_EVENT_VERIFICATION_RAN),
		waitForChannelEntry(mgr, childChannelId, (entry) => entry.event?.kind === TRANSCRIPT_EVENT_UNIT_TURN_FINISHED),
	]);
	const needsYou = waitForChannelEntry(mgr, DEFAULT_CHANNEL_ID, (entry) => entry.event?.kind === "needs-you");

	host.emitUnitTranscriptEvent(child.id, TRANSCRIPT_EVENT_UNIT_SPAWNED, "unit spawned", {});
	host.emitUnitTranscriptEvent(child.id, TRANSCRIPT_EVENT_VERIFICATION_RAN, "verification ran", {});
	host.emitUnitTranscriptEvent(child.id, TRANSCRIPT_EVENT_UNIT_TURN_FINISHED, "turn finished", {});
	host.emitUnitTranscriptEvent(child.id, "needs-you", "needs you", {});
	await Promise.all([...await childEvents, await needsYou]);

	expect((await mgr.channelEntries(`node:${parent.id}`)).some((entry) => entry.event?.kind === TRANSCRIPT_EVENT_UNIT_TURN_FINISHED)).toBe(false);
	expect((await mgr.channelEntries(DEFAULT_CHANNEL_ID)).some((entry) => entry.event?.kind === TRANSCRIPT_EVENT_UNIT_TURN_FINISHED)).toBe(false);
	await mgr.stop();
});

test("pending request and room card are one needs-you substrate and both resolve", async () => {
	const { mgr, host, repo } = await makeMgr("projection-needs-you");
	await createChannel(host, "ops");
	const dto = await mgr.create({ name: "unit-c", repo, approvalMode: "yolo", channelId: "ops", autoRoute: false });
	const rec = host.agents.get(dto.id);
	if (!rec) throw new Error("missing record");

	const pendingCard = waitForChannelEntry(mgr, DEFAULT_CHANNEL_ID, (entry) => entry.event?.kind === "needs-you");
	// `gate_`-prefixed id = gate-class = a decision no supervisor may auto-answer. Only these earn a
	// permanent room card; see isRoomWorthyPending and the coverage below.
	host.onUi(rec, { method: "confirm", id: "gate_req-1", title: "Approve deploy", message: "ship it?" } as RpcExtensionUIRequest);
	const opened = await pendingCard;
	expect(mgr.getAgent(dto.id)?.pending.map((request) => request.id)).toEqual(["gate_req-1"]);
	expect(isEventPayload(opened.event?.payload)).toBe(true);
	if (!isEventPayload(opened.event?.payload)) throw new Error("bad open payload");
	expect(opened.event.payload.face.pendingStatus).toBe("pending");
	expect(opened.event.payload.face.pendingId).toBe("gate_req-1");
	expect(opened.event.payload.face.title).toBe("Needs you · Approve deploy");
	expect(opened.event.payload.face.body).toBe("ship it?");
	expect(opened.event.payload.face.tone).toBe("warning");
	expect(opened.event.payload.face.pinned).toEqual({ agent: "unit-c", age: "just now" });
	const openedDay = new Date(opened.ts).toISOString().slice(0, 10);
	expect((await mgr.adoptionCounters()).roomInteractionsByDay[openedDay]).toBe(1);
	await mgr.appendChannelPost("ops", LOCAL_ACTOR, { text: "room steering" });
	expect((await mgr.adoptionCounters()).roomInteractionsByDay[openedDay]).toBe(2);

	const resolvedCard = waitForChannelEntry(mgr, DEFAULT_CHANNEL_ID, (entry) => entry.event?.kind === "needs-you" && isEventPayload(entry.event.payload) && entry.event.payload.face.pendingStatus === "resolved");
	await mgr.applyCommand({ type: "answer", id: dto.id, requestId: "gate_req-1", value: "yes" }, LOCAL_ACTOR);
	const resolved = await resolvedCard;
	expect(mgr.getAgent(dto.id)?.pending).toEqual([]);
	expect(isEventPayload(resolved.event?.payload)).toBe(true);
	if (!isEventPayload(resolved.event?.payload)) throw new Error("bad resolved payload");
	expect(resolved.id).not.toBe(opened.id);
	expect(resolved.event.payload.face.title).toBe("Resolved · Approve deploy");
	expect(resolved.event.payload.face.tone).toBe("success");
	expect(resolved.event.payload.face.detail).toContain("Original pending card remains unchanged");
	await mgr.stop();
});

test("plan revision candidates project plan cards with DAG door refs", async () => {
	const { mgr, host, repo } = await makeMgr("projection-plan-card");
	await createChannel(host, "ops");
	await fs.mkdir(path.join(repo, "plans", "the-room"), { recursive: true });
	await fs.writeFile(path.join(repo, "plans", "the-room", "01-a.md"), "# A\nSTATUS: open\n");
	await fs.writeFile(path.join(repo, "plans", "the-room", "02-b.md"), "# B\nSTATUS: open\n");
	const feature = mgr.createFeature({ title: "The room", repo, planDir: "plans/the-room" });
	const dto = await mgr.create({ name: "planner", repo, approvalMode: "yolo", channelId: "ops", autoRoute: false, featureId: feature.id });
	const projected = waitForChannelEntry(mgr, DEFAULT_CHANNEL_ID, (entry) => entry.event?.kind === TRANSCRIPT_EVENT_PLAN_CARD);

	const candidate = await mgr.addPlanRevisionCandidate({ repo, featureId: feature.id, planPath: "plans/the-room/01-a.md", producerAgentId: dto.id, summary: "split the door concern" });
	const card = await projected;

	expect(card.text).toContain("plan revision ready");
	expect(isEventPayload(card.event?.payload)).toBe(true);
	if (!isEventPayload(card.event?.payload)) throw new Error("bad plan-card payload");
	expect(card.event.payload.doorSurface).toBe("plan");
	expect(card.event.payload.refs.planId).toBe(feature.id);
	expect(card.event.payload.refs.planPath).toBe("plans/the-room/01-a.md");
	expect(card.event.payload.refs.candidateId).toBe(candidate.id);
	expect(card.event.payload.face.title).toBe("the-room");
	expect(card.event.payload.face.concernCount).toBe(2);
	expect(card.event.payload.face.pinned).toMatchObject({ concerns: 2, revision: "split the door concern" });
	await mgr.stop();
});

test("plan-surface save emits design-revised room card", async () => {
	const { mgr, host, repo } = await makeMgr("projection-design-revised");
	await createChannel(host, "ops");
	await fs.mkdir(path.join(repo, "plans", "the-room"), { recursive: true });
	await fs.writeFile(path.join(repo, "plans", "the-room", "01-a.md"), "# A\nSTATUS: open\n");
	const feature = mgr.createFeature({ title: "The room", repo, planDir: "plans/the-room" });
	await mgr.create({ name: "planner", repo, approvalMode: "yolo", channelId: "ops", autoRoute: false, featureId: feature.id });
	const projected = waitForChannelEntry(mgr, DEFAULT_CHANNEL_ID, (entry) => entry.event?.kind === TRANSCRIPT_EVENT_DESIGN_REVISED);

	const concern = await mgr.updateConcern(feature.id, { repo, file: "01-a.md", status: "done", blockedBy: [] }, LOCAL_ACTOR);
	const card = await projected;

	expect(concern?.status).toBe("done");
	expect(card.text).toContain("design revised");
	expect(card.event?.payload).toMatchObject({
		actor: LOCAL_ACTOR.id,
		featureId: feature.id,
		planPath: "01-a.md",
		doorSurface: "plan",
		face: { title: "Design revised", detail: "01-a.md" },
	});
	await mgr.stop();
});

test("projection is scoped to the manager org store", async () => {
	const a = await makeMgr("projection-org-a");
	const b = await makeMgr("projection-org-b");
	await createChannel(a.host, "ops");
	await createChannel(b.host, "ops");
	const dto = await a.mgr.create({ name: "unit-org-a", repo: a.repo, approvalMode: "yolo", channelId: "ops", autoRoute: false });
	const projected = waitForChannelEntry(a.mgr, DEFAULT_CHANNEL_ID, (entry) => entry.event?.kind === TRANSCRIPT_EVENT_GATE_VERDICT);

	a.host.emitUnitTranscriptEvent(dto.id, TRANSCRIPT_EVENT_GATE_VERDICT, "gate verdict · pass", { verdict: "pass" });
	await projected;
	expect((await a.mgr.channelEntries(DEFAULT_CHANNEL_ID)).map((entry) => entry.event?.kind)).toContain(TRANSCRIPT_EVENT_GATE_VERDICT);
	expect(await b.mgr.channelEntries("ops")).toHaveLength(0);
	await a.mgr.stop();
	await b.mgr.stop();
});

test("routine tool approvals never become room cards — only gate-class pendings do", async () => {
	// The defect this pins: over twelve hours of one real fleet run, #fleet accumulated 544 cards and
	// every single one was an `Allow tool: bash Command: …` permission prompt (plus its paired
	// "resolved" twin). 100% of the room's content was noise, zero proofs — the firehose DIRECTION.md's
	// near-empty needs-you law forbids. The lane still shows these; the room no longer records them.
	const { mgr, host, repo } = await makeMgr("projection-worthiness");
	await createChannel(host, "ops");
	const dto = await mgr.create({ name: "unit-noise", repo, approvalMode: "write", channelId: "ops", autoRoute: false });
	const rec = host.agents.get(dto.id);
	if (!rec) throw new Error("missing record");

	// Raise it, then resolve it. The lane and rail read AgentDTO.pending directly and are untouched by
	// this change; what must not happen is a permanent card — on either edge of the lifecycle.
	host.onUi(rec, { method: "confirm", id: "acpui_7", title: "Allow tool: bash", message: "Command: bun run check" } as RpcExtensionUIRequest);
	expect(await mgr.channelEntries("ops")).toEqual([]);
	await mgr.applyCommand({ type: "answer", id: dto.id, requestId: "acpui_7", value: "yes" }, LOCAL_ACTOR);
	expect(mgr.getAgent(dto.id)?.pending).toEqual([]);
	expect(await mgr.channelEntries("ops")).toEqual([]);

	// A gate-class request — the kind no supervisor may auto-answer — still earns its card.
	const gateCard = waitForChannelEntry(mgr, DEFAULT_CHANNEL_ID, (entry) => entry.event?.kind === "needs-you");
	host.onUi(rec, { method: "confirm", id: "acpui_8", title: "GATE: ship to production?", message: "3 services" } as RpcExtensionUIRequest);
	const card = await gateCard;
	expect(isEventPayload(card.event?.payload)).toBe(true);
	if (!isEventPayload(card.event?.payload)) throw new Error("bad payload");
	expect(card.event.payload.face.title).toBe("Needs you · GATE: ship to production?");
	await mgr.stop();
});

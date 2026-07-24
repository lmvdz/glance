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
import { TRANSCRIPT_EVENT_GATE_VERDICT, TRANSCRIPT_EVENT_LAND_ASSESSMENT, TRANSCRIPT_EVENT_PLAN_CARD } from "../src/transcript-event-kinds.ts";
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
	putChannel(channel: { id: string; name: string; createdAt: number; kind: "default" | "user" }): Promise<void>;
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
	await host.store.putChannel({ id, name: `#${id}`, createdAt: Date.now(), kind: "user" });
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
	await mgr.stop();
});

test("origin channel receives full lifecycle pointer-cards with pinned refs and face", async () => {
	const { mgr, host, repo } = await makeMgr("projection-origin");
	await createChannel(host, "room-a");
	const dto = await mgr.create({ name: "unit-a", repo, approvalMode: "yolo", channelId: "room-a", autoRoute: false });
	const projected = waitForChannelEntry(mgr, "room-a", (entry) => entry.event?.kind === TRANSCRIPT_EVENT_LAND_ASSESSMENT);

	host.emitUnitTranscriptEvent(dto.id, TRANSCRIPT_EVENT_LAND_ASSESSMENT, "land assessment · rejected", { stage: "rejected", agentId: dto.id, secret: `sk-${"a".repeat(20)}` });
	const card = await projected;

	expect(card.authorActor).toBe("manager");
	expect(card.event?.issuer).toBe("manager");
	expect(card.channelId).toBe("room-a");
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

test("unbound units project only fleet-default card kinds", async () => {
	const { mgr, host, repo } = await makeMgr("projection-fleet-filter");
	const dto = await mgr.create({ name: "unit-b", repo, approvalMode: "yolo", autoRoute: false });

	host.emitUnitTranscriptEvent(dto.id, TRANSCRIPT_EVENT_LAND_ASSESSMENT, "land assessment · rejected", { stage: "rejected" });
	expect(await mgr.channelEntries(DEFAULT_CHANNEL_ID)).toHaveLength(0);

	const projected = waitForChannelEntry(mgr, DEFAULT_CHANNEL_ID, (entry) => entry.event?.kind === TRANSCRIPT_EVENT_GATE_VERDICT);
	host.emitUnitTranscriptEvent(dto.id, TRANSCRIPT_EVENT_GATE_VERDICT, "gate verdict · pass", { verdict: "pass" });
	const card = await projected;
	expect(card.event?.kind).toBe(TRANSCRIPT_EVENT_GATE_VERDICT);
	expect(card.authorActor).toBe("manager");
	await mgr.stop();
});

test("pending request and room card are one needs-you substrate and both resolve", async () => {
	const { mgr, host, repo } = await makeMgr("projection-needs-you");
	await createChannel(host, "ops");
	const dto = await mgr.create({ name: "unit-c", repo, approvalMode: "yolo", channelId: "ops", autoRoute: false });
	const rec = host.agents.get(dto.id);
	if (!rec) throw new Error("missing record");

	const pendingCard = waitForChannelEntry(mgr, "ops", (entry) => entry.event?.kind === "needs-you");
	host.onUi(rec, { method: "confirm", id: "req-1", title: "Approve deploy", message: "ship it?" } as RpcExtensionUIRequest);
	const opened = await pendingCard;
	expect(mgr.getAgent(dto.id)?.pending.map((request) => request.id)).toEqual(["req-1"]);
	expect(isEventPayload(opened.event?.payload)).toBe(true);
	if (!isEventPayload(opened.event?.payload)) throw new Error("bad open payload");
	expect(opened.event.payload.face.pendingStatus).toBe("pending");
	expect(opened.event.payload.face.pendingId).toBe("req-1");

	const resolvedCard = waitForChannelEntry(mgr, "ops", (entry) => entry.event?.kind === "needs-you" && isEventPayload(entry.event.payload) && entry.event.payload.face.pendingStatus === "resolved");
	await mgr.applyCommand({ type: "answer", id: dto.id, requestId: "req-1", value: "yes" }, LOCAL_ACTOR);
	const resolved = await resolvedCard;
	expect(mgr.getAgent(dto.id)?.pending).toEqual([]);
	expect(isEventPayload(resolved.event?.payload)).toBe(true);
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
	const projected = waitForChannelEntry(mgr, "ops", (entry) => entry.event?.kind === TRANSCRIPT_EVENT_PLAN_CARD);

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

test("projection is scoped to the manager org store", async () => {
	const a = await makeMgr("projection-org-a");
	const b = await makeMgr("projection-org-b");
	await createChannel(a.host, "ops");
	await createChannel(b.host, "ops");
	const dto = await a.mgr.create({ name: "unit-org-a", repo: a.repo, approvalMode: "yolo", channelId: "ops", autoRoute: false });
	const projected = waitForChannelEntry(a.mgr, "ops", (entry) => entry.event?.kind === TRANSCRIPT_EVENT_GATE_VERDICT);

	a.host.emitUnitTranscriptEvent(dto.id, TRANSCRIPT_EVENT_GATE_VERDICT, "gate verdict · pass", { verdict: "pass" });
	await projected;
	expect(await a.mgr.channelEntries("ops")).toHaveLength(1);
	expect(await b.mgr.channelEntries("ops")).toHaveLength(0);
	await a.mgr.stop();
	await b.mgr.stop();
});

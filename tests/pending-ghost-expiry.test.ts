/**
 * Ghost expiry for replayed pendings (#lifecycle-truth concern 04): the agent-host's ring replay on
 * warm reattach already rebuilds pending with live, answerable correlation ids — but it can also
 * resurrect an already-answered (pre-crash) question, which would otherwise permanently wedge
 * applyState's reconciliation at "input". Pendings added during the settle window are tagged
 * replayed:true; two independent rules expire them: (a) a live post-settle agent_end turn boundary,
 * (b) two consecutive isStreaming===false applyState polls. Neither rule ever touches a live
 * (non-replayed) pending.
 */

import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SubagentTracker } from "../src/subagents.ts";
import type { AgentDTO, AgentStatus, PendingRequest, PersistedAgent, RpcExtensionUIRequest, RpcSessionState } from "../src/types.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

// Isolate ghost-expiry from the unrelated auto-answer feature — save/restore so this doesn't leak into
// other test files sharing the same bun test process (they run in one process; a global env mutation
// left unrestored silently breaks e.g. lifecycle-settle-gate.test.ts's own auto-supervise assertions).
const savedAutoSupervise = process.env.OMP_SQUAD_AUTOSUPERVISE;
process.env.OMP_SQUAD_AUTOSUPERVISE = "0";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
	if (savedAutoSupervise === undefined) delete process.env.OMP_SQUAD_AUTOSUPERVISE;
	else process.env.OMP_SQUAD_AUTOSUPERVISE = savedAutoSupervise;
});

async function freshStateDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pending-ghost-expiry-"));
	tmps.push(dir);
	return dir;
}

/** Models agent-host's synchronous ring replay: emits one blocking `ui` frame from inside start(),
 *  before it resolves — exactly like lifecycle-settle-gate.test.ts's ReplayDriver. */
class ReplayUiDriver extends EventEmitter implements AgentDriver {
	ready = false;
	alive = false;
	get isReady(): boolean {
		return this.ready;
	}
	get isAlive(): boolean {
		return this.alive;
	}
	async start(): Promise<void> {
		this.emit("ui", { type: "extension_ui_request", method: "confirm", id: "replay-confirm", title: "confirm?", message: "replayed?" } satisfies RpcExtensionUIRequest);
		this.ready = true;
		this.alive = true;
	}
	async stop(): Promise<void> {
		this.alive = false;
		this.ready = false;
	}
	async prompt(): Promise<void> {}
	async abort(): Promise<unknown> {
		return undefined;
	}
	async getState(): Promise<RpcSessionState> {
		return {} as RpcSessionState;
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

interface DriverFactoryHost {
	makeDriver: (p: PersistedAgent) => AgentDriver;
}

interface TransitionLogEntry {
	agentId: string;
	from: string;
	to: string;
	reason: string;
	at: number;
	cause?: Record<string, unknown>;
	denied?: boolean;
}

interface GhostExpiryHost {
	attachExisting: (p: PersistedAgent, transcript?: unknown[]) => Promise<void>;
	transitionLog: { recent: () => TransitionLogEntry[] };
	onUi: (rec: unknown, req: RpcExtensionUIRequest) => void;
	onAgentEvent: (rec: unknown, frame: { type?: string; [k: string]: unknown }) => void;
	agents: Map<string, { dto: AgentDTO }>;
}

test("a pending rebuilt during the settle window is tagged replayed:true; a live pending never is", async () => {
	const stateDir = await freshStateDir();
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	const driver = new ReplayUiDriver();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => driver;
	const host = mgr as unknown as GhostExpiryHost;

	const persisted: PersistedAgent = { id: "ghost-agent", name: "chat", repo: "(none)", worktree: "(none)", approvalMode: "yolo" };
	await host.attachExisting(persisted, []);

	const rec = host.agents.get(persisted.id)!;
	const replayedEntry = rec.dto.pending.find((p) => p.id === "replay-confirm");
	expect(replayedEntry?.replayed).toBe(true);

	// A fresh, live pending added AFTER settling closes must NOT be tagged replayed.
	host.onUi(rec, { type: "extension_ui_request", method: "confirm", id: "live-confirm", title: "for real this time?", message: "" } satisfies RpcExtensionUIRequest);
	const liveEntry = rec.dto.pending.find((p) => p.id === "live-confirm");
	expect(liveEntry?.replayed).toBeUndefined();

	await mgr.stop();
});

test("a live post-settle agent_end turn boundary expires a ghost-only pending, recording a transition + transcript note", async () => {
	const stateDir = await freshStateDir();
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	const driver = new ReplayUiDriver();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => driver;
	const host = mgr as unknown as GhostExpiryHost;

	const persisted: PersistedAgent = { id: "ghost-agent-2", name: "chat", repo: "(none)", worktree: "(none)", approvalMode: "yolo" };
	await host.attachExisting(persisted, []);
	const rec = host.agents.get(persisted.id)!;
	expect(rec.dto.pending.find((p) => p.id === "replay-confirm")?.replayed).toBe(true);
	expect(rec.dto.status).toBe("input"); // derived: the (still-open) replayed pending blocks on input

	host.onAgentEvent(rec, { type: "agent_end" });

	expect(rec.dto.pending.some((p) => p.id === "replay-confirm")).toBe(false); // ghost expired
	expect(rec.dto.status).toBe("idle"); // pending drained to empty -> derive() flips input -> idle

	const transcript = (mgr as unknown as { getTranscript: (id: string) => { text: string }[] }).getTranscript(persisted.id);
	expect(transcript.some((t) => t.text.includes("stale question expired"))).toBe(true);

	// input -> idle is a distinct-state transition, so it's recorded regardless of "pending-cancel"
	// being a derived reason (only a SAME-state derived call is a silent hot-path no-op).
	const log = host.transitionLog.recent().filter((e) => e.agentId === persisted.id);
	const expiryEntry = log.find((e) => e.reason === "pending-cancel" && e.from === "input" && e.to === "idle" && e.denied === undefined);
	expect(expiryEntry).toBeDefined();

	await mgr.stop();
});

test("agent_end's expiry never touches a live (non-replayed) pending alongside the ghost", async () => {
	const stateDir = await freshStateDir();
	const mgr = new SquadManager({ stateDir });
	await mgr.start();
	const driver = new ReplayUiDriver();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => driver;
	const host = mgr as unknown as GhostExpiryHost;

	const persisted: PersistedAgent = { id: "ghost-agent-3", name: "chat", repo: "(none)", worktree: "(none)", approvalMode: "yolo" };
	await host.attachExisting(persisted, []);
	const rec = host.agents.get(persisted.id)!;
	expect(rec.dto.pending.find((p) => p.id === "replay-confirm")?.replayed).toBe(true);

	// A genuinely live question, added after settling closes — must survive the expiry below.
	host.onUi(rec, { type: "extension_ui_request", method: "confirm", id: "live-confirm-3", title: "for real this time?", message: "" } satisfies RpcExtensionUIRequest);

	host.onAgentEvent(rec, { type: "agent_end" });

	expect(rec.dto.pending.some((p) => p.id === "replay-confirm")).toBe(false); // ghost expired
	expect(rec.dto.pending.some((p) => p.id === "live-confirm-3")).toBe(true); // live pending untouched
	expect(rec.dto.status).toBe("input"); // the surviving live pending still blocks on input

	const transcript = (mgr as unknown as { getTranscript: (id: string) => { text: string }[] }).getTranscript(persisted.id);
	expect(transcript.some((t) => t.text.includes("stale question expired"))).toBe(true); // never silent either way

	await mgr.stop();
});

interface ApplyStateHost {
	applyState: (rec: unknown, state: RpcSessionState) => void;
}

const SubsFor = (): SubagentTracker => new SubagentTracker();

function bareRec(id: string, pending: PendingRequest[]): { dto: AgentDTO; streaming: boolean; nonStreamingPolls?: number; subs: SubagentTracker; transcript: unknown[]; toolEntries: Map<string, unknown>; assistantBuf: string; thinkingBuf: string; agent: AgentDriver; options: PersistedAgent } {
	const dto: AgentDTO = {
		id,
		name: id,
		status: "input",
		kind: "omp-operator",
		repo: "/r",
		worktree: "/r",
		approvalMode: "yolo",
		pending,
		lastActivity: 0,
		messageCount: 0,
	};
	return {
		dto,
		streaming: false,
		subs: SubsFor(),
		transcript: [],
		toolEntries: new Map(),
		assistantBuf: "",
		thinkingBuf: "",
		agent: new ReplayUiDriver(),
		options: { id, name: id, repo: "/r", worktree: "/r", approvalMode: "yolo" },
	};
}

const streamState = (isStreaming: boolean): RpcSessionState => ({ todoPhases: [], isStreaming }) as RpcSessionState;

test("applyState's poll-based fallback expires a replayed ghost after two consecutive non-streaming polls, not one", async () => {
	const stateDir = await freshStateDir();
	const mgr = new SquadManager({ stateDir });
	const host = mgr as unknown as ApplyStateHost;

	const ghost: PendingRequest = { id: "ghost1", source: "ui", kind: "confirm", title: "stale?", createdAt: Date.now(), replayed: true };
	const rec = bareRec("poll-agent", [ghost]);

	host.applyState(rec, streamState(false));
	expect(rec.dto.pending.some((p) => p.id === "ghost1")).toBe(true); // first non-streaming poll: not yet expired

	host.applyState(rec, streamState(false));
	expect(rec.dto.pending.some((p) => p.id === "ghost1")).toBe(false); // second consecutive poll: expired

	await mgr.stop();
});

test("applyState's poll-based fallback resets its counter on a streaming poll (needs two CONSECUTIVE non-streaming polls)", async () => {
	const stateDir = await freshStateDir();
	const mgr = new SquadManager({ stateDir });
	const host = mgr as unknown as ApplyStateHost;

	const ghost: PendingRequest = { id: "ghost1", source: "ui", kind: "confirm", title: "stale?", createdAt: Date.now(), replayed: true };
	const rec = bareRec("poll-agent-2", [ghost]);

	host.applyState(rec, streamState(false)); // 1
	host.applyState(rec, streamState(true)); // resets the counter
	host.applyState(rec, streamState(false)); // 1 again, not 2 — not consecutive
	expect(rec.dto.pending.some((p) => p.id === "ghost1")).toBe(true);

	await mgr.stop();
});

test("applyState's poll fallback never touches a live (non-replayed) pending, regardless of poll count", async () => {
	const stateDir = await freshStateDir();
	const mgr = new SquadManager({ stateDir });
	const host = mgr as unknown as ApplyStateHost;

	const live: PendingRequest = { id: "live1", source: "ui", kind: "confirm", title: "real question", createdAt: Date.now() }; // no replayed flag
	const rec = bareRec("live-agent", [live]);

	for (let i = 0; i < 5; i++) host.applyState(rec, streamState(false));

	expect(rec.dto.pending.some((p) => p.id === "live1")).toBe(true); // never expired — not tagged replayed

	await mgr.stop();
});

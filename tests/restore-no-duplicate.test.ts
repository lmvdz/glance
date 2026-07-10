/**
 * `--restore` must not re-create records `start()` already reattached.
 *
 * THE ROSTER WAS BREEDING AT BOOT. `start()` runs first: `reconnectLive`/`adoptOrphanedAgents` reattach
 * persisted records VERBATIM, keyed by their original id (`reconnectLive` has exactly this guard). Then
 * `glance up --restore` calls `loadPersisted()`, which walked the SAME persisted list and `create()`d each
 * record under a FRESH id. Every reattached record got a twin — and the twin was persisted too, so the
 * next `--restore` doubled again.
 *
 * Observed live on the operator's daemon: a single `ompsq-445` became two rows after one bounce and four
 * after the next, each pair a terminal-marked workflow reattached verbatim alongside a freshly-minted
 * duplicate. The dispatcher was innocent — its ledger correctly reports `has(issue.id) === true` for that
 * ticket, and its automation events say `skipReason: already-handled` on every tick.
 *
 * `create()` is stubbed: the real one spawns an agent host.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SubagentTracker } from "../src/subagents.ts";
import type { AgentDTO, CreateAgentOptions, PersistedAgent } from "../src/types.ts";

const { SquadManager } = await import("../src/squad-manager.ts");

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function tmpDir(prefix: string): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(d);
	return d;
}

const persisted = (id: string, name: string): PersistedAgent =>
	({ id, name, repo: "/srv/app", worktree: `/srv/wt/${id}`, approvalMode: "yolo", kind: "omp-operator" }) as PersistedAgent;

/** Write the FileStore snapshot `loadPersisted()` reads. */
async function writeSnapshot(stateDir: string, agents: PersistedAgent[]): Promise<void> {
	await fs.writeFile(path.join(stateDir, "state.json"), JSON.stringify({ agents, features: [], capabilities: {} }));
}

// ── the defect ──────────────────────────────────────────────────────────────────────────────────

test("a record already reattached by start() is NOT re-created under a fresh id", async () => {
	const stateDir = await tmpDir("restore-dup-");
	const zombie = persisted("ompsq-445-old", "ompsq-445");
	await writeSnapshot(stateDir, [zombie]);

	const mgr = new (class extends SquadManager {
		created: string[] = [];
		override async create(opts: CreateAgentOptions): Promise<AgentDTO> {
			this.created.push(opts.name);
			return { id: `${opts.name}-fresh`, name: opts.name } as AgentDTO;
		}
		seedResident(p: PersistedAgent): void {
			const dto = { id: p.id, name: p.name, status: "error", kind: "omp-operator", repo: p.repo, worktree: p.worktree, approvalMode: "yolo", pending: [], lastActivity: 0, messageCount: 0 } as unknown as AgentDTO;
			this.agents.set(p.id, { dto, agent: undefined as never, options: p, transcript: [], assistantBuf: "", streaming: false, subs: new SubagentTracker(), toolEntries: new Map() } as never);
		}
	})({ stateDir } as never);

	mgr.seedResident(zombie); // what start()'s reconnectLive/reattachTerminal does
	const restored = await mgr.loadPersisted();

	expect(mgr.created).toEqual([]); // before the fix: ["ompsq-445"] — a twin under a fresh id
	expect(restored).toBe(0);
	expect(mgr.agents.size).toBe(1); // one row, keyed by its ORIGINAL id
	expect([...mgr.agents.keys()]).toEqual(["ompsq-445-old"]);
});

test("a record that start() did NOT reattach is still restored — the flag keeps working", async () => {
	const stateDir = await tmpDir("restore-live-");
	await writeSnapshot(stateDir, [persisted("gone-1", "gone")]);

	const mgr = new (class extends SquadManager {
		created: string[] = [];
		override async create(opts: CreateAgentOptions): Promise<AgentDTO> {
			this.created.push(opts.name);
			return { id: "gone-fresh", name: opts.name } as AgentDTO;
		}
	})({ stateDir } as never);

	const restored = await mgr.loadPersisted();
	expect(mgr.created).toEqual(["gone"]); // nothing resident ⇒ restore does its job
	expect(restored).toBe(1);
});

/** The compounding shape: bounce, bounce, bounce. Each `--restore` used to double the row. */
test("repeated restores do not multiply a resident record", async () => {
	const stateDir = await tmpDir("restore-compound-");
	const zombie = persisted("z-1", "ompsq-445");
	await writeSnapshot(stateDir, [zombie]);

	const mgr = new (class extends SquadManager {
		created: string[] = [];
		override async create(opts: CreateAgentOptions): Promise<AgentDTO> {
			this.created.push(opts.name);
			return { id: `${opts.name}-${this.created.length}`, name: opts.name } as AgentDTO;
		}
		seedResident(p: PersistedAgent): void {
			const dto = { id: p.id, name: p.name, status: "error", kind: "omp-operator", repo: p.repo, worktree: p.worktree, approvalMode: "yolo", pending: [], lastActivity: 0, messageCount: 0 } as unknown as AgentDTO;
			this.agents.set(p.id, { dto, agent: undefined as never, options: p, transcript: [], assistantBuf: "", streaming: false, subs: new SubagentTracker(), toolEntries: new Map() } as never);
		}
	})({ stateDir } as never);

	mgr.seedResident(zombie);
	await mgr.loadPersisted();
	await mgr.loadPersisted();
	await mgr.loadPersisted();

	expect(mgr.created).toEqual([]);
	expect(mgr.agents.size).toBe(1); // before the fix: 1 → 2 → 4 → 8
});

/** `createWithId` catches a driver/handshake failure, marks the record `error`, and RESOLVES with that
 *  DTO rather than rejecting. A bare `.then()` counted it, so the boot banner printed
 *  "restored 1 agent(s)" over a corpse. Found by cross-lineage review (gpt-5.6-sol). */
test("a restore whose agent fails to start is NOT counted as restored", async () => {
	const stateDir = await tmpDir("restore-errdto-");
	await writeSnapshot(stateDir, [persisted("dead-1", "dead")]);

	const mgr = new (class extends SquadManager {
		override async create(opts: CreateAgentOptions): Promise<AgentDTO> {
			// exactly what createWithId does when start() throws: resolve with an error DTO
			return { id: "dead-fresh", name: opts.name, status: "error", error: "host did not come up" } as AgentDTO;
		}
	})({ stateDir } as never);

	const restored = await mgr.loadPersisted();
	expect(restored).toBe(0); // before the fix: 1 — a corpse counted as a restore
});

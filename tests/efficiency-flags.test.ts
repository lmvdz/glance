/**
 * plans/eap-borrows concern 02 (delivery-confirmed efficiencyFlags): SquadManager#create integration —
 * proves the split-then-confirm wiring at the point it's actually decided (spawn time), on top of the
 * pure-function coverage in receipts.test.ts. A profile's `membrane:*` capability tokens never enter
 * `toolGrants` (isolation) and only survive onto `AgentRecord.efficiencyFlags` — which feeds 1:1 into
 * the RunSeed and then the receipt (receipts.test.ts proves that leg) — when the resolved harness's
 * `contextInjection` is `"native"`. An ACP harness (`contextInjection:"none"`) requests the same token
 * and gets nothing: the exact "measures signal, not placebo" invariant the concern doc names.
 */

import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDriver } from "../src/agent-driver.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { AgentDTO, PersistedAgent, RpcSessionState } from "../src/types.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const tmps: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
function stashEnv(...keys: string[]): void {
	for (const k of keys) savedEnv[k] = process.env[k];
}
afterEach(async () => {
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	for (const k of Object.keys(savedEnv)) delete savedEnv[k];
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

class FakeDriver extends EventEmitter implements AgentDriver {
	readonly isReady = true;
	readonly isAlive = true;
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async prompt(): Promise<void> {}
	async abort(): Promise<unknown> {
		return undefined;
	}
	async getState(): Promise<RpcSessionState> {
		return { todoPhases: [], isStreaming: false } as RpcSessionState;
	}
	respondUi(): void {}
	respondHostTool(): void {}
}

interface DriverFactoryHost {
	makeDriver: (p: PersistedAgent, cold?: boolean) => AgentDriver;
}
interface AgentRecordLike {
	dto: AgentDTO;
	toolGrants?: string[];
	efficiencyFlags?: string[];
}
interface InternalHost {
	agents: Map<string, AgentRecordLike>;
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

async function makeMgr(prefix: string): Promise<{ mgr: SquadManager; repo: string }> {
	const repo = await makeRepo(`${prefix}-repo-`);
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-state-`));
	const worktreeBase = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-wt-`));
	tmps.push(stateDir, worktreeBase);
	const mgr = new SquadManager({ stateDir, worktreeBase });
	await mgr.start();
	(mgr as unknown as DriverFactoryHost).makeDriver = () => new FakeDriver();
	return { mgr, repo };
}

test("native harness (default omp): a membrane token confirms — AgentRecord.efficiencyFlags carries it, toolGrants stays isolated", async () => {
	// eap-borrows concern 05 added double gate #2 (OMP_SQUAD_MEMBRANE_PROFILES) between the raw
	// capabilities-derived "requested" set and both the delivery confirmation and the prompt injection —
	// gate #2 must be on for the same membrane token this test names to actually confirm.
	stashEnv("OMP_SQUAD_PROFILES", "OMP_SQUAD_MEMBRANE_PROFILES");
	process.env.OMP_SQUAD_PROFILES = JSON.stringify([{ id: "native-membrane", name: "Native membrane", capabilities: ["read", "membrane:verdict-first"] }]);
	process.env.OMP_SQUAD_MEMBRANE_PROFILES = "1";
	const { mgr, repo } = await makeMgr("eff-native");
	const dto = await mgr.create({ name: "u", repo, profileId: "native-membrane", approvalMode: "yolo", autoRoute: false });
	expect(dto.harnessCaps?.contextInjection).toBe("native");
	const rec = (mgr as unknown as InternalHost).agents.get(dto.id)!;
	expect(rec.efficiencyFlags).toEqual(["membrane:verdict-first"]);
	expect(rec.toolGrants).toEqual(["read"]); // the membrane token never leaked into the tool allow-list
	await mgr.stop();
});

test("ACP-none harness (opencode): the SAME membrane token is requested but not delivered — no flag, ever", async () => {
	stashEnv("OMP_SQUAD_PROFILES");
	process.env.OMP_SQUAD_PROFILES = JSON.stringify([{ id: "acp-membrane", name: "ACP membrane", harness: "opencode", capabilities: ["read", "membrane:verdict-first"] }]);
	const { mgr, repo } = await makeMgr("eff-acp-none");
	const dto = await mgr.create({ name: "u", repo, profileId: "acp-membrane", approvalMode: "yolo", autoRoute: false });
	expect(dto.harnessCaps?.contextInjection).toBe("none");
	const rec = (mgr as unknown as InternalHost).agents.get(dto.id)!;
	expect(rec.efficiencyFlags).toBeUndefined(); // requested, never confirmed — no placebo stamp
	expect(rec.toolGrants).toEqual(["read"]); // real tool grant is unaffected by the drop
	await mgr.stop();
});

test("a profile with only real tool capabilities (no membrane tokens) is byte-for-byte unaffected", async () => {
	stashEnv("OMP_SQUAD_PROFILES");
	process.env.OMP_SQUAD_PROFILES = JSON.stringify([{ id: "plain", name: "Plain", capabilities: ["read", "bash"] }]);
	const { mgr, repo } = await makeMgr("eff-plain");
	const dto = await mgr.create({ name: "u", repo, profileId: "plain", approvalMode: "yolo", autoRoute: false });
	const rec = (mgr as unknown as InternalHost).agents.get(dto.id)!;
	expect(rec.toolGrants).toEqual(["read", "bash"]);
	expect(rec.efficiencyFlags).toBeUndefined();
	await mgr.stop();
});

test("no profile at all: no toolGrants, no efficiencyFlags — unscoped default is unchanged", async () => {
	const { mgr, repo } = await makeMgr("eff-noprofile");
	const dto = await mgr.create({ name: "u", repo, approvalMode: "yolo", autoRoute: false });
	const rec = (mgr as unknown as InternalHost).agents.get(dto.id)!;
	expect(rec.toolGrants).toBeUndefined();
	expect(rec.efficiencyFlags).toBeUndefined();
	await mgr.stop();
});

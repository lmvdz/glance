/**
 * rm-doesn't-stick, layer 3: a DB-mode daemon with a root factory (OMP_SQUAD_ROOT_FACTORY=1) plus
 * an org-scoped `ManagerRegistry` fleet. `managerFor(actor)` (via `fleetForOrg`) hard-codes the
 * on-box loopback bootstrap-admin identity to the root factory's org id (`ROOT_FACTORY_ORG`), so
 * EVERY mutating command from that identity — not just `rm` — always dispatched to the root
 * manager, even one naming an agent that actually lives on a different, live org manager.
 * `resolveRemovalId` then missed it in the root's own live roster AND persisted store, fell back to
 * tombstoning the raw identifier in the ROOT's ledger, and reported `{ ok: true }` — a no-op that
 * looked like it worked. Live evidence: agent ompsq-432 survived two `rm` rounds post-#117 with the
 * identical id; the root's removed-agents.json held the tombstone while the owning org manager's
 * ledger (and live roster) never saw it.
 *
 * This file exercises the fix (`SquadServer#resolveCommandManager`) through the REAL command path —
 * an HTTP POST to /api/command, exactly like the CLI's `glance rm` — against REAL `SquadManager`
 * instances (not fakes) so the tombstone assertions are against actual on-disk removed-agents.json
 * ledgers, not mocked behavior. Every manager here is real: if the fix regressed and a command still
 * routed to the wrong manager, that manager's OWN real ledger would show it.
 */
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileStore } from "../src/dal/store.ts";
import { ManagerRegistry } from "../src/manager-registry.ts";
import { openRemovedLedger } from "../src/removed-ledger.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer, type AuthInstance } from "../src/server.ts";
import type { Actor, PersistedAgent, SquadEvent } from "../src/types.ts";

process.env.OMP_SQUAD_AUTODISPATCH = "0";

const cleanups: Array<() => Promise<void> | void> = [];
const tmps: string[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

const operator: Actor = { id: "test-op", origin: "local" };

async function makeRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "cmdrouting-repo-"));
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

/** A terminal-marked workflow record — `reconnectLive`'s `reattachTerminal` path reattaches these
 *  into the live roster on `start()` WITHOUT spawning a real agent process/driver, exactly the trick
 *  `tests/removed-agent-durable.test.ts` uses. Gives us a genuinely LIVE (resident, in `.list()`)
 *  agent under a cheap, hermetic manager. */
function terminalWorkflowRecord(id: string, name: string, repo: string, worktree: string): PersistedAgent {
	return {
		id,
		name,
		repo,
		worktree,
		approvalMode: "yolo",
		kind: "workflow",
		workflow: { path: "verify" },
		workflowState: {
			goal: "ship it",
			currentNode: "escalate",
			visits: { escalate: 2 },
			vars: {},
			index: 4,
			coldReentryCount: 0,
			rollup: [],
			terminal: { reason: 'node "escalate" exceeded its visit cap (2)', at: Date.now(), forkPoint: { runId: "run-1", seq: 4 } },
		},
	};
}

function seed(registry: ManagerRegistry, orgId: string, manager: SquadManager): void {
	const internals = registry as unknown as { managers: Map<string, { manager: SquadManager; listener: (e: SquadEvent) => void; lastUsed: number }> };
	internals.managers.set(orgId, { manager, listener: () => {}, lastUsed: Date.now() });
}

/** Two tenant sessions ("orgB-owner" / "orgC-owner", each admin-tier in their own org) plus the
 *  no-cookie bootstrap-admin bearer-token path (handled entirely outside this stub). */
function authStub(): AuthInstance {
	return {
		handler: async () => new Response("not found", { status: 404 }),
		api: {
			getSession: async ({ headers }) => {
				const cookie = headers.get("cookie") ?? "";
				const match = /(?:^|;\s*)session=(orgB-owner|orgC-owner)(?:;|$)/.exec(cookie);
				if (!match) return null;
				const key = match[1] as "orgB-owner" | "orgC-owner";
				const orgId = key === "orgB-owner" ? "orgB" : "orgC";
				return { user: { id: `user-${key}`, name: key, email: `${key}@example.test` }, session: { activeOrganizationId: orgId } };
			},
			// "owner" ⇒ admin tier (bridgeRole) — needed since "remove" is admin-only (commandTier).
			getActiveMemberRole: async () => ({ role: "owner" }),
		},
	};
}

interface Fixture {
	url: string;
	token: string;
	orgBStateDir: string;
	orgCStateDir: string;
	rootStateDir: string;
	realId: string;
	name: string;
}

/** Boots a real SquadServer with THREE real `SquadManager`s: the root factory (`singleManager`,
 *  empty), org B (seeded with the live target agent), and org C (empty tenant, for the isolation
 *  test). Org managers are seeded directly into the registry (bypassing `ManagerRegistry`'s lazy
 *  `create()`, exactly like `tests/routing.test.ts`/`tests/ws-org-isolation.test.ts`) so they're
 *  "live" (materialized) from the server's very first request — matching the observed incident,
 *  where the org manager WAS live (visible in the GET /api/agents union) yet `rm` still missed it. */
async function startedFixture(): Promise<Fixture> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cmdrouting-"));
	tmps.push(dir);
	const repo = await makeRepo();
	const rootStateDir = path.join(dir, "root");
	const orgBStateDir = path.join(dir, "orgs", "orgB");
	const orgCStateDir = path.join(dir, "orgs", "orgC");
	const orgBWorktreeBase = path.join(orgBStateDir, "worktrees");

	const realId = "ompsq-432-mrbo78og-1-9bdd2ef8";
	const name = "ompsq-432";
	await new FileStore(orgBStateDir).save({ agents: [terminalWorkflowRecord(realId, name, repo, path.join(orgBWorktreeBase, "stuck"))], transcripts: {}, features: [] });

	const rootManager = new SquadManager({ stateDir: rootStateDir, worktreeBase: path.join(rootStateDir, "worktrees") });
	const orgBManager = new SquadManager({ stateDir: orgBStateDir, worktreeBase: orgBWorktreeBase });
	const orgCManager = new SquadManager({ stateDir: orgCStateDir, worktreeBase: path.join(orgCStateDir, "worktrees") });
	await Promise.all([rootManager.start(), orgBManager.start(), orgCManager.start()]);
	expect(orgBManager.list().some((a) => a.id === realId)).toBe(true); // sanity: genuinely live before any command
	expect(rootManager.list()).toEqual([]); // sanity: the root factory never had this agent

	const registry = new ManagerRegistry({ root: dir, store: (orgId) => new FileStore(path.join(dir, "orgs", orgId)), operator });
	seed(registry, "orgB", orgBManager);
	seed(registry, "orgC", orgCManager);

	const token = "bootstrap-admin-token-xxxxxxxx";
	const server = new SquadServer(rootManager, { port: 0, auth: authStub(), registry, token });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await Promise.all([rootManager.stop(), orgBManager.stop(), orgCManager.stop()]);
	});
	return { url, token, orgBStateDir, orgCStateDir, rootStateDir, realId, name };
}

async function removeCmd(url: string, headers: HeadersInit, id: string): Promise<Response> {
	return fetch(`${url}/api/command`, {
		method: "POST",
		headers: { ...headers, "content-type": "application/json" },
		body: JSON.stringify({ type: "remove", id, deleteWorktree: false }),
	});
}

test("bootstrap-admin rm by NAME reaches the agent's actual owning org manager (not the root factory) and durably tombstones it there", async () => {
	const { url, token, orgBStateDir, rootStateDir, realId, name } = await startedFixture();

	const res = await removeCmd(url, { authorization: `Bearer ${token}` }, name);
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({ ok: true });

	// THE FIX: the record's real id is tombstoned in ORG B's ledger (the actual owner) — not a phantom
	// tombstone for the raw name landing in the root's ledger while orgB's record silently survives.
	expect(openRemovedLedger(orgBStateDir).has(realId)).toBe(true);
	// The root factory's OWN ledger — where the pre-fix bug tombstoned the raw, unresolved name
	// (`resolveRemovalId` missing it in the root's own roster/store) — must stay untouched: the
	// command never reached the root manager at all once its true owner was found.
	expect(openRemovedLedger(rootStateDir).has(name)).toBe(false);
	expect(openRemovedLedger(rootStateDir).has(realId)).toBe(false);
});

test("bootstrap-admin rm actually removes the live record from its owning manager's roster (GET /api/agents union reflects it)", async () => {
	const { url, token, realId, name } = await startedFixture();
	await removeCmd(url, { authorization: `Bearer ${token}` }, name);

	const roster = (await (await fetch(`${url}/api/agents`, { headers: { authorization: `Bearer ${token}` } })).json()) as Array<{ id: string }>;
	expect(roster.some((a) => a.id === realId)).toBe(false);
});

test("bootstrap-admin can also route kill (not just remove) to the owning org manager — status flips on THAT manager's roster", async () => {
	const { url, token, realId } = await startedFixture();

	// `kill` sets the record's status to "stopped" (applyCommand's "kill" case) — a side effect only
	// observable if the command actually reached orgB's manager. Pre-fix, this landed on the (empty)
	// root manager's `this.agents.get(id)` miss and silently no-op'd, exactly like every other
	// id-gated command in the ClientCommand union — the roster would never show the transition.
	const res = await fetch(`${url}/api/command`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ type: "kill", id: realId }),
	});
	expect(res.status).toBe(200);

	const roster = (await (await fetch(`${url}/api/agents`, { headers: { authorization: `Bearer ${token}` } })).json()) as Array<{ id: string; status: string }>;
	expect(roster.find((a) => a.id === realId)?.status).toBe("stopped");
});

test("a tenant session confined to org B (the actual owner) can rm its own agent — same result as before this fix", async () => {
	const { url, orgBStateDir, realId, name } = await startedFixture();

	// A real session's own org (`orgB`) IS orgB's manager via the untouched, pre-existing single-org
	// path (`fleetForOrg` resolves straight there) — `resolveCommandManager` is a no-op for a
	// non-bootstrap-admin actor, so this exercises that "unaffected" guarantee, not the cross-manager
	// search itself.
	const res = await removeCmd(url, { cookie: "session=orgB-owner" }, name);
	expect(res.status).toBe(200);
	expect(openRemovedLedger(orgBStateDir).has(realId)).toBe(true);
});

test("a tenant session confined to org C CANNOT rm an agent that lives on org B — isolation preserved, even by name", async () => {
	const { url, orgBStateDir, orgCStateDir, realId, name } = await startedFixture();

	// Org C's admin issues `rm` for the SAME bare name "ompsq-432" that lives on org B. A
	// non-bootstrap-admin actor never gets the cross-manager union — `managerFor` resolves straight to
	// org C's OWN manager, which has no such agent (live or persisted) and tombstones the raw,
	// unresolved name in ITS OWN ledger (the existing single-manager fallback, unaffected by this fix).
	const res = await removeCmd(url, { cookie: "session=orgC-owner" }, name);
	expect(res.status).toBe(200); // org C's own remove() never throws — it's a same-manager no-op, not a breach
	expect(openRemovedLedger(orgCStateDir).has(name)).toBe(true); // orgC's own (harmless, name-never-matched) fallback tombstone
	// The actual invariant: org B's real agent is completely untouched by org C's request.
	expect(openRemovedLedger(orgBStateDir).has(realId)).toBe(false);
});

test("bootstrap-admin rm for an id/name that is live in NO manager gets an honest 404, not a false ok:true", async () => {
	const { url, token, rootStateDir, orgBStateDir, orgCStateDir } = await startedFixture();

	const res = await removeCmd(url, { authorization: `Bearer ${token}` }, "totally-unknown-agent");
	expect(res.status).toBe(404);
	// Nothing was tombstoned anywhere as a side effect of the honest-not-found path.
	expect(openRemovedLedger(rootStateDir).has("totally-unknown-agent")).toBe(false);
	expect(openRemovedLedger(orgBStateDir).has("totally-unknown-agent")).toBe(false);
	expect(openRemovedLedger(orgCStateDir).has("totally-unknown-agent")).toBe(false);
});

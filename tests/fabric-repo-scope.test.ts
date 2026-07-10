/**
 * When a caller names its repos, the fabric must return facts from THOSE repos only.
 *
 * `decisions`, `failures`, `leases` and `scout` were repo-filtered. `agents`, `digests`, and the
 * receipts behind `hotAreas` were not — they were scoped by ACTOR (who may read) and never by REPO
 * (what was asked for). Two consequences, both live:
 *
 *   1. `/api/fabric?repo=A` listed repo B's agents and pasted repo B's digest into the Knowledge view.
 *   2. The cold-start primer asks for exactly one repo and BM25-ranks whatever comes back. A digest is a
 *      summary of source. So a unit spawned in repo A could receive repo B's summarized source in its
 *      system prompt — and in DB-root mode the two repos can belong to different organizations.
 *
 * Found by cross-lineage review (gpt-5.6-sol) of the R3 primer widening, which turned an unscoped read
 * that only ever reached the Knowledge view into one that reaches every spawned agent's system prompt.
 *
 * Fails closed: an unattributable digest (no live agent, no surviving receipt to name its repo) is
 * dropped when a repo filter is in force, rather than admitted on the assumption it belongs.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeDigest } from "../src/digest.ts";
import { buildFabricSnapshot } from "../src/fabric.ts";
import { appendReceipt } from "../src/receipts.ts";
import type { Actor, AgentDTO } from "../src/types.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

async function tmpDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fabric-scope-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	return dir;
}

const HUMAN: Actor = { id: "web:admin", origin: "local", role: "admin" };

function dto(id: string, repo: string): AgentDTO {
	return { id, name: id, repo, status: "idle", activity: "", worktree: `/wt/${id}` } as AgentDTO;
}

/** Two repos, each with one agent, one digest, one receipt. */
async function twoRepos(): Promise<{ dir: string; agents: AgentDTO[] }> {
	const dir = await tmpDir();
	await writeDigest(dir, "alpha", "## alpha: the retry budget lives in src/dispatch.ts");
	await writeDigest(dir, "beta", "## beta: PRIVATE — the customer key rotation schedule");
	await appendReceipt(dir, { agentId: "alpha", name: "alpha", repo: "/srv/alpha", runId: "r-a", startedAt: 900, endedAt: 950, status: "idle", toolCalls: 1, toolTally: {}, filesTouched: ["src/alpha.ts"] });
	await appendReceipt(dir, { agentId: "beta", name: "beta", repo: "/srv/beta", runId: "r-b", startedAt: 900, endedAt: 950, status: "idle", toolCalls: 1, toolTally: {}, filesTouched: ["src/secret.ts"] });
	return { dir, agents: [dto("alpha", "/srv/alpha"), dto("beta", "/srv/beta")] };
}

const snap = (dir: string, agents: AgentDTO[], repos?: string[]) =>
	buildFabricSnapshot({ actor: HUMAN, agents, stateDir: dir, repos, includeLeases: false, now: () => 1000 });

test("repos: [A] returns no fact from repo B", async () => {
	const { dir, agents } = await twoRepos();
	const s = await snap(dir, agents, ["/srv/alpha"]);

	expect(s.agents.map((a) => a.agent.id)).toEqual(["alpha"]);
	expect(s.digests.map((d) => d.source.agentId)).toEqual(["alpha"]);
	expect(s.hotAreas.map((h) => h.file)).toEqual(["src/alpha.ts"]);
});

/** The leak, stated as the thing a reader cares about: repo B's summarized source must never be
 *  reachable from a read scoped to repo A. */
test("repo B's digest text cannot be reached through a repo-A snapshot", async () => {
	const { dir, agents } = await twoRepos();
	const s = await snap(dir, agents, ["/srv/alpha"]);
	expect(JSON.stringify(s)).not.toContain("key rotation schedule");
});

test("and the same read from repo B's side cannot see repo A", async () => {
	const { dir, agents } = await twoRepos();
	const s = await snap(dir, agents, ["/srv/beta"]);
	expect(s.digests.map((d) => d.source.agentId)).toEqual(["beta"]);
	expect(JSON.stringify(s)).not.toContain("retry budget");
});

test("no repos named ⇒ unrestricted, exactly as before (the Knowledge view's default)", async () => {
	const { dir, agents } = await twoRepos();
	const s = await snap(dir, agents);
	expect(s.digests.map((d) => d.source.agentId).sort()).toEqual(["alpha", "beta"]);
	expect(s.hotAreas.length).toBe(2);
});

/** A trailing slash is the difference between "scoped" and "empty", and an empty primer is a silent
 *  failure — it looks exactly like "the fabric had nothing to say". Normalize both sides. */
test("a trailing slash still matches — the filter normalizes, it doesn't fail shut", async () => {
	const { dir, agents } = await twoRepos();
	const s = await snap(dir, agents, ["/srv/alpha/"]);
	expect(s.digests.map((d) => d.source.agentId)).toEqual(["alpha"]);
});

/** A digest whose agent left the roster AND whose receipt is gone has no provable repo. Under a filter
 *  we cannot show it: "probably repo A" is exactly the reasoning that leaks repo B. */
test("an unattributable digest is dropped under a filter, kept without one", async () => {
	const dir = await tmpDir();
	await writeDigest(dir, "orphan", "## a digest with no receipt and no live agent");

	expect((await snap(dir, [], ["/srv/alpha"])).digests).toEqual([]);
	expect((await snap(dir, [])).digests.map((d) => d.source.agentId)).toEqual(["orphan"]); // unrestricted: still visible
});

/** Historical facts must survive the roster (the Knowledge-view incident) — the repo filter must not
 *  quietly re-break that by requiring a LIVE agent to attribute a repo. The receipt names it. */
test("a completed agent's digest still passes the filter, attributed by its receipt", async () => {
	const dir = await tmpDir();
	await writeDigest(dir, "ghost", "## a since-removed agent's digest");
	await appendReceipt(dir, { agentId: "ghost", name: "ghost", repo: "/srv/alpha", runId: "r-g", startedAt: 100, endedAt: 150, status: "stopped", toolCalls: 1, toolTally: {}, filesTouched: ["src/ghost.ts"] });

	const s = await snap(dir, [], ["/srv/alpha"]); // zero live agents — the operator's normal state
	expect(s.digests.map((d) => d.source.agentId)).toEqual(["ghost"]);
	expect(s.hotAreas.map((h) => h.file)).toEqual(["src/ghost.ts"]);
});

/**
 * Attribution and inclusion are different questions. `latestRun` decides which repo a digest BELONGS to;
 * `inRepo` decides whether it may be shown. Answering both from the same repo-filtered receipt list leaks:
 * nothing binds `digests/<agentId>.md` to one repo forever, and only the LATEST receipt names its current
 * one. Filter first, and an agent id reused in repo B resolves to its stale repo-A receipt — so repo B's
 * digest is attributed to A and admitted. (gpt-5.6-sol; their own weakest finding, and it holds.)
 */
test("a reused agent id cannot smuggle repo B's digest into a repo-A snapshot", async () => {
	const dir = await tmpDir();
	// `x` ran in repo A long ago; it was reused in repo B, whose run overwrote the single digest file.
	await writeDigest(dir, "x", "## PRIVATE — repo B's key rotation schedule");
	await appendReceipt(dir, { agentId: "x", name: "x", repo: "/srv/alpha", runId: "old", startedAt: 100, endedAt: 150, status: "idle", toolCalls: 1, toolTally: {}, filesTouched: ["src/a.ts"] });
	await appendReceipt(dir, { agentId: "x", name: "x", repo: "/srv/beta", runId: "new", startedAt: 900, endedAt: 950, status: "idle", toolCalls: 1, toolTally: {}, filesTouched: ["src/secret.ts"] });

	const a = await snap(dir, [], ["/srv/alpha"]);
	expect(a.digests).toEqual([]); // the digest is repo B's — its latest run says so
	expect(JSON.stringify(a)).not.toContain("key rotation schedule");
	expect(a.hotAreas.map((h) => h.file)).toEqual(["src/a.ts"]); // repo-A file evidence still shows

	const b = await snap(dir, [], ["/srv/beta"]);
	expect(b.digests.map((d) => d.source.agentId)).toEqual(["x"]); // and it IS visible from repo B
});

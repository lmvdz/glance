/**
 * Done-write gating (concern 04), `issueAlreadyDone` SPLIT: the skip-dispatch decision (`return
 * true`) stays completely proofless — gating it would re-open PR #18's stale-re-dispatch incident.
 * Only the direct closePlaneIssue write for a stale/already-closed issue requires a recorded
 * DoneProof; a terminal-without-proof doc (grandfathered pre-ship Done) is skipped but its Plane
 * close is suppressed and surfaced instead of happening silently.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { recordDoneProof } from "../src/done-proof.ts";
import { SquadManager } from "../src/squad-manager.ts";
import type { IssueRef } from "../src/types.ts";

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

/** Minimal Plane HTTP stub: GET .../states/ advertises a completed group; PATCH counts as a close. */
function planeStub(): { server: ReturnType<typeof Bun.serve>; patches: () => number } {
	let patches = 0;
	const server = Bun.serve({
		port: 0,
		fetch: (req) => {
			const url = new URL(req.url);
			if (req.method === "GET" && url.pathname.endsWith("/states/")) {
				return Response.json({ results: [{ id: "s-done", group: "completed" }] });
			}
			if (req.method === "PATCH") {
				patches++;
				return Response.json({ ok: true });
			}
			return new Response("no", { status: 404 });
		},
	});
	return { server, patches: () => patches };
}

async function freshManager(planeBase: string): Promise<{ mgr: SquadManager; stateDir: string; repo: string }> {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "already-done-state-"));
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "already-done-repo-"));
	tmps.push(stateDir, repo);
	process.env.PLANE_API_KEY = "secret";
	process.env.PLANE_WORKSPACE = "acme";
	process.env.PLANE_BASE_URL = planeBase;
	return { mgr: new SquadManager({ stateDir }), stateDir, repo };
}

/** A closed concern doc whose path is embedded verbatim in the issue name — the planDocRefs match. */
async function closedConcernRepo(repo: string): Promise<string> {
	const dir = path.join(repo, "plans", "demo");
	await fs.mkdir(dir, { recursive: true });
	const rel = "plans/demo/01-a.md";
	await fs.writeFile(path.join(repo, rel), "# A\nSTATUS: done\n");
	return rel;
}

test("issueAlreadyDone: skip-dispatch (return true) fires identically whether or not a DoneProof exists", async () => {
	const { server, patches } = planeStub();
	try {
		const { mgr, repo } = await freshManager(`http://127.0.0.1:${server.port}`);
		const rel = await closedConcernRepo(repo);
		const issue: IssueRef = { id: "iss-1", name: `Implement ${rel} exactly`, projectId: "proj-9" };

		// No DoneProof on record — skip-dispatch still returns true (never re-dispatches landed work).
		expect(await mgr.issueAlreadyDone(repo, issue)).toBe(true);
	} finally {
		server.stop(true);
	}
});

test("issueAlreadyDone: terminal-without-proof suppresses the Plane close but still skips dispatch", async () => {
	const { server, patches } = planeStub();
	try {
		const { mgr, repo } = await freshManager(`http://127.0.0.1:${server.port}`);
		const rel = await closedConcernRepo(repo);
		const issue: IssueRef = { id: "iss-2", name: `Implement ${rel} exactly`, projectId: "proj-9" }; // no identifier ⇒ no DoneProof lookup possible

		const audits: { action: string; outcome: string }[] = [];
		const overridable: { recordAudit: typeof mgr.recordAudit } = mgr;
		const original = overridable.recordAudit.bind(mgr);
		overridable.recordAudit = async (actor, action, target, outcome = "ok", detail) => {
			audits.push({ action, outcome });
			return original(actor, action, target, outcome, detail);
		};

		expect(await mgr.issueAlreadyDone(repo, issue)).toBe(true); // dispatch still skipped
		expect(patches()).toBe(0); // but the Plane close did NOT happen — no proof on record
		expect(audits.some((a) => a.action === "close.suppressed-unproven" && a.outcome === "error")).toBe(true);
	} finally {
		server.stop(true);
	}
});

test("issueAlreadyDone: closes the stale issue in Plane when a DoneProof IS on record", async () => {
	const { server, patches } = planeStub();
	try {
		const { mgr, stateDir, repo } = await freshManager(`http://127.0.0.1:${server.port}`);
		const rel = await closedConcernRepo(repo);
		const issue: IssueRef = { id: "iss-3", identifier: "PROJ-3", name: `Implement ${rel} exactly`, projectId: "proj-9" };
		recordDoneProof(stateDir, {
			branch: "squad/landed-earlier",
			repo: "r",
			issueId: issue.id,
			issueIdentifier: issue.identifier,
			mode: "local",
			commit: "c1",
			baseRef: "HEAD",
			verified: "green",
			detail: "landed before the re-dispatch",
			provenAt: Date.now(),
		});

		expect(await mgr.issueAlreadyDone(repo, issue)).toBe(true); // still skips dispatch
		expect(patches()).toBe(1); // AND this time the close actually happens — proof is on record
	} finally {
		server.stop(true);
	}
});

test("finding #11 (eap-borrows wave 2): issueAlreadyDone suppresses the Plane close for an UNVERIFIED DoneProof (still skips dispatch)", async () => {
	const { server, patches } = planeStub();
	try {
		const { mgr, stateDir, repo } = await freshManager(`http://127.0.0.1:${server.port}`);
		const rel = await closedConcernRepo(repo);
		const issue: IssueRef = { id: "iss-5", identifier: "PROJ-5", name: `Implement ${rel} exactly`, projectId: "proj-9" };
		recordDoneProof(stateDir, {
			branch: "squad/oob-2",
			repo: "r",
			issueId: issue.id,
			issueIdentifier: issue.identifier,
			mode: "pr",
			method: "merge",
			commit: "c11",
			baseRef: "origin/main",
			verified: "unverified",
			detail: "merged out-of-band via GitHub UI; gate not re-verified by the daemon",
			provenAt: Date.now(),
		});
		const audits: { action: string; outcome: string }[] = [];
		const overridable: { recordAudit: typeof mgr.recordAudit } = mgr;
		const original = overridable.recordAudit.bind(mgr);
		overridable.recordAudit = async (actor, action, target, outcome = "ok", detail) => {
			audits.push({ action, outcome });
			return original(actor, action, target, outcome, detail);
		};

		// OLD behavior (fail-open): ANY recorded proof authorized the close — this would have PATCHed
		// Plane closed on an out-of-band merge the daemon never re-verified. NEW: suppressed, audited.
		expect(await mgr.issueAlreadyDone(repo, issue)).toBe(true); // dispatch still skips (unaffected)
		expect(patches()).toBe(0);
		expect(audits.some((a) => a.action === "close.suppressed-unverified" && a.outcome === "error")).toBe(true);
	} finally {
		server.stop(true);
	}
});

test("issueAlreadyDone: returns false (dispatch proceeds) when no concern doc is closed", async () => {
	const { server } = planeStub();
	try {
		const { mgr, repo } = await freshManager(`http://127.0.0.1:${server.port}`);
		const dir = path.join(repo, "plans", "demo");
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(repo, "plans/demo/01-a.md"), "# A\nSTATUS: open\n");
		const issue: IssueRef = { id: "iss-4", name: "Implement plans/demo/01-a.md exactly", projectId: "proj-9" };

		expect(await mgr.issueAlreadyDone(repo, issue)).toBe(false);
	} finally {
		server.stop(true);
	}
});

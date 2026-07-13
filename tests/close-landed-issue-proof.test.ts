/**
 * Done-write gating (concern 04): closeLandedIssue must consult the DoneProof ledger (concern 01)
 * before writing a Plane close — a merge report with no matching proof is skipped and surfaced via
 * recordAudit's "close.suppressed-unproven" action, never silently trusted.
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

async function tmpDir(prefix: string): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tmps.push(d);
	return d;
}

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

async function freshManager(planeBase: string): Promise<{ mgr: SquadManager; stateDir: string }> {
	const stateDir = await tmpDir("close-proof-");
	process.env.PLANE_API_KEY = "secret";
	process.env.PLANE_WORKSPACE = "acme";
	process.env.PLANE_BASE_URL = planeBase;
	return { mgr: new SquadManager({ stateDir }), stateDir };
}

const issueWithIdentifier: IssueRef = { id: "iss-1", identifier: "PROJ-1", name: "do the thing", projectId: "proj-9" };
const issueNoIdentifier: IssueRef = { id: "iss-2", name: "do another thing", projectId: "proj-9" };

test("closeLandedIssue closes normally when a DoneProof is on record (looked up by issue identifier)", async () => {
	const { server, patches } = planeStub();
	try {
		const { mgr, stateDir } = await freshManager(`http://127.0.0.1:${server.port}`);
		recordDoneProof(stateDir, {
			branch: "squad/a1",
			repo: "r",
			issueId: issueWithIdentifier.id,
			issueIdentifier: issueWithIdentifier.identifier,
			mode: "local",
			commit: "c1",
			baseRef: "HEAD",
			verified: "green",
			detail: "merged squad/a1",
			provenAt: Date.now(),
		});
		await mgr.closeLandedIssue(issueWithIdentifier, { branch: "squad/a1" });
		expect(patches()).toBe(1);
	} finally {
		server.stop(true);
	}
});

test("closeLandedIssue closes normally when a DoneProof is on record (looked up by branch, no issue identifier)", async () => {
	const { server, patches } = planeStub();
	try {
		const { mgr, stateDir } = await freshManager(`http://127.0.0.1:${server.port}`);
		recordDoneProof(stateDir, {
			branch: "squad/a2",
			repo: "r",
			issueId: issueNoIdentifier.id,
			mode: "local",
			commit: "c2",
			baseRef: "HEAD",
			verified: "green",
			detail: "merged squad/a2",
			provenAt: Date.now(),
		});
		await mgr.closeLandedIssue(issueNoIdentifier, { branch: "squad/a2" });
		expect(patches()).toBe(1);
	} finally {
		server.stop(true);
	}
});

test("closeLandedIssue does NOT close without a DoneProof — suppressed and audited, closePlaneIssue never called", async () => {
	const { server, patches } = planeStub();
	try {
		const { mgr } = await freshManager(`http://127.0.0.1:${server.port}`); // no recordDoneProof — ledger is empty
		const audits: { actor: string; action: string; target: string | null; outcome: string; detail?: string }[] = [];
		const overridable: { recordAudit: typeof mgr.recordAudit } = mgr;
		const original = overridable.recordAudit.bind(mgr);
		overridable.recordAudit = async (actor, action, target, outcome = "ok", detail) => {
			audits.push({ actor: typeof actor === "string" ? actor : actor.id, action, target, outcome, detail });
			return original(actor, action, target, outcome, detail);
		};

		await mgr.closeLandedIssue(issueWithIdentifier, { branch: "squad/never-landed" });

		expect(patches()).toBe(0); // closePlaneIssue never called — no PATCH hit the Plane stub
		expect(audits.some((a) => a.action === "close.suppressed-unproven" && a.outcome === "error")).toBe(true);
	} finally {
		server.stop(true);
	}
});

test("closeLandedIssue does NOT close without a DoneProof — also true with no ctx.branch at all", async () => {
	const { server, patches } = planeStub();
	try {
		const { mgr } = await freshManager(`http://127.0.0.1:${server.port}`);
		await mgr.closeLandedIssue(issueNoIdentifier); // no ctx — nothing to look up by branch, no identifier either
		expect(patches()).toBe(0);
	} finally {
		server.stop(true);
	}
});

test("closeLandedIssue with a stale ctx.branch (proof recorded under a DIFFERENT branch) still suppresses the close", async () => {
	const { server, patches } = planeStub();
	try {
		const { mgr, stateDir } = await freshManager(`http://127.0.0.1:${server.port}`);
		recordDoneProof(stateDir, { branch: "squad/other-branch", repo: "r", mode: "local", commit: "c3", baseRef: "HEAD", verified: "green", detail: "unrelated land", provenAt: Date.now() });
		await mgr.closeLandedIssue(issueNoIdentifier, { branch: "squad/not-the-recorded-one" });
		expect(patches()).toBe(0);
	} finally {
		server.stop(true);
	}
});

// ── finding #11 (eap-borrows wave 2): hasProof/closeLandedIssue tri-state ──────────────────────────
// A recorded DoneProof used to authorize a close regardless of ITS OWN `verified` grade — an
// out-of-band GitHub-UI merge (reconcileOnePr) records `verified:"unverified"` (never re-checked by
// this daemon's own gate), and the OLD code closed the tracking issue exactly like a real green land.

test("finding #11: closeLandedIssue does NOT close on an UNVERIFIED DoneProof — escalated, not silently trusted", async () => {
	const { server, patches } = planeStub();
	try {
		const { mgr, stateDir } = await freshManager(`http://127.0.0.1:${server.port}`);
		recordDoneProof(stateDir, {
			branch: "squad/oob-1",
			repo: "r",
			issueId: issueWithIdentifier.id,
			issueIdentifier: issueWithIdentifier.identifier,
			mode: "pr",
			method: "merge",
			commit: "c9",
			baseRef: "origin/main",
			verified: "unverified",
			detail: "merged out-of-band via GitHub UI; gate not re-verified by the daemon",
			provenAt: Date.now(),
		});

		await mgr.closeLandedIssue(issueWithIdentifier, { branch: "squad/oob-1" });

		// OLD behavior (fail-open): ANY proof authorized the close — this would have PATCHed Plane closed
		// despite the daemon never actually re-verifying the merge. NEW behavior: no close at all.
		expect(patches()).toBe(0);

		// Idempotent + non-throwing on repeat calls (the reconciler retries every tick until confirmed).
		await mgr.closeLandedIssue(issueWithIdentifier, { branch: "squad/oob-1" });
		expect(patches()).toBe(0);
	} finally {
		server.stop(true);
	}
});

test("finding #11: closeLandedIssue DOES close a red-baseline DoneProof, with an audit annotation distinguishing it from a clean pass", async () => {
	const { server, patches } = planeStub();
	try {
		const { mgr, stateDir } = await freshManager(`http://127.0.0.1:${server.port}`);
		recordDoneProof(stateDir, {
			branch: "squad/rb-1",
			repo: "r",
			issueId: issueWithIdentifier.id,
			issueIdentifier: issueWithIdentifier.identifier,
			mode: "local",
			commit: "c10",
			baseRef: "HEAD",
			verified: "red-baseline",
			detail: "landed onto a red baseline — main was not green at head0",
			provenAt: Date.now(),
		});
		const audits: { action: string; outcome: string }[] = [];
		const overridable: { recordAudit: typeof mgr.recordAudit } = mgr;
		const original = overridable.recordAudit.bind(mgr);
		overridable.recordAudit = async (actor, action, target, outcome = "ok", detail) => {
			audits.push({ action, outcome });
			return original(actor, action, target, outcome, detail);
		};

		await mgr.closeLandedIssue(issueWithIdentifier, { branch: "squad/rb-1" });

		// Refusing to close a red-baseline land would zombify every brownfield issue forever — the land
		// itself already accepted the allowance — so it closes, but leaves a distinguishable audit trail.
		expect(patches()).toBe(1);
		expect(audits.some((a) => a.action === "close.red-baseline" && a.outcome === "ok")).toBe(true);
	} finally {
		server.stop(true);
	}
});

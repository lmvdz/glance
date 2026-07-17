/**
 * `promoteIssue` (adw-factory-borrows concern 05) — one-shot Tier-1/Tier-2 enrichment with a human
 * release gate. Exercised against a stub Plane API (Bun.serve, mirroring tests/plane.test.ts's
 * pattern) plus a fake `PromoteManager` so the ask-mode spawn + wait loop never touches a real
 * `SquadManager`/worktree. Each test uses its own repo path so the module-level Plane caches
 * (plane.ts's `issueListCache`/`issueDetailCache`) never bleed state across tests.
 */

import { afterEach, expect, test } from "bun:test";
import { promoteIssue, type PromoteManager } from "../src/promote.ts";
import type { Actor, AgentDTO, AgentStatus } from "../src/types.ts";
import type { Answer } from "../src/answers.ts";

const PLANE_ENV = ["PLANE_API_KEY", "PLANE_API_TOKEN", "PLANE_WORKSPACE", "PLANE_WORKSPACE_SLUG", "PLANE_PROJECT_MAP", "PLANE_BASE_URL", "PLANE_PROJECT_ID", "DATABASE_URL", "OMP_SQUAD_SPEC_MAX_CHARS", "OMP_SQUAD_PLANE_CACHE_MS", "OMP_SQUAD_PLANE_MIN_INTERVAL_MS"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of PLANE_ENV) saved[k] = process.env[k];

afterEach(() => {
	for (const k of PLANE_ENV) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

const ISSUE_ID = "11111111-1111-1111-1111-111111111111"; // uuid-shaped: resolveIssueId short-circuits inside updatePlaneIssueBody

/** A minimal stub Plane API serving exactly one issue, mirroring tests/plane.test.ts's routing
 *  pattern. `descriptionHtml` may be a function so a test can vary the served body across calls
 *  (the race-guard test below). */
function mockPlane(opts: {
	name: string;
	descriptionHtml: string | (() => string);
	onPatch?: (body: { description_html: string }) => void;
}): ReturnType<typeof Bun.serve> {
	return Bun.serve({
		port: 0,
		fetch: async (req) => {
			const url = new URL(req.url);
			const p = url.pathname;
			if (req.method === "PATCH" && p.endsWith(`/issues/${ISSUE_ID}/`)) {
				const body = (await req.json()) as { description_html: string };
				opts.onPatch?.(body);
				return Response.json({ ok: true });
			}
			if (p.endsWith(`/issues/${ISSUE_ID}/relations/`)) return Response.json({ blocked_by: [], blocking: [], relates_to: [] });
			if (p.endsWith(`/issues/${ISSUE_ID}/`)) {
				const html = typeof opts.descriptionHtml === "function" ? opts.descriptionHtml() : opts.descriptionHtml;
				return Response.json({
					id: ISSUE_ID,
					name: opts.name,
					sequence_id: 1,
					description_html: html,
					description_stripped: html.replace(/<[^>]+>/g, " "),
					state_detail: { group: "backlog" },
					project_detail: { identifier: "OMPSQ" },
				});
			}
			if (p.endsWith("/labels/")) return Response.json({ results: [] });
			if (p.endsWith("/states/")) return Response.json({ results: [{ id: "s-backlog", name: "Backlog", group: "backlog" }] });
			if (p.endsWith("/projects/proj-9/")) return Response.json({ identifier: "OMPSQ" });
			if (p.endsWith("/issues/")) return Response.json({ results: [{ id: ISSUE_ID, sequence_id: 1, name: opts.name, state_detail: { group: "backlog" } }] });
			return new Response("no", { status: 404 });
		},
	});
}

function configure(server: ReturnType<typeof Bun.serve>, repo: string): void {
	process.env.PLANE_API_KEY = "secret";
	process.env.PLANE_WORKSPACE = "acme";
	process.env.PLANE_BASE_URL = `http://127.0.0.1:${server.port}`;
	process.env.PLANE_PROJECT_MAP = JSON.stringify({ [repo]: "proj-9" });
	delete process.env.DATABASE_URL;
	// `promoteIssue` makes many sequential Plane calls (list + detail, twice); the default 500ms
	// global inter-request spacing (plane-throttle.ts) would otherwise blow past bun's per-test
	// timeout on nothing but throttling. Mirrors tests/plane-throttle.test.ts's own override value.
	process.env.OMP_SQUAD_PLANE_MIN_INTERVAL_MS = "5";
}

function agentDto(id: string, repo: string, status: AgentStatus = "working"): AgentDTO {
	return { id, name: id, status, kind: "omp-operator", repo, worktree: `/wt/${id}`, approvalMode: "yolo", pending: [], lastActivity: Date.now(), messageCount: 1 };
}

/** A fake manager that never calls `ask` — used to prove the refusal paths short-circuit before
 *  spending a unit. */
function refusingManager(): PromoteManager {
	return {
		async ask() {
			throw new Error("ask() must not be called for this scenario");
		},
		async answer() {
			return undefined;
		},
		list() {
			return [];
		},
	};
}

/** A fake manager whose `ask` immediately "answers" with `markdown` — `waitForAnswer` checks before
 *  sleeping, so this resolves without paying the 2s poll interval. */
function answeringManager(markdown: string): PromoteManager {
	return {
		async ask(opts, actor?: Actor) {
			void actor;
			return agentDto("agent-1", opts.repo);
		},
		async answer(id) {
			return { id, question: "q", repo: "/repo", markdown, askedAt: Date.now() - 10, answeredAt: Date.now() } satisfies Answer;
		},
		list() {
			return [];
		},
	};
}

const GOOD_DRAFT = [
	"<h2>Tier-1 origin &amp; research context</h2>",
	"<h3>Discovery</h3><p>Found during a routine audit on 2026-07-01.</p>",
	"<h2>Tier-2 implementation context</h2>",
	"<h3>Touches (files + lines)</h3><ul><li><code>src/foo.ts:10-20</code></li></ul>",
	"<h3>Acceptance test</h3><pre><code>bun test tests/foo.test.ts</code></pre>",
	"<h3>Verification gate</h3><pre><code>bun run typecheck</code></pre>",
	"<h3>Scope</h3><p><strong>Allowed:</strong> src/foo.ts</p>",
].join("");

test("refuses a do-not-auto-land ticket without ever calling ask()", async () => {
	const server = mockPlane({ name: "do-not-auto-land: some finding", descriptionHtml: "<p>x</p>" });
	try {
		const repo = "/repo/promote-quarantine-1";
		configure(server, repo);
		const result = await promoteIssue(refusingManager(), repo, ISSUE_ID);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBe("quarantined");
			expect(result.message).toContain("do-not-auto-land");
		}
	} finally {
		server.stop(true);
	}
});

test("refuses a [scout]-tagged ticket without ever calling ask()", async () => {
	const server = mockPlane({ name: "[scout] some auto-filed finding", descriptionHtml: "<p>x</p>" });
	try {
		const repo = "/repo/promote-quarantine-2";
		configure(server, repo);
		const result = await promoteIssue(refusingManager(), repo, ISSUE_ID);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBe("quarantined");
	} finally {
		server.stop(true);
	}
});

test("refuses an [observer]-tagged ticket without ever calling ask()", async () => {
	const server = mockPlane({ name: "[observer] a routine reproduction", descriptionHtml: "<p>x</p>" });
	try {
		const repo = "/repo/promote-quarantine-3";
		configure(server, repo);
		const result = await promoteIssue(refusingManager(), repo, ISSUE_ID);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBe("quarantined");
	} finally {
		server.stop(true);
	}
});

test("is idempotent: a ticket that already carries Tier-2 content is not re-promoted, and ask() is never called", async () => {
	const server = mockPlane({ name: "Fix the thing", descriptionHtml: GOOD_DRAFT });
	try {
		const repo = "/repo/promote-idempotent";
		configure(server, repo);
		const result = await promoteIssue(refusingManager(), repo, ISSUE_ID);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBe("already-promoted");
			expect(result.message).toContain("already");
		}
	} finally {
		server.stop(true);
	}
});

test("no such open issue matching the given id/identifier", async () => {
	const server = mockPlane({ name: "Fix the thing", descriptionHtml: "<p>x</p>" });
	try {
		const repo = "/repo/promote-not-found";
		configure(server, repo);
		const result = await promoteIssue(refusingManager(), repo, "OMPSQ-999");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBe("not-found");
	} finally {
		server.stop(true);
	}
});

test("not-configured when Plane isn't configured for the repo", async () => {
	for (const k of PLANE_ENV) delete process.env[k];
	const result = await promoteIssue(refusingManager(), "/repo/unconfigured", ISSUE_ID);
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.error).toBe("not-configured");
});

test("reports fleet-busy (not a hard failure) when ask() throws at the WIP cap", async () => {
	const server = mockPlane({ name: "Fix the thing", descriptionHtml: "<p>an empty triage body</p>" });
	try {
		const repo = "/repo/promote-fleet-busy";
		configure(server, repo);
		const manager: PromoteManager = {
			async ask() {
				throw new Error("WIP cap reached (8/8) — finish or remove an agent before spawning");
			},
			async answer() {
				return undefined;
			},
			list() {
				return [];
			},
		};
		const result = await promoteIssue(manager, repo, ISSUE_ID);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBe("fleet-busy");
			expect(result.message).toContain("retry");
		}
	} finally {
		server.stop(true);
	}
});

test("reports no-answer when the unit ends without ever answering", async () => {
	const server = mockPlane({ name: "Fix the thing", descriptionHtml: "<p>an empty triage body</p>" });
	try {
		const repo = "/repo/promote-no-answer";
		configure(server, repo);
		const manager: PromoteManager = {
			async ask(opts) {
				return agentDto("agent-2", opts.repo);
			},
			async answer() {
				return undefined; // never answers
			},
			list() {
				return []; // and it's gone from the roster — reaped without a final message
			},
		};
		const result = await promoteIssue(manager, repo, ISSUE_ID);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBe("no-answer");
	} finally {
		server.stop(true);
	}
});

test("reports no-answer when the unit errored mid-run", async () => {
	const server = mockPlane({ name: "Fix the thing", descriptionHtml: "<p>an empty triage body</p>" });
	try {
		const repo = "/repo/promote-errored";
		configure(server, repo);
		const manager: PromoteManager = {
			async ask(opts) {
				return agentDto("agent-3", opts.repo);
			},
			async answer() {
				return undefined;
			},
			list() {
				return [agentDto("agent-3", repo, "error")];
			},
		};
		const result = await promoteIssue(manager, repo, ISSUE_ID);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBe("no-answer");
	} finally {
		server.stop(true);
	}
});

test("fails closed (no Plane write) when the draft never had real Tier-2 sections at all", async () => {
	let patched = false;
	const server = mockPlane({
		name: "Fix the thing",
		descriptionHtml: "<p>an empty triage body</p>",
		onPatch: () => {
			patched = true;
		},
	});
	try {
		const repo = "/repo/promote-validation-empty";
		configure(server, repo);
		const badDraft = "<h2>Tier-2 implementation context</h2><h3>Scope</h3><p>touches src/foo.ts only</p>";
		const result = await promoteIssue(answeringManager(badDraft), repo, ISSUE_ID);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBe("validation-failed");
			expect(result.draft).toBe(badDraft);
		}
		expect(patched).toBe(false);
	} finally {
		server.stop(true);
	}
});

test("fails closed (no Plane write) when the full draft validates but the injection-cap truncation cuts it before Tier-2", async () => {
	let patched = false;
	const server = mockPlane({
		name: "Fix the thing",
		descriptionHtml: "<p>an empty triage body</p>",
		onPatch: () => {
			patched = true;
		},
	});
	try {
		const repo = "/repo/promote-validation-truncated";
		configure(server, repo);
		process.env.OMP_SQUAD_SPEC_MAX_CHARS = "150"; // small enough that Tier-1 prose alone exceeds it
		const longTier1 = `<h2>Tier-1 origin &amp; research context</h2><h3>Discovery</h3><p>${"x".repeat(200)}</p>`;
		const draft = longTier1 + GOOD_DRAFT.slice(GOOD_DRAFT.indexOf("<h2>Tier-2"));
		const result = await promoteIssue(answeringManager(draft), repo, ISSUE_ID);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBe("validation-failed");
			expect(result.message).toContain("cap");
			expect(result.draft).toBe(draft);
		}
		expect(patched).toBe(false);
	} finally {
		server.stop(true);
	}
});

test("promotes a Backlog ticket: writes Tier-1/Tier-2 body + a promotion marker, and never moves state", async () => {
	let patchedBody: { description_html: string } | undefined;
	const server = mockPlane({
		name: "Fix the thing",
		descriptionHtml: "<p>an empty triage body</p>",
		onPatch: (body) => {
			patchedBody = body;
		},
	});
	try {
		const repo = "/repo/promote-success";
		configure(server, repo);
		const result = await promoteIssue(answeringManager(GOOD_DRAFT), repo, "OMPSQ-1");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.issue).toBe("OMPSQ-1");
			expect(result.message).toContain("Backlog");
		}
		expect(patchedBody?.description_html).toContain("Acceptance test");
		expect(patchedBody?.description_html).toMatch(/<!-- promoted:[0-9a-f]{12}:\d{4}-\d{2}-\d{2} -->/);
	} finally {
		server.stop(true);
	}
});

test("re-read-before-write: a ticket promoted by someone else while the unit ran is not overwritten", async () => {
	let patched = false;
	let detailCalls = 0;
	const server = mockPlane({
		name: "Fix the thing",
		// First read (idempotency check) sees a plain triage body; the SECOND read (re-read-before-write,
		// right before the write) sees it already promoted — simulating a second promoter (or a human)
		// racing this one. Requires OMP_SQUAD_PLANE_CACHE_MS=0 below so the second read isn't served
		// from `fetchIssueDetail`'s cache.
		descriptionHtml: () => {
			detailCalls += 1;
			return detailCalls === 1 ? "<p>an empty triage body</p>" : GOOD_DRAFT;
		},
		onPatch: () => {
			patched = true;
		},
	});
	try {
		const repo = "/repo/promote-race";
		configure(server, repo);
		process.env.OMP_SQUAD_PLANE_CACHE_MS = "0";
		const result = await promoteIssue(answeringManager(GOOD_DRAFT), repo, ISSUE_ID);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBe("already-promoted");
		expect(patched).toBe(false);
		expect(detailCalls).toBeGreaterThanOrEqual(2);
	} finally {
		server.stop(true);
	}
});

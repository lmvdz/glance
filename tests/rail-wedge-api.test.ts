/**
 * Golden coverage for the wedge's GitHub REST API mechanics against a MOCKED GitHub API (glance#337,
 * rail T9) — no real GitHub App / installed App / credentials required, per the ticket's reality
 * constraint. Covers: the installation-token exchange, PR-metadata + commit-trailer fetch, the
 * check-run create/update body shape, and the idempotent find-existing-by-app-id lookup.
 *
 * Mocking convention mirrors tests/voice-token.test.ts's `mockOpenAiMint`: capture the real `fetch`
 * once, reassign `globalThis.fetch` per test to a URL-filtered stub, restore in `afterEach`.
 */
import { afterEach, expect, test } from "bun:test";
import {
	WedgeApiError,
	githubApiRequest,
	mintInstallationToken,
	fetchPullRequest,
	findExistingCheckRun,
	upsertCheckRun,
	InstallationTokenResponseSchema,
} from "../src/rail/index.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

/** Route requests by exact URL (ignoring query string when `matchQuery` is false) to a handler; any
 *  unmatched URL throws loudly rather than silently falling through to the real network — a wedge
 *  test must never make a live GitHub call. */
function mockGithub(routes: Record<string, (init: RequestInit | undefined) => { status: number; json?: unknown }>): void {
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		const url = typeof input === "string" ? input : (input as { url?: string })?.url ?? "";
		const path = url.replace(/^https:\/\/api\.github\.com/, "");
		const key = Object.keys(routes).find((k) => path === k || path.startsWith(`${k}?`));
		if (!key) throw new Error(`unmocked GitHub API call in test: ${url}`);
		const { status, json } = routes[key](init);
		return new Response(json !== undefined ? JSON.stringify(json) : undefined, { status });
	}) as typeof fetch;
}

// ── installation-token.ts ─────────────────────────────────────────────────────────────────────────

test("mintInstallationToken: POSTs to /app/installations/{id}/access_tokens with the App JWT as bearer", async () => {
	let capturedAuth: string | undefined;
	mockGithub({
		"/app/installations/999/access_tokens": (init) => {
			capturedAuth = new Headers(init?.headers as HeadersInit).get("authorization") ?? undefined;
			return { status: 201, json: { token: "ghs_installationtoken", expires_at: "2026-08-04T13:00:00Z" } };
		},
	});
	const result = await mintInstallationToken("the-app-jwt", 999);
	expect(result).toEqual({ token: "ghs_installationtoken", expiresAt: "2026-08-04T13:00:00Z" });
	expect(capturedAuth).toBe("Bearer the-app-jwt");
});

test("mintInstallationToken: a non-2xx response throws WedgeApiError with the status", async () => {
	mockGithub({ "/app/installations/999/access_tokens": () => ({ status: 401, json: { message: "Bad credentials" } }) });
	await expect(mintInstallationToken("bad-jwt", 999)).rejects.toThrow(WedgeApiError);
	try {
		await mintInstallationToken("bad-jwt", 999);
		throw new Error("expected rejection");
	} catch (err) {
		expect(err).toBeInstanceOf(WedgeApiError);
		expect((err as WedgeApiError).status).toBe(401);
	}
});

// ── pull-request.ts ───────────────────────────────────────────────────────────────────────────────

test("fetchPullRequest: assembles author/head/base + scans commit messages for trailer-shaped lines", async () => {
	mockGithub({
		"/repos/acme/widgets/pulls/42": () => ({
			status: 200,
			json: { number: 42, user: { login: "codex[bot]" }, head: { ref: "codex/fix-bug", sha: "a".repeat(40) }, base: { ref: "main" } },
		}),
		"/repos/acme/widgets/pulls/42/commits": () => ({
			status: 200,
			json: [
				{ commit: { message: "fix the bug\n\nCo-Authored-By: Codex <noreply@openai.com>" } },
				{ commit: { message: "unrelated commit with no trailers" } },
			],
		}),
	});
	const pr = await fetchPullRequest("installation-token", "acme", "widgets", 42);
	expect(pr).toEqual({
		number: 42,
		authorLogin: "codex[bot]",
		headRef: "codex/fix-bug",
		headSha: "a".repeat(40),
		baseRef: "main",
		commitTrailerLines: ["Co-Authored-By: Codex <noreply@openai.com>"],
	});
});

test("fetchPullRequest: a null PR user (ghost/deleted account) degrades to authorLogin \"\", never throws", async () => {
	mockGithub({
		"/repos/acme/widgets/pulls/7": () => ({ status: 200, json: { number: 7, user: null, head: { ref: "x", sha: "b".repeat(40) }, base: { ref: "main" } } }),
		"/repos/acme/widgets/pulls/7/commits": () => ({ status: 200, json: [] }),
	});
	const pr = await fetchPullRequest("t", "acme", "widgets", 7);
	expect(pr.authorLogin).toBe("");
	expect(pr.commitTrailerLines).toEqual([]);
});

// ── check-run.ts ──────────────────────────────────────────────────────────────────────────────────

test("findExistingCheckRun: matches on BOTH name and app.id — a same-named check from a different App is ignored", async () => {
	mockGithub({
		"/repos/acme/widgets/commits/deadbeef/check-runs": () => ({
			status: 200,
			json: {
				check_runs: [
					{ id: 111, name: "glance/landing-rail-receipt", app: { id: 999 } }, // different app id
					{ id: 222, name: "some-other-check", app: { id: 555 } }, // our app id, wrong name
					{ id: 333, name: "glance/landing-rail-receipt", app: { id: 555 } }, // the match
				],
			},
		}),
	});
	const id = await findExistingCheckRun("t", "acme", "widgets", "deadbeef", "glance/landing-rail-receipt", 555);
	expect(id).toBe(333);
});

test("findExistingCheckRun: no match returns undefined (never throws, never a fabricated id)", async () => {
	mockGithub({ "/repos/acme/widgets/commits/deadbeef/check-runs": () => ({ status: 200, json: { check_runs: [] } }) });
	const id = await findExistingCheckRun("t", "acme", "widgets", "deadbeef", "glance/landing-rail-receipt", 555);
	expect(id).toBeUndefined();
});

test("upsertCheckRun: no existingId → POST to the collection endpoint, status completed", async () => {
	let capturedMethod: string | undefined;
	let capturedBody: Record<string, unknown> | undefined;
	mockGithub({
		"/repos/acme/widgets/check-runs": (init) => {
			capturedMethod = init?.method;
			capturedBody = JSON.parse(init?.body as string);
			return { status: 201, json: { id: 4242, html_url: "https://github.com/acme/widgets/runs/4242" } };
		},
	});
	const result = await upsertCheckRun("t", {
		owner: "acme",
		repo: "widgets",
		name: "glance/landing-rail-receipt",
		headSha: "deadbeef",
		conclusion: "success",
		output: { title: "t", summary: "s", text: "x" },
	});
	expect(capturedMethod).toBe("POST");
	expect(capturedBody).toMatchObject({ name: "glance/landing-rail-receipt", head_sha: "deadbeef", status: "completed", conclusion: "success" });
	expect(result).toEqual({ id: 4242, htmlUrl: "https://github.com/acme/widgets/runs/4242", conclusion: "success" });
});

test("upsertCheckRun: an existingId → PATCH to the specific check-run id, not a new POST", async () => {
	let capturedMethod: string | undefined;
	mockGithub({
		"/repos/acme/widgets/check-runs/4242": (init) => {
			capturedMethod = init?.method;
			return { status: 200, json: { id: 4242, html_url: "https://github.com/acme/widgets/runs/4242" } };
		},
	});
	await upsertCheckRun(
		"t",
		{ owner: "acme", repo: "widgets", name: "glance/landing-rail-receipt", headSha: "deadbeef", conclusion: "action_required", output: { title: "t", summary: "s", text: "x" } },
		4242,
	);
	expect(capturedMethod).toBe("PATCH");
});

// ── github-api.ts ─────────────────────────────────────────────────────────────────────────────────

test("githubApiRequest: an unparsable JSON body throws WedgeApiError rather than crashing", async () => {
	globalThis.fetch = (async () => new Response("not json {{{", { status: 200 })) as typeof fetch;
	await expect(githubApiRequest("GET", "/some/path", "t", InstallationTokenResponseSchema)).rejects.toThrow(WedgeApiError);
});

test("githubApiRequest: a network failure (fetch throws) surfaces as status 0, never an uncaught throw type", async () => {
	globalThis.fetch = (async () => {
		throw new Error("ECONNREFUSED");
	}) as typeof fetch;
	try {
		await githubApiRequest("GET", "/x", "t", InstallationTokenResponseSchema);
		throw new Error("expected rejection");
	} catch (err) {
		expect(err).toBeInstanceOf(WedgeApiError);
		expect((err as WedgeApiError).status).toBe(0);
	}
});

test("githubApiRequest: a well-formed JSON body that fails its SCHEMA throws WedgeApiError too — never a silently mistyped value", async () => {
	mockGithub({ "/some/path": () => ({ status: 200, json: { wrong: "shape" } }) });
	try {
		await githubApiRequest("GET", "/some/path", "t", InstallationTokenResponseSchema);
		throw new Error("expected rejection");
	} catch (err) {
		expect(err).toBeInstanceOf(WedgeApiError);
		expect((err as WedgeApiError).message).toMatch(/shape validation/);
	}
});

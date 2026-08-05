/**
 * End-to-end coverage for the wedge's orchestrator (glance#337, rail T9, src/rail/wedge/post-check.ts)
 * against a fully mocked GitHub API: JWT mint (no network) → installation-token exchange → PR fetch →
 * agent-authorship gate → receipt verification → check-run upsert. Also covers env-var config loading
 * (loadWedgeCredentialsFromEnv / loadAuthorshipConfigFromEnv / loadMaxReceiptAgeMsFromEnv), since the
 * CLI (scripts/post-wedge-check.ts) has no unit coverage of its own — this is the closest thing to it.
 *
 * Gauntlet round 1 (glance#337 PR #358) rewrote this file's core scenarios: the ORIGINAL "success"
 * test supplied `commit: "abc1234"` for a receipt while the mocked PR head was `"f".repeat(40)` — a
 * blatant SHA mismatch that the pre-fix orchestrator happily greened anyway (any truthy receipt =
 * success). That's exactly the CRITICAL bug both lineages converged on; the fixture below now uses a
 * MATCHING commit for the success case, and the mismatched-SHA case is its own dedicated test that
 * asserts NON-success. Also: a human-authored PR is no longer "skipped" (no check posted) — it now
 * gets an informational `success` check, because a Ruleset's required-status-check applies to every
 * PR and a skip would either block ordinary human PRs or, if treated as passing, recreate the same
 * evasion the check exists to prevent (see post-check.ts's header and authorship.ts's header).
 */
import { afterEach, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	postAgentPrCheck,
	loadWedgeCredentialsFromEnv,
	loadAuthorshipConfigFromEnv,
	loadMaxReceiptAgeMsFromEnv,
	DEFAULT_MAX_RECEIPT_AGE_MS,
	DEFAULT_CHECK_NAME,
	type LandReceipt,
	type WedgeCredentials,
} from "../src/rail/index.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

let privateKeyPem: string;
beforeAll(() => {
	privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).privateKey;
});

function credentials(): WedgeCredentials {
	return { appId: "555", installationId: 999, privateKeyPem };
}

const HEAD_SHA = "f".repeat(40);

function mockFullFlow(opts: {
	authorLogin: string;
	headRef: string;
	commitTrailerLines?: string[];
	existingCheckRunId?: number;
	captured?: { checkRunBody?: Record<string, unknown>; checkRunMethod?: string };
}): void {
	const trailers = opts.commitTrailerLines ?? [];
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		const url = typeof input === "string" ? input : (input as { url?: string })?.url ?? "";
		const path = url.replace(/^https:\/\/api\.github\.com/, "");
		if (path === "/app/installations/999/access_tokens") {
			return new Response(JSON.stringify({ token: "installation-token-abc", expires_at: "2026-08-04T13:00:00Z" }), { status: 201 });
		}
		if (path === "/repos/acme/widgets/pulls/42") {
			return new Response(JSON.stringify({ number: 42, user: { login: opts.authorLogin }, head: { ref: opts.headRef, sha: HEAD_SHA }, base: { ref: "main" } }), { status: 200 });
		}
		if (path.startsWith("/repos/acme/widgets/pulls/42/commits")) {
			return new Response(JSON.stringify(trailers.map((line) => ({ commit: { message: `some commit\n\n${line}` } }))), { status: 200 });
		}
		if (path.startsWith("/repos/acme/widgets/commits/")) {
			const checkRuns = opts.existingCheckRunId ? [{ id: opts.existingCheckRunId, name: DEFAULT_CHECK_NAME, app: { id: 555 } }] : [];
			return new Response(JSON.stringify({ check_runs: checkRuns }), { status: 200 });
		}
		if (path.startsWith("/repos/acme/widgets/check-runs")) {
			if (opts.captured) {
				opts.captured.checkRunMethod = init?.method;
				opts.captured.checkRunBody = JSON.parse(init?.body as string);
			}
			return new Response(JSON.stringify({ id: opts.existingCheckRunId ?? 4242, html_url: "https://github.com/acme/widgets/runs/4242" }), { status: 200 });
		}
		throw new Error(`unmocked GitHub API call: ${url}`);
	}) as typeof fetch;
}

/** A receipt that VERIFIES against the mocked PR above (`HEAD_SHA`, repo "acme/widgets", a proven
 *  green gate, fresh timestamp) — the ONE fixture that should reach `success`. Every other scenario
 *  deliberately deviates from this baseline (wrong commit, failed gate, etc). */
function verifiedReceipt(over: Partial<LandReceipt> = {}): LandReceipt {
	return {
		repo: "acme/widgets",
		branch: "codex/fix",
		commit: HEAD_SHA,
		files: ["src/foo.ts"],
		insertions: 5,
		deletions: 1,
		landed: true,
		at: Date.now() - 60_000, // 1 minute old — always within the default freshness window
		gate: { status: "green", unprovenGreenRejected: false, newRegressions: [], baseWasRed: false },
		forcedWithoutProof: false,
		cost: { costUsd: 0.1, costUnknown: false },
		...over,
	};
}

test("agent-authored PR + a receipt VERIFIED against this PR's head ⇒ success, carrying the receipt in output.text", async () => {
	const captured: { checkRunBody?: Record<string, unknown> } = {};
	mockFullFlow({ authorLogin: "codex[bot]", headRef: "codex/fix", captured });
	const result = await postAgentPrCheck({ credentials: credentials(), owner: "acme", repo: "widgets", prNumber: 42, receipt: verifiedReceipt() });
	expect(result.conclusion).toBe("success");
	expect(result.reason).toBe("receipt-verified");
	expect(result.checkRunId).toBe(4242);
	expect(captured.checkRunBody?.conclusion).toBe("success");
	expect((captured.checkRunBody?.output as { text: string }).text).toContain("Landed");
});

test("gauntlet CRITICAL fix: a green receipt for a DIFFERENT commit than the PR's head is NEVER success", async () => {
	const captured: { checkRunBody?: Record<string, unknown> } = {};
	mockFullFlow({ authorLogin: "codex[bot]", headRef: "codex/fix", captured });
	const mismatched = verifiedReceipt({ commit: "0".repeat(40) }); // green, landed, proven — but for a DIFFERENT SHA
	const result = await postAgentPrCheck({ credentials: credentials(), owner: "acme", repo: "widgets", prNumber: 42, receipt: mismatched });
	expect(result.conclusion).not.toBe("success");
	expect(result.conclusion).toBe("failure");
	expect(result.reason).toBe("receipt-rejected");
	expect(result.rejection?.reason).toBe("sha-mismatch");
	expect(captured.checkRunBody?.conclusion).toBe("failure");
});

test("gauntlet CRITICAL fix: a FAILED-land receipt is never success, even if bound to the right SHA/repo", async () => {
	mockFullFlow({ authorLogin: "codex[bot]", headRef: "codex/fix" });
	const failed = verifiedReceipt({ landed: false, gate: { status: "failed", unprovenGreenRejected: false, newRegressions: ["tests/x.test.ts"], baseWasRed: false } });
	const result = await postAgentPrCheck({ credentials: credentials(), owner: "acme", repo: "widgets", prNumber: 42, receipt: failed });
	expect(result.conclusion).not.toBe("success");
	expect(result.reason).toBe("receipt-rejected");
	expect(result.rejection?.reason).toBe("gate-not-proven");
});

test("gauntlet CRITICAL fix: a receipt for a DIFFERENT repo is never success", async () => {
	mockFullFlow({ authorLogin: "codex[bot]", headRef: "codex/fix" });
	const wrongRepo = verifiedReceipt({ repo: "someone-else/other-project" });
	const result = await postAgentPrCheck({ credentials: credentials(), owner: "acme", repo: "widgets", prNumber: 42, receipt: wrongRepo });
	expect(result.conclusion).not.toBe("success");
	expect(result.rejection?.reason).toBe("repo-mismatch");
});

test("gauntlet CRITICAL fix: a stale receipt (older than the freshness window) is never success", async () => {
	mockFullFlow({ authorLogin: "codex[bot]", headRef: "codex/fix" });
	const stale = verifiedReceipt({ at: Date.now() - DEFAULT_MAX_RECEIPT_AGE_MS - 60_000 });
	const result = await postAgentPrCheck({ credentials: credentials(), owner: "acme", repo: "widgets", prNumber: 42, receipt: stale });
	expect(result.conclusion).not.toBe("success");
	expect(result.rejection?.reason).toBe("stale");
});

test("agent-authored PR + NO receipt ⇒ action_required, explains why in output.text", async () => {
	const captured: { checkRunBody?: Record<string, unknown> } = {};
	mockFullFlow({ authorLogin: "codex[bot]", headRef: "codex/fix", captured });
	const result = await postAgentPrCheck({ credentials: credentials(), owner: "acme", repo: "widgets", prNumber: 42 });
	expect(result.conclusion).toBe("action_required");
	expect(result.reason).toBe("receipt-missing");
	expect((captured.checkRunBody?.output as { summary: string }).summary).toMatch(/No glance receipt found/);
});

test("agent-authored PR + a receiptError (malformed --receipt file) ⇒ action_required with the malformed wording, not the generic one", async () => {
	const captured: { checkRunBody?: Record<string, unknown> } = {};
	mockFullFlow({ authorLogin: "codex[bot]", headRef: "codex/fix", captured });
	const result = await postAgentPrCheck({ credentials: credentials(), owner: "acme", repo: "widgets", prNumber: 42, receiptError: "not valid JSON" });
	expect(result.conclusion).toBe("action_required");
	expect(result.reason).toBe("receipt-missing");
	expect((captured.checkRunBody?.output as { summary: string }).summary).toMatch(/Malformed/);
});

test("gauntlet HIGH fix: a human-authored PR (no signal matches) gets an INFORMATIONAL success check-run — never skipped, never blocking", async () => {
	const captured: { checkRunBody?: Record<string, unknown> } = {};
	mockFullFlow({ authorLogin: "a-human", headRef: "feature/whatever", captured });
	const result = await postAgentPrCheck({ credentials: credentials(), owner: "acme", repo: "widgets", prNumber: 42, receipt: verifiedReceipt() });
	expect(result.conclusion).toBe("success");
	expect(result.reason).toBe("human-not-required");
	expect(captured.checkRunBody).toBeDefined();
	expect(captured.checkRunBody?.conclusion).toBe("success");
	expect((captured.checkRunBody?.output as { summary: string }).summary).toMatch(/Not required/);
});

test("commit-trailer signal, explicitly opted in via authorshipConfig, still gates the PR when no stronger signal matches", async () => {
	mockFullFlow({ authorLogin: "a-human", headRef: "feature/whatever", commitTrailerLines: ["Co-Authored-By: Codex <noreply@openai.com>"] });
	const result = await postAgentPrCheck({
		credentials: credentials(),
		owner: "acme",
		repo: "widgets",
		prNumber: 42,
		receipt: verifiedReceipt(),
		authorshipConfig: { botLogins: [], branchPrefixes: [], trailerKeys: ["co-authored-by"] },
	});
	expect(result.authorship.signal).toBe("co-authored-by-trailer");
	expect(result.reason).toBe("receipt-verified");
});

test("under the DEFAULT authorship config, a bare Co-Authored-By trailer does NOT gate the PR — it's the human-not-required path", async () => {
	mockFullFlow({ authorLogin: "a-human", headRef: "feature/whatever", commitTrailerLines: ["Co-Authored-By: A Human Pair <human2@example.com>"] });
	const result = await postAgentPrCheck({ credentials: credentials(), owner: "acme", repo: "widgets", prNumber: 42 });
	expect(result.authorship.isAgentAuthored).toBe(false);
	expect(result.reason).toBe("human-not-required");
	expect(result.conclusion).toBe("success");
});

test("an existing check-run for this SHA is PATCHed (idempotent upsert), not duplicated", async () => {
	const captured: { checkRunBody?: Record<string, unknown>; checkRunMethod?: string } = {};
	mockFullFlow({ authorLogin: "codex[bot]", headRef: "codex/fix", existingCheckRunId: 7777, captured });
	const result = await postAgentPrCheck({ credentials: credentials(), owner: "acme", repo: "widgets", prNumber: 42, receipt: verifiedReceipt() });
	expect(result.checkRunId).toBe(7777);
	expect(captured.checkRunMethod).toBe("PATCH");
});

// ── config.ts env loading ─────────────────────────────────────────────────────────────────────────

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
	"GLANCE_GH_APP_ID",
	"GLANCE_GH_APP_INSTALLATION_ID",
	"GLANCE_GH_APP_PRIVATE_KEY",
	"GLANCE_GH_APP_BOT_LOGINS",
	"GLANCE_GH_APP_BRANCH_PREFIXES",
	"GLANCE_GH_APP_TRAILER_KEYS",
	"GLANCE_GH_APP_RECEIPT_MAX_AGE_MS",
];
beforeAll(() => {
	for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
});
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (SAVED_ENV[k] === undefined) delete process.env[k];
		else process.env[k] = SAVED_ENV[k];
	}
});

test("loadWedgeCredentialsFromEnv: undefined when any of the three required vars is missing", () => {
	for (const k of ENV_KEYS.slice(0, 3)) delete process.env[k];
	expect(loadWedgeCredentialsFromEnv()).toBeUndefined();
});

test("loadWedgeCredentialsFromEnv: reads the private key from the FILE PATH the env var names, never inline", () => {
	const dir = mkdtempSync(join(tmpdir(), "wedge-test-"));
	const keyPath = join(dir, "app.pem");
	writeFileSync(keyPath, privateKeyPem);
	try {
		const env = { GLANCE_GH_APP_ID: "1", GLANCE_GH_APP_INSTALLATION_ID: "2", GLANCE_GH_APP_PRIVATE_KEY: keyPath } as NodeJS.ProcessEnv;
		const creds = loadWedgeCredentialsFromEnv(env);
		expect(creds).toEqual({ appId: "1", installationId: "2", privateKeyPem });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadWedgeCredentialsFromEnv: an unreadable key-file path degrades to undefined, never throws", () => {
	const env = { GLANCE_GH_APP_ID: "1", GLANCE_GH_APP_INSTALLATION_ID: "2", GLANCE_GH_APP_PRIVATE_KEY: "/nonexistent/path.pem" } as NodeJS.ProcessEnv;
	expect(loadWedgeCredentialsFromEnv(env)).toBeUndefined();
});

test("loadAuthorshipConfigFromEnv: unset vars keep the documented defaults, including empty trailerKeys", () => {
	for (const k of ENV_KEYS.slice(3, 6)) delete process.env[k];
	const cfg = loadAuthorshipConfigFromEnv();
	expect(cfg.botLogins).toContain("copilot-swe-agent[bot]");
	expect(cfg.branchPrefixes).toContain("agent/");
	expect(cfg.trailerKeys).toEqual([]);
});

test("loadAuthorshipConfigFromEnv: a comma-separated override widens just that one field", () => {
	const env = { GLANCE_GH_APP_BRANCH_PREFIXES: "myagent/, other-agent/" } as NodeJS.ProcessEnv;
	const cfg = loadAuthorshipConfigFromEnv(env);
	expect(cfg.branchPrefixes).toEqual(["myagent/", "other-agent/"]);
	// The bot-login default is untouched by overriding only branch prefixes.
	expect(cfg.botLogins).toEqual(["copilot-swe-agent[bot]"]);
});

test("loadAuthorshipConfigFromEnv: GLANCE_GH_APP_TRAILER_KEYS opts the trailer signal back in when explicitly set", () => {
	const env = { GLANCE_GH_APP_TRAILER_KEYS: "co-authored-by" } as NodeJS.ProcessEnv;
	const cfg = loadAuthorshipConfigFromEnv(env);
	expect(cfg.trailerKeys).toEqual(["co-authored-by"]);
});

test("loadMaxReceiptAgeMsFromEnv: unset ⇒ the default (24h)", () => {
	delete process.env.GLANCE_GH_APP_RECEIPT_MAX_AGE_MS;
	expect(loadMaxReceiptAgeMsFromEnv()).toBe(DEFAULT_MAX_RECEIPT_AGE_MS);
});

test("loadMaxReceiptAgeMsFromEnv: a valid override is honored", () => {
	const env = { GLANCE_GH_APP_RECEIPT_MAX_AGE_MS: "3600000" } as NodeJS.ProcessEnv;
	expect(loadMaxReceiptAgeMsFromEnv(env)).toBe(3_600_000);
});

test("loadMaxReceiptAgeMsFromEnv: a garbage value degrades to the default, never NaN/throws", () => {
	const env = { GLANCE_GH_APP_RECEIPT_MAX_AGE_MS: "not-a-number" } as NodeJS.ProcessEnv;
	expect(loadMaxReceiptAgeMsFromEnv(env)).toBe(DEFAULT_MAX_RECEIPT_AGE_MS);
});

test("loadMaxReceiptAgeMsFromEnv: a negative override is rejected, degrades to the default", () => {
	const env = { GLANCE_GH_APP_RECEIPT_MAX_AGE_MS: "-5" } as NodeJS.ProcessEnv;
	expect(loadMaxReceiptAgeMsFromEnv(env)).toBe(DEFAULT_MAX_RECEIPT_AGE_MS);
});

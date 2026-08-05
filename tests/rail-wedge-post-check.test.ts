/**
 * End-to-end coverage for the wedge's orchestrator (glance#337, rail T9, src/rail/wedge/post-check.ts)
 * against a fully mocked GitHub API: JWT mint (no network) → installation-token exchange → PR fetch →
 * agent-authorship gate → check-run upsert. Also covers env-var config loading
 * (loadWedgeCredentialsFromEnv / loadAuthorshipConfigFromEnv), since the CLI (scripts/post-wedge-check.ts)
 * has no unit coverage of its own — this is the closest thing to it.
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
			return new Response(
				JSON.stringify({ number: 42, user: { login: opts.authorLogin }, head: { ref: opts.headRef, sha: "f".repeat(40) }, base: { ref: "main" } }),
				{ status: 200 },
			);
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

function greenReceipt(): LandReceipt {
	return {
		repo: "acme/widgets",
		branch: "codex/fix",
		commit: "abc1234",
		files: ["src/foo.ts"],
		insertions: 5,
		deletions: 1,
		landed: true,
		at: 1_722_800_000_000,
		gate: { status: "green", unprovenGreenRejected: false, newRegressions: [], baseWasRed: false },
		forcedWithoutProof: false,
		cost: { costUsd: 0.1, costUnknown: false },
	};
}

test("agent-authored PR + a receipt ⇒ success check-run carrying the receipt in output.text", async () => {
	const captured: { checkRunBody?: Record<string, unknown> } = {};
	mockFullFlow({ authorLogin: "codex[bot]", headRef: "codex/fix", captured });
	const result = await postAgentPrCheck({ credentials: credentials(), owner: "acme", repo: "widgets", prNumber: 42, receipt: greenReceipt() });
	expect(result.skipped).toBe(false);
	if (result.skipped) throw new Error("unreachable");
	expect(result.conclusion).toBe("success");
	expect(result.checkRunId).toBe(4242);
	expect(captured.checkRunBody?.conclusion).toBe("success");
	expect((captured.checkRunBody?.output as { text: string }).text).toContain("Landed");
});

test("agent-authored PR + NO receipt ⇒ action_required, explains why in output.text", async () => {
	const captured: { checkRunBody?: Record<string, unknown> } = {};
	mockFullFlow({ authorLogin: "codex[bot]", headRef: "codex/fix", captured });
	const result = await postAgentPrCheck({ credentials: credentials(), owner: "acme", repo: "widgets", prNumber: 42 });
	expect(result.skipped).toBe(false);
	if (result.skipped) throw new Error("unreachable");
	expect(result.conclusion).toBe("action_required");
	expect((captured.checkRunBody?.output as { summary: string }).summary).toMatch(/No glance receipt found/);
});

test("human-authored PR (no signal matches) ⇒ skipped, NO check-run posted at all", async () => {
	const captured: { checkRunBody?: Record<string, unknown> } = {};
	mockFullFlow({ authorLogin: "a-human", headRef: "feature/whatever", captured });
	const result = await postAgentPrCheck({ credentials: credentials(), owner: "acme", repo: "widgets", prNumber: 42, receipt: greenReceipt() });
	expect(result.skipped).toBe(true);
	if (!result.skipped) throw new Error("unreachable");
	expect(result.reason).toBe("not-agent-authored");
	expect(captured.checkRunBody).toBeUndefined();
});

test("commit-trailer signal alone (weakest in the chain) still gates the PR when no stronger signal matches", async () => {
	mockFullFlow({ authorLogin: "a-human", headRef: "feature/whatever", commitTrailerLines: ["Co-Authored-By: Codex <noreply@openai.com>"] });
	const result = await postAgentPrCheck({ credentials: credentials(), owner: "acme", repo: "widgets", prNumber: 42, receipt: greenReceipt() });
	expect(result.skipped).toBe(false);
	if (result.skipped) throw new Error("unreachable");
	expect(result.authorship.signal).toBe("co-authored-by-trailer");
});

test("an existing check-run for this SHA is PATCHed (idempotent upsert), not duplicated", async () => {
	const captured: { checkRunBody?: Record<string, unknown>; checkRunMethod?: string } = {};
	mockFullFlow({ authorLogin: "codex[bot]", headRef: "codex/fix", existingCheckRunId: 7777, captured });
	const result = await postAgentPrCheck({ credentials: credentials(), owner: "acme", repo: "widgets", prNumber: 42, receipt: greenReceipt() });
	expect(result.skipped).toBe(false);
	if (result.skipped) throw new Error("unreachable");
	expect(result.checkRunId).toBe(7777);
	expect(captured.checkRunMethod).toBe("PATCH");
});

// ── config.ts env loading ─────────────────────────────────────────────────────────────────────────

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = ["GLANCE_GH_APP_ID", "GLANCE_GH_APP_INSTALLATION_ID", "GLANCE_GH_APP_PRIVATE_KEY", "GLANCE_GH_APP_BOT_LOGINS", "GLANCE_GH_APP_BRANCH_PREFIXES", "GLANCE_GH_APP_TRAILER_KEYS"];
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

test("loadAuthorshipConfigFromEnv: unset vars keep the documented defaults", () => {
	for (const k of ENV_KEYS.slice(3)) delete process.env[k];
	const cfg = loadAuthorshipConfigFromEnv();
	expect(cfg.botLogins).toContain("copilot-swe-agent[bot]");
	expect(cfg.branchPrefixes).toContain("agent/");
});

test("loadAuthorshipConfigFromEnv: a comma-separated override widens just that one field", () => {
	const env = { GLANCE_GH_APP_BRANCH_PREFIXES: "myagent/, other-agent/" } as NodeJS.ProcessEnv;
	const cfg = loadAuthorshipConfigFromEnv(env);
	expect(cfg.branchPrefixes).toEqual(["myagent/", "other-agent/"]);
	// The bot-login default is untouched by overriding only branch prefixes.
	expect(cfg.botLogins).toEqual(["copilot-swe-agent[bot]"]);
});

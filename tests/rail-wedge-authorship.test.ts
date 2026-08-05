/**
 * Golden coverage for the agent-authorship gate (glance#337, rail T9, src/rail/wedge/authorship.ts) —
 * R1's fallback chain: bot-login allowlist → branch-prefix → commit-trailer, first match wins, and
 * "none of the above" is honestly reported as human-authored rather than guessed.
 */
import { expect, test } from "bun:test";
import { classifyAgentAuthorship, DEFAULT_AUTHORSHIP_CONFIG, type PullRequestInfo } from "../src/rail/index.ts";

function pr(over: Partial<PullRequestInfo> = {}): PullRequestInfo {
	return {
		number: 1,
		authorLogin: "a-human",
		headRef: "feature/whatever",
		headSha: "0".repeat(40),
		baseRef: "main",
		commitTrailerLines: [],
		...over,
	};
}

test("bot-login allowlist match wins first, even when other signals also match", () => {
	const v = classifyAgentAuthorship(
		pr({ authorLogin: "copilot-swe-agent[bot]", headRef: "copilot/some-fix", commitTrailerLines: ["Co-Authored-By: Codex <noreply@openai.com>"] }),
	);
	expect(v.isAgentAuthored).toBe(true);
	expect(v.signal).toBe("bot-login");
	expect(v.detail).toContain("copilot-swe-agent[bot]");
});

test("bot-login match is case-insensitive", () => {
	const v = classifyAgentAuthorship(pr({ authorLogin: "Copilot-SWE-Agent[Bot]" }));
	expect(v.isAgentAuthored).toBe(true);
	expect(v.signal).toBe("bot-login");
});

test("branch-prefix match when no bot-login matches", () => {
	const v = classifyAgentAuthorship(pr({ headRef: "agent/fix-the-thing" }));
	expect(v.isAgentAuthored).toBe(true);
	expect(v.signal).toBe("branch-prefix");
	expect(v.detail).toContain("agent/");
});

test("branch-prefix match is case-insensitive on the branch name", () => {
	const v = classifyAgentAuthorship(pr({ headRef: "Codex/some-branch" }));
	expect(v.isAgentAuthored).toBe(true);
	expect(v.signal).toBe("branch-prefix");
});

test("commit-trailer match when neither bot-login nor branch-prefix match", () => {
	const v = classifyAgentAuthorship(pr({ commitTrailerLines: ["Reviewed-by: someone", "Co-Authored-By: Devin <bot@devin.ai>"] }));
	expect(v.isAgentAuthored).toBe(true);
	expect(v.signal).toBe("co-authored-by-trailer");
});

test("commit-trailer key match is case-insensitive on both the key and the trailer line", () => {
	const v = classifyAgentAuthorship(pr({ commitTrailerLines: ["CO-AUTHORED-BY: Someone <x@y.com>"] }));
	expect(v.isAgentAuthored).toBe(true);
	expect(v.signal).toBe("co-authored-by-trailer");
});

test("no signal matches ⇒ honestly reported human-authored, never guessed", () => {
	const v = classifyAgentAuthorship(pr());
	expect(v.isAgentAuthored).toBe(false);
	expect(v.signal).toBe("none");
	expect(v.detail).toContain("human-authored");
});

test("a trailer-shaped line that is NOT the configured key does not match", () => {
	const v = classifyAgentAuthorship(pr({ commitTrailerLines: ["Signed-off-by: Someone <x@y.com>"] }));
	expect(v.isAgentAuthored).toBe(false);
});

test("branch prefix must anchor at the start, not appear mid-string", () => {
	const v = classifyAgentAuthorship(pr({ headRef: "feature/not-agent/whatever" }));
	expect(v.isAgentAuthored).toBe(false);
});

test("empty author login never matches the bot-login allowlist", () => {
	const v = classifyAgentAuthorship(pr({ authorLogin: "" }));
	expect(v.signal).not.toBe("bot-login");
});

test("configurable allowlist: a custom bot login not in the default set is honored", () => {
	const v = classifyAgentAuthorship(pr({ authorLogin: "my-custom-agent[bot]" }), {
		...DEFAULT_AUTHORSHIP_CONFIG,
		botLogins: ["my-custom-agent[bot]"],
	});
	expect(v.isAgentAuthored).toBe(true);
	expect(v.signal).toBe("bot-login");
});

test("configurable allowlist: narrowing branchPrefixes to [] disables that signal", () => {
	const v = classifyAgentAuthorship(pr({ headRef: "agent/whatever" }), { ...DEFAULT_AUTHORSHIP_CONFIG, branchPrefixes: [] });
	expect(v.isAgentAuthored).toBe(false);
});

test("default config's bot login is exactly copilot-swe-agent[bot] — the one GitHub itself enforces", () => {
	expect(DEFAULT_AUTHORSHIP_CONFIG.botLogins).toContain("copilot-swe-agent[bot]");
});

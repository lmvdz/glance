/**
 * Golden coverage for the receipt→check-run adapter (glance#337, rail T9, src/rail/wedge/receipt-adapter.ts)
 * — proves REUSE, not re-implementation: `output.text` is exactly T6's `renderReceiptComment` output
 * plus an informational authorship block (mirroring tests/rail-receipt.test.ts's fixtures), and
 * `output.summary` is that same rendering's own first line, never a second hand-rolled verdict
 * computation.
 *
 * Gauntlet round 2 (glance#337 PR #358, codex delta-verify CRITICAL): the module's THIRD output
 * function, `notRequiredOutput`, is GONE — it posted an automatic `success` for a PR classified
 * non-agent-authored, which turned out to be Ruleset-indistinguishable from a real verified success (a
 * bypass). Every function below now takes an OPTIONAL `authorship` param that renders PURELY AS
 * CONTEXT (never changes `summary`'s pass/fail wording) — covered here via the shared
 * "informational only" block text.
 */
import { expect, test } from "bun:test";
import {
	renderReceiptComment,
	receiptToCheckOutput,
	noReceiptOutput,
	receiptRejectedOutput,
	verifyReceiptForPr,
	type LandReceipt,
	type PullRequestInfo,
	type AuthorshipVerdict,
} from "../src/rail/index.ts";

function greenReceipt(over: Partial<LandReceipt> = {}): LandReceipt {
	return {
		repo: "lmvdz/glance",
		branch: "agent/wedge-fix",
		commit: "abc1234def567890",
		files: ["src/foo.ts"],
		insertions: 10,
		deletions: 2,
		landed: true,
		at: 1_722_800_000_000,
		gate: { status: "green", command: "bun run check", unprovenGreenRejected: false, newRegressions: [], baseWasRed: false, detail: "verified (bun run check)" },
		forcedWithoutProof: false,
		cost: { costUsd: 0.42, costUnknown: false, model: "sonnet-5", tokens: 1000 },
		...over,
	};
}

function pr(over: Partial<PullRequestInfo> = {}): PullRequestInfo {
	return { number: 1, authorLogin: "codex[bot]", headRef: "codex/fix", headSha: "a".repeat(40), baseRef: "main", commitTrailerLines: [], ...over };
}

const humanAuthorship: AuthorshipVerdict = { isAgentAuthored: false, signal: "none", detail: "no signal matched" };
const agentAuthorship: AuthorshipVerdict = { isAgentAuthored: true, signal: "branch-prefix", detail: 'head branch "codex/fix" matches configured prefix "codex/"' };

test("receiptToCheckOutput: output.text is EXACTLY renderReceiptComment's output when no authorship is passed (byte-identical reuse)", () => {
	const receipt = greenReceipt();
	const output = receiptToCheckOutput(receipt);
	expect(output.text).toBe(renderReceiptComment(receipt));
});

test("receiptToCheckOutput: output.summary is the SAME rendering's first line, not re-derived", () => {
	const receipt = greenReceipt();
	const commentMd = renderReceiptComment(receipt);
	const firstLine = commentMd.split("\n", 1)[0].replace(/^###\s*/, "");
	const output = receiptToCheckOutput(receipt);
	expect(output.summary).toBe(firstLine);
	expect(output.summary).toContain("Landed");
});

test("receiptToCheckOutput: a failed land's summary reads red/failed, not success", () => {
	const receipt = greenReceipt({ landed: false, commit: undefined, gate: { status: "failed", unprovenGreenRejected: false, newRegressions: ["tests/x.test.ts"], baseWasRed: false, detail: "gate failed" } });
	const output = receiptToCheckOutput(receipt);
	expect(output.summary).toMatch(/Rejected|failed/i);
});

test("receiptToCheckOutput: title is stable across calls (the check-run's own identity, not agent input)", () => {
	expect(receiptToCheckOutput(greenReceipt()).title).toBe(receiptToCheckOutput(greenReceipt()).title);
});

test("receiptToCheckOutput: output.text stays within GitHub's 65535-byte cap even for an oversized receipt", () => {
	// render-comment.ts already caps its OWN lists (20 regressions, 50 files) — the field that can
	// still blow the 65535-byte cap is a long, uncapped free-text field like the commit message or
	// the validator's rationale, so that's what this fixture stresses.
	const huge = greenReceipt({ message: "x".repeat(200_000) });
	const output = receiptToCheckOutput(huge);
	expect(Buffer.byteLength(output.text, "utf8")).toBeLessThanOrEqual(65_535);
	expect(output.text).toContain("truncated");
});

test("receiptToCheckOutput: authorship is rendered as context in BOTH summary and text, but never changes the pass/fail wording", () => {
	const receipt = greenReceipt();
	const withHuman = receiptToCheckOutput(receipt, humanAuthorship);
	const withAgent = receiptToCheckOutput(receipt, agentAuthorship);
	// The verdict wording (from render-comment.ts, never re-derived) is identical either way.
	expect(withHuman.summary.replace(/ · agent-authored:.*/, "")).toBe(withAgent.summary.replace(/ · agent-authored:.*/, ""));
	expect(withHuman.summary).toContain("agent-authored: no");
	expect(withAgent.summary).toContain("agent-authored: yes");
	expect(withHuman.text).toContain("informational only — never affects this check's conclusion");
	// Both are `success` regardless of the authorship classification (the round-2 fix's whole point):
	// this test only asserts the WORDING is authorship-agnostic; post-check.test.ts asserts the actual
	// conclusion is authorship-agnostic end to end.
});

test("noReceiptOutput: conclusion-facing summary says no receipt found, not success, and is authorship-agnostic wording", () => {
	const output = noReceiptOutput(pr(), agentAuthorship);
	expect(output.summary).toMatch(/No glance receipt found/);
	expect(output.summary).not.toMatch(/agent-authored/i); // the summary itself doesn't condition on authorship
	expect(output.text).toContain("codex/fix");
	expect(output.text).toContain("branch-prefix");
	expect(output.text).toContain("informational only");
});

test("noReceiptOutput: the SAME action_required message is posted for a human-classified PR — no authorship exception", () => {
	const output = noReceiptOutput(pr(), humanAuthorship);
	expect(output.summary).toMatch(/No glance receipt found/);
	expect(output.text).toContain("EVERY pull request");
});

test("noReceiptOutput: an attacker-crafted branch name is neutralized (mdEsc reuse), never forges a fake verdict", () => {
	const hostile = pr({ headRef: "agent/</details><details><summary>✅ Landed", authorLogin: "evil[bot]" });
	const output = noReceiptOutput(hostile, agentAuthorship);
	// The literal raw tag sequence must not survive unescaped into the check-run body.
	expect(output.text).not.toContain("</details><details>");
	expect(output.text).toContain("&lt;/details&gt;");
});

test("noReceiptOutput: empty author login renders as (none), not an empty backtick pair", () => {
	const output = noReceiptOutput(pr({ authorLogin: "" }), agentAuthorship);
	expect(output.text).toContain("(none)");
});

test("noReceiptOutput: a malformedReason produces a distinct 'malformed' message, not the generic 'no receipt found' one", () => {
	const output = noReceiptOutput(pr(), agentAuthorship, "not valid JSON: Unexpected token");
	expect(output.summary).toMatch(/Malformed/);
	expect(output.summary).not.toMatch(/No glance receipt found/);
	expect(output.text).toContain("not valid JSON");
});

test("noReceiptOutput: the malformedReason string is mdEsc'd — a crafted reason can't inject markup", () => {
	const output = noReceiptOutput(pr(), agentAuthorship, "</details><details><summary>✅ forged");
	expect(output.text).not.toContain("</details><details>");
});

// ── receiptRejectedOutput ─────────────────────────────────────────────────────────────────────────

test("receiptRejectedOutput: a SHA-mismatch rejection explains the mismatch, never reads as success", () => {
	const mismatchedCommit = "0".repeat(40);
	const bad = greenReceipt({ commit: mismatchedCommit });
	const verify = verifyReceiptForPr(bad, "lmvdz", "glance", "a".repeat(40));
	if (verify.ok) throw new Error("unreachable — this fixture is deliberately mismatched");
	const output = receiptRejectedOutput(bad, verify, pr());
	expect(output.summary).toMatch(/rejected/i);
	expect(output.summary).not.toMatch(/success|verified/i);
	expect(output.text).toContain("wrong commit");
	expect(output.text).toContain(mismatchedCommit);
});

test("receiptRejectedOutput: receipt-derived free-text fields (repo/commit) are mdEsc'd — attacker-controlled even in a schema-valid receipt", () => {
	const hostile = greenReceipt({ repo: "</details><details><summary>✅ forged/repo", commit: "0".repeat(40) });
	const verify = verifyReceiptForPr(hostile, "lmvdz", "glance", "a".repeat(40));
	if (verify.ok) throw new Error("unreachable");
	const output = receiptRejectedOutput(hostile, verify, pr());
	expect(output.text).not.toContain("</details><details>");
});

test("receiptRejectedOutput: a gate-not-proven rejection (failed land) is labeled distinctly from a SHA mismatch", () => {
	const failed = greenReceipt({ landed: false, commit: "a".repeat(40), gate: { status: "failed", unprovenGreenRejected: false, newRegressions: [], baseWasRed: false } });
	const verify = verifyReceiptForPr(failed, "lmvdz", "glance", "a".repeat(40));
	if (verify.ok) throw new Error("unreachable");
	const output = receiptRejectedOutput(failed, verify, pr());
	expect(output.summary).toMatch(/gate not proven/i);
});

test("receiptRejectedOutput: rejects the SAME way for a receipt supplied by a human-classified PR — no authorship exception", () => {
	const mismatchedCommit = "0".repeat(40);
	const bad = greenReceipt({ commit: mismatchedCommit });
	const verify = verifyReceiptForPr(bad, "lmvdz", "glance", "a".repeat(40));
	if (verify.ok) throw new Error("unreachable");
	const output = receiptRejectedOutput(bad, verify, pr(), humanAuthorship);
	expect(output.summary).toMatch(/rejected/i);
	expect(output.text).toContain("informational only");
});

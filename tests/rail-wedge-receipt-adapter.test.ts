/**
 * Golden coverage for the receipt→check-run adapter (glance#337, rail T9, src/rail/wedge/receipt-adapter.ts)
 * — proves REUSE, not re-implementation: `output.text` is exactly T6's `renderReceiptComment` output
 * (mirroring tests/rail-receipt.test.ts's fixtures), and `output.summary` is that same rendering's own
 * first line, never a second hand-rolled verdict computation.
 */
import { expect, test } from "bun:test";
import { renderReceiptComment, receiptToCheckOutput, noReceiptOutput, type LandReceipt, type PullRequestInfo, type AuthorshipVerdict } from "../src/rail/index.ts";

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

test("receiptToCheckOutput: output.text is EXACTLY renderReceiptComment's output (byte-identical reuse)", () => {
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

test("noReceiptOutput: conclusion-facing summary says no receipt found, not success", () => {
	const authorship: AuthorshipVerdict = { isAgentAuthored: true, signal: "branch-prefix", detail: 'head branch "codex/fix" matches configured prefix "codex/"' };
	const output = noReceiptOutput(pr(), authorship);
	expect(output.summary).toMatch(/No glance receipt found/);
	expect(output.text).toContain("codex/fix");
	expect(output.text).toContain("branch-prefix");
});

test("noReceiptOutput: an attacker-crafted branch name is neutralized (mdEsc reuse), never forges a fake verdict", () => {
	const authorship: AuthorshipVerdict = { isAgentAuthored: true, signal: "branch-prefix", detail: "x" };
	const hostile = pr({ headRef: "agent/</details><details><summary>✅ Landed", authorLogin: "evil[bot]" });
	const output = noReceiptOutput(hostile, authorship);
	// The literal raw tag sequence must not survive unescaped into the check-run body.
	expect(output.text).not.toContain("</details><details>");
	expect(output.text).toContain("&lt;/details&gt;");
});

test("noReceiptOutput: empty author login renders as (none), not an empty backtick pair", () => {
	const authorship: AuthorshipVerdict = { isAgentAuthored: true, signal: "branch-prefix", detail: "x" };
	const output = noReceiptOutput(pr({ authorLogin: "" }), authorship);
	expect(output.text).toContain("(none)");
});

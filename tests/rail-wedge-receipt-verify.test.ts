/**
 * Golden coverage for the receipt-verification policy (glance#337, rail T9 gauntlet round 1 CRITICAL
 * fix, src/rail/wedge/receipt-verify.ts): the four independent checks — repo match, SHA match, proven
 * gate outcome, freshness — that decide whether a receipt is trusted as proof for a check-run, instead
 * of the previous "any truthy object greens the check" bug.
 */
import { expect, test } from "bun:test";
import { DEFAULT_MAX_RECEIPT_AGE_MS, verifyReceiptForPr, type LandReceipt } from "../src/rail/index.ts";

const HEAD_SHA = "f".repeat(40);
const NOW = 1_722_800_000_000;

function receipt(over: Partial<LandReceipt> = {}): LandReceipt {
	return {
		repo: "acme/widgets",
		branch: "codex/fix",
		commit: HEAD_SHA,
		files: ["src/foo.ts"],
		landed: true,
		at: NOW - 60_000, // 1 minute old — well within the default window
		gate: { status: "green", unprovenGreenRejected: false, newRegressions: [], baseWasRed: false },
		forcedWithoutProof: false,
		cost: { costUnknown: true },
		...over,
	};
}

test("all four checks pass ⇒ ok:true", () => {
	const v = verifyReceiptForPr(receipt(), "acme", "widgets", HEAD_SHA, { now: NOW });
	expect(v).toEqual({ ok: true });
});

test("red-baseline gate status also counts as proven (main not green, but this change introduced no new failures)", () => {
	const v = verifyReceiptForPr(receipt({ gate: { status: "red-baseline", unprovenGreenRejected: false, newRegressions: [], baseWasRed: true } }), "acme", "widgets", HEAD_SHA, { now: NOW });
	expect(v).toEqual({ ok: true });
});

// ── 1. repo match ─────────────────────────────────────────────────────────────────────────────────

test("repo mismatch is rejected", () => {
	const v = verifyReceiptForPr(receipt({ repo: "acme/OTHER-repo" }), "acme", "widgets", HEAD_SHA, { now: NOW });
	expect(v.ok).toBe(false);
	if (v.ok) throw new Error("unreachable");
	expect(v.reason).toBe("repo-mismatch");
});

test("repo match is case-insensitive (GitHub itself routes owner/repo case-insensitively)", () => {
	const v = verifyReceiptForPr(receipt({ repo: "ACME/Widgets" }), "acme", "widgets", HEAD_SHA, { now: NOW });
	expect(v).toEqual({ ok: true });
});

// ── 2. SHA match — the gauntlet's headline scenario ──────────────────────────────────────────────

test("a green receipt for a DIFFERENT commit is rejected — SHA mismatch, never success", () => {
	const v = verifyReceiptForPr(receipt({ commit: "abc1234abc1234abc1234abc1234abc1234abcd" }), "acme", "widgets", HEAD_SHA, { now: NOW });
	expect(v.ok).toBe(false);
	if (v.ok) throw new Error("unreachable");
	expect(v.reason).toBe("sha-mismatch");
});

test("a receipt with no commit (nothing merged) is rejected as a SHA mismatch, not a crash", () => {
	const v = verifyReceiptForPr(receipt({ commit: undefined, landed: false }), "acme", "widgets", HEAD_SHA, { now: NOW });
	expect(v.ok).toBe(false);
	if (v.ok) throw new Error("unreachable");
	expect(v.reason).toBe("sha-mismatch");
});

test("SHA match is case-insensitive (git SHAs are canonically lowercase, but never trust casing)", () => {
	const v = verifyReceiptForPr(receipt({ commit: HEAD_SHA.toUpperCase() }), "acme", "widgets", HEAD_SHA, { now: NOW });
	expect(v).toEqual({ ok: true });
});

// ── 3. gate outcome — a failed-land receipt must NOT verify ──────────────────────────────────────

test("a failed-land receipt is NOT success — gate-not-proven", () => {
	const v = verifyReceiptForPr(receipt({ landed: false, gate: { status: "failed", unprovenGreenRejected: false, newRegressions: ["x"], baseWasRed: false } }), "acme", "widgets", HEAD_SHA, {
		now: NOW,
	});
	expect(v.ok).toBe(false);
	if (v.ok) throw new Error("unreachable");
	expect(v.reason).toBe("gate-not-proven");
});

test("unproven-rejected gate status is rejected even if landed happens to be true", () => {
	const v = verifyReceiptForPr(receipt({ gate: { status: "unproven-rejected", unprovenGreenRejected: true, newRegressions: [], baseWasRed: false } }), "acme", "widgets", HEAD_SHA, { now: NOW });
	expect(v.ok).toBe(false);
	if (v.ok) throw new Error("unreachable");
	expect(v.reason).toBe("gate-not-proven");
});

test("no-gate status is rejected — nothing proved the land, even though it's recorded as landed", () => {
	const v = verifyReceiptForPr(receipt({ gate: { status: "no-gate", unprovenGreenRejected: false, newRegressions: [], baseWasRed: false } }), "acme", "widgets", HEAD_SHA, { now: NOW });
	expect(v.ok).toBe(false);
	if (v.ok) throw new Error("unreachable");
	expect(v.reason).toBe("gate-not-proven");
});

test("forcedWithoutProof is rejected even with an otherwise-green gate status", () => {
	const v = verifyReceiptForPr(receipt({ forcedWithoutProof: true }), "acme", "widgets", HEAD_SHA, { now: NOW });
	expect(v.ok).toBe(false);
	if (v.ok) throw new Error("unreachable");
	expect(v.reason).toBe("gate-not-proven");
});

test("landed:false is rejected even with gate.status green (an inconsistent/malformed-but-schema-valid receipt fails closed)", () => {
	const v = verifyReceiptForPr(receipt({ landed: false }), "acme", "widgets", HEAD_SHA, { now: NOW });
	expect(v.ok).toBe(false);
	if (v.ok) throw new Error("unreachable");
	expect(v.reason).toBe("gate-not-proven");
});

// ── 4. freshness ──────────────────────────────────────────────────────────────────────────────────

test("a receipt older than the default 24h window is rejected as stale", () => {
	const v = verifyReceiptForPr(receipt({ at: NOW - DEFAULT_MAX_RECEIPT_AGE_MS - 1 }), "acme", "widgets", HEAD_SHA, { now: NOW });
	expect(v.ok).toBe(false);
	if (v.ok) throw new Error("unreachable");
	expect(v.reason).toBe("stale");
});

test("a receipt exactly at the freshness boundary is still accepted", () => {
	const v = verifyReceiptForPr(receipt({ at: NOW - DEFAULT_MAX_RECEIPT_AGE_MS }), "acme", "widgets", HEAD_SHA, { now: NOW });
	expect(v).toEqual({ ok: true });
});

test("a future-timestamped receipt (clock skew or a forged timestamp) is rejected as stale, never accepted", () => {
	const v = verifyReceiptForPr(receipt({ at: NOW + 60_000 }), "acme", "widgets", HEAD_SHA, { now: NOW });
	expect(v.ok).toBe(false);
	if (v.ok) throw new Error("unreachable");
	expect(v.reason).toBe("stale");
});

test("a custom maxAgeMs override narrows the freshness window", () => {
	const v = verifyReceiptForPr(receipt({ at: NOW - 120_000 }), "acme", "widgets", HEAD_SHA, { now: NOW, maxAgeMs: 60_000 });
	expect(v.ok).toBe(false);
	if (v.ok) throw new Error("unreachable");
	expect(v.reason).toBe("stale");
});

// ── check ordering (repo/SHA checked before the more expensive-to-explain gate/freshness checks) ──

test("repo-mismatch is reported even when the SHA also would have mismatched — first failing check wins", () => {
	const v = verifyReceiptForPr(receipt({ repo: "other/repo", commit: "0".repeat(40) }), "acme", "widgets", HEAD_SHA, { now: NOW });
	expect(v.ok).toBe(false);
	if (v.ok) throw new Error("unreachable");
	expect(v.reason).toBe("repo-mismatch");
});

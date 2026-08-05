import { expect, test, describe } from "bun:test";
import {
	renderReceiptHtml,
	renderReceiptComment,
	mdEsc,
	classifyLand,
	writeLandReceipt,
	landReceiptDir,
	landReceiptFilename,
	type LandReceipt,
	type PanelVerdict,
} from "../src/rail/index.ts";
import type { ValidationRecord } from "../src/types.ts";
import type { ReviewerPrecisionStamp } from "../src/memory/index.ts";
import type { LandResult } from "../src/land.ts";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Golden coverage for the land receipt surface (T6, glance#334). These pin the invariants that make
 * the receipt trustworthy — honest state in FORM, no fabricated numbers, no $0 for unattributed cost,
 * a red state when a gate failed — rather than a brittle byte-for-byte snapshot.
 */

const measured: ReviewerPrecisionStamp = { lineage: "codex", n: 52, survived: 39, survivedRate: 39 / 52, provisional: false };
const unmeasured: ReviewerPrecisionStamp = { lineage: "grok", n: 0, survived: 0, provisional: true };

function validation(precision?: ReviewerPrecisionStamp, verdict: ValidationRecord["verdict"] = "pass"): ValidationRecord {
	return {
		verdict,
		agreement: verdict === "pass" ? 1 : 0.5,
		confidence: 0.9,
		perCriterion: [{ id: "c1", satisfied: verdict === "pass" }],
		rationale: "all declared criteria satisfied",
		model: precision?.lineage ?? "codex",
		reviewerPrecision: precision,
		ranAt: 1_700_000_000_000,
	};
}

/** A representative clean land: gates green, one measured reviewer, a rollback point, a known cost. */
function greenReceipt(over: Partial<LandReceipt> = {}): LandReceipt {
	return {
		repo: "lmvdz/glance",
		branch: "rail/t6-receipt-surface",
		commit: "abc1234def567890",
		files: ["src/rail/receipt/render-html.ts", "src/rail/receipt/write.ts"],
		insertions: 240,
		deletions: 12,
		landed: true,
		at: 1_722_800_000_000,
		gate: { status: "green", command: "bun run check", unprovenGreenRejected: false, newRegressions: [], baseWasRed: false, detail: "merged rail/t6 (fast-forward); verified (bun run check)" },
		validation: validation(measured),
		rollbackPoint: "0009998887776665",
		forcedWithoutProof: false,
		cost: { costUsd: 1.2345, costUnknown: false, model: "opus-4.8", tokens: 84213 },
		...over,
	};
}

describe("renderReceiptHtml", () => {
	test("representative land: answers the five questions, self-contained + theme-aware", () => {
		const html = renderReceiptHtml(greenReceipt());
		// self-contained
		expect(html.startsWith("<!doctype html>")).toBe(true);
		expect(html).toContain("<style>");
		expect(html).not.toContain("http://");
		expect(html).not.toContain("https://");
		expect(html).not.toContain("<script");
		expect(html).not.toContain("src=");
		// theme-aware, both directions
		expect(html).toContain("prefers-color-scheme: dark");
		expect(html).toContain('data-theme="dark"');
		expect(html).toContain('data-theme="light"');
		expect(html).toContain('name="viewport"');
		// wide content scrolls in its own container
		expect(html).toContain("overflow-x: auto");
		// 1. WHAT landed
		expect(html).toContain("rail/t6-receipt-surface");
		expect(html).toContain("abc1234def"); // short sha
		expect(html).toContain("+240");
		expect(html).toContain("−12");
		// 2. WHAT PROVED IT
		expect(html).toContain("gates green");
		expect(html).toContain("bun run check");
		// 3. WHO REVIEWED IT — measured precision, real number
		expect(html).toContain("codex · 75% (n=52)");
		// 4. ROLLBACK POINT
		expect(html).toContain("0009998887"); // short rollback sha
		// 5. COST — real dollars, honest
		expect(html).toContain("$1.23");
		expect(html).toContain("opus-4.8");
		// honest verdict encoded in form
		expect(html).toContain('data-status="ok"');
		expect(html).toContain("Landed");
	});

	test("n=0 reviewer renders 'unmeasured', never a fabricated percentage", () => {
		const html = renderReceiptHtml(greenReceipt({ validation: validation(unmeasured) }));
		expect(html).toContain("grok · unmeasured (n=0)");
		expect(html).not.toContain("grok · 0%"); // must not read as measured-and-zero
	});

	test("costUnknown shows 'cost unattributed', never $0", () => {
		const html = renderReceiptHtml(greenReceipt({ cost: { costUsd: undefined, costUnknown: true, model: "sonnet-5" } }));
		expect(html).toContain("cost unattributed");
		expect(html).not.toContain("$0.00");
		expect(html).not.toContain("$0.0000");
	});

	test("a genuinely-free measured run shows $0.0000, NOT unattributed", () => {
		const html = renderReceiptHtml(greenReceipt({ cost: { costUsd: 0, costUnknown: false, model: "free-model" } }));
		expect(html).toContain("$0.0000");
		expect(html).not.toContain("cost unattributed");
	});

	test("failed-gate land renders the red/failed state with the failure set", () => {
		const failed = greenReceipt({
			landed: false,
			commit: undefined,
			rollbackPoint: undefined,
			gate: {
				status: "failed",
				command: "bun test",
				unprovenGreenRejected: false,
				newRegressions: ["tests/foo.test.ts > does the thing", "tests/bar.test.ts > another"],
				baseWasRed: false,
				detail: "regression gate (bun test) blocked rail/x: 2 new failure(s)",
			},
			validation: validation(measured, "veto"),
			cost: { costUsd: 0.5, costUnknown: false },
		});
		const html = renderReceiptHtml(failed);
		expect(html).toContain('data-status="bad"');
		expect(html).toContain("Rejected");
		expect(html).toContain("gate failed");
		expect(html).toContain("tests/foo.test.ts &gt; does the thing"); // escaped, listed
		expect(html).toContain("class=\"failures\"");
		expect(html).toContain("nothing merged");
		expect(html).toContain("veto");
	});

	test("unproven-green rejection renders honestly", () => {
		const html = renderReceiptHtml(
			greenReceipt({ landed: false, commit: undefined, rollbackPoint: undefined, gate: { status: "unproven-rejected", unprovenGreenRejected: true, newRegressions: [], baseWasRed: false } }),
		);
		expect(html).toContain('data-status="bad"');
		expect(html).toContain("unproven pass rejected");
		expect(html).toContain("could not be trusted");
	});

	test("red-baseline land is amber, not green", () => {
		const html = renderReceiptHtml(greenReceipt({ gate: { status: "red-baseline", unprovenGreenRejected: false, newRegressions: [], baseWasRed: true } }));
		expect(html).toContain('data-status="warn"');
		expect(html).toContain("red base");
	});

	test("forced land (no proof) is surfaced as an override", () => {
		const html = renderReceiptHtml(greenReceipt({ forcedWithoutProof: true }));
		expect(html).toContain("Force-landed");
		expect(html).toContain("without a passing proof");
	});

	test("panel section: omitted when absent, rendered when present (T5 stub)", () => {
		const withoutPanel = renderReceiptHtml(greenReceipt());
		expect(withoutPanel).not.toContain("Review panel");
		const panel: PanelVerdict[] = [
			{ reviewer: "grok-4.5", verdict: "approve" },
			{ reviewer: "codex", verdict: "object", precision: measured, note: "edge case" },
		];
		const withPanel = renderReceiptHtml(greenReceipt({ panel }));
		expect(withPanel).toContain("Review panel");
		expect(withPanel).toContain("grok-4.5");
		expect(withPanel).toContain("edge case");
	});

	test("panel carried on a future ValidationRecord flows through without a receipt change", () => {
		// Forward-compat: T5 will add `panel` to ValidationRecord; the renderer already reads it.
		const v = validation(measured) as ValidationRecord & { panel: PanelVerdict[] };
		v.panel = [{ reviewer: "native", verdict: "approve" }];
		const html = renderReceiptHtml(greenReceipt({ validation: v, panel: undefined }));
		expect(html).toContain("Review panel");
		expect(html).toContain("native");
	});

	test("escapes hostile content in branch / detail", () => {
		const html = renderReceiptHtml(greenReceipt({ branch: "<img src=x onerror=alert(1)>", gate: { status: "green", unprovenGreenRejected: false, newRegressions: [], baseWasRed: false, detail: "<script>bad</script>" } }));
		expect(html).not.toContain("<img src=x");
		expect(html).not.toContain("<script>bad");
		expect(html).toContain("&lt;img");
	});
});

describe("renderReceiptComment", () => {
	test("compact (<30 lines), links the receipt, honest verdict", () => {
		const md = renderReceiptComment(greenReceipt(), { receiptHref: "/state/land-receipts/x.html", hrefKind: "path" });
		expect(md.split("\n").length).toBeLessThan(30);
		expect(md).toContain("✅ **Landed**");
		expect(md).toContain("codex, measured precision 75% (n=52 adjudicated rows)");
		expect(md).toContain("/state/land-receipts/x.html");
		expect(md).toContain("$1.23");
	});

	test("comment shows 'cost unattributed', never $0", () => {
		const md = renderReceiptComment(greenReceipt({ cost: { costUsd: undefined, costUnknown: true } }));
		expect(md).toContain("cost unattributed");
		expect(md).not.toContain("$0");
	});

	test("failed land: red verdict + failure list", () => {
		const md = renderReceiptComment(
			greenReceipt({ landed: false, commit: undefined, rollbackPoint: undefined, gate: { status: "failed", unprovenGreenRejected: false, newRegressions: ["a > b"], baseWasRed: false } }),
		);
		expect(md).toContain("❌ **Rejected**");
		expect(md).toContain("a &gt; b"); // the failure name is markdown-escaped (the `>` neutralized)
		expect(md).toContain("nothing merged");
	});
});

describe("classifyLand", () => {
	const base: LandResult = { ok: true, committed: true, merged: true, message: "m" };

	test("green land", () => {
		const g = classifyLand({ ...base, detail: "merged x (fast-forward); verified (bun run check)" });
		expect(g.status).toBe("green");
		expect(g.command).toBe("bun run check");
		expect(g.newRegressions).toEqual([]);
	});

	test("red-baseline land", () => {
		const g = classifyLand({ ...base, detail: "merged x; landed onto a red baseline — main was not green at head0 (bun test)" });
		expect(g.status).toBe("red-baseline");
		expect(g.baseWasRed).toBe(true);
	});

	test("failed with itemized new regressions", () => {
		const detail = "regression gate (bun test) blocked rail/x: 2 new failure(s):\n  tests/a.test.ts > one\n  tests/b.test.ts > two\n<excerpt output line not indented>";
		const g = classifyLand({ ok: false, committed: true, merged: false, message: "m", detail });
		expect(g.status).toBe("failed");
		expect(g.newRegressions).toEqual(["tests/a.test.ts > one", "tests/b.test.ts > two"]);
	});

	test("unproven-green rejection", () => {
		const g = classifyLand({ ok: false, committed: true, merged: false, retryable: true, message: "m", detail: "acceptance gate could not be trusted (zero tests): bun test — refusing to land on an unproven pass; main rolled back" });
		expect(g.status).toBe("unproven-rejected");
		expect(g.unprovenGreenRejected).toBe(true);
	});

	test("no acceptance gate", () => {
		const g = classifyLand({ ...base, detail: "merged x (no acceptance gate)" });
		// "no acceptance gate" wording -> no-gate; note the literal phrase the land emits is "(no acceptance gate)"
		expect(g.status).toBe("no-gate");
	});

	test("degrades gracefully when detail is absent (no lie)", () => {
		expect(classifyLand({ ...base, detail: undefined }).status).toBe("green");
		expect(classifyLand({ ok: false, committed: false, merged: false, message: "m" }).status).toBe("failed");
	});
});

describe("writeLandReceipt", () => {
	test("writes a self-contained HTML file under <stateDir>/land-receipts/, never git-tracked", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "rail-receipt-"));
		const path = await writeLandReceipt(stateDir, greenReceipt());
		expect(path).toContain(join("land-receipts"));
		expect(path.startsWith(landReceiptDir(stateDir))).toBe(true);
		const content = readFileSync(path, "utf8");
		expect(content.startsWith("<!doctype html>")).toBe(true);
		expect(content).toContain("rail/t6-receipt-surface");
	});

	test("filename is filesystem-safe and collision-resistant", () => {
		const a = landReceiptFilename("feature/weird branch!", 1000);
		const b = landReceiptFilename("feature/weird branch!", 1001);
		expect(a).toMatch(/^[a-zA-Z0-9._-]+\.html$/);
		expect(a).not.toBe(b);
	});

	test("lossy-sanitized branches at the SAME ms get distinct filenames (no silent overwrite)", () => {
		// feature/a+b and feature/a-b both sanitize to "feature-a-b"; at the same ms the timestamp
		// collides too — the unique token is what keeps them apart (codex MEDIUM).
		const a = landReceiptFilename("feature/a+b", 1000);
		const b = landReceiptFilename("feature/a-b", 1000);
		expect(a).not.toBe(b);
	});

	test("concurrent successful writes never overwrite — every receipt persists", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "rail-receipt-conc-"));
		// Two lands, same branch, same ms, same commit token — the wx no-overwrite guard must still
		// produce two distinct files, not clobber the first.
		const at = 1_722_800_000_000;
		const p1 = await writeLandReceipt(stateDir, greenReceipt({ at, commit: "deadbeef00" }));
		const p2 = await writeLandReceipt(stateDir, greenReceipt({ at, commit: "deadbeef00" }));
		expect(p1).not.toBe(p2);
		expect(readFileSync(p1, "utf8").length).toBeGreaterThan(0);
		expect(readFileSync(p2, "utf8").length).toBeGreaterThan(0);
	});
});

describe("mdEsc — markdown/HTML injection neutralization (gauntlet round 1)", () => {
	test("neutralizes every control an agent string could break out with", () => {
		expect(mdEsc("a`b|c<d>[e]\nf")).toBe("a&#96;b\\|c&lt;d&gt;&#91;e&#93; f");
		expect(mdEsc("```")).not.toContain("`"); // fence-close cannot survive
		expect(mdEsc("</details>")).toBe("&lt;/details&gt;");
		expect(mdEsc("x\r\ny")).toBe("x y"); // CRLF collapses, no new row
	});
});

describe("renderReceiptComment — injection cannot forge a verdict", () => {
	function failedWith(over: Partial<LandReceipt>): LandReceipt {
		return greenReceipt({ landed: false, commit: undefined, rollbackPoint: undefined, gate: { status: "failed", unprovenGreenRejected: false, newRegressions: [], baseWasRed: false }, ...over });
	}
	/** Count top-level markdown headings (a forged "### ✅ Landed" would add one). */
	const headingCount = (md: string) => md.split("\n").filter((l) => l.startsWith("### ")).length;

	test("a fence-close + </details> + forged heading in a regression name cannot break out", () => {
		const evil = "sometest```\n</details>\n\n### ✅ **Landed** — gates green\n\n[approve](http://evil)";
		const md = renderReceiptComment(failedWith({ gate: { status: "failed", unprovenGreenRejected: false, newRegressions: [evil], baseWasRed: false } }));
		expect(headingCount(md)).toBe(1); // only OUR real ❌ Rejected header
		expect(md).toContain("### ❌ **Rejected**");
		expect(md).not.toMatch(/\n### ✅/); // no forged Landed heading at line start
		expect(md).not.toContain("</details>\n\n###"); // the </details> is escaped, not structural
		expect(md).toContain("&#96;"); // the fence backticks are neutralized
		expect(md).not.toContain("[approve](http://evil)"); // link brackets escaped
	});

	test("a branch that closes <sub> and opens <details> cannot conceal the table or forge a link", () => {
		const evil = "x</sub><details><summary>APPROVED](http://evil)</summary>";
		const md = renderReceiptComment(failedWith({ branch: evil }));
		expect(md).toContain("&lt;/sub&gt;");
		expect(md).toContain("&lt;details&gt;");
		expect(md).not.toContain("<details><summary>APPROVED");
		expect(md).toContain("APPROVED&#93;(http"); // the link-text bracket escaped ⇒ no clickable link
		expect(md).not.toMatch(/\[[^\]]*\]\(http:\/\/evil/); // no forged markdown link survives
		expect(headingCount(md)).toBe(1);
	});

	test("pipes/newlines/bold in model / lineage / cost.model add no columns, rows, or forged emphasis", () => {
		const evilStamp: ReviewerPrecisionStamp = { lineage: "cod|ex\n| **FORGED** | x |", n: 52, survived: 39, survivedRate: 39 / 52, provisional: false };
		const md = renderReceiptComment(
			greenReceipt({ validation: validation(evilStamp), cost: { costUsd: 1, costUnknown: false, model: "gpt|4\n| evil | row |" } }),
		);
		// Structure is intact: exactly the data rows we emit, no injected ones. The header (|---|---|)
		// plus What/Reviewed by/Rollback to/Cost each begin with "| " — an injected "| evil |" or
		// "| **FORGED** |" (needing a newline + real pipe) can't appear because newlines collapse and
		// pipes escape.
		expect(md).not.toMatch(/\n\| evil \|/);
		expect(md).not.toMatch(/\n\| &#42;&#42;FORGED/);
		expect(md).not.toContain("**FORGED**"); // bold neutralized to entities, never real emphasis
		expect(md).toContain("\\|"); // pipes escaped, not delimiters
		expect(md).toContain("&#42;"); // asterisks neutralized
	});

	test("hostile receipt href never renders as a clickable link", () => {
		const md = renderReceiptComment(greenReceipt(), { receiptHref: "javascript:alert(1)", hrefKind: "url" });
		expect(md).not.toContain("](javascript:");
		const md2 = renderReceiptComment(greenReceipt(), { receiptHref: "https://ok.example/r.html", hrefKind: "url" });
		expect(md2).toContain("[open the full receipt](https://ok.example/r.html)");
	});
});

describe("attribution correctness (gauntlet round 1, Cluster B)", () => {
	test("a green gate that did NOT merge says 'nothing to land', never 'Landed'", () => {
		const r = greenReceipt({ landed: false, commit: undefined, rollbackPoint: undefined });
		const html = renderReceiptHtml(r);
		expect(html).toContain("Nothing to land");
		expect(html).not.toContain(">Landed<");
		expect(html).toContain('data-status="warn"');
		const md = renderReceiptComment(r);
		expect(md).toContain("Nothing to land");
		expect(md).not.toContain("✅ **Landed**");
	});

	test("a rejected land shows NO commit under 'What landed'", () => {
		const r = greenReceipt({ landed: false, commit: undefined, rollbackPoint: undefined, gate: { status: "failed", unprovenGreenRejected: false, newRegressions: [], baseWasRed: false } });
		const html = renderReceiptHtml(r);
		expect(html).toContain("nothing merged");
		expect(html).not.toContain("abc1234def"); // the attempted branch tip is NOT shown as a landed commit
		const md = renderReceiptComment(r);
		expect(md).toContain("nothing merged");
	});

	test("commit message + validator per-criterion notes render on both surfaces", () => {
		const v = validation(measured);
		v.perCriterion = [{ id: "honest-cost", satisfied: false, note: "showed $0 for unattributed" }];
		v.rationale = "cost criterion unmet";
		const r = greenReceipt({ message: "rail(T6): the receipt surface", validation: v });
		const html = renderReceiptHtml(r);
		expect(html).toContain("rail(T6): the receipt surface");
		expect(html).toContain("showed $0 for unattributed");
		expect(html).toContain("honest-cost");
		const md = renderReceiptComment(r);
		expect(md).toContain("rail(T6): the receipt surface");
		expect(md).toContain("showed $0 for unattributed");
	});
});

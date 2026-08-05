/**
 * In-code cross-lineage gauntlet panel (T5, glance#333) — unit-level tests for `runReviewPanel`
 * (`src/rail/panel.ts`) against fake, injected reviewers. Real git/CLI plumbing is covered by
 * `tests/rail-panel.live-smoke.test.ts` (opt-in, real codex/grok/omp binaries) and the land-path
 * wiring by `tests/validator-land-gate-panel.test.ts` / `tests/validator.gate-panel.test.ts`.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelLineage } from "../src/model-lineage.ts";
import {
	defaultPanelReviewers,
	diffRiskTier,
	panelMax,
	panelTimeoutMs,
	reviewPanelEnabled,
	runReviewPanel,
	type PanelReviewerSpec,
} from "../src/rail/panel.ts";

const ENV_KEYS = ["OMP_SQUAD_REVIEW_PANEL", "OMP_SQUAD_REVIEW_PANEL_MAX", "OMP_SQUAD_REVIEW_PANEL_TIMEOUT_MS", "OMP_SQUAD_LAND_MAX_DIFF_FILES"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

const tmps: string[] = [];
afterEach(async () => {
	for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

function fakeDiff(files: string[]): string {
	return files.map((f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-old\n+new\n`).join("\n");
}

function accept(lineage: ModelLineage, harness: string): PanelReviewerSpec {
	return { lineage, harness, review: async () => ({ disposition: "accept" }) };
}

function object(lineage: ModelLineage, harness: string, severity: "low" | "high", claim: string, concernClass?: string): PanelReviewerSpec {
	return { lineage, harness, review: async () => ({ disposition: "object", severity, claim, concernClass }) };
}

async function tmpLedgerFile(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rail-panel-ledger-"));
	tmps.push(dir);
	return path.join(dir, "reviewer-ledger.jsonl");
}

async function readLedgerRows(ledgerPath: string): Promise<Record<string, unknown>[]> {
	const text = await fs.readFile(ledgerPath, "utf8").catch(() => "");
	return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// ── env defaults (default-off contract) ─────────────────────────────────────────────────────────

test("panel master flag is OFF by default; panelMax defaults to 2; panelTimeoutMs defaults to 120000", () => {
	expect(reviewPanelEnabled()).toBe(false);
	expect(panelMax()).toBe(2);
	expect(panelTimeoutMs()).toBe(120_000);
});

// ── diffRiskTier: the pure signal, reused from land-risk.ts ─────────────────────────────────────

test("diffRiskTier: a sensitive path warrants a panel regardless of file count", () => {
	const tier = diffRiskTier(fakeDiff([".github/workflows/deploy.yml"]));
	expect(tier.warrants).toBe(true);
	expect(tier.sensitivePaths).toEqual([".github/workflows/deploy.yml"]);
});

test("diffRiskTier: a small, non-sensitive diff does not warrant a panel", () => {
	const tier = diffRiskTier(fakeDiff(["src/a.ts", "src/b.ts"]));
	expect(tier.warrants).toBe(false);
	expect(tier.sensitivePaths).toEqual([]);
});

test("diffRiskTier: the blast-radius cap is env-tunable, reusing land-risk's OWN OMP_SQUAD_LAND_MAX_DIFF_FILES", () => {
	const files = Array.from({ length: 10 }, (_, i) => `src/gen/f${i}.ts`);
	const diff = fakeDiff(files);
	expect(diffRiskTier(diff).warrants).toBe(false);
	process.env.OMP_SQUAD_LAND_MAX_DIFF_FILES = "5";
	expect(diffRiskTier(diff).warrants).toBe(true);
});

// ── master flag / docs-only / risk-tier gating ──────────────────────────────────────────────────

test("master flag OFF ⇒ runReviewPanel never fires, even for a sensitive-path diff with reviewers ready", async () => {
	const diff = fakeDiff([".github/workflows/deploy.yml"]);
	const reviewers = () => [accept("xai", "grok"), accept("openai", "codex")];
	expect(await runReviewPanel({ diff, source: "test", reviewers })).toBeUndefined();
});

test("docs-only diff ⇒ no panel even with the master flag on (preserves lens-select's [] behavior)", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	const diff = fakeDiff(["README.md", "docs/guide.md"]);
	const reviewers = () => [object("xai", "grok", "high", "should never fire"), accept("openai", "codex")];
	expect(await runReviewPanel({ diff, source: "test", reviewers })).toBeUndefined();
});

test("a small, non-sensitive code diff ⇒ tier doesn't warrant a panel, even with the flag on", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	const diff = fakeDiff(["src/a.ts", "src/b.ts"]);
	const reviewers = () => [accept("xai", "grok"), accept("openai", "codex")];
	expect(await runReviewPanel({ diff, source: "test", reviewers })).toBeUndefined();
});

// ── the panel itself: distinct lineages, blind, bounded ─────────────────────────────────────────

test("a sensitive-path diff (flag on) spawns >= 2 DISTINCT-lineage reviewers, each blind to the diff + invariants only", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	const diff = fakeDiff([".github/workflows/deploy.yml", "src/a.ts"]);
	const seen: { diff: string; invariants: string }[] = [];
	const reviewers = (): PanelReviewerSpec[] => [
		{
			lineage: "xai",
			harness: "grok",
			review: async (input) => {
				seen.push(input);
				return { disposition: "accept" };
			},
		},
		{
			lineage: "openai",
			harness: "codex",
			review: async (input) => {
				seen.push(input);
				return { disposition: "accept" };
			},
		},
	];
	const panel = await runReviewPanel({ diff, source: "test", reviewers });
	expect(panel).toBeDefined();
	expect(panel!.length).toBe(2);
	expect(new Set(panel!.map((p) => p.lineage)).size).toBe(2);
	expect(panel!.every((p) => p.verdict === "accept")).toBe(true);
	// Blind: each reviewer got ONLY the diff + the fixed invariants text — never criteria, notes, or
	// (structurally, by the seam's own signature) another reviewer's verdict.
	for (const s of seen) {
		expect(s.diff).toBe(diff);
		expect(s.invariants).not.toContain("criteria");
		expect(s.invariants).not.toContain("acceptance");
	}
});

test("fewer than 2 DISTINCT lineages available ⇒ no panel (never a fabricated panel of one)", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	const diff = fakeDiff([".github/workflows/deploy.yml"]);
	const reviewers = () => [accept("xai", "grok")];
	expect(await runReviewPanel({ diff, source: "test", reviewers })).toBeUndefined();
});

test("duplicate lineages in the pool are deduped BEFORE the min-panel-size check", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	const diff = fakeDiff([".github/workflows/deploy.yml"]);
	const reviewers = () => [accept("xai", "grok"), accept("xai", "grok-secondary")];
	expect(await runReviewPanel({ diff, source: "test", reviewers })).toBeUndefined();
});

test("panelMax caps the panel size even when more distinct lineages are available", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	process.env.OMP_SQUAD_REVIEW_PANEL_MAX = "2";
	const diff = fakeDiff([".github/workflows/deploy.yml"]);
	const reviewers = () => [accept("xai", "grok"), accept("openai", "codex"), accept("anthropic", "omp")];
	const panel = await runReviewPanel({ diff, source: "test", reviewers });
	expect(panel!.length).toBe(2);
});

test("a hung reviewer is bounded by panelTimeoutMs and recorded as a timeout — never wedges the panel", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	process.env.OMP_SQUAD_REVIEW_PANEL_TIMEOUT_MS = "50";
	const diff = fakeDiff([".github/workflows/deploy.yml"]);
	const reviewers = (): PanelReviewerSpec[] => [
		{ lineage: "xai", harness: "grok", review: () => new Promise<never>(() => {}) },
		accept("openai", "codex"),
	];
	const start = Date.now();
	const panel = await runReviewPanel({ diff, source: "test", reviewers });
	const elapsed = Date.now() - start;
	expect(elapsed).toBeLessThan(2_000); // bounded well under any real hang
	expect(panel).toBeDefined();
	expect(panel!.find((p) => p.lineage === "xai")?.verdict).toBe("timeout");
	expect(panel!.find((p) => p.lineage === "openai")?.verdict).toBe("accept");
});

test("a reviewer that throws is recorded as an error, never a fabricated accept/object", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	const diff = fakeDiff([".github/workflows/deploy.yml"]);
	const reviewers = (): PanelReviewerSpec[] => [
		{
			lineage: "xai",
			harness: "grok",
			review: async () => {
				throw new Error("boom");
			},
		},
		accept("openai", "codex"),
	];
	const panel = await runReviewPanel({ diff, source: "test", reviewers });
	expect(panel!.find((p) => p.lineage === "xai")?.verdict).toBe("error");
});

// ── ledger recording: only ADJUDICATED findings become rows ─────────────────────────────────────

test("a HIGH-severity objection gets rechecked and recorded to the ledger; a LOW-severity objection and a clean accept do NOT", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	const diff = fakeDiff([".github/workflows/deploy.yml"]);
	const reviewers = () => [
		object("xai", "grok", "high", "a fail-open in the new gate", "fail-open"),
		object("openai", "codex", "low", "a minor style nit", "style"),
	];
	const verify = () => async (input: { claim: string }) => input.claim.includes("fail-open");
	const ledgerPath = await tmpLedgerFile();

	const panel = await runReviewPanel({ diff, source: "land test@abc123", reviewers, verify, ledgerPath });
	expect(panel).toBeDefined();
	const high = panel!.find((p) => p.lineage === "xai")!;
	expect(high.verdict).toBe("object");
	expect(high.survived).toBe(true);
	const low = panel!.find((p) => p.lineage === "openai")!;
	expect(low.verdict).toBe("object");
	expect(low.survived).toBeUndefined(); // never rechecked ⇒ never adjudicated ⇒ never a fabricated boolean

	const rows = await readLedgerRows(ledgerPath);
	expect(rows.length).toBe(1);
	expect(rows[0]).toMatchObject({ lineage: "xai", concernClass: "fail-open", survived: true, source: "land test@abc123", note: "a fail-open in the new gate", severity: "high" });
});

test("a clean panel (every reviewer accepts) writes NO ledger rows at all", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	const diff = fakeDiff([".github/workflows/deploy.yml"]);
	const reviewers = () => [accept("xai", "grok"), accept("openai", "codex")];
	const ledgerPath = await tmpLedgerFile();
	const panel = await runReviewPanel({ diff, source: "test", reviewers, ledgerPath });
	expect(panel!.every((p) => p.verdict === "accept")).toBe(true);
	expect(await readLedgerRows(ledgerPath)).toEqual([]);
});

test("a REFUTED high-severity objection is still recorded — survived:false is a row too", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	const diff = fakeDiff([".github/workflows/deploy.yml"]);
	const reviewers = () => [object("xai", "grok", "high", "a claim that will be refuted", "toctou"), accept("openai", "codex")];
	const verify = () => async () => false;
	const ledgerPath = await tmpLedgerFile();
	const panel = await runReviewPanel({ diff, source: "land refute@1", reviewers, verify, ledgerPath });
	expect(panel!.find((p) => p.lineage === "xai")?.survived).toBe(false);
	const rows = await readLedgerRows(ledgerPath);
	expect(rows.length).toBe(1);
	expect(rows[0]).toMatchObject({ survived: false });
});

test("an unreachable recheck (undefined) leaves survived unset — never escalated to true", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	const diff = fakeDiff([".github/workflows/deploy.yml"]);
	const reviewers = () => [object("xai", "grok", "high", "unverifiable claim", "toctou"), accept("openai", "codex")];
	const verify = () => async () => undefined;
	const ledgerPath = await tmpLedgerFile();
	const panel = await runReviewPanel({ diff, source: "test", reviewers, verify, ledgerPath });
	expect(panel!.find((p) => p.lineage === "xai")?.survived).toBe(false);
	// `verify` returning `undefined` ⇒ `confirmed === true` is false ⇒ survived:false (fail-open, matches
	// validator.ts's runLensVerify: an inconclusive recheck is treated as NOT confirmed, never escalated).
	const rows = await readLedgerRows(ledgerPath);
	expect(rows[0]).toMatchObject({ survived: false });
});

test("FLIP THE INPUT: a reviewer verdict change (accept -> confirmed high objection) moves both the panel result and the ledger", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	const diff = fakeDiff([".github/workflows/deploy.yml"]);
	let verdict: "accept" | "object" = "accept";
	const reviewers = (): PanelReviewerSpec[] => [
		{
			lineage: "xai",
			harness: "grok",
			review: async () => (verdict === "accept" ? { disposition: "accept" } : { disposition: "object", severity: "high", claim: "now flagged", concernClass: "toctou" }),
		},
		accept("openai", "codex"),
	];
	const verify = () => async () => true;
	const ledgerPath = await tmpLedgerFile();

	const first = await runReviewPanel({ diff, source: "land a@1", reviewers, verify, ledgerPath });
	expect(first!.find((p) => p.lineage === "xai")?.verdict).toBe("accept");
	expect(await readLedgerRows(ledgerPath)).toEqual([]);

	verdict = "object";
	const second = await runReviewPanel({ diff, source: "land b@2", reviewers, verify, ledgerPath });
	expect(second!.find((p) => p.lineage === "xai")?.verdict).toBe("object");
	expect(second!.find((p) => p.lineage === "xai")?.survived).toBe(true);
	const rows = await readLedgerRows(ledgerPath);
	expect(rows.length).toBe(1);
	expect(rows[0]).toMatchObject({ source: "land b@2" });
});

test("a ledger-write fault degrades the MEASUREMENT, never the panel result", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	const diff = fakeDiff([".github/workflows/deploy.yml"]);
	const reviewers = () => [object("xai", "grok", "high", "x", "fail-open"), accept("openai", "codex")];
	const verify = () => async () => true;
	// A directory as the "ledger path" ⇒ appendFileSync throws (EISDIR) — the panel must still resolve.
	const badDir = await fs.mkdtemp(path.join(os.tmpdir(), "rail-panel-baddir-"));
	tmps.push(badDir);
	const panel = await runReviewPanel({ diff, source: "test", reviewers, verify, ledgerPath: badDir });
	expect(panel).toBeDefined();
	expect(panel!.find((p) => p.lineage === "xai")?.survived).toBe(true);
});

// ── default reviewer pool (production wiring, no CLI invocation) ───────────────────────────────

test("defaultPanelReviewers only offers lineages whose binary is actually present", () => {
	const pool = defaultPanelReviewers();
	// Sanity: no duplicate lineages, and every entry names a harness.
	expect(new Set(pool.map((p) => p.lineage)).size).toBe(pool.length);
	for (const p of pool) expect(p.harness.length).toBeGreaterThan(0);
});

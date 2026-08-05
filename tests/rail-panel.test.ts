/**
 * In-code cross-lineage gauntlet panel (T5, glance#333) — unit-level tests for `runReviewPanel`
 * (`src/rail/panel.ts`) against fake, injected reviewers.
 *
 * Gauntlet round 1 (dual-lineage blind review of PR #353 — codex gpt-5.6-sol + grok-4.5, both
 * converged on a CRITICAL finding, codex added six more) rewired this file: the panel no longer writes
 * the tracked ledger file directly (A1 — see `tests/rail-panel-ledger.test.ts` for the projection lane
 * that now owns that write), so every ledger-shaped assertion here reads the QUEUE
 * (`readPendingPanelFindings`) instead of a ledger file. A5 (an inconclusive claim-verification call
 * must never be coerced into a refutation) and A7 (ledger rows use grok/codex/native, not xai/openai/
 * anthropic) are asserted directly here.
 *
 * Real git/CLI plumbing (hermetic cwd, process-group kill, the production reviewer factories) is
 * covered by `tests/rail-panel-spawn.test.ts` (fake-process fixtures) and
 * `tests/rail-panel.live-smoke.test.ts` (opt-in, real codex/grok/omp binaries). The land-path wiring is
 * `tests/validator.gate-panel.test.ts` / `tests/validator-land-gate-panel.test.ts`.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelLineage } from "../src/model-lineage.ts";
import {
	canonicalLedgerTag,
	defaultPanelReviewers,
	diffRiskTier,
	panelMax,
	panelTimeoutMs,
	reviewPanelEnabled,
	runReviewPanel,
	type PanelReviewerSpec,
} from "../src/rail/panel.ts";
import { readPendingPanelFindings } from "../src/rail/panel-ledger.ts";

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

async function tmpStateDir(): Promise<string> {
	const d = await fs.mkdtemp(path.join(os.tmpdir(), "rail-panel-state-"));
	tmps.push(d);
	return d;
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

// ── A7: canonical ledger lineage tag ────────────────────────────────────────────────────────────

test("canonicalLedgerTag: the harness (not the vendor lineage) decides the ledger bucket, matching T4's reader", () => {
	expect(canonicalLedgerTag("grok", "xai")).toBe("grok");
	expect(canonicalLedgerTag("codex", "openai")).toBe("codex");
	expect(canonicalLedgerTag("omp", "anthropic")).toBe("native");
});

test("canonicalLedgerTag: falls back to lineage-derived tag for an exotic harness name (never fabricates xai/openai/anthropic as buckets)", () => {
	expect(canonicalLedgerTag("grok-secondary", "xai")).toBe("grok");
	expect(canonicalLedgerTag("codex-alt", "openai")).toBe("codex");
	expect(canonicalLedgerTag("some-anthropic-fixture", "anthropic")).toBe("native");
	expect(canonicalLedgerTag("totally-unknown", "unknown")).toBe("totally-unknown");
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
	const panel = await runReviewPanel({ diff, source: "test-blind", reviewers });
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
	expect(await runReviewPanel({ diff, source: "test-one-lineage", reviewers })).toBeUndefined();
});

test("duplicate lineages in the pool are deduped BEFORE the min-panel-size check", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	const diff = fakeDiff([".github/workflows/deploy.yml"]);
	const reviewers = () => [accept("xai", "grok"), accept("xai", "grok-secondary")];
	expect(await runReviewPanel({ diff, source: "test-dupe-lineage", reviewers })).toBeUndefined();
});

test("panelMax caps the panel size even when more distinct lineages are available", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	process.env.OMP_SQUAD_REVIEW_PANEL_MAX = "2";
	const diff = fakeDiff([".github/workflows/deploy.yml"]);
	const reviewers = () => [accept("xai", "grok"), accept("openai", "codex"), accept("anthropic", "omp")];
	const panel = await runReviewPanel({ diff, source: "test-cap", reviewers });
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
	const panel = await runReviewPanel({ diff, source: "test-hung", reviewers });
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
	const panel = await runReviewPanel({ diff, source: "test-throws", reviewers });
	expect(panel!.find((p) => p.lineage === "xai")?.verdict).toBe("error");
});

// ── A1: the panel QUEUES (never writes the tracked ledger directly) ────────────────────────────

test("with NO stateDir, an adjudicated finding is NOT queued anywhere — the panel result is still returned", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	const diff = fakeDiff([".github/workflows/deploy.yml"]);
	const reviewers = () => [object("xai", "grok", "high", "a fail-open", "fail-open"), accept("openai", "codex")];
	const verify = () => async () => true;
	const panel = await runReviewPanel({ diff, source: "test-no-statedir", reviewers, verify });
	expect(panel!.find((p) => p.lineage === "xai")?.survived).toBe(true); // the record is still complete
	// No stateDir was given, so there is nowhere it COULD have queued — nothing to assert against a
	// tracked file (this test's whole point: the panel never reaches for a default/ambient path).
});

test("a HIGH-severity objection gets verified and queued; a LOW-severity objection and a clean accept do NOT queue", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	const diff = fakeDiff([".github/workflows/deploy.yml"]);
	const reviewers = () => [
		object("xai", "grok", "high", "a fail-open in the new gate", "fail-open"),
		object("openai", "codex", "low", "a minor style nit", "style"),
	];
	const verify = () => async (input: { claim: string }) => input.claim.includes("fail-open");
	const stateDir = await tmpStateDir();

	const panel = await runReviewPanel({ diff, source: "land test@abc123", reviewers, verify, stateDir });
	expect(panel).toBeDefined();
	const high = panel!.find((p) => p.lineage === "xai")!;
	expect(high.verdict).toBe("object");
	expect(high.survived).toBe(true);
	const low = panel!.find((p) => p.lineage === "openai")!;
	expect(low.verdict).toBe("object");
	expect(low.survived).toBeUndefined(); // never verified ⇒ never adjudicated ⇒ never queued

	const queued = readPendingPanelFindings(stateDir);
	expect(queued.length).toBe(1);
	// A7: the QUEUED row already carries the CANONICAL ledger tag ("grok"), never the raw vendor
	// lineage ("xai") — the projection lane writes it verbatim.
	expect(queued[0]).toMatchObject({ lineage: "grok", concernClass: "fail-open", survived: true, source: "land test@abc123", note: "a fail-open in the new gate", severity: "high" });
});

test("a clean panel (every reviewer accepts) queues NOTHING", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	const diff = fakeDiff([".github/workflows/deploy.yml"]);
	const reviewers = () => [accept("xai", "grok"), accept("openai", "codex")];
	const stateDir = await tmpStateDir();
	const panel = await runReviewPanel({ diff, source: "test-clean", reviewers, stateDir });
	expect(panel!.every((p) => p.verdict === "accept")).toBe(true);
	expect(readPendingPanelFindings(stateDir)).toEqual([]);
});

test("a REFUTED high-severity objection is still queued — survived:false is a row too", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	const diff = fakeDiff([".github/workflows/deploy.yml"]);
	const reviewers = () => [object("xai", "grok", "high", "a claim that will be refuted", "toctou"), accept("openai", "codex")];
	const verify = () => async () => false;
	const stateDir = await tmpStateDir();
	const panel = await runReviewPanel({ diff, source: "land refute@1", reviewers, verify, stateDir });
	expect(panel!.find((p) => p.lineage === "xai")?.survived).toBe(false);
	const queued = readPendingPanelFindings(stateDir);
	expect(queued.length).toBe(1);
	expect(queued[0]).toMatchObject({ survived: false });
});

// ── A5: an inconclusive claim-verification call is a THIRD state, never coerced into "refuted" ────

test("A5 HONESTY: an unreachable/inconclusive claim-verification call (undefined) leaves survived UNSET — it must NEVER be coerced into false", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	const diff = fakeDiff([".github/workflows/deploy.yml"]);
	const reviewers = () => [object("xai", "grok", "high", "unverifiable claim", "toctou"), accept("openai", "codex")];
	const verify = () => async () => undefined; // "couldn't determine" — the honest third state
	const stateDir = await tmpStateDir();
	const panel = await runReviewPanel({ diff, source: "test-a5", reviewers, verify, stateDir });
	const finding = panel!.find((p) => p.lineage === "xai");
	expect(finding?.verdict).toBe("object");
	expect(finding?.survived).toBeUndefined(); // NOT false — this is the exact gauntlet-round-1 fix
	expect(Object.hasOwn(finding ?? {}, "survived")).toBe(false);
	// An inconclusive check is not an adjudication — it must NOT be queued for the ledger either
	// (queuing `survived:false` here would fabricate a "refuted" measurement that never actually happened).
	expect(readPendingPanelFindings(stateDir)).toEqual([]);
});

test("A5: a claim-verification reviewer that THROWS also leaves survived unset (never escalated, never queued)", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	const diff = fakeDiff([".github/workflows/deploy.yml"]);
	const reviewers = () => [object("xai", "grok", "high", "x", "toctou"), accept("openai", "codex")];
	const verify = () => async () => {
		throw new Error("verifier CLI crashed");
	};
	const stateDir = await tmpStateDir();
	const panel = await runReviewPanel({ diff, source: "test-a5-throw", reviewers, verify, stateDir });
	expect(panel!.find((p) => p.lineage === "xai")?.survived).toBeUndefined();
	expect(readPendingPanelFindings(stateDir)).toEqual([]);
});

test("B2: the claim-verification call has its OWN independent timeout bound — a hung verifier never wedges the panel", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	process.env.OMP_SQUAD_REVIEW_PANEL_TIMEOUT_MS = "50";
	const diff = fakeDiff([".github/workflows/deploy.yml"]);
	const reviewers = () => [object("xai", "grok", "high", "x", "toctou"), accept("openai", "codex")];
	const verify = () => () => new Promise<boolean>(() => {}); // never resolves
	const stateDir = await tmpStateDir();
	const start = Date.now();
	const panel = await runReviewPanel({ diff, source: "test-verify-hung", reviewers, verify, stateDir });
	expect(Date.now() - start).toBeLessThan(2_000);
	expect(panel!.find((p) => p.lineage === "xai")?.survived).toBeUndefined(); // timed out ⇒ inconclusive, never coerced
	expect(readPendingPanelFindings(stateDir)).toEqual([]);
});

test("FLIP THE INPUT: a reviewer verdict change (accept -> confirmed high objection) moves both the panel result and the queue", async () => {
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
	const stateDir = await tmpStateDir();

	const first = await runReviewPanel({ diff, source: "land a@1", reviewers, verify, stateDir });
	expect(first!.find((p) => p.lineage === "xai")?.verdict).toBe("accept");
	expect(readPendingPanelFindings(stateDir)).toEqual([]);

	verdict = "object";
	const second = await runReviewPanel({ diff, source: "land b@2", reviewers, verify, stateDir });
	expect(second!.find((p) => p.lineage === "xai")?.verdict).toBe("object");
	expect(second!.find((p) => p.lineage === "xai")?.survived).toBe(true);
	const queued = readPendingPanelFindings(stateDir);
	expect(queued.length).toBe(1);
	expect(queued[0]).toMatchObject({ source: "land b@2" });
});

test("a queue-write fault degrades the MEASUREMENT, never the panel result", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	const diff = fakeDiff([".github/workflows/deploy.yml"]);
	const reviewers = () => [object("xai", "grok", "high", "x", "fail-open"), accept("openai", "codex")];
	const verify = () => async () => true;
	// A bogus nested "stateDir" underneath a plain FILE (not a directory) — the underlying `mapFile`
	// write is itself best-effort/never-throws, so this exercises that the panel doesn't add a NEW
	// throw path of its own around it.
	const badDir = await fs.mkdtemp(path.join(os.tmpdir(), "rail-panel-baddir-"));
	tmps.push(badDir);
	await fs.writeFile(path.join(badDir, "not-a-dir"), "x");
	const panel = await runReviewPanel({ diff, source: "test-queue-fault", reviewers, verify, stateDir: path.join(badDir, "not-a-dir", "nested") });
	expect(panel).toBeDefined();
	expect(panel!.find((p) => p.lineage === "xai")?.survived).toBe(true);
});

// ── B4: single-flight coalescing ────────────────────────────────────────────────────────────────

test("B4: concurrent IDENTICAL panel requests (same source+diff) share ONE run — reviewers are invoked only once", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	const diff = fakeDiff([".github/workflows/deploy.yml"]);
	let calls = 0;
	const reviewers = (): PanelReviewerSpec[] => [
		{
			lineage: "xai",
			harness: "grok",
			review: async () => {
				calls++;
				await new Promise((r) => setTimeout(r, 20));
				return { disposition: "accept" };
			},
		},
		accept("openai", "codex"),
	];
	const [a, b, c] = await Promise.all([
		runReviewPanel({ diff, source: "coalesce-key", reviewers }),
		runReviewPanel({ diff, source: "coalesce-key", reviewers }),
		runReviewPanel({ diff, source: "coalesce-key", reviewers }),
	]);
	expect(calls).toBe(1); // three concurrent identical requests, ONE reviewer spawn
	expect(a).toEqual(b);
	expect(b).toEqual(c);
});

test("B4: distinct sources for the SAME diff do NOT coalesce — each gets its own panel run", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	const diff = fakeDiff([".github/workflows/deploy.yml"]);
	let calls = 0;
	const reviewers = (): PanelReviewerSpec[] => [
		{
			lineage: "xai",
			harness: "grok",
			review: async () => {
				calls++;
				return { disposition: "accept" };
			},
		},
		accept("openai", "codex"),
	];
	await Promise.all([runReviewPanel({ diff, source: "source-1", reviewers }), runReviewPanel({ diff, source: "source-2", reviewers })]);
	expect(calls).toBe(2);
});

test("B4 ROUND 2 CRITICAL: identical source+diff (e.g. two tenants landing a cloned SHA) but DIFFERENT repo/stateDir do NOT coalesce — no cross-tenant queue contamination", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	const diff = fakeDiff([".github/workflows/deploy.yml"]);
	const sameSource = "land shared-template@abc123"; // an identical cloned SHA/diff, same source label
	let calls = 0;
	const reviewers = (): PanelReviewerSpec[] => [
		{
			lineage: "xai",
			harness: "grok",
			review: async () => {
				calls++;
				return { disposition: "object", severity: "high", claim: "a tenant-specific finding", concernClass: "fail-open" };
			},
		},
		accept("openai", "codex"),
	];
	const verify = () => async () => true;
	const stateDirA = await tmpStateDir();
	const stateDirB = await tmpStateDir();

	// The OLD narrow key (`source::hash(diff)`) would have been IDENTICAL for both calls — the round-1
	// bug: the SECOND caller would have received the FIRST caller's in-flight promise, and its finding
	// would have been queued under the FIRST tenant's stateDir instead of its own.
	const [resultA, resultB] = await Promise.all([
		runReviewPanel({ diff, source: sameSource, reviewers, verify, stateDir: stateDirA, repo: "/tenant/a/repo" }),
		runReviewPanel({ diff, source: sameSource, reviewers, verify, stateDir: stateDirB, repo: "/tenant/b/repo" }),
	]);

	expect(calls).toBe(2); // did NOT coalesce — two genuinely independent panel runs
	expect(resultA).toBeDefined();
	expect(resultB).toBeDefined();
	const queuedA = readPendingPanelFindings(stateDirA);
	const queuedB = readPendingPanelFindings(stateDirB);
	expect(queuedA.length).toBe(1); // tenant A's finding landed in tenant A's OWN queue
	expect(queuedB.length).toBe(1); // tenant B's finding landed in tenant B's OWN queue — never lost, never merged
});

test("B4 ROUND 2: identical source+diff+repo but DIFFERENT proofTree/criteriaKey do NOT coalesce (a retry against a genuinely different tree/criteria is not 'the same proof')", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	const diff = fakeDiff([".github/workflows/deploy.yml"]);
	let calls = 0;
	const reviewers = (): PanelReviewerSpec[] => [
		{
			lineage: "xai",
			harness: "grok",
			review: async () => {
				calls++;
				return { disposition: "accept" };
			},
		},
		accept("openai", "codex"),
	];
	await Promise.all([
		runReviewPanel({ diff, source: "same-source", reviewers, repo: "/same/repo", proofTree: "tree-1", criteriaKey: "criteria-1" }),
		runReviewPanel({ diff, source: "same-source", reviewers, repo: "/same/repo", proofTree: "tree-2", criteriaKey: "criteria-2" }),
	]);
	expect(calls).toBe(2);
});

test("B4 ROUND 2: truly identical requests (same source+diff+repo+worktree+stateDir+proofTree+criteriaKey+pool) STILL coalesce into one run", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	const diff = fakeDiff([".github/workflows/deploy.yml"]);
	let calls = 0;
	const reviewers = (): PanelReviewerSpec[] => [
		{
			lineage: "xai",
			harness: "grok",
			review: async () => {
				calls++;
				await new Promise((r) => setTimeout(r, 15));
				return { disposition: "accept" };
			},
		},
		accept("openai", "codex"),
	];
	const stateDir = await tmpStateDir();
	const shared = { diff, source: "identical", reviewers, stateDir, repo: "/r", worktree: "/r/wt", proofTree: "t1", criteriaKey: "c1" };
	const [a, b] = await Promise.all([runReviewPanel(shared), runReviewPanel(shared)]);
	expect(calls).toBe(1);
	expect(a).toEqual(b);
});

test("B4: sequential (non-concurrent) identical requests do NOT stay coalesced forever — a later call re-runs the panel", async () => {
	process.env.OMP_SQUAD_REVIEW_PANEL = "1";
	const diff = fakeDiff([".github/workflows/deploy.yml"]);
	let calls = 0;
	const reviewers = (): PanelReviewerSpec[] => [
		{
			lineage: "xai",
			harness: "grok",
			review: async () => {
				calls++;
				return { disposition: "accept" };
			},
		},
		accept("openai", "codex"),
	];
	await runReviewPanel({ diff, source: "sequential-key", reviewers });
	await runReviewPanel({ diff, source: "sequential-key", reviewers });
	expect(calls).toBe(2); // the in-flight entry was cleared after the first resolved
});

// ── default reviewer pool (production wiring, no CLI invocation) ───────────────────────────────

test("defaultPanelReviewers only offers lineages whose binary is actually present", () => {
	const pool = defaultPanelReviewers();
	// Sanity: no duplicate lineages, and every entry names a harness.
	expect(new Set(pool.map((p) => p.lineage)).size).toBe(pool.length);
	for (const p of pool) expect(p.harness.length).toBeGreaterThan(0);
});

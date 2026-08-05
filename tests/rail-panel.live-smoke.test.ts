/**
 * LIVE smoke for the in-code cross-lineage gauntlet panel (T5, glance#333) — a REAL panel run against
 * the real `codex`/`grok`/`omp` CLIs (whichever are present on PATH), writing REAL rows to a scratch
 * ledger file. Everything else in this PR (`tests/rail-panel.test.ts`, `tests/validator.gate-panel.test.ts`,
 * `tests/validator-land-gate-panel.test.ts`) proves the panel's LOGIC against fakes; this file is the one
 * place that proves the production reviewer factories (`defaultPanelReviewers`) actually produce
 * parseable verdicts from real subprocesses.
 *
 * Opt-in only (`PANEL_LIVE_SMOKE=1`) — real model calls cost tokens and take real wall-clock time (up
 * to `panelTimeoutMs()` per reviewer), so this must never run in the default `bun test` sweep or slow
 * down every contributor's gate. Skipped (not failed) when the flag is unset, mirroring this suite's
 * existing opt-in-live-test convention (e.g. `tests/squad.test.ts`'s `OMP_SQUAD_REAL_RPC`) — EXCEPT the
 * flag deliberately does NOT start with `OMP_SQUAD_`/`PLANE_`/`GLANCE_`: `tests/setup.ts`'s hermetic-env
 * sweep runs as a preload BEFORE any test module is imported and strips every env var with those three
 * prefixes (the one named carve-out is `OMP_SQUAD_REQUIRE_DOCKER_TESTS`), so a same-prefixed opt-in flag
 * set on the invoking shell would already be gone by the time this file's module body reads it — this is
 * a TEST-RUNNER concern, not daemon behavior under test, so it belongs outside that namespace entirely
 * rather than needing its own carve-out entry.
 */

import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { defaultPanelReviewers, runReviewPanel } from "../src/rail/panel.ts";

const LIVE = process.env.PANEL_LIVE_SMOKE === "1";

test.skipIf(!LIVE)(
	"LIVE: a real sensitive-path diff spawns a real cross-lineage panel and writes real ledger rows",
	async () => {
		process.env.OMP_SQUAD_REVIEW_PANEL = "1";
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "panel-live-smoke-"));
		try {
			// Sanity: at least 2 distinct-lineage reviewer binaries must actually be present, or this
			// smoke can't prove anything (and would silently degrade to "no panel" rather than testing
			// the real CLIs).
			const pool = defaultPanelReviewers();
			expect(pool.length).toBeGreaterThanOrEqual(2);

			const diff = [
				"diff --git a/.github/workflows/deploy.yml b/.github/workflows/deploy.yml",
				"--- a/.github/workflows/deploy.yml",
				"+++ b/.github/workflows/deploy.yml",
				"@@ -1,3 +1,5 @@",
				" on: push",
				"+permissions: write-all",
				"+# no environment guard on this deploy trigger",
				" jobs:",
				"   deploy:",
			].join("\n");
			const ledgerPath = path.join(dir, "reviewer-ledger.jsonl");

			const panel = await runReviewPanel({ diff, source: "live-smoke-test", ledgerPath });

			expect(panel).toBeDefined();
			expect(panel!.length).toBeGreaterThanOrEqual(2);
			expect(new Set(panel!.map((p) => p.lineage)).size).toBe(panel!.length);
			for (const v of panel!) {
				expect(["accept", "object", "timeout", "error"]).toContain(v.verdict);
				if (v.verdict === "object") expect(typeof v.claim).toBe("string");
			}
			console.log("live-smoke panel result:", JSON.stringify(panel, null, 2));

			// Any HIGH-severity objection got rechecked and recorded — if none fired, the ledger being
			// empty is also a valid (if less interesting) live outcome, so this only asserts SHAPE, not
			// that a finding necessarily occurred (a live model's actual verdict is not under test control).
			const rows = (await fs.readFile(ledgerPath, "utf8").catch(() => ""))
				.split("\n")
				.filter((l) => l.trim())
				.map((l) => JSON.parse(l));
			for (const r of rows) {
				expect(r).toMatchObject({ source: "live-smoke-test" });
				expect(typeof r.survived).toBe("boolean");
			}
		} finally {
			delete process.env.OMP_SQUAD_REVIEW_PANEL;
			await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
		}
	},
	240_000,
);

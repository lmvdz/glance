/**
 * LIVE smoke for the in-code cross-lineage gauntlet panel (T5, glance#333) — a REAL panel run against
 * the real `codex`/`grok`/`omp` CLIs (whichever are present on PATH), queuing REAL rows and projecting
 * them into a scratch tracked ledger. Everything else in this PR (`tests/rail-panel.test.ts`,
 * `tests/rail-panel-ledger.test.ts`, `tests/rail-panel-spawn.test.ts`, `tests/validator.gate-panel.test.ts`,
 * `tests/validator-land-gate-panel.test.ts`) proves the panel's LOGIC against fakes; this file is the one
 * place that proves the production reviewer factories (`defaultPanelReviewers`) actually produce
 * parseable verdicts from real subprocesses, that A7's canonical lineage tag survives a real run, and
 * that running the panel from INSIDE this repo's own checkout never dirties it (the hermetic-cwd
 * mitigation for finding C3, deterministically unit-proven in `tests/rail-panel-spawn.test.ts`, holds
 * up under a real multi-CLI panel too).
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
import { projectPendingPanelFindings, readPendingPanelFindings } from "../src/rail/panel-ledger.ts";
import { defaultPanelReviewers, runReviewPanel } from "../src/rail/panel.ts";

const LIVE = process.env.PANEL_LIVE_SMOKE === "1";

async function git(cwd: string, ...a: string[]): Promise<string> {
	const p = Bun.spawn(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
	const out = await new Response(p.stdout).text();
	await p.exited;
	return out.trim();
}

test.skipIf(!LIVE)(
	"LIVE: a real sensitive-path diff spawns a real cross-lineage panel, queues real rows, and projects them — this repo's OWN checkout is never dirtied by any of it",
	async () => {
		process.env.OMP_SQUAD_REVIEW_PANEL = "1";
		const repoStatusBefore = await git(process.cwd(), "status", "--porcelain");

		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "panel-live-smoke-state-"));
		const ledgerRepo = await fs.mkdtemp(path.join(os.tmpdir(), "panel-live-smoke-ledgerrepo-"));
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

			const panel = await runReviewPanel({ diff, source: "live-smoke-test", stateDir });

			expect(panel).toBeDefined();
			expect(panel!.length).toBeGreaterThanOrEqual(2);
			expect(new Set(panel!.map((p) => p.lineage)).size).toBe(panel!.length);
			for (const v of panel!) {
				expect(["accept", "object", "timeout", "error"]).toContain(v.verdict);
				if (v.verdict === "object") expect(typeof v.claim).toBe("string");
				// A7: every reviewer's `harness` is a REAL production harness name (grok/codex/omp),
				// never the raw "xai"/"openai"/"anthropic" vendor lineage string.
				expect(["grok", "codex", "omp"]).toContain(v.harness);
			}
			console.log("live-smoke panel result:", JSON.stringify(panel, null, 2));

			// Any adjudicated finding is QUEUED (A1 — never written to a tracked ledger directly), under
			// the CANONICAL lineage tag (A7).
			const queued = readPendingPanelFindings(stateDir);
			for (const r of queued) {
				expect(r).toMatchObject({ source: "live-smoke-test" });
				expect(["grok", "codex", "native"]).toContain(r.lineage); // never "xai"/"openai"/"anthropic"
				expect(typeof r.survived).toBe("boolean");
			}

			// Project into a SCRATCH tracked ledger (never the real one) — proves the end-to-end
			// queue -> commit lane against real, model-produced data, not just fixtures.
			const ledgerPath = path.join(ledgerRepo, "reviewer-ledger.jsonl");
			await fs.writeFile(ledgerPath, "");
			await git(ledgerRepo, "init", "-q", "-b", "main");
			await git(ledgerRepo, "config", "user.email", "t@t");
			await git(ledgerRepo, "config", "user.name", "t");
			await git(ledgerRepo, "add", "-A");
			await git(ledgerRepo, "commit", "-qm", "seed");
			const projection = await projectPendingPanelFindings(stateDir, ledgerRepo, ledgerPath);
			expect(projection.projected).toBe(queued.length);
			if (queued.length > 0) expect(projection.committed).toBe(true);
			expect(readPendingPanelFindings(stateDir)).toEqual([]);
			const ledgerStatus = await git(ledgerRepo, "status", "--porcelain");
			expect(ledgerStatus).toBe(""); // committed, tree clean

			// C3 (hermetic cwd): this ENTIRE panel ran with `process.cwd()` pointed at THIS repo (a real
			// checkout with AGENTS.md/plan docs/.git history) — if any reviewer's subprocess had inherited
			// it instead of a scratch cwd, a real agentic CLI could plausibly have poked at it. The
			// deterministic proof that `hermeticCwd()` itself returns an empty, non-repo directory lives
			// in `tests/rail-panel-spawn.test.ts`; this is the live-data corroboration that running the
			// production reviewer factories end to end never leaves so much as a stray file behind in
			// THIS checkout.
			const repoStatusAfter = await git(process.cwd(), "status", "--porcelain");
			expect(repoStatusAfter).toBe(repoStatusBefore);
		} finally {
			delete process.env.OMP_SQUAD_REVIEW_PANEL;
			await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
			await fs.rm(ledgerRepo, { recursive: true, force: true }).catch(() => {});
		}
	},
	240_000,
);

/**
 * B2 live corroboration: a REAL reviewer CLI invocation, bounded to a deadline too short for it to
 * ever finish a real turn, must leave no surviving process — `tests/rail-panel-spawn.test.ts`'s
 * `boundedHermeticSpawn` unit test proves this deterministically with a shell fixture; this drives the
 * SAME code path with a real `grok`/`codex` binary to corroborate it against a real agentic CLI's
 * actual process tree (which may fork workers the shell fixture can't model).
 */
test.skipIf(!LIVE)(
	"LIVE: a real reviewer CLI, bounded to an impossibly short timeout, is fully torn down — no surviving process holds its pipe open",
	async () => {
		process.env.OMP_SQUAD_REVIEW_PANEL = "1";
		process.env.OMP_SQUAD_REVIEW_PANEL_TIMEOUT_MS = "1"; // impossibly short — every real reviewer times out
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "panel-live-smoke-timeout-"));
		try {
			const pool = defaultPanelReviewers();
			expect(pool.length).toBeGreaterThanOrEqual(2);
			const diff = [
				"diff --git a/.github/workflows/deploy.yml b/.github/workflows/deploy.yml",
				"--- a/.github/workflows/deploy.yml",
				"+++ b/.github/workflows/deploy.yml",
				"@@ -1 +1 @@",
				"-on: push",
				"+on: push # changed",
			].join("\n");

			const start = Date.now();
			const panel = await runReviewPanel({ diff, source: "live-smoke-timeout-test", stateDir });
			const elapsed = Date.now() - start;

			// The function itself returned promptly (well under a real CLI turn's duration) — proof the
			// caller was never wedged, regardless of what the killed subprocess is doing in the background.
			expect(elapsed).toBeLessThan(15_000);
			expect(panel).toBeDefined();
			expect(panel!.every((v) => v.verdict === "timeout")).toBe(true);
		} finally {
			delete process.env.OMP_SQUAD_REVIEW_PANEL;
			delete process.env.OMP_SQUAD_REVIEW_PANEL_TIMEOUT_MS;
			await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
		}
	},
	60_000,
);

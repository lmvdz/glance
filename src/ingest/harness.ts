/**
 * harness ingest framework — the pluggable seam behind cross-harness cost attribution.
 *
 * The daemon writes receipts only for runs IT spawns (harness "omp"). Every other
 * harness that burns tokens against a repo — Claude Code, OpenAI Codex, and any
 * future CLI or provider — needs an INGESTER that reads its usage and folds it into
 * the one receipt ledger (`appendReceipt`), so the Fleet-Pulse attribution
 * (`src/omp-graph/attribution.ts`) sees every dollar, not just the daemon's own.
 *
 * A `HarnessIngester` is just a name + an idempotent `ingest(repo)`. Two source
 * SHAPES exist and both fit here:
 *  - LOCAL-LOG (claude-code, codex): walk on-disk session transcripts, filter by
 *    cwd → repo, cursor for idempotency. Naturally repo-scoped.
 *  - ACCOUNT-API (openrouter): query the provider's usage API. These carry no cwd,
 *    so they self-gate to a single configured attribution repo (see openrouter.ts)
 *    rather than double-attributing account spend to every repo.
 *
 * `ingestAllHarnesses` is the single call site (server graph/attribution payloads);
 * it throttles per (stateDir, repo, harness) so a burst of graph requests can't spam
 * the walks/APIs, and isolates failures so one bad harness can't sink the rest.
 */

export interface HarnessIngestResult {
	scanned: number;
	ingested: number;
}

export interface HarnessIngester {
	/** stable harness id, stamped onto receipts (`RunReceipt.harness`). */
	name: string;
	/** Append receipts for any of THIS repo's not-yet-ingested usage. Idempotent. */
	ingest(opts: { stateDir: string; repo: string; now?: number }): Promise<HarnessIngestResult>;
}

const THROTTLE_MS = 5 * 60_000;
const lastRun = new Map<string, number>();

/**
 * Run every registered ingester for `repo`, throttled per (stateDir, repo, harness)
 * and failure-isolated. Callers `await` it before reading receipts, but it never
 * throws — a broken ingester logs and is skipped.
 */
export async function ingestAllHarnesses(ingesters: HarnessIngester[], stateDir: string, repo: string): Promise<void> {
	const now = Date.now();
	for (const h of ingesters) {
		const key = `${stateDir}:${repo}:${h.name}`;
		if (now - (lastRun.get(key) ?? 0) < THROTTLE_MS) continue;
		lastRun.set(key, now);
		try {
			const r = await h.ingest({ stateDir, repo });
			if (r.ingested > 0) console.log(`${h.name} ingest: ${r.ingested} session(s) → receipts (${r.scanned} scanned)`);
		} catch (err) {
			console.warn(`${h.name} ingest failed:`, err);
		}
	}
}

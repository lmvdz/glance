/**
 * ingest — the registered set of external-harness ingesters and the one call the
 * server makes to fold their usage into the receipt ledger before reading it for
 * the Fleet-Pulse cost attribution.
 *
 * Adding a harness is a one-line registration here plus its module: implement a
 * `HarnessIngester` (see harness.ts), append it below. Order is cosmetic (each is
 * independently throttled + failure-isolated in `ingestAllHarnesses`).
 */

import { ingestAllHarnesses, type HarnessIngester } from "./harness.ts";
import { claudeCodeIngester } from "./claude-code.ts";
import { codexIngester } from "./codex.ts";
import { openRouterIngester } from "./openrouter.ts";

export const HARNESS_INGESTERS: HarnessIngester[] = [claudeCodeIngester, codexIngester, openRouterIngester];

/** Run every registered harness ingester for `repo` (throttled, failure-isolated, never throws). */
export function ingestHarnesses(stateDir: string, repo: string): Promise<void> {
	return ingestAllHarnesses(HARNESS_INGESTERS, stateDir, repo);
}

export { ingestAllHarnesses, type HarnessIngester } from "./harness.ts";

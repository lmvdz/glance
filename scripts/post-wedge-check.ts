#!/usr/bin/env bun
/**
 * scripts/post-wedge-check.ts — the one-command daemon invocation for the GitHub-App wedge spike
 * (glance#337, rail T9). Mints an installation token from the App's credentials, fetches PR metadata,
 * and pushes a Checks API check-run — the outcome depends on authorship + receipt verification (see
 * `postAgentPrCheck`'s doc comment for the full decision table): `success` only for a receipt that
 * verifies against THIS PR's current head (repo/SHA/gate-outcome/freshness all bound — gauntlet round
 * 1 CRITICAL fix), `failure` for a receipt that was supplied but doesn't verify, `action_required` for
 * an agent-authored PR with no (or an unreadable) receipt, and an honestly-labeled informational
 * `success` for a PR that isn't classified agent-authored at all (so the Ruleset's required check
 * doesn't block ordinary human PRs — see authorship.ts's header).
 *
 * Usage:
 *   bun run scripts/post-wedge-check.ts --owner <o> --repo <r> --pr <n> \
 *     [--receipt <path-to-LandReceipt.json>] [--details-url <url>] [--check-name <name>]
 *
 * Credentials come from the environment — see plans/landing-rail/wedge-install.md for the full setup:
 *   GLANCE_GH_APP_ID              the App's numeric ID
 *   GLANCE_GH_APP_INSTALLATION_ID the installation ID on the target repo
 *   GLANCE_GH_APP_PRIVATE_KEY     PATH to the App's PEM private-key file (never the PEM inline)
 * Optional authorship-gate overrides (comma-separated; see src/rail/wedge/authorship.ts for defaults —
 * NOTE the commit-trailer signal is OFF by default, opt in explicitly):
 *   GLANCE_GH_APP_BOT_LOGINS, GLANCE_GH_APP_BRANCH_PREFIXES, GLANCE_GH_APP_TRAILER_KEYS
 * Optional freshness override: GLANCE_GH_APP_RECEIPT_MAX_AGE_MS (default 24h).
 *
 * `--receipt` takes a JSON file holding a serialized `LandReceipt` (src/rail/receipt/types.ts) — the
 * daemon's own land path would pass the in-memory object directly to `postAgentPrCheck` instead of
 * going through this file; the CLI's JSON-file form exists for manual/spike invocation and testing.
 * The file is decoded through `LandReceiptSchema`, never a bare `JSON.parse(...) as LandReceipt` cast
 * (gauntlet round 1 CRITICAL: this file used to do exactly that) — a malformed file still POSTS a
 * check (an explicit "malformed receipt" `action_required`, never silently treated as "no receipt was
 * ever supplied" and never `success`), so the PR shows honest, visible feedback instead of a stale or
 * missing check.
 */

import { readFileSync } from "node:fs";
import { Result, Schema } from "effect";
import {
	loadAuthorshipConfigFromEnv,
	loadMaxReceiptAgeMsFromEnv,
	loadWedgeCredentialsFromEnv,
	postAgentPrCheck,
	LandReceiptSchema,
	type LandReceipt,
} from "../src/rail/index.ts";
import { formatDecodeIssue } from "../src/schema/client-command.ts";
import { errText } from "../src/err-text.ts";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	const value = i >= 0 ? process.argv[i + 1] : undefined;
	// A missing value must not swallow the next flag.
	return value !== undefined && !value.startsWith("--") ? value : undefined;
}

/** Decode `--receipt`'s file through `LandReceiptSchema` — never a bare parse-and-cast (gauntlet round
 *  1 CRITICAL; see this file's header). Returns `{ receipt }` on success, `{ error }` (a bounded,
 *  human-readable reason) on ANY failure — missing file, invalid JSON, or a well-formed JSON value
 *  that doesn't match the schema. The caller treats `error` as "malformed", never as "no file given". */
function decodeReceiptFile(path: string): { receipt?: LandReceipt; error?: string } {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		return { error: `could not read ${path}: ${errText(err)}` };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		return { error: `${path} is not valid JSON: ${errText(err)}` };
	}
	const decoded = Schema.decodeUnknownResult(LandReceiptSchema)(raw);
	if (Result.isFailure(decoded)) {
		return { error: `${path} does not match the LandReceipt shape: ${formatDecodeIssue(decoded.failure)}` };
	}
	// Re-narrowed to the domain type — sound because `LandReceiptSchema`'s own type-level guard
	// (receipt-schema.ts) locks it to `LandReceipt`; the only mismatch is Schema's readonly arrays vs
	// the domain type's mutable ones, same cast pattern as src/schema/client-command.ts.
	return { receipt: decoded.success as LandReceipt };
}

async function main(): Promise<void> {
	const owner = arg("owner");
	const repo = arg("repo");
	const prRaw = arg("pr");
	const receiptPath = arg("receipt");
	const detailsUrl = arg("details-url");
	const checkName = arg("check-name");

	if (!owner || !repo || !prRaw || !/^\d+$/.test(prRaw)) {
		console.error("usage: bun run scripts/post-wedge-check.ts --owner <o> --repo <r> --pr <n> [--receipt <path-to-LandReceipt.json>] [--details-url <url>] [--check-name <name>]");
		process.exit(2);
	}

	const credentials = loadWedgeCredentialsFromEnv();
	if (!credentials) {
		console.error("missing GLANCE_GH_APP_ID / GLANCE_GH_APP_INSTALLATION_ID / GLANCE_GH_APP_PRIVATE_KEY — see plans/landing-rail/wedge-install.md");
		process.exit(1);
	}

	let receipt: LandReceipt | undefined;
	let receiptError: string | undefined;
	if (receiptPath) {
		const decoded = decodeReceiptFile(receiptPath);
		receipt = decoded.receipt;
		receiptError = decoded.error;
		if (receiptError) console.error(`warning: ${receiptError} — posting an explicit "malformed receipt" check instead of silently treating this as no receipt`);
	}

	const result = await postAgentPrCheck({
		credentials,
		owner,
		repo,
		prNumber: Number(prRaw),
		receipt,
		receiptError,
		authorshipConfig: loadAuthorshipConfigFromEnv(),
		maxReceiptAgeMs: loadMaxReceiptAgeMsFromEnv(),
		detailsUrl,
		checkName,
	});

	console.log(`posted check-run #${result.checkRunId} (${result.conclusion}, reason: ${result.reason}) for ${owner}/${repo}#${prRaw} — ${result.checkRunUrl}`);
	if (result.rejection) console.log(`  rejected because: ${result.rejection.reason} — ${result.rejection.detail}`);
}

main().catch((err) => {
	console.error(`post-wedge-check failed: ${errText(err)}`);
	process.exit(1);
});

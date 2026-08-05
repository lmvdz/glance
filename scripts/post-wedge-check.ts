#!/usr/bin/env bun
/**
 * scripts/post-wedge-check.ts — the one-command daemon invocation for the GitHub-App wedge spike
 * (glance#337, rail T9). Mints an installation token from the App's credentials, fetches PR metadata,
 * runs the agent-authorship gate, and pushes a Checks API check-run: `success` with the T6 receipt in
 * `output.text` when a receipt is supplied, `action_required` when the PR looks agent-authored but no
 * receipt was found, or a no-op when the PR doesn't look agent-authored at all.
 *
 * Usage:
 *   bun run scripts/post-wedge-check.ts --owner <o> --repo <r> --pr <n> \
 *     [--receipt <path-to-LandReceipt.json>] [--details-url <url>] [--check-name <name>]
 *
 * Credentials come from the environment — see plans/landing-rail/wedge-install.md for the full setup:
 *   GLANCE_GH_APP_ID              the App's numeric ID
 *   GLANCE_GH_APP_INSTALLATION_ID the installation ID on the target repo
 *   GLANCE_GH_APP_PRIVATE_KEY     PATH to the App's PEM private-key file (never the PEM inline)
 * Optional authorship-gate overrides (comma-separated; see src/rail/wedge/authorship.ts for defaults):
 *   GLANCE_GH_APP_BOT_LOGINS, GLANCE_GH_APP_BRANCH_PREFIXES, GLANCE_GH_APP_TRAILER_KEYS
 *
 * `--receipt` takes a JSON file holding a serialized `LandReceipt` (src/rail/receipt/types.ts) — the
 * daemon's own land path would pass the in-memory object directly to `postAgentPrCheck` instead of
 * going through this file; the CLI's JSON-file form exists for manual/spike invocation and testing.
 */

import { readFileSync } from "node:fs";
import { loadAuthorshipConfigFromEnv, loadWedgeCredentialsFromEnv, postAgentPrCheck, type LandReceipt } from "../src/rail/index.ts";
import { errText } from "../src/err-text.ts";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	const value = i >= 0 ? process.argv[i + 1] : undefined;
	// A missing value must not swallow the next flag.
	return value !== undefined && !value.startsWith("--") ? value : undefined;
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
	if (receiptPath) {
		try {
			receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as LandReceipt;
		} catch (err) {
			console.error(`could not read/parse --receipt ${receiptPath}: ${errText(err)}`);
			process.exit(1);
		}
	}

	const result = await postAgentPrCheck({
		credentials,
		owner,
		repo,
		prNumber: Number(prRaw),
		receipt,
		authorshipConfig: loadAuthorshipConfigFromEnv(),
		detailsUrl,
		checkName,
	});

	if (result.skipped) {
		console.log(`skipped — PR #${prRaw} on ${owner}/${repo} is not agent-authored (${result.authorship.detail})`);
		return;
	}
	console.log(`posted check-run #${result.checkRunId} (${result.conclusion}) for ${owner}/${repo}#${prRaw} — ${result.checkRunUrl}`);
}

main().catch((err) => {
	console.error(`post-wedge-check failed: ${errText(err)}`);
	process.exit(1);
});

/**
 * Env-var config loading for the wedge (glance#337, rail T9) — mirrors secrets.ts's
 * file-path-over-inline-value convention (`GLANCE_SECRETS_KEY_FILE` there → `GLANCE_GH_APP_PRIVATE_KEY`
 * here): the App's private key is read from a FILE PATH the env var names, never from an inline PEM
 * blob in the env var itself, so the key material never sits directly in `process.env`/the process's
 * argv/environ view any longer than a single synchronous `readFileSync` needs it in memory.
 *
 * Every loader here degrades to `undefined` (credentials) or a documented default (authorship config)
 * on a missing/unreadable input — never throws. A missing wedge config is a normal state (the wedge
 * isn't configured on this host yet), not an error.
 */

import { readFileSync } from "node:fs";
import type { WedgeCredentials } from "./types.ts";
import { DEFAULT_AUTHORSHIP_CONFIG, type AuthorshipConfig } from "./authorship.ts";
import { DEFAULT_MAX_RECEIPT_AGE_MS } from "./receipt-verify.ts";

function readPrivateKeyFile(path: string | undefined): string | undefined {
	if (!path) return undefined;
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined; // missing/unreadable file degrades to "no key", never throws
	}
}

/**
 * Resolve the App's credentials from the environment:
 *   - `GLANCE_GH_APP_ID`               — the App's numeric ID
 *   - `GLANCE_GH_APP_INSTALLATION_ID`  — the installation ID on the target repo
 *   - `GLANCE_GH_APP_PRIVATE_KEY`      — PATH to the App's PEM private-key file (not the PEM itself)
 * Returns `undefined` if any of the three is missing or the key file can't be read — the wedge is
 * simply "not configured" rather than a boot-time failure (same posture as `hasMasterKey()`).
 */
export function loadWedgeCredentialsFromEnv(env: NodeJS.ProcessEnv = process.env): WedgeCredentials | undefined {
	const appId = env.GLANCE_GH_APP_ID;
	const installationId = env.GLANCE_GH_APP_INSTALLATION_ID;
	const privateKeyPem = readPrivateKeyFile(env.GLANCE_GH_APP_PRIVATE_KEY);
	if (!appId || !installationId || !privateKeyPem) return undefined;
	return { appId, installationId, privateKeyPem };
}

function splitList(raw: string | undefined): string[] | undefined {
	if (!raw) return undefined;
	const items = raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return items.length > 0 ? items : undefined;
}

/** Optional allowlist overrides for the agent-authorship gate — comma-separated lists. Any var left
 *  unset keeps `DEFAULT_AUTHORSHIP_CONFIG`'s value for that field (not a global all-or-nothing swap),
 *  so an operator can widen just the branch-prefix set without having to restate the bot-login list. */
export function loadAuthorshipConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthorshipConfig {
	return {
		botLogins: splitList(env.GLANCE_GH_APP_BOT_LOGINS) ?? DEFAULT_AUTHORSHIP_CONFIG.botLogins,
		branchPrefixes: splitList(env.GLANCE_GH_APP_BRANCH_PREFIXES) ?? DEFAULT_AUTHORSHIP_CONFIG.branchPrefixes,
		// Empty by default (see authorship.ts's header) — reading the var at all is opt-in, not a
		// widened default; an unset/blank var keeps the empty default, never silently re-enables it.
		trailerKeys: splitList(env.GLANCE_GH_APP_TRAILER_KEYS) ?? DEFAULT_AUTHORSHIP_CONFIG.trailerKeys,
	};
}

/** How old a receipt is allowed to be (ms) before `verifyReceiptForPr` rejects it as stale. Not a
 *  `src/config.ts` `envInt` read: that helper reads `process.env` directly, which would defeat this
 *  module's env-DI-param testability convention (every loader here accepts an explicit `env` for
 *  tests) — a small inline parse instead. */
export function loadMaxReceiptAgeMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.GLANCE_GH_APP_RECEIPT_MAX_AGE_MS;
	if (!raw) return DEFAULT_MAX_RECEIPT_AGE_MS;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_RECEIPT_AGE_MS;
}

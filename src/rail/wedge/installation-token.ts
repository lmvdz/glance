/**
 * Exchange a GitHub App JWT for a short-lived installation access token (glance#337, rail T9).
 * `POST /app/installations/{id}/access_tokens`, authenticated as the App (the JWT), returns a token
 * scoped to that installation's repos and the App's granted permissions. Installation tokens expire
 * in 1 hour; the wedge mints one fresh per check-run post rather than caching across calls — a spike
 * posting at most one check per land doesn't need the complexity of a cache with expiry tracking.
 *
 * Docs: https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app
 */

import { githubApiRequest } from "./github-api.ts";
import { InstallationTokenResponseSchema } from "./schemas.ts";
import type { WedgeApiOptions } from "./types.ts";

export interface InstallationToken {
	token: string;
	/** ISO-8601 timestamp — 1 hour from mint time. */
	expiresAt: string;
}

/** `appJwt` authenticates as the App itself (mintAppJwt's output); the returned token authenticates
 *  as the INSTALLATION and is what every subsequent GitHub call (fetching PR metadata, posting the
 *  check-run) must use — the App JWT itself cannot read/write repo content. */
export async function mintInstallationToken(appJwt: string, installationId: string | number, opts: WedgeApiOptions = {}): Promise<InstallationToken> {
	const res = await githubApiRequest("POST", `/app/installations/${installationId}/access_tokens`, appJwt, InstallationTokenResponseSchema, opts);
	return { token: res.token, expiresAt: res.expires_at };
}

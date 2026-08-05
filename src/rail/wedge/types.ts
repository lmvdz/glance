/**
 * src/rail/wedge — the GitHub-App wedge (glance#337, rail T9). Shared shapes used across the wedge's
 * modules: the App's credentials and the per-request API options every GitHub call accepts.
 *
 * The wedge is a SPIKE: a minimal GitHub App that posts a Checks API check-run to gate agent-authored
 * PRs on an external repo with ZERO adoption by that repo (no workflow file, no Action — see
 * plans/landing-rail/research/github-app-wedge.md, the adjudicated design this module implements).
 */

/** The App's credentials, resolved from the environment (see config.ts). Never hardcoded, never
 *  logged — `privateKeyPem` is the App's RSA private key in PEM form (read from a file path, not an
 *  env-var-inline value, mirroring secrets.ts's file-over-inline convention). */
export interface WedgeCredentials {
	/** The GitHub App's numeric ID (the JWT `iss` claim). */
	appId: string;
	/** The installation ID on the target repo (`POST /app/installations/{id}/access_tokens`). */
	installationId: string | number;
	/** The App's RSA private key, PEM-encoded (PKCS#1 or PKCS#8 — `node:crypto` accepts both). */
	privateKeyPem: string;
}

/** Per-request knobs every GitHub REST call accepts. `apiBase` exists for GitHub Enterprise Server
 *  and for tests (point it at a local stub); it is never required for github.com. */
export interface WedgeApiOptions {
	/** Defaults to `https://api.github.com`. */
	apiBase?: string;
	/** Defaults to 15s — matches voice-token.ts's `verifyVoiceProviderKey` timeout convention. */
	timeoutMs?: number;
}

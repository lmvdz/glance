/**
 * GitHub App JWT minting (glance#337, rail T9). A GitHub App authenticates as ITSELF (not as an
 * installation) with a short-lived JWT signed by its RSA private key: `{ iat, exp, iss: appId }`,
 * `RS256`. That JWT is then exchanged for an installation access token (installation-token.ts).
 *
 * No JWT library exists in this codebase (grepped: no jsonwebtoken/jose import in src/) and `jose` is
 * only a TRANSITIVE dependency of better-auth today, not a direct one — pulling it in as a direct
 * import would be an undeclared-dependency footgun. A GitHub App JWT is three fixed fields signed with
 * RS256; `node:crypto` does the whole thing in ~20 lines with zero new dependencies, so that's what
 * this does.
 *
 * Docs: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
 * GitHub requires `exp` no more than 10 minutes past `iat`, and recommends backdating `iat` by up to
 * 60s to tolerate clock drift between this host and GitHub's — both honored below.
 */

import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { errText } from "../../err-text.ts";

const CLOCK_DRIFT_BACKDATE_S = 60;
const MAX_LIFETIME_S = 600; // GitHub's hard cap

function base64url(input: string | Buffer): string {
	const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
	return buf.toString("base64url");
}

function loadPrivateKey(pem: string): KeyObject {
	try {
		return createPrivateKey(pem);
	} catch (err) {
		throw new Error(`mintAppJwt: invalid RSA private key PEM: ${errText(err)}`);
	}
}

/**
 * Mint a GitHub App JWT. Pure given `nowMs` (defaults to `Date.now()`, overridable for tests) — no
 * network, no fs. Throws only on a malformed private key; never silently produces an unsigned/invalid
 * token.
 */
export function mintAppJwt(appId: string, privateKeyPem: string, nowMs: number = Date.now()): string {
	const key = loadPrivateKey(privateKeyPem);
	const iat = Math.floor(nowMs / 1000) - CLOCK_DRIFT_BACKDATE_S;
	const exp = iat + MAX_LIFETIME_S;
	const header = { alg: "RS256", typ: "JWT" };
	const payload = { iat, exp, iss: appId };
	const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
	const signature = createSign("RSA-SHA256").update(signingInput).sign(key);
	return `${signingInput}.${base64url(signature)}`;
}

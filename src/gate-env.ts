/**
 * Scrubbed environment for acceptance/verify gates — the proof runner (src/proof.ts), the
 * land gate (src/land.ts runGate), and the manager's gate runner all execute AGENT-AUTHORED
 * test code unsandboxed on the daemon host. Before this, that code inherited the daemon's
 * FULL env: the dashboard bearer secret, PLANE_API_KEY, payment provider keys, every LLM
 * provider credential. A malicious (or merely curious) test could read and exfiltrate them.
 *
 * This is pass-through-minus-secrets, deliberately NOT commissioning's deny-by-default
 * (validate.ts acceptanceEnv): real repo suites need arbitrary toolchain vars (CARGO_HOME,
 * GOPATH, NVM_DIR, CI, …) and a false-red gate here makes the Observer file false
 * `regression:` issues. Removed instead: every `OMP_SQUAD_*` var, secret-SHAPED names, and
 * the daemon's known credential vars. `OMP_SQUAD_GATE_ENV="NAME1,NAME2"` re-admits named
 * vars for a suite that legitimately needs one (e.g. an integration-test key).
 *
 * ponytail: name-shape deny-listing can miss an oddly-named secret. The durable fix is
 * running gates under the existing --sandbox container seam; this closes the broad
 * default leak without breaking legitimate suites.
 */

const SECRET_NAME =
	/(_API_KEY|_APIKEY|_TOKEN|_SECRET|_SECRET_KEY|_PASSWORD|_PASSWD|_CREDENTIALS?|_PRIVATE_KEY|_ACCESS_KEY|_SESSION_KEY|_SIGNING_KEY|_ENCRYPTION_KEY|_TLS_KEY|_AUTH)$/i;

/** Daemon credentials whose names the shape regex misses. */
const SECRET_EXACT = new Set(["DATABASE_URL", "PLANE_API_KEY"]);

/** The environment a verify/proof/regression gate child may see. */
export function gateEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const allow = new Set(
		(source.OMP_SQUAD_GATE_ENV ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		if (typeof value !== "string") continue;
		// Strip BOTH prefixes: env-compat.ts mirrors every OMP_SQUAD_* secret into a canonical GLANCE_
		// twin, so scrubbing only OMP_SQUAD_ would leak the twin (e.g. GLANCE_TLS_KEY) to gate test code.
		if (!allow.has(key) && (key.startsWith("OMP_SQUAD_") || key.startsWith("GLANCE_") || SECRET_NAME.test(key) || SECRET_EXACT.has(key))) continue;
		env[key] = value;
	}
	return env;
}

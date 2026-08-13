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

import { isSquadEnvCompatKey } from "./spawn-env.ts";

const SECRET_NAME =
	/(_API_KEY|_APIKEY|_TOKEN|_SECRET|_SECRET_KEY|_PASSWORD|_PASSWD|_CREDENTIALS?|_PRIVATE_KEY|_ACCESS_KEY|_SESSION_KEY|_SIGNING_KEY|_ENCRYPTION_KEY|_TLS_KEY|_AUTH)$/i;

/** Daemon credentials whose names the shape regex misses. */
const SECRET_EXACT = new Set(["DATABASE_URL", "PLANE_API_KEY"]);

/**
 * Positive ALLOWLIST env for a registered TENANT gate (glance#393 round 3, THEME B / codex C-2).
 *
 * `gateEnv` above is pass-through-minus-secrets — a DENYLIST — which is right for the detection path
 * (a stranger's cargo/go/python suite legitimately needs arbitrary toolchain vars, and a false-red
 * there files a phantom regression). But a denylist is not a security boundary: codex reproduced
 * `SECRET_CANARY` (suffix `_CANARY`, matched by no rule) reaching the executed gate child. A
 * registered tenant runs AGENT-AUTHORED code against declared services, so its env is a boundary, not
 * a courtesy: only an explicit minimal operational base + the service-discovery vars + whatever the
 * tenant's own contract (or the operator) re-admits by NAME. Everything else is absent by construction
 * — a newly-invented secret name leaks nothing because it was never on the list.
 *
 * The tradeoff is deliberate and per the finding: a tenant suite that needs `CARGO_HOME`/`NODE_ENV`
 * declares it in `policy.env` (per-tenant) or the operator sets `OMP_SQUAD_GATE_ENV` (daemon escape
 * hatch) — an explicit act, never an accident.
 */
const TENANT_GATE_ALLOW_EXACT = new Set([
	"PATH", "HOME", "SHELL", "USER", "LOGNAME", "PWD", "TERM", "TZ", "LANG", "LANGUAGE",
	"TMPDIR", "TMP", "TEMP", "HOSTNAME", "CI", "COLUMNS", "LINES",
]);
/** Prefixes always admitted: locale, and the rail's own service-discovery vars (never secrets). */
const TENANT_GATE_ALLOW_PREFIX = ["LC_", "GLANCE_SERVICE_", "GLANCE_GATE_COMPOSE_"];

/**
 * L-1 (round 4): the REJECT-LIST FLOOR. Even a name an operator explicitly listed in `policy.env`
 * (or `OMP_SQUAD_GATE_ENV`, or an allowed prefix) is refused if it is secret-SHAPED — an allowlist
 * that lets a confused/coerced operator re-admit `DATABASE_URL` is a confused-deputy hole. This is
 * the one rule `allow` cannot override; only the rail's own `add` values (GLANCE_SERVICE_*) bypass it,
 * and those are rail-controlled, never daemon secrets. Covers the receipt's set — DATABASE_URL,
 * `*_API_KEY`, `*_TOKEN`, `*_SECRET`, `SECRET_*` — plus the broader credential shapes `gateEnv` denies.
 */
export function isSecretShaped(key: string): boolean {
	return SECRET_EXACT.has(key) || SECRET_NAME.test(key) || /^SECRET_/i.test(key) || /CANARY/i.test(key);
}

/**
 * CONFIG-INJECTION hard floor (round 5, codex C-1). These are not secrets by NAME, but they
 * reopen the secret leak one level up: they instruct docker/compose to LOAD other config — env files,
 * alternate compose files, custom HTTP headers — whose contents then participate in `${...}`
 * interpolation into tenant service containers. Codex proved it live: `COMPOSE_ENV_FILES=/etc/os-release`
 * changed `${ID}` via real `docker compose config`, so a daemon-owned env file with `DATABASE_URL=…`
 * restores `${DATABASE_URL}` interpolation despite the direct scrub. A prefix allowlist is not a
 * boundary — this floor is refused even if a future edit re-widens the allow set. (`docker compose`
 * ALSO gets an explicit empty `--env-file`, so this is belt-and-suspenders.)
 */
const CONFIG_INJECTION_DENY = new Set([
	"COMPOSE_ENV_FILES", "COMPOSE_FILE", "COMPOSE_PATH_SEPARATOR", "COMPOSE_PROFILES",
	"DOCKER_CUSTOM_HEADERS",
]);

/** Refused everywhere, over any allowlist: a secret name OR a config-injection var. */
function isForbiddenGateEnvName(key: string): boolean {
	return isSecretShaped(key) || CONFIG_INJECTION_DENY.has(key);
}

/**
 * Round 5 (codex C-1): there is NO external prefix extension point any more. Callers name the exact
 * vars they need. A prefix (`DOCKER_*`/`COMPOSE_*`) is not a boundary — it let `COMPOSE_ENV_FILES`
 * and `DOCKER_CUSTOM_HEADERS` through, the same shape of mistake as round 3's suffix denylist one
 * level up. The internal base prefixes that remain are rail/locale-owned (LC_, GLANCE_*), never
 * attacker-influenced and never config-injecting.
 */
export function tenantGateEnv(
	source: NodeJS.ProcessEnv = process.env,
	extra?: { allow?: readonly string[]; add?: Record<string, string> },
): Record<string, string> {
	const allow = new Set<string>([
		...TENANT_GATE_ALLOW_EXACT,
		...(source.OMP_SQUAD_GATE_ENV ?? "").split(",").map((s) => s.trim()).filter(Boolean),
		...(extra?.allow ?? []).map((s) => s.trim()).filter(Boolean),
	]);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		if (typeof value !== "string") continue;
		if (isForbiddenGateEnvName(key)) continue; // hard floor — secrets AND config-injection, never
		if (allow.has(key) || TENANT_GATE_ALLOW_PREFIX.some((p) => key.startsWith(p))) env[key] = value;
	}
	// The service-discovery vars are added LAST and unconditionally — they are the rail's own values,
	// not the daemon's env, so they ride even if a same-named var was (impossibly) absent above.
	return { ...env, ...(extra?.add ?? {}) };
}

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
		// isSquadEnvCompatKey is shared with spawn-env.ts's tenant-agent scrub so the two can't drift
		// apart on this one prefix pair — everything else here stays gate-env's own, unshared logic.
		if (!allow.has(key) && (isSquadEnvCompatKey(key) || SECRET_NAME.test(key) || SECRET_EXACT.has(key))) continue;
		env[key] = value;
	}
	return env;
}

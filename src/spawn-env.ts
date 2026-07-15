/**
 * Scrubbed environment for TENANT AGENT spawns — the three sites that hand the daemon's env to an
 * agent-authored process: `agent-host.ts` (the omp/pi child a squad agent drives), `omp-call.ts`
 * (one-shot `omp -p` calls), and `acp-agent-driver.ts` (an ACP runtime — `auggie`/`gemini`/`codex`/…).
 * Before this module, all three inherited the daemon's FULL environment: `DATABASE_URL` (and, once
 * the voice plan lands, the boot secret) is readable by any agent via `printenv` or hostile repo
 * content that induces one. This is a live multi-tenant hole today, independent of voice.
 *
 * Deny-by-shape, not an allowlist of known-bad: a var whose NAME looks like a daemon credential is
 * stripped even if this module has never heard of it — new secrets are safe by default. What survives
 * the deny pass is then narrowed further to an explicit keep-list; this is a stricter default than
 * `gate-env.ts`'s pass-through-minus-secrets (gate code runs a developer's own toolchain suite and
 * needs arbitrary vars like CARGO_HOME/GOPATH/CI — a tenant agent process needs far less).
 *
 * `OMP_SQUAD_*`/`GLANCE_*` full-prefix denial is SHARED with gate-env.ts via `isSquadEnvCompatKey`
 * (env-compat.ts mirrors every `OMP_SQUAD_*` var into a canonical `GLANCE_*` twin, so scrubbing only
 * one prefix leaks the other) — one place owns that pair so the two scrubs can't drift apart on it.
 * Everything past that prefix pair is intentionally NOT shared: gate-env.ts denies `PLANE_API_KEY`
 * specifically (a gate suite may legitimately need other `PLANE_*` vars, e.g. a workspace slug for an
 * integration test); the tenant scrub below denies the whole `PLANE_*` prefix, because a tenant agent
 * has no legitimate use for ANY of the daemon's Plane configuration.
 */

import { DEFAULT_PROVIDER, resolveProvider } from "./model-lineage.ts";

/** `OMP_SQUAD_*` and its env-compat twin `GLANCE_*` (env-compat.ts mirrors every `OMP_SQUAD_*` secret
 *  into a canonical `GLANCE_` name at boot) — denied in full by both the gate scrub and the tenant
 *  agent scrub below. */
export function isSquadEnvCompatKey(key: string): boolean {
	return key.startsWith("OMP_SQUAD_") || key.startsWith("GLANCE_");
}

/** Daemon credential PREFIXES denied in full, regardless of whether the specific var name is
 *  secret-shaped — a tenant agent has no legitimate use for ANY var under these prefixes. */
const SECRET_PREFIXES = ["BETTER_AUTH_", "GITHUB_", "WORKOS_", "PLANE_"];

/** Daemon credentials denied by exact name — don't carry a secret-shaped suffix, so the shape regex
 *  below can't catch them. Grok's audit: common DB/cloud credential names that pass through the shape
 *  regex untouched — `PGPASSWORD`/`MYSQL_PWD` have no `_` before the suffix the regex requires,
 *  `AWS_ACCESS_KEY_ID` ends in `_ID` (not `_KEY`) despite carrying the key material, and
 *  `DOCKER_AUTH_CONFIG` carries a base64 registry credential under a name shaped like neither `_KEY`
 *  nor `_TOKEN`. (`AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN` are already caught by the shape
 *  regex below — `_KEY`/`_TOKEN` respectively — and don't need listing here; see spawn-env.test.ts.) */
const SECRET_EXACT = new Set(["DATABASE_URL", "PGPASSWORD", "MYSQL_PWD", "AWS_ACCESS_KEY_ID", "DOCKER_AUTH_CONFIG"]);

/** Vars denied by name SHAPE — catches secrets under names this module has never seen; a var newly
 *  added anywhere in the daemon's env is safe by default as long as it's named like a credential. */
const SECRET_NAME_SHAPE = /(_KEY|_SECRET|_TOKEN|_PASSWORD|_CREDENTIALS?)$/i;

/** Vars that MATCH `SECRET_NAME_SHAPE` by name but are not themselves secret material — they name a
 *  file PATH a harness must read, not a credential value. Checked first in `isDaemonSecretEnvKey` so
 *  the shape deny can never catch them; still gated by `isKeepListed` below like everything else, so
 *  listing a name here only lifts the shape veto, it doesn't grant passage on its own.
 *  `GOOGLE_APPLICATION_CREDENTIALS` is the ADC convention Vertex/Gemini SDKs read: a path to a
 *  service-account JSON file on the daemon's own filesystem, not a secret string in the env itself. */
const SHAPE_EXCEPTIONS = new Set(["GOOGLE_APPLICATION_CREDENTIALS"]);

/** True if `key` names a daemon secret that must never reach a spawned tenant agent process.
 *  Not exported: `scrubbedSpawnEnv` (below, same file) is the only production caller — test
 *  through it instead of this predicate directly (dead-exports-ratchet precedent). */
function isDaemonSecretEnvKey(key: string): boolean {
	if (SHAPE_EXCEPTIONS.has(key)) return false;
	if (isSquadEnvCompatKey(key)) return true;
	if (SECRET_EXACT.has(key)) return true;
	if (SECRET_PREFIXES.some((p) => key.startsWith(p))) return true;
	return SECRET_NAME_SHAPE.test(key);
}

/** Non-secret operational vars a spawned agent process legitimately needs regardless of what the
 *  deny-by-shape check says: locate binaries/home/shell, speak the right locale, format timestamps,
 *  and (proxy vars) reach the harness's provider API at all in a proxied deployment — none of these
 *  are credentials, but dropping them silently breaks agents behind a corporate/CI proxy. */
const PROXY_VAR_NAMES = new Set(["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy"]);

/** The proxy vars' siblings: non-secret RUNTIME config every major harness SDK honors, needed by the
 *  same proxied/CA/ADC deployments the proxy vars exist for. None of these carry credential material —
 *  they're a base URL, a CA bundle path, or a Node runtime flag — but dropping them silently breaks a
 *  harness that can't reach its provider at all (wrong/no base URL) or can't verify TLS (missing CA)
 *  in exactly the enterprise deployments concern 01 was built to not regress.
 *   - `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` / `OPENAI_API_BASE` (legacy OpenAI SDK spelling) /
 *     `GEMINI_BASE_URL` / `GOOGLE_GENAI_BASE_URL`: SDK-read endpoint overrides for a proxied or
 *     self-hosted-gateway deployment — swapping the URL, not a secret.
 *   - `NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` / `SSL_CERT_DIR`: a CA bundle PATH so TLS verification
 *     succeeds against a corporate MITM proxy or internal CA — the path, never the private key.
 *   - `NODE_OPTIONS`: process-level Node/Bun flags (`--max-old-space-size`, `--dns-result-order`, …) an
 *     operator sets fleet-wide; dropping it is a functional regression (validate.ts's `typecheckWorker`
 *     spuriously OOMs on a large repo without it), not a security boundary.
 *  `GOOGLE_APPLICATION_CREDENTIALS` rides here too — it's a file PATH (ADC convention), re-admitted
 *  from the shape-deny via `SHAPE_EXCEPTIONS` above; keep-listing it here is what actually lets it
 *  through once the shape veto no longer blocks it. */
const RUNTIME_CONFIG_VAR_NAMES = new Set([
	"ANTHROPIC_BASE_URL",
	"OPENAI_BASE_URL",
	"OPENAI_API_BASE",
	"GEMINI_BASE_URL",
	"GOOGLE_GENAI_BASE_URL",
	"NODE_EXTRA_CA_CERTS",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_OPTIONS",
	"GOOGLE_APPLICATION_CREDENTIALS",
]);

function isKeepListed(key: string): boolean {
	if (key === "PATH" || key === "HOME" || key === "SHELL" || key === "TERM" || key === "TZ" || key === "LANG") return true;
	if (key.startsWith("LC_") || key.startsWith("XDG_")) return true;
	return PROXY_VAR_NAMES.has(key) || RUNTIME_CONFIG_VAR_NAMES.has(key);
}

/** Vendor lineage (model-lineage.ts) → the credential var(s) that vendor's SDK convention reads.
 *  Google gets BOTH names because different Gemini-speaking libraries read different var names —
 *  narrowing to only one would silently break whichever library reads the other. `unknown` is not a
 *  key here on purpose: `harnessAuthEnv` never looks this map up with lineage `"unknown"` — it falls
 *  back to `DEFAULT_PROVIDER` (a real, known key) before it ever would. */
const LINEAGE_AUTH_VARS: Record<"anthropic" | "openai" | "google" | "xai", string[]> = {
	anthropic: ["ANTHROPIC_API_KEY"],
	openai: ["OPENAI_API_KEY"],
	google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
	xai: ["XAI_API_KEY"],
};

/** Harness names whose vendor `resolveProvider`/`modelLineage` cannot express — Augment routes model
 *  calls through its own key regardless of which model family a unit pins, so it is not a
 *  `ModelLineage` at all. Checked before lineage resolution, and independent of `model`: an
 *  auggie ACP spawn needs `AUGMENT_API_KEY` no matter what model string (if any) rode along. */
const HARNESS_ONLY_AUTH_VARS: Record<string, string[]> = {
	auggie: ["AUGMENT_API_KEY"],
};

/** Every provider credential the fleet knows about — the union across every vendor lineage plus the
 *  harness-only (Augment) and router (OpenRouter) credentials. This is the FULL grant, and it exists for
 *  exactly ONE caller: `allProviderAuthEnv`, for the genuinely-unknowable-vendor spawn class. Kept as an
 *  explicit list (not derived from the maps above) so OPENROUTER_API_KEY — which is not a `ModelLineage`
 *  and lives in neither map — is included on purpose, and so a newly added provider is a deliberate,
 *  review-visible one-line edit here rather than a silent omission. */
const ALL_PROVIDER_AUTH_VARS: string[] = [
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"GOOGLE_API_KEY",
	"GEMINI_API_KEY",
	"XAI_API_KEY",
	"OPENROUTER_API_KEY",
	"AUGMENT_API_KEY",
];

function admit(source: NodeJS.ProcessEnv, names: string[]): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of names) {
		const v = source[name];
		if (typeof v === "string") env[name] = v;
	}
	return env;
}

/**
 * The subset of `source` naming THIS spawn's harness's own provider credential — spread this into
 * `scrubbedSpawnEnv`'s `inject` argument at a spawn site. Concern 01: "the harness key for *this*
 * spawn, injected deliberately... keep it narrow" — every OTHER provider credential the operator has
 * configured (a multi-provider fleet sets all of them) must NOT reach a spawn that doesn't need it.
 *
 * `harness` (a registered harness NAME, e.g. "omp"/"codex"/"gemini"/"grok"/"auggie") and `model` (the
 * unit's pinned model spec, when known) narrow the result to the single vendor this spawn actually
 * needs, via the SAME `resolveProvider` combinator rate-limit gating already trusts (model wins when
 * classifiable; the harness's static vendor pin is the fallback).
 *
 * Round-2 cross-lineage audit (both codex and grok, independently): the ORIGINAL fallback for "we
 * genuinely can't classify this spawn's vendor" admitted EVERY configured provider credential —
 * ANTHROPIC_API_KEY through AUGMENT_API_KEY, all seven, into a spawn that at most needed one of them.
 * That is not "honest ignorance", it's the widest possible grant dressed up as one: a multi-provider
 * operator's opencode-with-no-pinned-model spawn walked away with every vendor's key regardless of
 * which (if any) it would ever call. FIX: unknown lineage now fails closed to `DEFAULT_PROVIDER` alone
 * (model-lineage.ts's documented "an unclassifiable unit's provider" answer, already trusted for
 * rate-limit gating) — ONE credential, not seven, for every harness/model combination this function
 * cannot classify. Such a spawn is classifiable IN PRINCIPLE (pin a model, or name a vendor-pinned
 * harness `model-lineage.ts`'s `HARNESS_LINEAGE` knows), so withholding six credentials it never asked
 * for is the correct failure mode: no verified harness in the registry relies on the old seven-key
 * grant (spawn-env.test.ts proves it for every registered vendor-pinned harness plus the omp/pi default).
 *
 * The ONE spawn class where this narrowing does NOT apply is a Flue worker: its model/vendor is chosen
 * by the tenant's own `.flue/agents` config AT RUNTIME, so there is no harness or model the daemon could
 * pass to classify it in advance — narrowing it to `DEFAULT_PROVIDER` would silently break every
 * non-Anthropic Flue workflow. That call site uses `allProviderAuthEnv` (below), the deliberate,
 * named full-grant exception, NOT `harnessAuthEnv`.
 */
export function harnessAuthEnv(source: NodeJS.ProcessEnv = process.env, harness?: string, model?: string): Record<string, string> {
	const h = harness?.toLowerCase();
	if (h && HARNESS_ONLY_AUTH_VARS[h]) return admit(source, HARNESS_ONLY_AUTH_VARS[h]);
	const lineage = resolveProvider(model, harness);
	if (lineage !== "unknown") return admit(source, LINEAGE_AUTH_VARS[lineage]);
	// DEFAULT_PROVIDER is a fixed model-lineage.ts constant ("anthropic" today), typed as the broader
	// ModelLineage union — the `!== "unknown"` guard is redundant at runtime (it can never actually be
	// "unknown") but narrows the type for LINEAGE_AUTH_VARS' index, same pattern as the `lineage` check
	// just above. The `[]` arm is unreachable in practice, never a silent broad grant if it somehow were.
	if (DEFAULT_PROVIDER !== "unknown") return admit(source, LINEAGE_AUTH_VARS[DEFAULT_PROVIDER]);
	return admit(source, []);
}

/**
 * The full provider-credential grant, for the ONE spawn class whose vendor is genuinely unknowable to the
 * daemon in advance: a Flue worker (`flue-service-driver.ts`), which picks its model/vendor from the
 * tenant's own `.flue/agents` config at runtime. There is no harness or model to hand `harnessAuthEnv`,
 * so narrowing would fail closed on every non-Anthropic Flue workflow. This admits every provider key the
 * operator has configured — the same breadth Flue spawns had before this narrowing, and still strictly
 * tighter than Flue's pre-scrub full-env inheritance (no DATABASE_URL / auth secret / master key). The
 * residual — a Flue worker repo can read every provider credential — is the same same-uid tenant-agent
 * exposure the sandbox workstream owns; it is NOT reopened by narrowing everything else. Every non-Flue
 * spawn stays narrowed via `harnessAuthEnv`; this exception is used at exactly one call site.
 */
export function allProviderAuthEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
	return admit(source, ALL_PROVIDER_AUTH_VARS);
}

/**
 * The environment a spawned TENANT AGENT process may see. `base` is deny-by-shape scrubbed and then
 * narrowed to the explicit keep-list; `inject` (default `{}`) is layered on top LAST and unconditionally
 * — it is the deliberate, caller-named allowance for whatever this particular spawn needs that the
 * keep-list doesn't cover (the harness's own credential via `harnessAuthEnv()`, behavior-control vars
 * like `PI_RPC_EMIT_TITLE`/`gitNoSignEnv()` the callers already set today). `inject` is trusted: a
 * spawn site names exactly what it's re-admitting instead of this module guessing.
 *
 * Do not silently drop a var an agent needs — a scrub that breaks spawns gets reverted, and then
 * nothing is scrubbed. Every call site's test proves both halves hold: secrets absent, spawns alive.
 */
export function scrubbedSpawnEnv(base: NodeJS.ProcessEnv, inject: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(base)) {
		if (typeof value !== "string") continue;
		if (isDaemonSecretEnvKey(key)) continue;
		if (!isKeepListed(key)) continue;
		env[key] = value;
	}
	return { ...env, ...inject };
}

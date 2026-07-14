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

import { resolveProvider } from "./model-lineage.ts";

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
 *  below can't catch them. */
const SECRET_EXACT = new Set(["DATABASE_URL"]);

/** Vars denied by name SHAPE — catches secrets under names this module has never seen; a var newly
 *  added anywhere in the daemon's env is safe by default as long as it's named like a credential. */
const SECRET_NAME_SHAPE = /(_KEY|_SECRET|_TOKEN|_PASSWORD|_CREDENTIALS?)$/i;

/** True if `key` names a daemon secret that must never reach a spawned tenant agent process.
 *  Not exported: `scrubbedSpawnEnv` (below, same file) is the only production caller — test
 *  through it instead of this predicate directly (dead-exports-ratchet precedent). */
function isDaemonSecretEnvKey(key: string): boolean {
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
function isKeepListed(key: string): boolean {
	if (key === "PATH" || key === "HOME" || key === "SHELL" || key === "TERM" || key === "TZ" || key === "LANG") return true;
	if (key.startsWith("LC_") || key.startsWith("XDG_")) return true;
	return PROXY_VAR_NAMES.has(key);
}

/** LLM-provider credential var names a harness reads directly, by its own SDK's convention — never
 *  minted or namespaced by glance. This is the ONE deliberate widening of the deny-by-shape scrub: an
 *  agent harness (omp, pi, or an ACP runtime) needs its own provider key to make a model call at all,
 *  so these survive by NAME, not by falling through the shape filter that strips everything else
 *  ending in `_KEY`. Narrow and explicit — extend this list (don't loosen SECRET_NAME_SHAPE) when a
 *  new harness needs a credential this doesn't yet cover. This is also the FALLBACK `harnessAuthEnv`
 *  admits when it cannot narrow to a single vendor (harness/model unknown or genuinely multi-vendor,
 *  e.g. a flue worker's own `.flue/agents` config) — every named var, not none, because withholding a
 *  credential a real spawn needs is the failure mode concern 01 warns will get the whole scrub
 *  reverted ("do not silently drop a var an agent needs").
 */
const HARNESS_AUTH_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY", "AUGMENT_API_KEY"];

/** Vendor lineage (model-lineage.ts) → the credential var(s) that vendor's SDK convention reads.
 *  Google gets BOTH names because different Gemini-speaking libraries read different var names —
 *  narrowing to only one would silently break whichever library reads the other. `unknown` is not a
 *  key here on purpose: callers fall back to `HARNESS_AUTH_VARS` (the full list) instead, since a
 *  vendor we can't identify might need any of them. */
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

/** Harnesses that are multi-model by design (`harnessLineage` honestly returns "unknown" for them —
 *  see model-lineage.ts) but whose OWN default model, absent an explicit per-unit pin, is Anthropic's
 *  (`DEFAULT_PROVIDER`) — the same assumption `resolveProvider`'s callers already make for rate-limit
 *  gating. Narrowing an omp/pi spawn with no model info to "every credential" would defeat the whole
 *  point on the two most common harnesses in the fleet; narrowing it to Anthropic matches what the
 *  spawn will actually use unless a unit explicitly pins a cross-vendor model (in which case `model`
 *  is passed and `resolveProvider` resolves the REAL vendor before this fallback is ever consulted). */
const DEFAULT_ANTHROPIC_HARNESSES = new Set(["omp", "pi"]);

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
 * classifiable; the harness's static vendor pin is the fallback). Omitting `harness` — or a harness/
 * model combination `resolveProvider` can't classify and isn't one of the omp/pi default-vendor cases
 * above — falls back to the full `HARNESS_AUTH_VARS` list: the honest "we don't know" case, and
 * strictly what every call site did before this narrowing existed.
 */
export function harnessAuthEnv(source: NodeJS.ProcessEnv = process.env, harness?: string, model?: string): Record<string, string> {
	const h = harness?.toLowerCase();
	if (h && HARNESS_ONLY_AUTH_VARS[h]) return admit(source, HARNESS_ONLY_AUTH_VARS[h]);
	const lineage = resolveProvider(model, harness);
	if (lineage !== "unknown") return admit(source, LINEAGE_AUTH_VARS[lineage]);
	if (h && DEFAULT_ANTHROPIC_HARNESSES.has(h)) return admit(source, LINEAGE_AUTH_VARS.anthropic);
	return admit(source, HARNESS_AUTH_VARS);
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

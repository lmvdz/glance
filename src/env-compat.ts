/**
 * Backward-compatible env aliasing for the omp-squad → glance rename.
 *
 * The canonical env prefix is now `GLANCE_`. The legacy `OMP_SQUAD_` prefix stays fully honored so existing
 * `.env` files, deployments, and the running daemon keep working with no changes. At boot we mirror the two
 * prefixes so a value set under EITHER name is readable under BOTH — the rest of the codebase can keep
 * reading `process.env.OMP_SQUAD_*` unchanged while operators adopt `GLANCE_*` at their own pace.
 *
 * Precedence: `GLANCE_*` wins when both are set. Import this module FOR ITS SIDE EFFECT, first, before any
 * code reads process.env.
 */

const LEGACY = "OMP_SQUAD_";
const CANON = "GLANCE_";

// Pass 1: GLANCE_ → OMP_SQUAD_ (force; GLANCE_ wins on conflict).
for (const [key, val] of Object.entries(process.env)) {
	if (val === undefined || !key.startsWith(CANON)) continue;
	process.env[LEGACY + key.slice(CANON.length)] = val;
}
// Pass 2: OMP_SQUAD_ → GLANCE_ (only where GLANCE_ isn't already set).
for (const [key, val] of Object.entries(process.env)) {
	if (val === undefined || !key.startsWith(LEGACY)) continue;
	const canonKey = CANON + key.slice(LEGACY.length);
	if (process.env[canonKey] === undefined) process.env[canonKey] = val;
}

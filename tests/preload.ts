/**
 * Test preload — neutralize inherited environment so the suite is hermetic.
 *
 * The squad daemon (and any worktree it spawns) exports real Plane credentials
 * (PLANE_*) and self-audit flags (OMP_SQUAD_OBSERVE_AUTODISPATCH/AUTOFIX). Without
 * this, tests inherit them and break two ways:
 *   - real PLANE_* makes plane.ts fetch the live api.plane.so; throttledFetch's
 *     global queue then stalls on the hung connection, timing out every later
 *     Plane test (plane-throttle, plane, governor);
 *   - OBSERVE_AUTODISPATCH=1 flips the observer's default triage marker, so a
 *     "default = needs-triage" assertion sees an auto-dispatch title instead.
 * Tests that need these set them explicitly, so clearing the baseline is safe.
 */

for (const k of Object.keys(process.env)) {
	if (k.startsWith("PLANE_")) delete process.env[k];
}
delete process.env.OMP_SQUAD_OBSERVE_AUTODISPATCH;
delete process.env.OMP_SQUAD_OBSERVE_AUTOFIX;

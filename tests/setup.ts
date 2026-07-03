/**
 * Test preload — hermetic env boundary (wired via bunfig.toml `[test] preload`).
 *
 * The squad fleet operator's shell exports real PLANE_* credentials and a pile of OMP_SQUAD_*
 * runtime flags (autodispatch, autoland, observe tuning, …). Those leak into `bun test`:
 *  - a daemon started by a test sees real PLANE_* ⇒ planeConfigured() is true ⇒ it polls the LIVE
 *    Plane API in the background; those slow real-network calls flood the global throttledFetch
 *    chain and fire against later tests' fetch mocks (timeouts + corrupted call counts);
 *  - OMP_SQUAD_OBSERVE_* flags flip observer defaults that tests snapshot at module load.
 * Tests that need these set their own per-test, so clearing them here just defines the baseline.
 *
 * Runs once, before any test module is imported (so module-level env snapshots capture the
 * cleared state). ponytail: a name-prefix sweep — the only two prefixes this repo reads.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const k of Object.keys(process.env)) {
	if (k.startsWith("PLANE_") || k.startsWith("OMP_SQUAD_")) delete process.env[k];
}

// Point the fleet state dir at a throwaway. presence/leases (ttl-registry) and any daemon a test spins up
// now live here instead of the operator's real ~/.omp/squad — the source of the flaky "empty data"
// failures where stale/live presence + lease files leaked into read-API assertions.
process.env.OMP_SQUAD_STATE_DIR = mkdtempSync(join(tmpdir(), "glance-test-state-"));

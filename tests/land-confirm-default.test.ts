/**
 * glance#329 — before this fix, `LAND_CONFIRM`'s two callers hand-rolled their own default
 * independently and disagreed: `squad-manager.ts`'s `landConfirm` field read
 * `process.env.OMP_SQUAD_LAND_CONFIRM !== "0"` (default ON — a GREEN verify is HELD for a one-tap
 * Land), while `server.ts`'s observability payload (the thing `glance doctor` reads) read
 * `envBool("OMP_SQUAD_LAND_CONFIRM", false)` (default OFF — reported as auto-merging). A stock daemon
 * that never touched the flag was actually the SAFER of the two postures while `doctor` swore it was
 * the more dangerous one.
 *
 * The fix: one shared resolver, `config.ts`'s `landConfirmEnabled()`, that both sites called instead of
 * re-deriving the default.
 *
 * Gauntlet round 1 (codex, adjudicated REAL-but-latent): that first fix left a LIFETIME mismatch —
 * `squad-manager.ts`'s `landConfirm` field resolves `landConfirmEnabled()` ONCE, at construction, and
 * caches it, while `server.ts`'s `autonomyFacts()` called the resolver fresh on every `/api/doctor`
 * request. Nothing in production mutates `OMP_SQUAD_LAND_CONFIRM` after boot today (runtime-settings
 * never touches this flag), so the two values happen to always agree in practice — but the class is
 * open, and a doctor built to answer "what will THIS daemon actually do" must not silently start
 * lying the moment that assumption stops holding. The fix: `SquadManager.effectiveLandConfirm` exposes
 * the manager's own cached value, and `autonomyFacts()` now sources from a LIVE manager instance
 * instead of re-calling the resolver.
 *
 * This file pins:
 *
 *   1. `landConfirmEnabled()` itself: unset ⇒ true (ON), "0" ⇒ false, "1" ⇒ true.
 *   2. A REAL `SquadManager`'s `effectiveLandConfirm` getter matches `landConfirmEnabled()` at
 *      construction — proof the manager didn't quietly grow its own copy of the default.
 *   3. A REAL `SquadServer`'s `/api/doctor` response (`autonomy.landConfirm`, the exact field
 *      `glance doctor` renders) matches the manager's `effectiveLandConfirm` too — end-to-end through
 *      the actual HTTP payload, both with the flag unset (default) and explicitly forced off ("0").
 *   4. THE LIFETIME CASE (codex's exact failing sequence): construct a manager with the flag one way,
 *      then mutate `process.env` to the OPPOSITE. `landConfirmEnabled()` (the resolver) sees the
 *      mutation immediately — that's correct, it's a fresh-read helper. But `/api/doctor` must keep
 *      reporting the manager's ORIGINAL cached value, because that's what `land()` will actually do on
 *      this instance's next GREEN verify — not what a brand-new manager constructed right now would do.
 */

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { landConfirmEnabled } from "../src/config.ts";
import { SquadManager } from "../src/squad-manager.ts";
import { SquadServer } from "../src/server.ts";

const saved = process.env.OMP_SQUAD_LAND_CONFIRM;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
	// Belt-and-suspenders on top of each test's own `finally` restore (LANE_POLICY test-pollution
	// lesson: a shared env var mutated mid-test and left dirty poisons every test file that runs after
	// this one in the SAME process, and only shows up as a flake in the full suite, never in isolation).
	if (saved === undefined) delete process.env.OMP_SQUAD_LAND_CONFIRM;
	else process.env.OMP_SQUAD_LAND_CONFIRM = saved;
});

// ── (1) the shared resolver's own truth table ────────────────────────────────

test("landConfirmEnabled: unset defaults ON (a GREEN verify is held for one-tap Land), '0' turns it off, '1' is explicit on", () => {
	delete process.env.OMP_SQUAD_LAND_CONFIRM;
	expect(landConfirmEnabled()).toBe(true);
	process.env.OMP_SQUAD_LAND_CONFIRM = "0";
	expect(landConfirmEnabled()).toBe(false);
	process.env.OMP_SQUAD_LAND_CONFIRM = "1";
	expect(landConfirmEnabled()).toBe(true);
});

// ── (2)+(3)+(4) the pin: manager's real (cached) value and the doctor payload never diverge ──

async function makeManagerAndServer(): Promise<{ mgr: SquadManager; url: string; token: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "land-confirm-default-"));
	const token = "land-confirm-pin-token";
	const mgr = new SquadManager({ stateDir: dir, skipGlobalJanitors: true });
	await mgr.start();
	const server = new SquadServer(mgr, { port: 0, token });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});
	return { mgr, url, token };
}

async function doctorLandConfirm(url: string, token: string): Promise<boolean> {
	const res = await fetch(`${url}/api/doctor`, { headers: { authorization: `Bearer ${token}` } });
	expect(res.status).toBe(200);
	const body = (await res.json()) as { autonomy: { landConfirm: boolean } };
	return body.autonomy.landConfirm;
}

test("default (flag unset): manager's effectiveLandConfirm === landConfirmEnabled() === doctor's reported landConfirm", async () => {
	delete process.env.OMP_SQUAD_LAND_CONFIRM;
	const expected = landConfirmEnabled();
	expect(expected).toBe(true); // pins the documented default itself, not just internal agreement

	const { mgr, url, token } = await makeManagerAndServer();
	expect(mgr.effectiveLandConfirm).toBe(expected);

	const reported = await doctorLandConfirm(url, token);
	expect(reported).toBe(expected);
});

test("flag forced off ('0'): manager and doctor move TOGETHER, not just coincidentally equal at the default", async () => {
	process.env.OMP_SQUAD_LAND_CONFIRM = "0";
	const expected = landConfirmEnabled();
	expect(expected).toBe(false);

	const { mgr, url, token } = await makeManagerAndServer();
	expect(mgr.effectiveLandConfirm).toBe(expected);

	const reported = await doctorLandConfirm(url, token);
	expect(reported).toBe(expected);
});

test("lifetime (gauntlet round 1, codex): doctor reports the manager's CACHED value, not a fresh env re-read, when the env mutates after construction", async () => {
	process.env.OMP_SQUAD_LAND_CONFIRM = "0"; // construct with landConfirm OFF
	const { mgr, url, token } = await makeManagerAndServer();
	const managerActual = mgr.effectiveLandConfirm;
	expect(managerActual).toBe(false);

	try {
		// Mutate to the OPPOSITE after construction. Nothing in production does this today, but the class
		// is open — this is exactly the divergence window the gauntlet found.
		process.env.OMP_SQUAD_LAND_CONFIRM = "1";
		// The resolver itself DOES see the mutation immediately — that's correct, it's a fresh-read
		// helper, and is exactly why `autonomyFacts()` must NOT call it for this field anymore.
		expect(landConfirmEnabled()).toBe(true);

		// /api/doctor must still report what THIS manager will actually do, not what a brand-new manager
		// constructed right now would do.
		const reported = await doctorLandConfirm(url, token);
		expect(reported).toBe(managerActual);
		expect(reported).toBe(false);
		expect(mgr.effectiveLandConfirm).toBe(false); // the manager's own cached field never moved either
	} finally {
		process.env.OMP_SQUAD_LAND_CONFIRM = "0"; // restore before any other code in this test file runs
	}
});

/**
 * glance#329 — before this fix, `LAND_CONFIRM`'s two callers hand-rolled their own default
 * independently and disagreed: `squad-manager.ts`'s `landConfirm` field read
 * `process.env.OMP_SQUAD_LAND_CONFIRM !== "0"` (default ON — a GREEN verify is HELD for a one-tap
 * Land), while `server.ts`'s observability payload (the thing `glance doctor` reads) read
 * `envBool("OMP_SQUAD_LAND_CONFIRM", false)` (default OFF — reported as auto-merging). A stock daemon
 * that never touched the flag was actually the SAFER of the two postures while `doctor` swore it was
 * the more dangerous one.
 *
 * The fix: one shared resolver, `config.ts`'s `landConfirmEnabled()`, that both sites now call instead
 * of re-deriving the default. This file pins three things so they can never re-diverge:
 *
 *   1. `landConfirmEnabled()` itself: unset ⇒ true (ON), "0" ⇒ false, "1" ⇒ true.
 *   2. A REAL `SquadManager`'s private `landConfirm` field matches `landConfirmEnabled()` — proof the
 *      manager didn't quietly grow its own copy of the default.
 *   3. A REAL `SquadServer`'s `/api/doctor` response (`autonomy.landConfirm`, the exact field
 *      `glance doctor` renders) matches `landConfirmEnabled()` too — end-to-end through the actual
 *      HTTP payload, both with the flag unset (default) and explicitly forced off ("0"), so the two
 *      sites are proven to move TOGETHER, not just coincidentally equal at one value.
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

// ── (2)+(3) the pin: manager's real field and the doctor payload never diverge ──

interface ManagerInternals {
	landConfirm: boolean;
}

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

test("default (flag unset): manager's real landConfirm field === landConfirmEnabled() === doctor's reported landConfirm", async () => {
	delete process.env.OMP_SQUAD_LAND_CONFIRM;
	const expected = landConfirmEnabled();
	expect(expected).toBe(true); // pins the documented default itself, not just internal agreement

	const { mgr, url, token } = await makeManagerAndServer();
	const managerActual = (mgr as unknown as ManagerInternals).landConfirm;
	expect(managerActual).toBe(expected);

	const reported = await doctorLandConfirm(url, token);
	expect(reported).toBe(expected);
});

test("flag forced off ('0'): manager and doctor move TOGETHER, not just coincidentally equal at the default", async () => {
	process.env.OMP_SQUAD_LAND_CONFIRM = "0";
	const expected = landConfirmEnabled();
	expect(expected).toBe(false);

	const { mgr, url, token } = await makeManagerAndServer();
	const managerActual = (mgr as unknown as ManagerInternals).landConfirm;
	expect(managerActual).toBe(expected);

	const reported = await doctorLandConfirm(url, token);
	expect(reported).toBe(expected);
});

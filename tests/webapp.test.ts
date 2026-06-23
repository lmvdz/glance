/**
 * Webapp build + serve gate — the Vite SPA (`webapp/`, CC-rewrite) is outside the root `tsc`
 * scope, so a broken component or config otherwise ships unnoticed. This drives the real
 * toolchain: typecheck, then a production build, asserting Vite emits a content-hashed bundle
 * the index references. Also pins the serve seam DEFAULT-OFF invariant.
 *
 * KEEP alongside web.test.ts until the dashboard cutover.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SquadServer, webappEnabled } from "../src/server.ts";
import { SquadManager } from "../src/squad-manager.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

const WEBAPP = path.join(import.meta.dir, "..", "webapp");

async function run(args: string[]): Promise<number> {
	// Bounded by each test's bun:test timeout arg — no manual wall-clock timer (project rule).
	const proc = Bun.spawn(["bun", ...args], { cwd: WEBAPP, stdout: "pipe", stderr: "pipe" });
	const code = await proc.exited;
	if (code !== 0) {
		// Surface the toolchain failure in the test output.
		console.error(await new Response(proc.stderr).text());
		console.error(await new Response(proc.stdout).text());
	}
	return code;
}

// Idempotent prereq: cold checkouts have no webapp/node_modules.
// ponytail: one-time install; ceiling = slow first run, upgrade path = CI caches webapp/node_modules.
test("webapp deps installed", async () => {
	if (!existsSync(path.join(WEBAPP, "node_modules"))) {
		expect(await run(["install"])).toBe(0);
	}
}, 320_000);

test("webapp typechecks", async () => {
	expect(await run(["run", "typecheck"])).toBe(0);
}, 130_000);

test("webapp builds a content-hashed bundle", async () => {
	expect(await run(["run", "build"])).toBe(0);
	const index = path.join(WEBAPP, "dist", "index.html");
	expect(existsSync(index)).toBe(true);
	const html = await fs.readFile(index, "utf8");
	// Vite content-hashes its emitted JS: /assets/index-<hash>.js
	expect(html).toMatch(/\/assets\/[^"']+-[A-Za-z0-9_-]+\.js/);
}, 200_000);

test("serve seam is OFF by default (flag unset)", () => {
	const prev = process.env.OMP_SQUAD_WEBAPP;
	delete process.env.OMP_SQUAD_WEBAPP;
	try {
		expect(webappEnabled()).toBe(false);
	} finally {
		if (prev !== undefined) process.env.OMP_SQUAD_WEBAPP = prev;
	}
});

// Boots a real bound server with the flag ON (dist exists from the build test above) and proves the
// seam serves the Vite shell + hashed assets, then 404s an unknown asset. The shell is public (no
// token), mirroring auth.test.ts's "serves the shell publicly" path.
test("flag ON serves the Vite shell + hashed assets, OFF serves the live dashboard", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "webappsrv-"));
	const mgr = new SquadManager({ stateDir: dir });
	await mgr.start();
	const prev = process.env.OMP_SQUAD_WEBAPP;
	process.env.OMP_SQUAD_WEBAPP = "1";
	const server = new SquadServer(mgr, { port: 0 });
	const url = server.start();
	cleanups.push(async () => {
		server.stop();
		await mgr.stop();
		await fs.rm(dir, { recursive: true, force: true });
		if (prev === undefined) delete process.env.OMP_SQUAD_WEBAPP;
		else process.env.OMP_SQUAD_WEBAPP = prev;
	});

	// Shell = Vite dist index (has #root + a hashed asset ref, NOT the live inline-script dashboard).
	const shell = await fetch(`${url}/`);
	expect(shell.status).toBe(200);
	const html = await shell.text();
	expect(html).toContain('id="root"');
	const m = html.match(/\/assets\/[^"']+-[A-Za-z0-9_-]+\.js/);
	expect(m).not.toBeNull();

	// The referenced hashed asset serves tokenless with a JS content-type.
	const js = await fetch(`${url}${m![0]}`);
	expect(js.status).toBe(200);
	expect(js.headers.get("content-type")).toContain("javascript");

	// Unknown asset under the dist seam → 404 (containment branch).
	expect((await fetch(`${url}/assets/does-not-exist.js`)).status).toBe(404);
}, 30_000);

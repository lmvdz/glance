/**
 * install-hooks — the shim text is the contract (omp discovers it verbatim) and
 * install/uninstall must round-trip. No network, no real ~/.omp writes: the
 * round-trip targets an explicit mkdtemp dir.
 */

import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { install, shimContent, uninstall } from "../src/install-hooks.ts";

let tmp: string | undefined;

test("shimContent embeds both hook paths and a combined default export", () => {
	const out = shimContent("/abs/repo/src");
	assert.ok(out.includes("export default"), "missing default export");
	assert.ok(out.includes("/abs/repo/src/presence-hook.ts"), "missing presence-hook path");
	assert.ok(out.includes("/abs/repo/src/lease-hook.ts"), "missing lease-hook path");
});

test("install/uninstall round-trip against a tmp dir", async () => {
	tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-squad-coord-"));
	const repoSrc = "/abs/repo/src";

	const file = await install(repoSrc, tmp);
	assert.equal(file, path.join(tmp, "omp-squad-coord", "index.ts"));
	assert.ok(existsSync(file), "index.ts not written");
	assert.equal(await fsp.readFile(file, "utf8"), shimContent(repoSrc));

	assert.equal(await uninstall(tmp), true);
	assert.equal(existsSync(path.join(tmp, "omp-squad-coord")), false, "extension dir not removed");
});

afterAll(async () => {
	if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
});

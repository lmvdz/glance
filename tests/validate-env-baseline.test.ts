/**
 * validate.ts's ENV_BASELINE — the fixed, non-secret operational var list `typecheckWorker`'s tsc
 * spawn and `acceptanceEnv`'s flue-run spawn both build on.
 *
 * Code-review round-2 (CONFIRMED): `typecheckWorker` went to `baselineEnv()` (8 vars: PATH/HOME/
 * TMPDIR/TMP/TEMP/LANG/LC_ALL/TZ), dropping `NODE_OPTIONS` — a big worker repo whose own toolchain
 * config sets `NODE_OPTIONS=--max-old-space-size=…` had that memory ceiling silently discarded for the
 * `tsc --noEmit` spawn, which then OOMs and the typecheck gate fails spuriously against code that
 * would pass with the operator's own memory ceiling honored. `NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE` ride
 * along in the same fix since `acceptanceEnv()` shares `ENV_BASELINE` and its `flue run` spawn makes
 * real network calls (a model call, or the worker's own HTTP dependencies) that need a CA bundle path
 * to verify TLS behind a corporate proxy or custom CA. None of the three are secrets: a runtime flag
 * and two file paths, not credential material — `acceptanceEnv`'s own deny-by-default scrub (proven in
 * squad.test.ts) still keeps every actual secret out.
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acceptanceEnv, validateWorker } from "../src/validate.ts";
import type { CommissionSpec } from "../src/types.ts";

const tmps: string[] = [];
afterAll(async () => {
	for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

test("acceptanceEnv passes through NODE_OPTIONS, NODE_EXTRA_CA_CERTS, and SSL_CERT_FILE (non-secret, ENV_BASELINE) while still denying real secrets", () => {
	const src = {
		PATH: "/usr/bin",
		NODE_OPTIONS: "--max-old-space-size=8192",
		NODE_EXTRA_CA_CERTS: "/etc/ssl/corp-ca.pem",
		SSL_CERT_FILE: "/etc/ssl/cert.pem",
		DATABASE_URL: "postgres://daemon-secret",
		ANTHROPIC_API_KEY: "sk-leak",
	};
	const env = acceptanceEnv({ name: "w", purpose: "p", model: false }, src);
	expect(env.NODE_OPTIONS).toBe("--max-old-space-size=8192");
	expect(env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/corp-ca.pem");
	expect(env.SSL_CERT_FILE).toBe("/etc/ssl/cert.pem");
	expect("DATABASE_URL" in env).toBe(false);
	expect("ANTHROPIC_API_KEY" in env).toBe(false);
});

test("validateWorker's typecheck gate carries NODE_OPTIONS through to the real tsc spawn — a real-spawn mutation proof, not just an ENV_BASELINE array assertion", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sqt-validate-typecheck-env-"));
	tmps.push(dir);
	await fs.mkdir(path.join(dir, "node_modules", ".bin"), { recursive: true });
	const tscBin = path.join(dir, "node_modules", ".bin", "tsc");
	const dumpPath = path.join(dir, "env.json");
	// typecheckWorker only checks existsSync(tscBin) then spawns it — the fake binary never has to
	// behave like tsc, only dump its own env and exit cleanly.
	await fs.writeFile(tscBin, `#!/usr/bin/env bun\nrequire("fs").writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify(process.env));\nprocess.exit(0);\n`);
	await fs.chmod(tscBin, 0o755);

	const prevOptions = process.env.NODE_OPTIONS;
	const prevCa = process.env.NODE_EXTRA_CA_CERTS;
	process.env.NODE_OPTIONS = "--max-old-space-size=8192";
	process.env.NODE_EXTRA_CA_CERTS = "/etc/ssl/corp-ca.pem";
	try {
		const spec: CommissionSpec = { name: "w", purpose: "typecheck-env proof" };
		await validateWorker(dir, spec);
		const dumped = JSON.parse(await fs.readFile(dumpPath, "utf8")) as Record<string, string>;
		expect(dumped.NODE_OPTIONS).toBe("--max-old-space-size=8192");
		expect(dumped.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/corp-ca.pem");
		expect(dumped.PATH).toBeDefined(); // sanity: tsc still got a usable env, not an empty one
	} finally {
		if (prevOptions === undefined) delete process.env.NODE_OPTIONS;
		else process.env.NODE_OPTIONS = prevOptions;
		if (prevCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
		else process.env.NODE_EXTRA_CA_CERTS = prevCa;
	}
});

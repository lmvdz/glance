/**
 * The daemon loads Plane creds from ~/.claude/secrets/plane.env, so the parser must
 * handle the file's real shape (export/quoted/plain lines, comments) and — critically —
 * never override an explicit env var the operator set on the daemon.
 */
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadEnvFile } from "../src/plane-secrets.ts";

const KEYS = ["PS_API", "PS_WS", "PS_PLAIN", "PS_INLINE", "PS_EXISTING"];
afterEach(() => {
	for (const k of KEYS) delete process.env[k];
});

function tmpEnv(body: string): string {
	const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ps-")), "plane.env");
	fs.writeFileSync(f, body);
	return f;
}

test("parses export/quoted/plain lines, skips comments, sets process.env", () => {
	const f = tmpEnv(["# a comment", 'export PS_API="tok123"', "export PS_WS='slug'", "PS_PLAIN=bare", "PS_INLINE=val # trailing", ""].join("\n"));
	const set = loadEnvFile(f);
	expect(set.sort()).toEqual(["PS_API", "PS_INLINE", "PS_PLAIN", "PS_WS"]);
	expect(process.env.PS_API).toBe("tok123");
	expect(process.env.PS_WS).toBe("slug");
	expect(process.env.PS_PLAIN).toBe("bare");
	expect(process.env.PS_INLINE).toBe("val"); // inline comment stripped on an unquoted value
});

test("never overrides an existing env var (explicit daemon env wins)", () => {
	process.env.PS_EXISTING = "keep";
	const set = loadEnvFile(tmpEnv('export PS_EXISTING="overwrite"'));
	expect(set).toEqual([]);
	expect(process.env.PS_EXISTING).toBe("keep");
});

test("missing file is a no-op", () => {
	expect(loadEnvFile("/no/such/plane.env")).toEqual([]);
});

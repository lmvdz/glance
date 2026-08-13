import { afterEach, expect, test } from "bun:test";
import { cmdAutomation, cmdKill, cmdPromote } from "../src/cli/client.ts";

/**
 * Concern 22's one behavior change — the api() unification — regression-pinned (codex M: ~18
 * request paths changed error shape with zero runnable checks). Strategy: stub global fetch and
 * process.exit, capture stdout/stderr, and assert the NEW contract per class:
 *  - a simple-table verb (kill): non-2xx is a labeled stderr error + exit 1 (the old path printed
 *    "failed: …" to STDOUT and exited 0 — false success);
 *  - automation --json: a non-2xx now fails explicitly instead of printing the error body with
 *    exit 0;
 *  - promote --json: a non-2xx with a JSON body still emits the machine-readable body on stdout
 *    with exit 1 (the daemon's 409 refusals are a script contract — the first unification cut
 *    broke it; this is the regression pin for the restore).
 */

const realFetch = globalThis.fetch;
const realExit = process.exit;
const realOut = process.stdout.write.bind(process.stdout);
const realErr = process.stderr.write.bind(process.stderr);

afterEach(() => {
	globalThis.fetch = realFetch;
	process.exit = realExit;
	process.stdout.write = realOut;
	process.stderr.write = realErr;
});

function capture(): { out: string[]; err: string[]; exits: number[] } {
	const cap = { out: [] as string[], err: [] as string[], exits: [] as number[] };
	process.stdout.write = ((s: string) => {
		cap.out.push(String(s));
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((s: string) => {
		cap.err.push(String(s));
		return true;
	}) as typeof process.stderr.write;
	process.exit = ((code?: number) => {
		cap.exits.push(code ?? 0);
		throw new Error(`exit:${code}`);
	}) as typeof process.exit;
	return cap;
}

const res = (status: number, body: string) =>
	(async () => new Response(body, { status })) as unknown as typeof fetch;

test("kill (SIMPLE_COMMANDS): non-2xx is a labeled stderr error with exit 1 — never the old stdout false-success", async () => {
	const cap = capture();
	globalThis.fetch = res(500, "boom");
	await cmdKill(["unit-1"]).catch((e) => expect(String(e)).toContain("exit:1"));
	expect(cap.exits).toEqual([1]);
	expect(cap.err.join("")).toContain("failed: 500 boom");
	expect(cap.out.join("")).not.toContain("killed");
});

test("automation --json: a non-2xx fails explicitly instead of printing the error body as data with exit 0", async () => {
	const cap = capture();
	globalThis.fetch = res(503, '{"error":"unavailable"}');
	await cmdAutomation(["--json"]).catch((e) => expect(String(e)).toContain("exit:1"));
	expect(cap.exits).toEqual([1]);
	expect(cap.out.join("")).toBe("");
});

test("promote --json: a non-2xx JSON refusal still reaches stdout machine-readable, with exit 1 (the 409 script contract)", async () => {
	const cap = capture();
	globalThis.fetch = res(409, JSON.stringify({ ok: false, message: "already promoted" }));
	await cmdPromote(["OMPSQ-1", "--json"]).catch((e) => expect(String(e)).toContain("exit:1"));
	expect(cap.exits).toEqual([1]);
	const parsed = JSON.parse(cap.out.join("")) as { ok: boolean; message: string };
	expect(parsed.ok).toBe(false);
	expect(parsed.message).toBe("already promoted");
});

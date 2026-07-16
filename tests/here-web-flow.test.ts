/**
 * `glance here --web` / printed URL (plans/daily-onramp/05-web-flow.md).
 *
 * The fail-closed criteria from the concern's Verify, without a live daemon or browser:
 *   1. the printed URL puts `?token=` BEFORE `#/agent/`, never after — proven against the exact
 *      capture the webapp performs (`new URL(u).searchParams.get("token")`, webapp/src/lib/api.ts),
 *      which sees only the query string and never the fragment;
 *   2. opener command selection is correct for WSL (env-detected and /proc/version-detected),
 *      native Linux, darwin, and win32;
 *   3. a missing opener binary degrades to a printable note — never a thrown error into the REPL;
 *   4. `--web` never eats the positional prompt (the shared parser treats any flag followed by a
 *      bare word as value-taking — parseHereArgs exists to prevent exactly that).
 * The live half (a real WSL2 browser open) runs in the scratch-daemon choreography, not here.
 */

import { expect, test } from "bun:test";
import { hereWebUrl, isWsl, openerCandidates, openInBrowser } from "../src/here-web.ts";
import { parseHereArgs } from "../src/here.ts";

// ── 1. URL shape: token in the query, deep link in the fragment ─────────────────────────────────

test("hereWebUrl puts the token before the fragment, in the exact shape captureToken reads", () => {
	const url = hereWebUrl("http://127.0.0.1:7878", "s3cret", "chat-ab12");
	expect(url).toBe("http://127.0.0.1:7878/?token=s3cret#/agent/chat-ab12");
	// The webapp's own capture: URLSearchParams sees ONLY the query string. If the token slid into
	// the fragment this returns null and the page loads an unauthenticated shell, silently.
	expect(new URL(url).searchParams.get("token")).toBe("s3cret");
	expect(new URL(url).hash).toBe("#/agent/chat-ab12");
	// Ordering, stated directly: ?token= strictly precedes #, and never appears after it.
	expect(url.indexOf("?token=")).toBeGreaterThan(-1);
	expect(url.indexOf("?token=")).toBeLessThan(url.indexOf("#"));
	expect(url.slice(url.indexOf("#"))).not.toContain("token=");
});

test("hereWebUrl survives URL-hostile tokens and agent ids via encoding", () => {
	const url = hereWebUrl("http://127.0.0.1:7878", "a+b&c#d", "chat/one two");
	expect(new URL(url).searchParams.get("token")).toBe("a+b&c#d");
	// The raw fragment must still start with the route prefix — nothing from the token leaked past it.
	expect(new URL(url).hash.startsWith("#/agent/")).toBe(true);
});

test("hereWebUrl without a token keeps the deep link and drops the query entirely", () => {
	const url = hereWebUrl("http://127.0.0.1:7878", "", "chat-ab12");
	expect(url).toBe("http://127.0.0.1:7878/#/agent/chat-ab12");
	expect(url).not.toContain("?");
});

test("hereWebUrl normalizes a trailing slash on the base (no // in the printed URL)", () => {
	const url = hereWebUrl("http://127.0.0.1:7878/", "t", "chat-1");
	expect(url).toBe("http://127.0.0.1:7878/?token=t#/agent/chat-1");
});

// ── 2. opener selection per platform ────────────────────────────────────────────────────────────

test("isWsl: WSL_DISTRO_NAME wins; /proc/version vendor tag is the fallback; plain linux is not WSL", () => {
	expect(isWsl({ WSL_DISTRO_NAME: "Ubuntu-24.04" }, "")).toBe(true);
	expect(isWsl({}, "Linux version 6.18.33.2-microsoft-standard-WSL2 (root@x)")).toBe(true);
	expect(isWsl({}, "Linux version 6.8.0-45-generic (buildd@lcy02)")).toBe(false);
});

test("openerCandidates: wslview ladder on WSL2, xdg-open alone on native linux, open/start elsewhere", () => {
	const u = "http://x/?token=t#/agent/a";
	expect(openerCandidates(u, { platform: "linux", wsl: true })).toEqual([
		["wslview", u],
		["explorer.exe", u],
		["xdg-open", u],
	]);
	expect(openerCandidates(u, { platform: "linux", wsl: false })).toEqual([["xdg-open", u]]);
	expect(openerCandidates(u, { platform: "darwin", wsl: false })).toEqual([["open", u]]);
	expect(openerCandidates(u, { platform: "win32", wsl: false })).toEqual([["cmd", "/c", "start", "", u]]);
});

test("openInBrowser routes by WSL_DISTRO_NAME: set → wslview first, unset → xdg-open, darwin → open", () => {
	const u = "http://x/?token=t#/agent/a";
	const spawned: string[][] = [];
	const spawn = (argv: string[]): void => {
		spawned.push(argv);
	};
	expect(openInBrowser(u, { platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" }, spawn }).via).toBe("wslview");
	expect(openInBrowser(u, { platform: "linux", env: {}, procVersion: "generic", spawn }).via).toBe("xdg-open");
	expect(openInBrowser(u, { platform: "darwin", env: {}, spawn }).via).toBe("open");
	expect(spawned.map((a) => a[0])).toEqual(["wslview", "xdg-open", "open"]);
});

// ── 3. missing opener degrades, never throws ────────────────────────────────────────────────────

test("a missing first rung falls through the WSL ladder to the one that spawns", () => {
	const u = "http://x/?token=t#/agent/a";
	const spawned: string[][] = [];
	const spawn = (argv: string[]): void => {
		if (argv[0] === "wslview") throw new Error("ENOENT: wslview not installed");
		spawned.push(argv);
	};
	const outcome = openInBrowser(u, { platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" }, spawn });
	expect(outcome.opened).toBe(true);
	expect(outcome.via).toBe("explorer.exe");
	expect(spawned).toEqual([["explorer.exe", u]]);
});

test("every opener missing degrades to a printable note — the REPL never sees a throw", () => {
	const spawn = (): void => {
		throw new Error("ENOENT");
	};
	let outcome: ReturnType<typeof openInBrowser> | undefined;
	expect(() => {
		outcome = openInBrowser("http://x/?token=t#/agent/a", { platform: "linux", env: { WSL_DISTRO_NAME: "U" }, spawn });
	}).not.toThrow();
	expect(outcome?.opened).toBe(false);
	expect(outcome?.note).toContain("wslview, explorer.exe, xdg-open");
	expect(outcome?.note).toContain("webapp URL above");
});

// ── 4. --web never eats the prompt ───────────────────────────────────────────────────────────────

test("parseHereArgs: --web is boolean and the positional prompt survives in order", () => {
	expect(parseHereArgs(["--web", "why is this failing"])).toMatchObject({ web: true, positional: ["why is this failing"] });
	expect(parseHereArgs(["fix the flake", "--web"])).toMatchObject({ web: true, positional: ["fix the flake"] });
	expect(parseHereArgs(["--web"])).toMatchObject({ web: true, positional: [] });
	const plain = parseHereArgs(["--model", "opus", "hello"]);
	expect(plain.web).toBe(false);
	expect(plain.flags.model).toBe("opus");
	expect(plain.positional).toEqual(["hello"]);
	// combined: flag values and the prompt both land where they belong
	const combo = parseHereArgs(["--web", "--model", "opus", "ship", "it"]);
	expect(combo).toMatchObject({ web: true, positional: ["ship", "it"] });
	expect(combo.flags.model).toBe("opus");
});

/**
 * Web flow for `glance here` — the deep-linked webapp URL and the `--web` browser opener
 * (plans/daily-onramp/05-web-flow.md).
 *
 * URL shape — the one non-obvious ordering constraint: the webapp's `captureToken()`
 * (webapp/src/lib/api.ts) reads `new URL(location.href).searchParams.get("token")`, and
 * `URLSearchParams` only ever sees the QUERY string, never the fragment. So the token MUST
 * precede the `#` (`?token=X#/agent/Y`), never live inside it (`#/agent/Y?token=X` loads an
 * unauthenticated shell, silently). `hereWebUrl` is the single place this ordering is built.
 *
 * Opener — platform-aware because the generic Linux opener is wrong on WSL2 (this operator's
 * environment): `wslview` (ships with `wslu`) hands the URL to the Windows-host browser, and
 * when it isn't installed, `explorer.exe` via interop does the same job — plain `xdg-open`
 * under WSL2 either no-ops or errors depending on distro, so it's the last rung, not the first.
 * A missing opener degrades to "URL printed, not opened" with a one-line note; it never throws
 * into the REPL.
 */

import { readFileSync } from "node:fs";

/**
 * The deep-linked, authenticated webapp URL for a session:
 * `<base>/?token=<token>#/agent/<id>` — token as a query param BEFORE the fragment (see module
 * doc), fragment in the exact `#/agent/<id>` shape push payloads already use (src/push.ts).
 * An empty token (daemon hasn't minted one) drops the query, keeping the deep link.
 */
export function hereWebUrl(baseUrl: string, token: string, agentId: string): string {
	const b = baseUrl.replace(/\/+$/, "");
	const q = token ? `?token=${encodeURIComponent(token)}` : "";
	return `${b}/${q}#/agent/${encodeURIComponent(agentId)}`;
}

/** WSL detection: `WSL_DISTRO_NAME` when the env survived, /proc/version's vendor tag otherwise. */
export function isWsl(env: Record<string, string | undefined> = process.env, procVersion?: string): boolean {
	if (env.WSL_DISTRO_NAME) return true;
	let v = procVersion;
	if (v === undefined) {
		try {
			v = readFileSync("/proc/version", "utf8");
		} catch {
			v = "";
		}
	}
	return /microsoft|wsl/i.test(v);
}

/**
 * Ordered opener attempts for the platform — each is a full argv, tried until one spawns.
 * WSL2 gets a ladder (wslview → explorer.exe interop → xdg-open) because any single rung is
 * legitimately absent on real machines (this operator's box has no `wslu`).
 */
export function openerCandidates(url: string, opts: { platform: NodeJS.Platform; wsl: boolean }): string[][] {
	if (opts.platform === "darwin") return [["open", url]];
	if (opts.platform === "win32") return [["cmd", "/c", "start", "", url]];
	if (opts.wsl) return [["wslview", url], ["explorer.exe", url], ["xdg-open", url]];
	return [["xdg-open", url]];
}

export interface OpenOutcome {
	opened: boolean;
	/** The binary that took the URL when opened; the exhausted ladder when not. */
	via: string;
	/** One-line degradation notice for the REPL when nothing spawned. */
	note?: string;
}

/** Detached best-effort spawn: the child's own exit code is deliberately ignored (spec'd). */
function detachedSpawn(argv: string[]): void {
	const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	proc.unref();
}

/**
 * Open `url` in the platform browser, best-effort. Walks the candidate ladder; a spawn failure
 * (missing binary) moves to the next rung; exhausting the ladder returns a printable note —
 * NEVER a throw (a browser-launch failure must not crash the REPL).
 */
export function openInBrowser(
	url: string,
	opts: {
		platform?: NodeJS.Platform;
		env?: Record<string, string | undefined>;
		procVersion?: string;
		spawn?: (argv: string[]) => void;
	} = {},
): OpenOutcome {
	const platform = opts.platform ?? process.platform;
	const spawn = opts.spawn ?? detachedSpawn;
	const candidates = openerCandidates(url, {
		platform,
		wsl: platform === "linux" && isWsl(opts.env ?? process.env, opts.procVersion),
	});
	for (const argv of candidates) {
		try {
			spawn(argv);
			return { opened: true, via: argv[0] };
		} catch {
			// missing/broken opener — try the next rung
		}
	}
	const tried = candidates.map((c) => c[0]).join(", ");
	return { opened: false, via: tried, note: `couldn't open a browser (tried ${tried}) — use the webapp URL above` };
}

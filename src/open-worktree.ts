/**
 * open-worktree.ts — the fleet→ground gesture (plans/fleet-ide-bridge B02):
 * resolve and launch the operator's editor/cockpit on a unit's worktree.
 * `glance open <unit>` (CLI, local spawn) and POST /api/agents/:id/open
 * (webapp button, daemon-host spawn) both land here.
 *
 * Spawn discipline: argv array only — never a shell string. The worktree path
 * is the daemon's own record (never client input) and the command template is
 * operator env config, so no agent- or client-controlled text reaches exec.
 */
import { spawn, spawnSync } from "node:child_process";
import { statSync } from "node:fs";

/** Roster shape needed to pick a unit — a slice of AgentDTO. */
export interface OpenTarget {
	id: string;
	name: string;
	worktree: string;
	branch?: string;
}

/** `glance open <key>`: exact id, then exact name, then exact branch, then a
 *  unique id prefix. Ambiguity at ANY tier is a miss — ids are unique, but names
 *  and branches can collide across units, and guessing opens the wrong worktree. */
export function matchUnit<T extends OpenTarget>(agents: T[], key: string): T | null {
	for (const tier of [(a: T) => a.id === key, (a: T) => a.name === key, (a: T) => a.branch === key, (a: T) => a.id.startsWith(key)]) {
		const hits = agents.filter(tier);
		if (hits.length === 1) return hits[0];
		if (hits.length > 1) return null;
	}
	return null;
}

export interface OpenDeps {
	env?: Record<string, string | undefined>;
	/** PATH probe; default Bun.which. */
	which?: (bin: string) => string | null;
	/** WSL→Windows path translation, invoked only when the opener binary lives under /mnt/. */
	toWindowsPath?: (p: string) => string;
	/** Is this an existing directory? (default: real fs stat) — the worktree must be one. */
	isDir?: (p: string) => boolean;
	/** Detached process launcher; returns whether the spawn call succeeded. */
	spawnFn?: (argv: string[], env: Record<string, string>) => boolean;
}

export interface OpenResult {
	/** The worktree path, post-translation — what the opener actually received (or what to copy). */
	path: string;
	spawned: boolean;
	/** Fully-resolved argv, null when no opener is configured/found. */
	argv: string[] | null;
	/** Human hint for the spawned=false case. */
	hint?: string;
}

function defaultWhich(bin: string): string | null {
	return typeof Bun !== "undefined" ? Bun.which(bin) : (spawnSync("which", [bin]).stdout?.toString().trim() || null);
}

function defaultToWindowsPath(p: string): string {
	// `--` so a (rejected-upstream, but defense-in-depth) dash-leading path can never become a wslpath flag.
	const res = spawnSync("wslpath", ["-w", "--", p]);
	const translated = res.status === 0 ? res.stdout.toString().trim() : "";
	return translated || p;
}

/** GUI/session vars a graphical editor legitimately needs. Everything else — API keys, daemon
 *  tokens, coordinator secrets loaded from .env — is stripped: a spawned `wezterm`/`code` hands
 *  its shell (and every editor extension) the full parent environment otherwise. */
const ENV_ALLOW = /^(PATH|HOME|USER|LOGNAME|SHELL|TERM|LANG|LC_[A-Z_]+|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_[A-Z_]+|DBUS_SESSION_BUS_ADDRESS|WSL_[A-Z_]+|WSLENV|TMPDIR)$/;

function guiEnv(env: Record<string, string | undefined>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(env)) if (v !== undefined && ENV_ALLOW.test(k)) out[k] = v;
	return out;
}

function defaultSpawn(argv: string[], env: Record<string, string>): boolean {
	try {
		const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: "ignore", env });
		child.on("error", () => {}); // ENOENT arrives async; never crash the daemon/CLI over an opener
		child.unref();
		return true;
	} catch {
		return false;
	}
}

/** The /api/agents/:id/open decision, pure so the guard order is pinnable in tests:
 *  404 unknown unit → 403 in db/org mode WITHOUT ever invoking the opener (a multi-tenant
 *  daemon must never spawn host processes; the path still rides in the body for copy-path)
 *  → spawn. */
export function openRouteDecision(
	unit: Pick<OpenTarget, "worktree"> | undefined,
	dbMode: boolean,
	openFn: (worktree: string) => OpenResult = openWorktree,
): { status: number; body: Record<string, unknown> } {
	if (!unit) return { status: 404, body: { error: "no such agent" } };
	if (dbMode) return { status: 403, body: { path: unit.worktree, spawned: false, reason: "multi-tenant daemon never spawns host processes" } };
	const out = openFn(unit.worktree);
	return { status: 200, body: { path: out.path, spawned: out.spawned, opener: out.argv?.[0] ?? null, hint: out.hint ?? null } };
}

/** Launch the configured opener on `worktree`. Resolution order:
 *  OMP_SQUAD_OPEN_CMD template (`{path}` placeholder, whitespace-split — no shell
 *  quoting) → `terax` on PATH → `code` on PATH → nothing (path returned to copy).
 *
 *  Two guards make the path safe to hand an arbitrary opener (codex review):
 *  the worktree must be an ABSOLUTE, EXISTING directory (a relative or `-`-leading
 *  path would otherwise arrive as an editor OPTION, and a `sh -c {path}` template
 *  would read metacharacters in it as code), and `{path}` may never occupy argv[0]
 *  (the path is data, never the executable). */
export function openWorktree(worktree: string, deps: OpenDeps = {}): OpenResult {
	const env = deps.env ?? process.env;
	const which = deps.which ?? defaultWhich;
	const toWin = deps.toWindowsPath ?? defaultToWindowsPath;
	const spawnFn = deps.spawnFn ?? defaultSpawn;
	const isDir = deps.isDir ?? ((p: string) => statSync(p, { throwIfNoEntry: false })?.isDirectory() === true);

	if (!worktree.startsWith("/") || !isDir(worktree)) {
		return { path: worktree, spawned: false, argv: null, hint: "refusing to open: worktree is not an absolute existing directory" };
	}

	const custom = (env.OMP_SQUAD_OPEN_CMD ?? env.GLANCE_OPEN_CMD ?? "").trim();
	let template: string[] | null = null;
	if (custom) {
		template = custom.split(/\s+/);
		if (!template.includes("{path}")) template.push("{path}");
		if (template[0] === "{path}") {
			return { path: worktree, spawned: false, argv: null, hint: "refusing to open: OMP_SQUAD_OPEN_CMD puts {path} in the executable position" };
		}
	} else {
		for (const bin of ["terax", "code"]) {
			if (which(bin)) {
				template = [bin, "{path}"];
				break;
			}
		}
	}
	if (!template) {
		return { path: worktree, spawned: false, argv: null, hint: "no opener found — set OMP_SQUAD_OPEN_CMD or put terax/code on PATH" };
	}

	// A Windows binary reached through WSL interop (/mnt/...) can't read Linux paths;
	// translate the ARGUMENT, not the binary. (VS Code's WSL shim also lives under
	// /mnt/ — a \\wsl$ UNC path still opens there, just not in WSL-remote mode.)
	const binPath = which(template[0]) ?? template[0];
	const openPath = binPath.startsWith("/mnt/") ? toWin(worktree) : worktree;
	const argv = template.map((t) => (t === "{path}" ? openPath : t));
	const spawned = spawnFn(argv, guiEnv(env));
	return { path: openPath, spawned, argv, hint: spawned ? undefined : `spawn failed: ${argv[0]}` };
}

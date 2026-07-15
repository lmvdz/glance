/**
 * The real-world probe behind `glance doctor` — every fact gathered from the machine, none inferred.
 *
 * Split from `doctor.ts` on purpose: the report logic there is pure and exhaustively tested against
 * fabricated facts, while everything here touches the filesystem, docker, git, and a possibly-dead
 * daemon. The seam is the only reason the diagnosis is testable at all.
 *
 * Two rules, both learned the hard way:
 *
 *  1. **Ask the daemon what the daemon believes.** `/proc/<pid>/environ` shows a process's INITIAL
 *     environment, so reading it to answer "is autodispatch on?" gives a confident wrong answer — I made
 *     that mistake twice in one session. When the daemon is up, `GET /api/doctor` is the source of truth.
 *  2. **Diagnose a dead daemon too.** The single most valuable moment for `doctor` is when nothing is
 *     running. Repo, state-dir, docker, and webapp checks never need the daemon, so they run regardless.
 */

import { existsSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import * as path from "node:path";
import { errText } from "./err-text.ts";
import { harnessHooksInstalled } from "./harness-hooks.ts";
import { hardenedGit } from "./git-harden.ts";
import { planeConfig } from "./plane.ts";
import { resolveStateDir } from "./state-dir.ts";
import { DERIVED_SANDBOX_IMAGE } from "./gate-runner.ts";
import type { AutonomyFacts, DaemonFacts, DoctorProbe, RepoFacts, SymptomIndexEntry } from "./doctor.ts";

interface DoctorFactsResponse {
	daemon: DaemonFacts;
	autonomy: AutonomyFacts;
	plane?: { configured: boolean; reachable: boolean; detail?: string };
	gate?: { image: string; strict: boolean };
	projects: string[];
	zombieAgents: number;
	/** The known-symptom index (comprehension concern 07) — absent on an older daemon that predates
	 *  this field, which reads as "no symptoms known" rather than a probe crash. */
	symptoms?: SymptomIndexEntry[];
}

/** Structural check, not a full decode: the fields `doctor` actually reads. */
function isDoctorFacts(v: unknown): v is DoctorFactsResponse {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o.daemon === "object" && o.daemon !== null && typeof o.autonomy === "object" && o.autonomy !== null;
}

const DEAD: DaemonFacts = { running: false };
/** Nothing is armed when nothing is running. Reporting the CALLING shell's flags here would describe a
 *  daemon that does not exist. */
const NO_AUTONOMY: AutonomyFacts = { autodispatch: false, autodrive: false, autoland: false, autosupervise: false, landConfirm: false, regressionGate: false };

/** A wedged docker daemon or a git on a stalled network filesystem must not hang the diagnosis forever —
 *  the machine `doctor` is asked about is, by hypothesis, the broken one. (grok-4.5) */
async function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<T>((resolve) => {
		timer = setTimeout(() => resolve(onTimeout), ms);
		timer.unref?.();
	});
	return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

const SPAWN_TIMEOUT_MS = 5_000;

async function run(argv: string[], cwd: string): Promise<{ code: number; stdout: string }> {
	const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
	const done = (async () => {
		const stdout = await new Response(proc.stdout).text();
		return { code: await proc.exited, stdout: stdout.trim() };
	})();
	const result = await withTimeout(done, SPAWN_TIMEOUT_MS, { code: 124, stdout: "" });
	if (result.code === 124) proc.kill();
	return result;
}

async function gitOut(args: string[], cwd: string): Promise<string | undefined> {
	const r = await withTimeout(hardenedGit(args, { cwd }).catch(() => ({ code: 1, stdout: "" })), SPAWN_TIMEOUT_MS, { code: 124, stdout: "" });
	return r.code === 0 ? r.stdout.trim() : undefined;
}

/** `git branch --list 'squad/*'` — `--list` patterns are relative to `refs/heads/`, a distinction that
 *  already produced one false-positive gate in this repo. */
async function staleSquadBranches(repo: string): Promise<number> {
	const out = await gitOut(["branch", "--list", "squad/*", "--format=%(refname:short)"], repo);
	return out ? out.split("\n").filter((l) => l.trim()).length : 0;
}

/** Exported for the test that pins `dirtyFiles` to land's exact definition of dirty. */
export async function repoFacts(repo: string): Promise<RepoFacts> {
	if (!existsSync(repo)) return { repo, exists: false, isGitRepo: false, dirtyFiles: 0, hasOrigin: false, staleBranches: 0 };
	const inside = await gitOut(["rev-parse", "--is-inside-work-tree"], repo);
	if (inside !== "true") return { repo, exists: true, isGitRepo: false, dirtyFiles: 0, hasOrigin: false, staleBranches: 0 };

	const [status, remotes, head, stale] = await Promise.all([
		// EXACTLY the check that refuses a land (`land.ts`: `status --porcelain --untracked-files=no` on
		// the repo). Counting untracked files here would report "every land will refuse" for a stray build
		// artifact that land ignores — and a diagnostic that cries wolf gets turned off. (grok-4.5)
		gitOut(["status", "--porcelain", "--untracked-files=no"], repo),
		gitOut(["remote"], repo),
		gitOut(["symbolic-ref", "--quiet", "--short", "HEAD"], repo),
		staleSquadBranches(repo),
	]);
	return {
		repo,
		exists: true,
		isGitRepo: true,
		dirtyFiles: status ? status.split("\n").filter((l) => l.trim()).length : 0,
		hasOrigin: (remotes ?? "").split("\n").includes("origin"),
		defaultBranch: head,
		staleBranches: stale,
	};
}

export interface ProbeOptions {
	/** Daemon base URL, e.g. `http://127.0.0.1:7878`. */
	base: string;
	headers: Record<string, string>;
	/** The checkout the operator is standing in. */
	cwd: string;
	/** Milliseconds to wait on the daemon before declaring it dead. */
	timeoutMs?: number;
}

export function makeDoctorProbe(opts: ProbeOptions): DoctorProbe {
	// Fetched once and shared: eight checks want pieces of it, and a doctor that issues eight round-trips
	// can report eight mutually inconsistent snapshots of a daemon that changed underneath it.
	//
	// "Cannot ask the daemon" is NOT "the daemon is down". `/api/doctor` is new; a daemon started from an
	// older install answers 404 while happily driving agents. Caught on the first live run of this command,
	// which told me to `glance up` a daemon that was already up. `/api/health` has existed forever, so it
	// is the liveness probe, and `/api/doctor` only decides whether the facts are legible.
	let factsPromise: Promise<{ facts?: DoctorFactsResponse; alive: boolean; opaqueReason?: string }> | undefined;
	const probeDaemon = () => {
		factsPromise ??= (async () => {
			try {
				// ANY HTTP response means something is listening — a 401 (wrong token) and a 404 (older
				// daemon) both prove liveness. Only a thrown fetch (connection refused, timeout) means dead.
				await fetch(`${opts.base}/api/health`, { headers: opts.headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 3_000) });
			} catch {
				return { alive: false };
			}
			const alive = true;
			try {
				const res = await fetch(`${opts.base}/api/doctor`, { headers: opts.headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 3_000) });
				if (res.status === 404) return { alive, opaqueReason: "/api/doctor (404 — older daemon)" };
				if (res.status === 401 || res.status === 403) return { alive, opaqueReason: `/api/doctor (${res.status} — this token is not an operator)` };
				if (!res.ok) return { alive, opaqueReason: `/api/doctor (HTTP ${res.status})` };
				const body: unknown = await res.json();
				// A 200 does not prove we are talking to glance. `noFleet` answers `[]`, and an unrelated
				// service on this port answers anything at all. Check the shape before believing it, or the
				// first property access throws and the whole diagnosis reads as a probe crash. (gpt-5.6-sol)
				if (!isDoctorFacts(body)) return { alive, opaqueReason: "/api/doctor (unrecognized response — is something else on this port?)" };
				return { alive, facts: body };
			} catch (err) {
				return { alive, opaqueReason: `/api/doctor (${errText(err)})` };
			}
		})();
		return factsPromise;
	};
	const facts = async (): Promise<DoctorFactsResponse | undefined> => (await probeDaemon()).facts;

	return {
		async daemon() {
			const probed = await probeDaemon();
			if (!probed.alive) return DEAD;
			const f = probed.facts;
			if (!f) return { running: true, reachableButOpaque: true, opaqueReason: probed.opaqueReason };
			// The daemon reports the rev it was BUILT from only if it was launched with GLANCE_REV. When it
			// wasn't, resolve it from the checkout its cwd sits in — that is where a `bun src/index.ts`
			// daemon's code actually lives. A global install lands in neither, and `installedRev` stays
			// undefined rather than borrowing the operator's rev and claiming they match.
			const [installedRev, installRepo] = f.daemon.cwd
				? await Promise.all([f.daemon.installedRev ? Promise.resolve(f.daemon.installedRev) : gitOut(["rev-parse", "HEAD"], f.daemon.cwd), gitOut(["rev-parse", "--show-toplevel"], f.daemon.cwd)])
				: [f.daemon.installedRev, undefined];
			return { ...f.daemon, installedRev, installRepo };
		},
		async autonomy() {
			const probed = await probeDaemon();
			// A dead daemon is genuinely running nothing. A LIVE but opaque one may be autolanding as we
			// speak — reporting "nothing is armed" there would be a fabricated all-clear.
			if (!probed.alive) return NO_AUTONOMY;
			return probed.facts?.autonomy;
		},
		async repoRev() {
			const [rev, repoRoot] = await Promise.all([gitOut(["rev-parse", "HEAD"], opts.cwd), gitOut(["rev-parse", "--show-toplevel"], opts.cwd)]);
			return { rev, repoRoot };
		},
		async stateDir() {
			const p = resolveStateDir();
			try {
				await access(p, constants.W_OK);
				return { path: p, exists: true, writable: true };
			} catch {
				// A fresh install has no state dir yet — the daemon creates it at boot. "Not writable" there
				// is a lie, and the old `chown -R` remedy would have failed on a path that does not exist.
				if (existsSync(p)) return { path: p, exists: true, writable: false };
				try {
					await access(path.dirname(p), constants.W_OK);
					return { path: p, exists: false, writable: true };
				} catch {
					return { path: p, exists: false, writable: false };
				}
			}
		},
		async planeArmed() {
			// PLANE LIVES IN THE DAEMON. It loads `plane.env` once, at boot; the operator's shell almost
			// never carries those variables. Reading them here answered "is the work queue connected?" for
			// the CLI process — the exact substitution (calling shell for daemon) this whole command exists
			// to stop making. Ask the daemon; only fall back to local env when there is no daemon. (grok-4.5)
			const f = await facts();
			if (f?.plane) return f.plane;
			const cfg = planeConfig();
			if (!cfg) return { configured: false, reachable: false };
			try {
				const res = await fetch(`${cfg.baseUrl}/api/v1/users/me/`, {
					headers: { "x-api-key": cfg.apiKey },
					signal: AbortSignal.timeout(opts.timeoutMs ?? 3_000),
				});
				return { configured: true, reachable: res.ok, detail: res.ok ? undefined : `HTTP ${res.status}` };
			} catch (err) {
				return { configured: true, reachable: false, detail: errText(err) };
			}
		},
		async gateImage() {
			// The image the gate will ACTUALLY use, resolved the way the gate resolves it: an explicit
			// `OMP_SQUAD_GATE_SANDBOX=<image>` wins, then the operator's default, then the derived one.
			// Inspecting the derived image while the operator pinned another told them about an image the
			// gate would never run. (gpt-5.6-sol)
			const f = await facts();
			const gate = f?.gate;
			const image = gate?.image ?? DERIVED_SANDBOX_IMAGE;
			const strict = gate?.strict ?? false;
			const version = await run(["docker", "version", "--format", "{{.Server.Version}}"], opts.cwd).catch(() => ({ code: 1, stdout: "" }));
			if (version.code !== 0) return { dockerUsable: false, imagePresent: false, image, strict };
			const inspect = await run(["docker", "image", "inspect", image], opts.cwd).catch(() => ({ code: 1, stdout: "" }));
			return { dockerUsable: true, imagePresent: inspect.code === 0, image, strict };
		},
		async projects() {
			const f = await facts();
			// With no daemon, the repo you are standing in is the one you care about. That is also the only
			// one we can name without reading the registry the daemon owns.
			const repos = f?.projects?.length ? f.projects : [opts.cwd];
			return Promise.all(repos.map(repoFacts));
		},
		async webappBuilt() {
			// The DAEMON serves `webapp/dist` from wherever ITS code lives, which is routinely not the repo
			// the operator is standing in. Asking the local cwd would report "the UI is missing" every time
			// `glance doctor` runs from a managed repo. Believe the daemon; fall back to the cwd only when
			// there is no daemon to ask.
			const f = await facts();
			if (f) return f.daemon.webappDist !== false;
			return existsSync(path.join(opts.cwd, "webapp", "dist", "index.html"));
		},
		// Read from the operator's OWN home config — hooks live in the human's CLI settings, not in
		// the daemon's state (a remote daemon has no idea what this laptop's ~/.claude says).
		harnessHooks() {
			return harnessHooksInstalled();
		},
		async zombieAgents() {
			return (await facts())?.zombieAgents ?? 0;
		},
		async symptoms() {
			return (await facts())?.symptoms ?? [];
		},
	};
}

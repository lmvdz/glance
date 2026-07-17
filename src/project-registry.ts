/**
 * Durable project registry — the repos this operator has told glance to care about.
 *
 * Until now a "project" was not a thing you owned; it was an artifact of the live roster.
 * `SquadManager.projects()` grouped LIVE AGENTS by `dto.repo`, so a repo existed in the UI only while
 * it happened to have a running agent. Observed on the operator's own daemon: `/api/projects` returned
 * only `omp-squad` moments after lunarpup's last agent was reaped — lunarpup vanished from the sidebar
 * despite being the daemon's own working directory. Its two features were DERIVED from those very
 * agents (persisted features on disk: 47, all omp-squad, zero lunarpup), so agents and features vanished
 * together and nothing was left to anchor the repo. It reappeared only when an agent respawned there. Projects blinked in and out with the roster, there was no POST to add
 * one, and nothing in the web UI could switch between them.
 *
 * This registry is the missing durable half: a repo you register stays a project whether or not any
 * agent is alive in it. `projects()` unions it with live-agent repos and persisted-feature repos, so a
 * project can never silently disappear.
 *
 * Same tiny-JSON-set shape as `removed-ledger.ts` / `dispatch-ledger.ts`: per-stateDir (already
 * per-ORG in DB-root mode, see `manager-registry.ts`), read through the storage backend, decoded with a
 * real Schema rather than a `JSON.parse as` cast — persisted state survives daemon upgrades, so the
 * shape check is a genuine trust boundary. Deliberately NOT plumbed through the `Store` snapshot
 * contract: a registered repo has no agent record to fold into a roster snapshot.
 *
 * Registration does not touch the repo. Unregistering deletes nothing on disk — it only stops glance
 * from listing it. A repo that still has live agents or features keeps appearing regardless, because
 * hiding work that exists would be the same lie in a new place.
 */

import path from "node:path";
import * as os from "node:os";
import { Schema } from "effect";
import { getStorageBackend } from "./dal/storage.ts";
import { decodeJsonWith } from "./schema/external-json.ts";

/** Distinguishes "already there" from "the disk write failed" — a caller must never report a failed
 *  write to the operator as a successful registration. */
export type RegistryWrite = "added" | "exists" | "error";
export type RegistryDelete = "removed" | "absent" | "error";

export interface ProjectRegistry {
	/** Registered repo roots, sorted. Never throws. */
	list(): string[];
	has(repo: string): boolean;
	/** Idempotent. `"error"` ⇒ the in-memory set is unchanged and nothing was persisted. */
	add(repo: string): RegistryWrite;
	/** Idempotent. `"error"` ⇒ the in-memory set is unchanged and nothing was persisted. */
	delete(repo: string): RegistryDelete;
}

/** On-disk shape: a JSON array of absolute repo roots (written sorted). */
const RegisteredReposSchema = Schema.Array(Schema.String);

const FILE = "projects.json";
/** Sidecar for `glance here` session-scoped registrations (daily-onramp 02). The registry write in
 *  `projects.json` is DURABLE, so the "undo this on session end" marker must be durable too — an
 *  in-memory-only marker meant a daemon restart mid-session silently promoted an ephemeral
 *  registration to permanent (fail-open; blind-review finding). SquadManager reloads this at boot
 *  and reaps flagged entries whose session did not survive the restart. */
const EPHEMERAL_FILE = "ephemeral-projects.json";

function readRepoSet(stateDir: string, file: string): Set<string> {
	try {
		const full = path.join(stateDir, file);
		const b = getStorageBackend();
		if (!b.exists(full)) return new Set();
		const raw = b.readTextSync(full);
		if (raw === undefined) return new Set();
		const repos = decodeJsonWith(RegisteredReposSchema, raw);
		return new Set((repos ?? []).filter((r) => r.length > 0));
	} catch {
		return new Set(); // corrupt/unreadable ⇒ behave as "nothing registered"; never crash start()
	}
}

function readRepos(stateDir: string): Set<string> {
	return readRepoSet(stateDir, FILE);
}

/** True when the set is now durably on disk. A failed write must NOT be reported as a success: the
 *  operator would see "project added", and the next restart would disagree (cross-lineage review). */
function writeRepoSet(stateDir: string, file: string, repos: Set<string>): boolean {
	try {
		getStorageBackend().writeDurableSync(path.join(stateDir, file), JSON.stringify([...repos].sort()));
		return true;
	} catch {
		return false;
	}
}

function writeRepos(stateDir: string, repos: Set<string>): boolean {
	return writeRepoSet(stateDir, FILE, repos);
}

/** The persisted ephemeral-registration markers (see EPHEMERAL_FILE). Never throws. */
export function readEphemeralProjects(stateDir: string): Set<string> {
	return readRepoSet(stateDir, EPHEMERAL_FILE);
}

/** True when the marker set is durably on disk. A failed write means the marker would NOT survive a
 *  restart — the caller must treat that as a failed ephemeral registration, not shrug it off. */
export function writeEphemeralProjects(stateDir: string, repos: Set<string>): boolean {
	return writeRepoSet(stateDir, EPHEMERAL_FILE, repos);
}

/** Leading-`~` expansion (see `normalizeRepoPath`'s live-finding comment). Exported so the agent
 *  spawn path (squad-manager) can apply the same defense to repo paths that reach it WITHOUT going
 *  through the registry (older persisted state, direct API callers).
 *  @substrate exported for tests + the spawn-path defense described above; the in-file
 *  `normalizeRepoPath` is the current production caller. */
export function expandHomePath(p2: string): string {
	if (p2 === "~") return os.homedir();
	if (p2.startsWith("~/")) return path.join(os.homedir(), p2.slice(2));
	return p2;
}

/**
 * Normalize a repo root to the key everything else uses: `AgentDTO.repo` and `FeatureDTO.repo` are
 * absolute paths, and `ProjectDTO.id` IS the repo path, so the union in `projects()` only collapses if
 * both sides agree on the exact string. Trailing slashes and `.`/`..` segments are removed; a relative
 * path is rejected by the caller (see `registerProject`), never silently resolved against the daemon's
 * cwd — that cwd is an accident of how the operator launched it.
 */
export function normalizeRepoPath(repo: string): string {
	// Live finding 2026-07-15: a project registered as `~/sui/omp-graph` (literal tilde — shells
	// expand it, nothing else does) rode all the way into an agent's spawn cwd, where posix_spawn
	// ENOENT'd on the un-expanded path and the console agent error-looped for an afternoon. Expand
	// a leading `~/` (or bare `~`) to the daemon user's home BEFORE normalizing, so the tilde form
	// and the absolute form collapse to the same registry key and every downstream consumer
	// (AgentDTO.repo, spawn cwd) sees a real path.
	const expanded = expandHomePath(repo.trim());
	const normalized = path.normalize(expanded);
	const stripped = normalized.replace(/\/+$/, "");
	// `"/"` normalizes to `""` under a naive trailing-slash strip, and an empty key reads as "repo is
	// required" — a nonsense error for a real (if bizarre) path. Preserve the filesystem root; the git
	// validation downstream is what should reject it. (gpt-5.6-sol)
	return stripped.length > 0 ? stripped : normalized.startsWith("/") ? "/" : stripped;
}

/**
 * A failed `writeDurableSync` is NOT proof that nothing was written: the local backend can rename the
 * temp file successfully and then throw while fsyncing the directory, leaving the new set on disk while
 * the caller sees an error. A naive in-memory rollback would then DISAGREE with disk, and the restart
 * would resurrect a registration we told the operator had failed. Re-read disk and believe it — that is
 * the only state that survives. (gpt-5.6-sol)
 */
function resyncFromDisk(stateDir: string, repos: Set<string>): void {
	const onDisk = readRepos(stateDir);
	repos.clear();
	for (const r of onDisk) repos.add(r);
}

export function openProjectRegistry(stateDir: string): ProjectRegistry {
	const repos = readRepos(stateDir);
	return {
		list() {
			return [...repos].sort();
		},
		has(repo) {
			return repos.has(normalizeRepoPath(repo));
		},
		add(repo) {
			const key = normalizeRepoPath(repo);
			if (!key) return "error";
			if (repos.has(key)) return "exists";
			repos.add(key);
			if (!writeRepos(stateDir, repos)) {
				resyncFromDisk(stateDir, repos);
				return "error";
			}
			return "added";
		},
		delete(repo) {
			const key = normalizeRepoPath(repo);
			if (!repos.has(key)) return "absent";
			repos.delete(key);
			if (!writeRepos(stateDir, repos)) {
				resyncFromDisk(stateDir, repos);
				return "error";
			}
			return "removed";
		},
	};
}

/**
 * Presence / claim registry — "who or what is working on this repo right now?"
 *
 * The missing primitive behind cross-agent coordination: ANY agent — a
 * squad-managed worktree agent OR a raw `omp` session (via presence-hook.ts) —
 * writes a claim when it starts working a directory, heartbeats while alive, and
 * releases on exit. Anyone can ask `who(repo)` before starting, so two agents
 * don't unknowingly work the same tree.
 *
 * Storage is machine-wide and collision-safe by construction: ONE JSON file per
 * claim under ~/.omp/squad/presence/<repo-hash>/<id>.json, so concurrent writers
 * never clobber a shared file. A claim is "live" only if heartbeated within TTL;
 * stale files are ignored and opportunistically pruned.
 *
 * Standalone CLI (zero deps on the rest of omp-squad):
 *   bun src/presence.ts who [repo]   list live claims for a repo (default: cwd)
 *   bun src/presence.ts list         list every live claim, grouped by repo
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const PRESENCE_TTL_MS = 90_000;

const ROOT = path.join(os.homedir(), ".omp", "squad", "presence");

export interface PresenceEntry {
	/** Unique claim id (one file). */
	id: string;
	/** Absolute repo/working directory being worked. */
	repo: string;
	repoName: string;
	/** Human operator (OS user / OMP_SQUAD_OPERATOR). */
	operator: string;
	/** Agent/session label (e.g. squad agent name, or "omp:<sessionId>"). */
	agent: string;
	pid: number;
	host: string;
	branch?: string;
	task?: string;
	/** Where the claim came from. */
	source: "squad" | "omp" | "other";
	/** True if the daemon reattached to this agent's surviving host after a restart/upgrade. */
	reattached?: boolean;
	startedAt: number;
	heartbeat: number;
}

export interface ClaimInput {
	repo: string;
	operator?: string;
	agent: string;
	branch?: string;
	task?: string;
	reattached?: boolean;
	source?: PresenceEntry["source"];
	/** Provide to update an existing claim; omit to mint a new one. */
	id?: string;
}

function repoKey(repo: string): string {
	return createHash("sha1").update(path.resolve(repo)).digest("hex").slice(0, 16);
}

function dirFor(repo: string): string {
	return path.join(ROOT, repoKey(repo));
}

function isEntry(value: unknown): value is PresenceEntry {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return typeof v.id === "string" && typeof v.repo === "string" && typeof v.heartbeat === "number" && typeof v.pid === "number";
}

/** Create or refresh a claim. Returns the claim id (mint a new one if not given). */
export async function claim(input: ClaimInput): Promise<string> {
	const id = input.id ?? `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
	const now = Date.now();
	const dir = dirFor(input.repo);
	await fsp.mkdir(dir, { recursive: true });
	const file = path.join(dir, `${id}.json`);
	let startedAt = now;
	try {
		const prev: unknown = JSON.parse(await fsp.readFile(file, "utf8"));
		if (isEntry(prev)) startedAt = prev.startedAt;
	} catch {
		/* new claim */
	}
	const entry: PresenceEntry = {
		id,
		repo: path.resolve(input.repo),
		repoName: path.basename(path.resolve(input.repo)) || input.repo,
		operator: input.operator ?? process.env.OMP_SQUAD_OPERATOR ?? os.userInfo().username ?? "unknown",
		agent: input.agent,
		pid: process.pid,
		host: os.hostname(),
		branch: input.branch,
		task: input.task,
		source: input.source ?? "other",
		reattached: input.reattached,
		startedAt,
		heartbeat: now,
	};
	await fsp.writeFile(file, JSON.stringify(entry));
	return id;
}

export async function heartbeat(id: string, repo: string): Promise<void> {
	const file = path.join(dirFor(repo), `${id}.json`);
	try {
		const cur: unknown = JSON.parse(await fsp.readFile(file, "utf8"));
		if (!isEntry(cur)) return;
		cur.heartbeat = Date.now();
		await fsp.writeFile(file, JSON.stringify(cur));
	} catch {
		/* claim gone — caller may re-claim */
	}
}

export async function release(id: string, repo: string): Promise<void> {
	await fsp.rm(path.join(dirFor(repo), `${id}.json`), { force: true }).catch(() => {});
}

async function readDir(dir: string, ttlMs: number): Promise<PresenceEntry[]> {
	let names: string[];
	try {
		names = await fsp.readdir(dir);
	} catch {
		return [];
	}
	const cutoff = Date.now() - ttlMs;
	const live: PresenceEntry[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const file = path.join(dir, name);
		try {
			const parsed: unknown = JSON.parse(await fsp.readFile(file, "utf8"));
			if (isEntry(parsed) && parsed.heartbeat >= cutoff) live.push(parsed);
			else if (isEntry(parsed)) await fsp.rm(file, { force: true }).catch(() => {});
		} catch {
			/* skip unreadable */
		}
	}
	return live.sort((a, b) => b.heartbeat - a.heartbeat);
}

/** Live claims for one repo. */
export async function who(repo: string, ttlMs = PRESENCE_TTL_MS): Promise<PresenceEntry[]> {
	return readDir(dirFor(repo), ttlMs);
}

/** Every live claim across all repos. */
export async function all(ttlMs = PRESENCE_TTL_MS): Promise<PresenceEntry[]> {
	let keys: string[];
	try {
		keys = await fsp.readdir(ROOT);
	} catch {
		return [];
	}
	const out: PresenceEntry[] = [];
	for (const key of keys) out.push(...(await readDir(path.join(ROOT, key), ttlMs)));
	return out.sort((a, b) => b.heartbeat - a.heartbeat);
}

function ago(ts: number): string {
	const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	return `${Math.round(s / 3600)}h ago`;
}

function printEntries(entries: PresenceEntry[]): void {
	for (const e of entries) {
		const where = e.branch ? ` (${e.branch})` : "";
		const task = e.task ? ` — ${e.task.replace(/\s+/g, " ").slice(0, 60)}` : "";
		process.stdout.write(`  ${e.source.padEnd(5)} ${e.operator}/${e.agent}${where}  pid ${e.pid} · ${ago(e.heartbeat)}${task}\n`);
	}
}

if (import.meta.main) {
	const [cmd, arg] = process.argv.slice(2);
	if (cmd === "list") {
		const entries = await all();
		if (!entries.length) process.stdout.write("no active agents\n");
		const byRepo = new Map<string, PresenceEntry[]>();
		for (const e of entries) byRepo.set(e.repo, [...(byRepo.get(e.repo) ?? []), e]);
		for (const [repo, es] of byRepo) {
			process.stdout.write(`${es[0].repoName}  ${repo}\n`);
			printEntries(es);
		}
	} else {
		const repo = arg ?? process.cwd();
		const entries = await who(repo);
		process.stdout.write(entries.length ? `${entries.length} active on ${path.resolve(repo)}:\n` : `nobody is working on ${path.resolve(repo)}\n`);
		printEntries(entries);
	}
}

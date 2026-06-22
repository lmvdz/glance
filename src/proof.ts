/**
 * Land proof — a feature must not land on the word of an AI summary. `runProof` runs a
 * deterministic acceptance command IN the worktree and records the result keyed to the
 * worktree's HEAD commit; the land gate (`proofGate`) refuses to merge unless that proof
 * is FRESH: it passed, against the exact commit being landed. Screenshots written under
 * <worktree>/.omp/proof/ are collected as vision evidence — they are attached, never gate.
 *
 * Collision-safe storage mirrors leases/presence: one JSON per worktree under
 * ~/.omp/squad/proof/<repo-hash>/<worktree-hash>.json.
 */

import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runVisionPass, type VisionProducer } from "./vision.ts";
import { GIT_HARDEN_ARGS, GIT_HARDEN_ENV } from "./git-harden.ts";

const ROOT = path.join(os.homedir(), ".omp", "squad", "proof");

export interface Proof {
	/** Acceptance command exited 0. */
	ok: boolean;
	/** Worktree HEAD the proof ran against — the proof is stale once HEAD moves past it. */
	commit: string;
	/** The acceptance command that ran. */
	command: string;
	ranAt: number;
	/** Output tail, for the panel / debugging. */
	detail: string;
	/** Screenshot paths collected from <worktree>/.omp/proof/ — vision evidence. */
	artifacts: string[];
}

function fileFor(repo: string, worktree: string): { dir: string; file: string } {
	const dir = path.join(ROOT, createHash("sha1").update(path.resolve(repo)).digest("hex").slice(0, 16));
	const id = createHash("sha1").update(path.resolve(worktree)).digest("hex").slice(0, 20);
	return { dir, file: path.join(dir, `${id}.json`) };
}

async function gitOut(args: string[], cwd: string): Promise<string> {
	// ponytail: untrusted repo config can exec code via core.fsmonitor/diff.external/hooks/pager — these neutralize it.
	const proc = Bun.spawn(["git", ...GIT_HARDEN_ARGS, ...args], { cwd, env: { ...process.env, ...GIT_HARDEN_ENV }, stdout: "pipe", stderr: "ignore" });
	const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	return out.trim();
}

/** Current HEAD of a worktree, or "" when it isn't a repo. */
export async function headCommit(worktree: string): Promise<string> {
	return gitOut(["rev-parse", "HEAD"], worktree).catch(() => "");
}

function isProof(v: unknown): v is Proof {
	if (!v || typeof v !== "object") return false;
	const p = v as Record<string, unknown>;
	return typeof p.ok === "boolean" && typeof p.commit === "string" && typeof p.ranAt === "number";
}

/** The recorded proof for a worktree, or undefined. */
export async function proofFor(repo: string, worktree: string): Promise<Proof | undefined> {
	try {
		const p: unknown = JSON.parse(await fsp.readFile(fileFor(repo, worktree).file, "utf8"));
		return isProof(p) ? p : undefined;
	} catch {
		return undefined;
	}
}

/** A proof may gate a land only if it passed AND ran against the commit being landed. */
export function isFresh(proof: Proof | undefined, head: string): boolean {
	return !!proof && proof.ok && head !== "" && proof.commit === head;
}

/** Proofs older than this are for a landed/abandoned worktree — swept so per-worktree dirs don't pile up. */
const PROOF_TTL_MS = 24 * 60 * 60 * 1000;

/** Remove proof records older than `maxAgeMs` and any now-empty repo dirs. Returns records removed. */
export async function sweepProofs(maxAgeMs = PROOF_TTL_MS): Promise<number> {
	let repoDirs: string[];
	try {
		repoDirs = await fsp.readdir(ROOT);
	} catch {
		return 0;
	}
	const cutoff = Date.now() - maxAgeMs;
	let removed = 0;
	for (const rd of repoDirs) {
		const dir = path.join(ROOT, rd);
		let files: string[];
		try {
			files = await fsp.readdir(dir);
		} catch {
			continue;
		}
		let live = 0;
		for (const f of files) {
			if (!f.endsWith(".json")) continue;
			const file = path.join(dir, f);
			try {
				const p: unknown = JSON.parse(await fsp.readFile(file, "utf8"));
				if (isProof(p) && p.ranAt >= cutoff) { live++; continue; }
				await fsp.rm(file, { force: true });
				removed++;
			} catch {
				/* skip unreadable */
			}
		}
		if (live === 0) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
	return removed;
}

/** Screenshots under <worktree>/.omp/proof/ — vision evidence attached to the proof. */
async function collectArtifacts(worktree: string): Promise<string[]> {
	const dir = path.join(worktree, ".omp", "proof");
	try {
		const out: string[] = [];
		for await (const rel of new Bun.Glob("**/*.{png,jpg,jpeg,webp,gif}").scan({ cwd: dir })) out.push(path.join(dir, rel));
		return out.sort();
	} catch {
		return [];
	}
}

/**
 * Run the acceptance command in the worktree, collect evidence, persist + return the proof.
 *
 * `ok`/`commit` are the gate — derived solely from the deterministic command and HEAD. The
 * optional browser-vision pass (off unless `visionUrl` or env `OMP_SQUAD_APP_URL` is set) only
 * appends evidence to `artifacts`; it can never flip the gate.
 */
export async function runProof(opts: { repo: string; worktree: string; command: string; visionUrl?: string; producer?: VisionProducer }): Promise<Proof> {
	// Total by contract: a missing worktree (reaped / never created) or any spawn failure yields a
	// FAILED proof, never a throw — an unhandled rejection here crashes the daemon's orchestrator tick.
	let out = "";
	let err = "";
	let code = 1;
	try {
		if (!existsSync(opts.worktree)) throw new Error(`worktree missing: ${opts.worktree}`);
		const proc = Bun.spawn(["bash", "-lc", opts.command], { cwd: opts.worktree, stdout: "pipe", stderr: "pipe" });
		const [o, e, c] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		out = o;
		err = e;
		code = c;
	} catch (spawnErr) {
		err = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
		code = 1;
	}
	const tail = `${out}\n${err}`.trim().split("\n").slice(-20).join("\n");
	const proof: Proof = {
		ok: code === 0,
		commit: await headCommit(opts.worktree),
		command: opts.command,
		ranAt: Date.now(),
		detail: tail.slice(0, 4000),
		artifacts: await collectArtifacts(opts.worktree),
	};
	// Optional, evidence-only browser-vision pass. Never touches the gate fields above — it only
	// merges its screenshots/notes into artifacts (deduped, since collectArtifacts may already
	// hold screenshots a prior vision run left under .omp/proof/vision/).
	const url = opts.visionUrl ?? process.env.OMP_SQUAD_APP_URL;
	if (url) {
		const shots = await runVisionPass({ worktree: opts.worktree, url, producer: opts.producer });
		proof.artifacts = [...new Set([...proof.artifacts, ...shots])].sort();
	}
	const { dir, file } = fileFor(opts.repo, opts.worktree);
	await fsp.mkdir(dir, { recursive: true });
	await fsp.writeFile(file, JSON.stringify(proof));
	return proof;
}

/** Gate one branch's land: undefined ⇒ clear to land, else a human-readable reason to block. */
export async function proofGate(repo: string, worktree: string, branch?: string): Promise<string | undefined> {
	// In-place agents (no branch, or worktree === repo) have nothing to merge — nothing to prove.
	if (!branch || path.resolve(worktree) === path.resolve(repo)) return undefined;
	const proof = await proofFor(repo, worktree);
	if (isFresh(proof, await headCommit(worktree))) return undefined;
	if (!proof) return "no proof — run Verify before landing (or force)";
	if (!proof.ok) return "last proof FAILED — fix and re-verify before landing (or force)";
	return "proof is stale (new commits since it ran) — re-verify before landing (or force)";
}

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
import * as os from "node:os";
import * as path from "node:path";

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
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
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

/** Run the acceptance command in the worktree, collect evidence, persist + return the proof. */
export async function runProof(opts: { repo: string; worktree: string; command: string }): Promise<Proof> {
	const proc = Bun.spawn(["bash", "-lc", opts.command], { cwd: opts.worktree, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	const tail = `${out}\n${err}`.trim().split("\n").slice(-20).join("\n");
	const proof: Proof = {
		ok: code === 0,
		commit: await headCommit(opts.worktree),
		command: opts.command,
		ranAt: Date.now(),
		detail: tail.slice(0, 4000),
		artifacts: await collectArtifacts(opts.worktree),
	};
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

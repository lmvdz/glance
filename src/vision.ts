/**
 * Browser-vision evidence — an OPTIONAL, autonomous pass that opens the running app in a
 * browser, captures a few screenshots and a short notes.md, and returns the artifact paths.
 *
 * EVIDENCE ONLY. This NEVER gates a land: the deterministic acceptance command in proof.ts
 * stays the sole gate (`ok`/`commit`/`isFresh`). Vision artifacts are merged into
 * `proof.artifacts` for the reviewer / panel and nothing else.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { gitNoSignEnv } from "./git-harden.ts";
import { harnessAuthEnv, scrubbedSpawnEnv } from "./spawn-env.ts";

/** Drives a browser against `url`, leaving screenshots + notes.md under `dir`. Injectable so
 *  tests need no real omp/browser; the default spawns a one-shot `omp -p`. */
export type VisionProducer = (ctx: { worktree: string; url: string; dir: string }) => Promise<void>;

/** A vision agent gets one bounded shot — it's evidence, not a gate, so we cap the wall clock. */
const VISION_TIMEOUT_MS = 180_000;

/**
 * Default producer: a one-shot `omp -p` agent with browser tools, pointed at the vision dir.
 *
 * ponytail: best-effort LLM observer — its screenshots/notes are evidence, never a gate. A
 * missing `omp`, a missing browser, a non-zero exit, or the timeout simply leaves fewer (or
 * zero) artifacts; the deterministic proof is untouched. Ceiling: no retry, no model knob.
 */
const ompProducer: VisionProducer = async ({ worktree, url, dir }) => {
	const prompt =
		`Open ${url} in a browser and act as a QA observer. ` +
		`Take 2-4 screenshots of the main views and save them as PNG files into ${dir}. ` +
		`Then write ${path.join(dir, "notes.md")} as a short bullet list of what you saw — does the page ` +
		`load, are the main elements present, any obvious visual breakage. ` +
		`You are EVIDENCE ONLY: do not pass or fail anything. Be brief.`;
	// This agent opens the worktree's own repo content in a browser — scrub the daemon's secrets
	// from its env like every other tenant-agent omp spawn (spawn-env.ts). Always the `omp` harness
	// (hardcoded argv[0] below) — narrow harnessAuthEnv() to it explicitly.
	const proc = Bun.spawn(["omp", "-p", "--approval-mode", "yolo", prompt], {
		cwd: worktree,
		stdout: "ignore",
		stderr: "ignore",
		env: scrubbedSpawnEnv(process.env, { ...gitNoSignEnv(), ...harnessAuthEnv(process.env, "omp") }),
		signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
	});
	await proc.exited;
};

/** Every file the producer left under the vision dir (screenshots + notes), sorted. */
async function collect(dir: string): Promise<string[]> {
	try {
		const out: string[] = [];
		for await (const rel of new Bun.Glob("**/*").scan({ cwd: dir })) out.push(path.join(dir, rel));
		return out.sort();
	} catch {
		return [];
	}
}

/**
 * Run the browser-vision evidence pass for a worktree. Best-effort: never throws. Returns the
 * artifact paths (screenshots + notes.md) found under <worktree>/.omp/proof/vision/ after the
 * producer ran, or [] on any failure.
 */
export async function runVisionPass(opts: { worktree: string; url: string; producer?: VisionProducer }): Promise<string[]> {
	const dir = path.join(opts.worktree, ".omp", "proof", "vision");
	try {
		await fsp.mkdir(dir, { recursive: true });
		await (opts.producer ?? ompProducer)({ worktree: opts.worktree, url: opts.url, dir });
	} catch {
		/* best-effort: a producer failure leaves whatever it managed to write */
	}
	return collect(dir);
}

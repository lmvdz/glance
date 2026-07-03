/**
 * Shared helpers for one-shot `omp -p` calls and parsing their JSON output.
 * Deduped from intake.ts (ompClassify/extractDecision), smart-spawn.ts
 * (infer/parsePlanJson), and supervisor.ts (decide/extractJsonObject).
 */

import { gitNoSignEnv } from "./git-harden.ts";

const DEFAULT_TIMEOUT_MS = 1_000;

/**
 * Run a one-shot `omp` invocation and capture stdout. Never throws: a spawn
 * error or `timeoutMs` abort degrades to `{ out: "", code: 1 }`, so callers can
 * treat any non-zero `code` (or empty `out`) as failure uniformly.
 */
export async function ompOneShot(args: string[], opts: { bin?: string; timeoutMs?: number } = {}): Promise<{ out: string; code: number }> {
	const bin = opts.bin ?? "omp";
	if (!Bun.which(bin)) return { out: "", code: 1 };
	try {
		const proc = Bun.spawn([bin, ...args], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
			env: { ...process.env, ...gitNoSignEnv() },
			signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		});
		const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		return { out, code };
	} catch {
		return { out: "", code: 1 };
	}
}

/** Extract the outermost balanced-ish JSON object from noisy model output (handles ```json fences and stray prose). */
export function extractJsonObject(raw: string): Record<string, unknown> | undefined {
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	try {
		const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * One-shot omp decision with a guaranteed fallback. Runs `ompOneShot(args)`; on
 * non-zero exit / empty output / a parse that returns undefined, returns `fallback`.
 * `retries` (default 0 = today's single-shot behavior) adds bounded re-attempts
 * before the fallback — for transient model hiccups (BRIEF Pattern 6). Never throws.
 */
export async function decideTyped<T>(opts: {
	args: string[];
	parse: (raw: string) => T | undefined;
	fallback: T;
	bin?: string;
	timeoutMs?: number;
	retries?: number;
}): Promise<T> {
	const attempts = Math.max(1, 1 + (opts.retries ?? 0));
	for (let i = 0; i < attempts; i++) {
		const { out, code } = await ompOneShot(opts.args, { bin: opts.bin, timeoutMs: opts.timeoutMs });
		if (code === 0 && out) {
			const v = opts.parse(out);
			if (v !== undefined) return v;
		}
	}
	return opts.fallback;
}

/**
 * Shared helpers for one-shot `omp -p` calls and parsing their JSON output.
 * Deduped from intake.ts (ompClassify/extractDecision), smart-spawn.ts
 * (infer/parsePlanJson), and supervisor.ts (decide/extractJsonObject).
 */

/**
 * Run a one-shot `omp` invocation and capture stdout. Never throws: a spawn
 * error or `timeoutMs` abort degrades to `{ out: "", code: 1 }`, so callers can
 * treat any non-zero `code` (or empty `out`) as failure uniformly.
 */
export async function ompOneShot(args: string[], opts: { bin?: string; timeoutMs?: number } = {}): Promise<{ out: string; code: number }> {
	try {
		const proc = Bun.spawn([opts.bin ?? "omp", ...args], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
			env: { ...process.env },
			...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
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

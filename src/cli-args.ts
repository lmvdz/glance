/**
 * Shared CLI plumbing for glance verbs — flag parsing, the daemon base URL, and the persisted
 * bearer token. Extracted from index.ts so a long-lived client verb (`glance here`, src/here.ts)
 * can ride the exact same conventions without importing the whole CLI entrypoint, which would be
 * an import cycle (index.ts dispatches to here.ts).
 */

import * as path from "node:path";
import { readFileSync } from "node:fs";
import { resolveStateDir } from "./state-dir.ts";

export const DEFAULT_PORT = Number(process.env.OMP_SQUAD_PORT ?? 7878);

export interface ParsedArgs {
	positional: string[];
	flags: Record<string, string | boolean>;
}

export function parseArgs(args: string[]): ParsedArgs {
	const positional: string[] = [];
	const flags: Record<string, string | boolean> = {};
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags[key] = next;
				i++;
			} else {
				flags[key] = true;
			}
		} else {
			positional.push(a);
		}
	}
	return { positional, flags };
}

export function base(flags: Record<string, string | boolean>): string {
	const port = flags.port ? Number(flags.port) : DEFAULT_PORT;
	return `http://127.0.0.1:${port}`;
}

export function stateDirPath(): string {
	// Canonical resolution lives in state-dir.ts (shared with ttl-registry, worktrees, sockets, proof):
	// env override → ~/.glance if present → legacy ~/.omp/squad if present → ~/.glance for fresh installs.
	return resolveStateDir();
}

/** The persisted bearer token itself (empty when the daemon hasn't minted one yet). */
export function readAccessToken(): string {
	try {
		return readFileSync(path.join(stateDirPath(), "access-token"), "utf8").trim();
	} catch {
		return "";
	}
}

/** Authorization header for CLI→daemon calls, read from the persisted token (empty if the daemon has none). */
export function tokenHeader(): Record<string, string> {
	const t = readAccessToken();
	return t ? { Authorization: `Bearer ${t}` } : {};
}

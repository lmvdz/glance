/**
 * Load `~/.claude/secrets/plane.env` into the daemon's environment at startup, so
 * Plane is configured for the squad straight from the shared secret — no manual
 * `source` before `omp-squad up`. plane.ts reads the result via process.env.
 *
 * Parses shell `export KEY="VALUE"` lines (the format the secret file uses).
 * Existing env always wins, so an explicit `PLANE_*=…` on the daemon overrides the
 * file. ponytail: plain line parse, not a full shell — fine for a KEY=VALUE secret;
 * upgrade to a dotenv lib only if the file grows shell logic.
 */
import { existsSync, readFileSync } from "node:fs";

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** Load KEY=VALUE pairs from a secret env file into process.env (without overriding existing). Returns the keys set. */
export function loadEnvFile(file: string): string[] {
	if (!existsSync(file)) return [];
	const set: string[] = [];
	for (const raw of readFileSync(file, "utf8").split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const m = LINE.exec(line);
		if (!m) continue;
		const key = m[1];
		let val = m[2].trim();
		// strip a trailing inline comment only for an unquoted value
		if (!/^["']/.test(val)) val = val.replace(/\s+#.*$/, "").trim();
		// strip matching surrounding quotes
		if (val.length >= 2 && (val[0] === '"' || val[0] === "'") && val[val.length - 1] === val[0]) val = val.slice(1, -1);
		if (process.env[key] === undefined) {
			process.env[key] = val;
			set.push(key);
		}
	}
	return set;
}

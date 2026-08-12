/**
 * Where a TenantGateManifest LIVES — glance-side, per-org, human-registered.
 *
 * One JSON per state dir (`<stateDir>/tenant-gates.json`), the same tiny-JSON-set shape
 * `project-registry.ts` / `dispatch-ledger.ts` use. Per-stateDir is per-ORG by construction:
 * `ManagerRegistry` gives each org its own `stateDir = <root>/orgs/<orgId>` in DB mode, and file
 * mode has exactly one. That is what ends the daemon-global gate policy R2 found at
 * gate-runner.ts's `process.env` reads — tenant A can demand hermetic gates while tenant B stays
 * on detection, because the record is not shared.
 *
 * READ-THROUGH ON EVERY LOOKUP, deliberately. `project-registry.ts` caches its set in memory
 * because a missed registration there means a repo is absent from a sidebar. A missed registration
 * HERE means a gated tenant is gated by DETECTION instead of by its contract — a fail-open, and the
 * exact defect class this whole ticket closes. The file is small and gates are not a hot path, so
 * the safe read wins over the cheap one.
 *
 * A corrupt or wrong-shaped record does NOT silently degrade to "unregistered". `get` distinguishes
 * the three states — no record, a good record, an unreadable record — because collapsing the third
 * into the first would mean a tenant's gates vanish the moment someone hand-edits the file badly.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Result, Schema } from "effect";
import { getStorageBackend } from "./dal/storage.ts";
import { normalizeRepoPath } from "./project-registry.ts";
import { decodeTenantGateManifest, type TenantGateManifest } from "./tenant-gates.ts";

const FILE = "tenant-gates.json";

/**
 * Registration INPUT a tenant repo may ship. Read only by a human-driven registration flow, NEVER
 * at land time — see the authority note in tenant-gates.ts. Named so its role is unmistakable in a
 * grep: a file under the tenant's own control, imported once, approved by a person.
 */
export const TENANT_MANIFEST_INPUT_PATH = path.join(".glance", "gates.json");

/** The record's on-disk shape: `{ "<repo path>": <manifest> }`. Members are decoded individually. */
const StoredSchema = Schema.Record(Schema.String, Schema.Unknown);
const decodeStored = Schema.decodeUnknownResult(StoredSchema);

/** `undefined` ⇒ no manifest registered for this repo. `{ error }` ⇒ a record exists but is broken. */
export type ManifestLookup = { manifest: TenantGateManifest } | { error: string } | undefined;

export interface TenantGateRegistry {
	/** The registered contract for `repo`, a decode error, or undefined when unregistered. */
	get(repo: string): ManifestLookup;
	/** Registered repo roots, sorted. Never throws. */
	repos(): string[];
	/** Idempotent overwrite. `"error"` ⇒ nothing was persisted. */
	register(manifest: TenantGateManifest): "registered" | "invalid" | "error";
	unregister(repo: string): "removed" | "absent" | "error";
	/** Absolute path of the backing record — for doctor output and operator messages. */
	file(): string;
}

function readAll(file: string): Record<string, unknown> {
	try {
		const b = getStorageBackend();
		if (!b.exists(file)) return {};
		const raw = b.readTextSync(file);
		if (raw === undefined) return {};
		const parsed: unknown = JSON.parse(raw);
		const decoded = decodeStored(parsed);
		return Result.isSuccess(decoded) ? { ...decoded.success } : {};
	} catch {
		return {}; // unreadable file ⇒ nothing registered; individual bad RECORDS still surface via get()
	}
}

function writeAll(file: string, all: Record<string, unknown>): boolean {
	try {
		const sorted = Object.fromEntries(Object.entries(all).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
		getStorageBackend().writeDurableSync(file, JSON.stringify(sorted, null, 2));
		return true;
	} catch {
		return false;
	}
}

export function openTenantGateRegistry(stateDir: string): TenantGateRegistry {
	const file = path.join(stateDir, FILE);
	return {
		file() {
			return file;
		},
		get(repo) {
			const key = normalizeRepoPath(repo);
			const raw = readAll(file)[key];
			if (raw === undefined) return undefined;
			const decoded = decodeTenantGateManifest(raw);
			if ("error" in decoded) return { error: `registered manifest for ${key} is unusable: ${decoded.error}` };
			// A record filed under one repo but naming another is a mis-registration, not a contract —
			// honoring it would gate repo A with repo B's counts.
			if (normalizeRepoPath(decoded.manifest.repo) !== key) {
				return { error: `registered manifest under ${key} declares repo ${decoded.manifest.repo} — refusing to gate a repo with another repo's contract` };
			}
			return decoded;
		},
		repos() {
			return Object.keys(readAll(file)).sort();
		},
		register(manifest) {
			const key = normalizeRepoPath(manifest.repo);
			if (!key) return "invalid";
			const check = decodeTenantGateManifest(manifest);
			if ("error" in check) return "invalid";
			const all = readAll(file);
			all[key] = { ...manifest, repo: key };
			return writeAll(file, all) ? "registered" : "error";
		},
		unregister(repo) {
			const key = normalizeRepoPath(repo);
			const all = readAll(file);
			if (!(key in all)) return "absent";
			delete all[key];
			return writeAll(file, all) ? "removed" : "error";
		},
	};
}

/**
 * Read a tenant repo's own `.glance/gates.json` as REGISTRATION INPUT. Returns undefined when the
 * repo ships none. The `repo` field is forced to the caller's repo root so an imported file cannot
 * claim to govern a different checkout.
 *
 * This is the ONLY function in the codebase that reads a gate contract out of a tenant repo, and no
 * land path calls it — that separation is the authority decision, made grep-visible.
 */
export async function readTenantManifestInput(repo: string): Promise<{ manifest: TenantGateManifest } | { error: string } | undefined> {
	const file = path.join(repo, TENANT_MANIFEST_INPUT_PATH);
	let raw: string;
	try {
		raw = await fs.readFile(file, "utf8");
	} catch (e) {
		if ((e as { code?: string }).code === "ENOENT") return undefined;
		return { error: `${file} is unreadable: ${String(e)}`.slice(0, 300) };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { error: `${file} is not valid JSON` };
	}
	const withRepo = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...(parsed as Record<string, unknown>), repo: normalizeRepoPath(repo) } : parsed;
	return decodeTenantGateManifest(withRepo);
}

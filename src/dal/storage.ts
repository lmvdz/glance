/**
 * Pluggable STORAGE BACKEND — the swappable substrate under omp-squad's durable org state
 * (plans/archive/archil-mt-pilot/ "OrgStorage/ArchilStorage" payoff, built here WITHOUT Archil).
 *
 * The daemon's authoritative state — the roster/feature `state.json`, transcripts, feedback, runtime
 * settings, policy rules, run receipts, and land proofs — is written and read exclusively through a
 * `StorageBackend`. Today that backend is `LocalStorageBackend` (the local filesystem, byte-identical
 * to the prior direct-fs behavior). A different substrate — an Archil shared/branchable mount, S3, a
 * networked FS — becomes a drop-in by implementing this ONE interface and calling `setStorageBackend`
 * at boot; not a single call site changes.
 *
 * Scope of the seam (deliberate): the DAEMON's durable blob state, keyed by absolute path (so per-org
 * roots are encoded in the path, not the backend instance). NOT in scope: git worktrees (real fs paths
 * git operates on directly — an Archil deployment mounts them, it doesn't proxy them), and agent-process
 * reads (a separate process reads the mounted disk directly). Non-authoritative logs/caches/cursors
 * still use raw fs and can migrate to these helpers incrementally.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Options for a durable write. `mode` sets the created file's permission bits (e.g. 0o600 for a
 *  secret) — a temp+rename otherwise lands at the default 0644 and would leak a token/key. */
export interface WriteOpts {
	mode?: number;
}

export interface StorageBackend {
	/** Short identifier for logs / diagnostics (e.g. "local", "archil"). */
	readonly name: string;
	/** Atomically + durably write `data` to `file` (survives a host crash). */
	writeDurable(file: string, data: string, opts?: WriteOpts): Promise<void>;
	/** Synchronous durable write — for the single-daemon state ledgers that persist inline on a sync
	 *  path and can't await. A non-filesystem backend (pure remote API) may not support this. */
	writeDurableSync(file: string, data: string, opts?: WriteOpts): void;
	/** Append `data` to `file` durably (fsync'd) — for NDJSON ledgers like receipts. */
	appendDurable(file: string, data: string): Promise<void>;
	/** Read `file` as UTF-8, or `undefined` if it doesn't exist / can't be read. */
	readText(file: string): Promise<string | undefined>;
	/** Synchronous read for daemon-side callers that can't await; `undefined` on any error. */
	readTextSync(file: string): string | undefined;
	/** Directory entries (names only), or `[]` when the dir is missing. */
	readdir(dir: string): Promise<string[]>;
	/** Recursively remove a file or dir; a no-op when absent. */
	remove(target: string): Promise<void>;
	/** Recursively create a directory. */
	mkdir(dir: string): Promise<void>;
	/** Whether a path exists (sync — mirrors `existsSync`). */
	exists(file: string): boolean;
}

/** Codes on which the directory-fd fsync (the rename barrier) is skipped — some FUSE mounts reject
 *  opening a dir for fsync. The file-bytes fsync still holds. */
const DIR_FSYNC_TOLERATED = new Set(["EISDIR", "EINVAL", "EBADF", "EPERM", "ENOTSUP"]);

/** The default backend: the local filesystem, behavior-identical to the prior direct-fs persistence. */
export class LocalStorageBackend implements StorageBackend {
	readonly name = "local";

	async writeDurable(file: string, data: string, opts?: WriteOpts): Promise<void> {
		const dir = path.dirname(file);
		await fs.mkdir(dir, { recursive: true });
		const tmp = `${file}.tmp`;
		try {
			const fh = await fs.open(tmp, "w", opts?.mode);
			try {
				await fh.writeFile(data);
				await fh.sync(); // fsync the file's bytes before the rename
			} finally {
				await fh.close();
			}
			await fs.rename(tmp, file);
		} catch (err) {
			await fs.rm(tmp, { force: true }).catch(() => {});
			throw err;
		}
		// fsync the directory so the rename entry itself is durable.
		try {
			const dfh = await fs.open(dir, "r");
			try {
				await dfh.sync();
			} finally {
				await dfh.close();
			}
		} catch (err) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code && !DIR_FSYNC_TOLERATED.has(code)) throw err;
		}
	}

	writeDurableSync(file: string, data: string, opts?: WriteOpts): void {
		const dir = path.dirname(file);
		mkdirSync(dir, { recursive: true });
		const tmp = `${file}.tmp`;
		try {
			const fd = openSync(tmp, "w", opts?.mode);
			try {
				writeSync(fd, data);
				fsyncSync(fd); // fsync the bytes before the rename
			} finally {
				closeSync(fd);
			}
			renameSync(tmp, file);
		} catch (err) {
			try {
				rmSync(tmp, { force: true });
			} catch {
				/* best-effort */
			}
			throw err;
		}
		try {
			const dfd = openSync(dir, "r");
			try {
				fsyncSync(dfd);
			} finally {
				closeSync(dfd);
			}
		} catch (err) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code && !DIR_FSYNC_TOLERATED.has(code)) throw err;
		}
	}

	async appendDurable(file: string, data: string): Promise<void> {
		await fs.mkdir(path.dirname(file), { recursive: true });
		const fh = await fs.open(file, "a");
		try {
			await fh.writeFile(data);
			await fh.sync();
		} finally {
			await fh.close();
		}
	}

	async readText(file: string): Promise<string | undefined> {
		try {
			return await fs.readFile(file, "utf8");
		} catch {
			return undefined;
		}
	}

	readTextSync(file: string): string | undefined {
		try {
			return readFileSync(file, "utf8");
		} catch {
			return undefined;
		}
	}

	async readdir(dir: string): Promise<string[]> {
		try {
			return await fs.readdir(dir);
		} catch {
			return [];
		}
	}

	async remove(target: string): Promise<void> {
		await fs.rm(target, { recursive: true, force: true });
	}

	async mkdir(dir: string): Promise<void> {
		await fs.mkdir(dir, { recursive: true });
	}

	exists(file: string): boolean {
		return existsSync(file);
	}
}

/**
 * ArchilStorage drop-in point (plans/archive/archil-mt-pilot/). Implementing these methods against an
 * Archil shared/branchable mount — plus the mount lifecycle the pilot's green-light follow-up owns
 * (keep-mounted-for-daemon-lifetime, acquire rollback, mount-ready barrier, token source) — swaps the
 * whole durable substrate with no call-site changes. Intentionally NOT implemented: the pilot's gate
 * (collaboration/consistency characterization on a provisioned disk) hasn't run, so wiring live Archil
 * ops here would be an unvalidated integration against a paid, unprovisioned dependency. It fails LOUD
 * rather than silently degrading, so a misconfiguration can never look like it's persisting.
 */
export class ArchilStorageBackend implements StorageBackend {
	readonly name = "archil";
	private nope(): never {
		throw new Error(
			"ArchilStorageBackend is not provisioned — the Archil pilot's GO/NO-GO gate (plans/archive/archil-mt-pilot/ concern 02) has not run. " +
				"Provision an Archil disk + ARCHIL_* creds and implement the mount-backed ops, or run with the default local backend.",
		);
	}
	// async methods REJECT (not throw synchronously) so callers' `.catch`/`await` see a normal failure.
	async writeDurable(): Promise<void> {
		this.nope();
	}
	writeDurableSync(): void {
		this.nope();
	}
	async appendDurable(): Promise<void> {
		this.nope();
	}
	async readText(): Promise<string | undefined> {
		this.nope();
	}
	async readdir(): Promise<string[]> {
		this.nope();
	}
	async remove(): Promise<void> {
		this.nope();
	}
	async mkdir(): Promise<void> {
		this.nope();
	}
	// sync methods throw synchronously (there is no promise to reject).
	readTextSync(): string | undefined {
		this.nope();
	}
	exists(): boolean {
		this.nope();
	}
}

let active: StorageBackend = new LocalStorageBackend();

/** Swap the process-wide durable-storage backend (call once at daemon boot, before any persistence). */
export function setStorageBackend(backend: StorageBackend): void {
	active = backend;
}

/** The active backend — every durable read/write routes through this. */
export function getStorageBackend(): StorageBackend {
	return active;
}

/**
 * Select a backend from `OMP_SQUAD_STORAGE_BACKEND` (`local` default | `archil`). The daemon calls this
 * at boot. `archil` returns the loud-failing stub until the pilot's follow-up implements it — so the
 * knob documents the swap point without pretending Archil works.
 */
export function backendFromEnv(env: NodeJS.ProcessEnv = process.env): StorageBackend {
	return env.OMP_SQUAD_STORAGE_BACKEND === "archil" ? new ArchilStorageBackend() : new LocalStorageBackend();
}

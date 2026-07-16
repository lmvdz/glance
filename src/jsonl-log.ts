/**
 * JsonlLog<T> — a small ring+spool JSONL log, generalized from automation-log.ts's idiom
 * (capped in-memory ring, serialized fire-and-forget append, torn-line-skipping hydrate)
 * for reuse by transitions.jsonl. automation-log.ts is NOT refactored to use this — that
 * subsystem's spool is entangled with isMeaningful filtering and stays as-is; unify later
 * if a third consumer appears.
 *
 * Consistency contract: the RING is authoritative for the tail (what recent() returns);
 * the FILE is best-effort (a failed write is logged once per failure episode, never thrown
 * into the caller). A caller that needs the full persisted history reads the file directly
 * (see hydrateAll below) — recent() never does file I/O.
 *
 * Rotation: when the file exceeds `maxBytes`, it is renamed to `<path>.1` (clobbering any
 * previous `.1`) and a fresh file started. `hydrateAll()` reads `<path>.1` then `<path>`, so a
 * "full history" caller sees across one rotation boundary — but this log is NOT a durable
 * forensic record beyond THAT: a `.1` gets clobbered by the next rotation with no `.2`.
 * Receipts/transcripts are the long-horizon record; this is a bounded recent-history + live-tail
 * feed, one generation deep.
 */

import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface JsonlLogOptions<T> {
	path: string;
	max?: number; // ring size, default 500
	maxBytes?: number; // rotation threshold, default 2_000_000 (2MB)
	idOf?: (entry: T) => number | string; // for hydrate's lastId-style bookkeeping; optional, unused by transitions.jsonl (no numeric id field on TransitionEntry)
	log?: (msg: string) => void;
}

export class JsonlLog<T> {
	private readonly ring: T[] = [];
	private readonly max: number;
	private readonly maxBytes: number;
	private readonly filePath: string;
	private readonly log: (msg: string) => void;
	private spoolFailing = false;
	private spoolTail: Promise<void> = Promise.resolve();

	constructor(opts: JsonlLogOptions<T>) {
		this.filePath = opts.path;
		this.max = opts.max ?? 500;
		this.maxBytes = opts.maxBytes ?? 2_000_000;
		this.log = opts.log ?? ((m) => console.warn(`[jsonl-log] ${m}`));
		this.hydrate();
	}

	/** Ring push + fire-and-forget spool. Never throws. */
	append(entry: T): void {
		this.ring.push(entry);
		if (this.ring.length > this.max) this.ring.shift();
		this.spoolTail = this.spoolTail.then(
			() => this.spool(entry),
			() => this.spool(entry),
		);
	}

	/** Ring tail, newest-last (callers reverse if they want newest-first) — no file I/O. */
	recent(limit?: number): T[] {
		return limit && limit > 0 ? this.ring.slice(-limit) : this.ring.slice();
	}

	/** Full persisted history from disk (torn-line-skipping) — for the explicit "full history" request
	 *  only. Reads the rotated `<path>.1` tail BEFORE the live file (oldest-first), mirroring
	 *  adoption-counters.ts's `readJsonl`: once a file crosses `maxBytes` the older half of the ledger
	 *  lives in `.1`, and a caller documented as "the full-history path" that skipped it would silently
	 *  drop everything written before the last rotation. Either or both files may be absent (no rotation
	 *  yet, or fresh state dir) — that is the normal case, not an error. */
	async hydrateAll(): Promise<T[]> {
		const out: T[] = [];
		for (const p of [`${this.filePath}.1`, this.filePath]) {
			let text: string;
			try {
				text = await fs.readFile(p, "utf8");
			} catch {
				continue; // missing file = normal (no rotation yet, or fresh state dir)
			}
			for (const line of text.split("\n")) {
				if (!line.trim()) continue;
				try {
					out.push(JSON.parse(line) as T);
				} catch {
					/* skip torn line */
				}
			}
		}
		return out;
	}

	private async spool(entry: T): Promise<void> {
		try {
			await fs.mkdir(path.dirname(this.filePath), { recursive: true });
			await this.rotateIfNeeded();
			await fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`);
			if (this.spoolFailing) {
				this.spoolFailing = false;
				this.log("spool recovered");
			}
		} catch (err) {
			if (!this.spoolFailing) {
				this.spoolFailing = true;
				this.log(`spool failed (not persisting): ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	/** Rename the file to `<path>.1` (clobbering any previous `.1`) once it crosses `maxBytes`, so the
	 *  next append starts a fresh file. A missing file (nothing to rotate yet) is the normal case. */
	private async rotateIfNeeded(): Promise<void> {
		let size: number;
		try {
			size = (await fs.stat(this.filePath)).size;
		} catch {
			return;
		}
		if (size <= this.maxBytes) return;
		await fs.rename(this.filePath, `${this.filePath}.1`).catch(() => undefined);
	}

	/** Seed the ring from the tail of the file so a restart still shows recent history. Sync, like
	 *  automation-log.ts's hydrate(), since it runs once in the constructor. */
	private hydrate(): void {
		let text: string;
		try {
			text = readFileSync(this.filePath, "utf8");
		} catch (err) {
			// A missing file is the normal first-boot case; any OTHER read error (permissions, I/O) means
			// persisted history exists but couldn't be loaded — surface it rather than silently starting empty.
			if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") this.log(`unreadable on hydrate — starting with empty ring: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		const lines = text.split("\n").filter((l) => l.trim());
		for (const line of lines.slice(-this.max)) {
			try {
				this.ring.push(JSON.parse(line) as T);
			} catch {
				/* skip a torn line */
			}
		}
	}
}

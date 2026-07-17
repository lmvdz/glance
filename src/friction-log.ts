/**
 * Friction ledger (plans/daily-dogfood-engine/01) — the durable append-only record behind
 * `glance grr`. Every capture surface (CLI verb, webapp composer popover, TUI Ctrl-G / /grr,
 * `glance here` /grr) funnels into ONE write path: {@link FrictionLog.record}, reached either
 * via `POST /api/friction` (HTTP surfaces) or via `SquadManager.recordFriction` (the in-process
 * TUI, which lives in the daemon and has no reason to loop back over HTTP).
 *
 * Storage: a `JsonlLog<FrictionEntry>` at `<stateDir>/friction.jsonl` — the same generic
 * ring+spool used for transitions.jsonl (src/squad-manager.ts's transitionLog), deliberately NOT
 * `automation-log.ts`: that subsystem is hard-typed to AutomationEvent's heterogeneous-metrics
 * schema and gates persistence through `isMeaningful()`, a heartbeat-vs-worth-persisting filter
 * that doesn't apply here — every gripe is meaningful by construction (the operator typed it
 * mid-annoyance). Rationale recorded so it isn't re-litigated; see the concern doc's Approach.
 *
 * The ring (recent()) is the read path for `GET /api/friction` / `glance grr --list`; the file
 * (hydrateAll()) is the full-history path the weekly drain (concern 03) reads.
 */

import * as path from "node:path";
import { JsonlLog } from "./jsonl-log.ts";
import type { FrictionEntry } from "./types.ts";

/** What a capture surface knows at the moment of annoyance — everything else (id, ts) is minted here. */
export interface FrictionCapture {
	/** Repo the operator was in ("" when genuinely unknown — e.g. a webapp capture with no session). */
	repo: string;
	/** The gripe itself. Callers validate non-empty; record() refuses an empty one fail-closed. */
	gripe: string;
	/** Capture surface ("cli" / "tui" / "webapp-composer" / "here") or free-form situational context. */
	context?: string;
	/** The agent whose chat/session the gripe was captured from, when there was one. */
	agentId?: string;
	/** Who's filing this gripe. Defaults to `"human"` — every existing capture surface (CLI, TUI,
	 *  webapp composer, `here` /grr) omits this and gets the default. `"auto"` is for the daemon's OWN
	 *  internal hook sites only (squad-manager.ts's boundary-sync/ACP-timeout/session-loss captures);
	 *  `POST /api/friction`'s handler never reads a `source` off the client body, so this can never
	 *  arrive as `"auto"` from outside. */
	source?: "human" | "auto";
}

/** `<stateDir>/friction.jsonl` — mirrors automationPath()/receiptPath()'s state-dir convention.
 *
 * @substrate exported for tests only — tests/friction-log.test.ts reads the file this path points
 * at directly to assert on-disk content; its only in-repo caller is `FrictionLog`'s constructor,
 * in this same file. */
export function frictionPath(stateDir: string): string {
	return path.join(stateDir, "friction.jsonl");
}

export class FrictionLog {
	private readonly log: JsonlLog<FrictionEntry>;

	constructor(stateDir: string, warn?: (msg: string) => void) {
		this.log = new JsonlLog<FrictionEntry>({ path: frictionPath(stateDir), log: warn });
	}

	/** THE single ledger-write: mint id+ts, append, return the persisted shape. Throws on an
	 *  empty/whitespace gripe rather than durably recording nothing — every caller surfaces that
	 *  as its own usage error, none of them swallow it into a silent no-op. */
	record(capture: FrictionCapture): FrictionEntry {
		const gripe = capture.gripe.trim();
		if (!gripe) throw new Error("gripe required");
		const entry: FrictionEntry = {
			id: crypto.randomUUID(),
			ts: Date.now(),
			repo: capture.repo,
			gripe,
			...(capture.context?.trim() ? { context: capture.context.trim() } : {}),
			...(capture.agentId ? { agentId: capture.agentId } : {}),
			// Only ever stamped for "auto" — a "human" (or absent) source is omitted from the written
			// line entirely, same as every other optional field here; the read-side default (below)
			// covers both this omission AND every pre-existing row that predates the field.
			...(capture.source === "auto" ? { source: "auto" as const } : {}),
		};
		this.log.append(entry);
		return entry;
	}

	/** A missing `source` reads as `"human"` — the migration default for every friction.jsonl row
	 *  written before this field existed, and for every ordinary human capture surface today (none of
	 *  which sets it). Applied on every read path (never rewrites the file). */
	private static withSourceDefault(e: FrictionEntry): FrictionEntry {
		return e.source === undefined ? { ...e, source: "human" } : e;
	}

	/** Ring tail, newest-LAST (JsonlLog convention) — callers reverse for newest-first display. */
	recent(limit?: number): FrictionEntry[] {
		return this.log.recent(limit).map(FrictionLog.withSourceDefault);
	}

	/** Full persisted history from disk — the weekly drain's read, not the API's. */
	async hydrateAll(): Promise<FrictionEntry[]> {
		return (await this.log.hydrateAll()).map(FrictionLog.withSourceDefault);
	}
}

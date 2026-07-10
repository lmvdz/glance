/**
 * Baseline tracker (eap-borrows follow-up, concern 01 DESIGN decision 4) — the missing PRODUCER for
 * `omp-graph/task-class-matrix.ts`'s `detectBaselineStaleness` + the `pinnedModel` concept. Both were
 * shipped as pure functions with no caller: nothing persisted a "previously selected" baseline, so
 * `detectBaselineStaleness` had nothing real to compare against, and nothing resolved an operator pin.
 * "auto-champion + optional human pin + staleness AttentionEvent" was therefore only 1/3 live —
 * `selectBaseline` (the auto-champion half) was the sole piece with a caller (`membrane-breaker-cadence.ts`).
 *
 * Storage mirrors `threshold-tuner.ts`'s smallest precedent: a small JSON file under `stateDir`,
 * best-effort read/write (a disk hiccup here must never break the land path that feeds it), no
 * unbounded growth (one entry per taskClass, overwritten on each selection — only the MOST RECENT
 * selection is meaningful for the next staleness comparison; no history is kept).
 *
 * `selectAndTrackBaseline` is the one entry point production code should call instead of raw
 * `selectBaseline`: it resolves an optional pin, detects staleness against BOTH the pin (if one is
 * configured and points at a now-thin/vanished cell) and the last-persisted selection, then records
 * whatever it selects for the next round. Pure `detectBaselineStaleness`/`selectBaseline` stay exactly
 * as they were — this module only adds the producer/consumer wiring around them.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { detectBaselineStaleness, selectBaseline, type TaskClassBaseline, type TaskClassMatrixDoc } from "./omp-graph/task-class-matrix.ts";
import type { AttentionEvent } from "./types.ts";

export interface PersistedBaseline {
	model: string;
	at: number;
}

type PersistedBaselineState = Record<string, PersistedBaseline>; // taskClass -> last-selected baseline

function trackerPath(stateDir: string): string {
	return path.join(stateDir, "baseline-tracker.json");
}

function readState(stateDir: string): PersistedBaselineState {
	try {
		const p = trackerPath(stateDir);
		if (!existsSync(p)) return {};
		const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
		if (!raw || typeof raw !== "object") return {};
		const out: PersistedBaselineState = {};
		for (const [taskClass, value] of Object.entries(raw as Record<string, unknown>)) {
			if (value && typeof value === "object" && typeof (value as Partial<PersistedBaseline>).model === "string" && typeof (value as Partial<PersistedBaseline>).at === "number") {
				out[taskClass] = { model: (value as PersistedBaseline).model, at: (value as PersistedBaseline).at };
			}
		}
		return out;
	} catch {
		return {}; // corrupt/unreadable ⇒ behave as "no previous selection" rather than throw
	}
}

function writeState(stateDir: string, state: PersistedBaselineState): void {
	try {
		writeFileSync(trackerPath(stateDir), JSON.stringify(state));
	} catch {
		/* best-effort: a disk failure must never break the land it records */
	}
}

/** The previously-persisted baseline for `taskClass`, or `undefined` on the very first selection ever
 *  made for it (nothing to compare staleness against yet). */
export function readPersistedBaseline(stateDir: string, taskClass: string): PersistedBaseline | undefined {
	return readState(stateDir)[taskClass];
}

/** Record the model just selected as `taskClass`'s baseline — overwrites any prior entry. */
export function recordSelectedBaseline(stateDir: string, taskClass: string, model: string, now: number = Date.now()): void {
	const state = readState(stateDir);
	state[taskClass] = { model, at: now };
	writeState(stateDir, state);
}

// ── Optional human pin ──────────────────────────────────────────────────────────────────────────────
// A tiny operator-edited file this codebase never writes itself — a deliberate override, never a
// silent default. Checked in order: `OMP_SQUAD_BASELINE_PIN_<TASKCLASS>` (fastest, container-friendly,
// e.g. "tdd:heavy" -> `OMP_SQUAD_BASELINE_PIN_TDD_HEAVY`), then `<stateDir>/baseline-pins.json`
// (`{ "tdd:heavy": "opus", ... }`, survives restarts without an env change baked into the deploy).

function pinsPath(stateDir: string): string {
	return path.join(stateDir, "baseline-pins.json");
}

function envPinKey(taskClass: string): string {
	return `OMP_SQUAD_BASELINE_PIN_${taskClass.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/** Resolve an operator-configured pinned model for `taskClass`, or `undefined` when none is set. Never
 *  throws — a malformed/missing pin resolves to "no pin", never a crash on the land path this feeds. */
export function resolvePinnedModel(stateDir: string, taskClass: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const fromEnv = env[envPinKey(taskClass)];
	if (fromEnv && fromEnv.trim()) return fromEnv.trim();
	try {
		const p = pinsPath(stateDir);
		if (!existsSync(p)) return undefined;
		const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
		if (!raw || typeof raw !== "object") return undefined;
		const value = (raw as Record<string, unknown>)[taskClass];
		return typeof value === "string" && value ? value : undefined;
	} catch {
		return undefined;
	}
}

export interface BaselineTrackResult {
	/** The baseline `selectBaseline` resolves for this call (pin-honoring), or `undefined` when neither
	 *  a valid pin nor an auto-champion is available. */
	baseline: TaskClassBaseline | undefined;
	/** Zero, one, or two staleness events — one for a rotted persisted-previous baseline, one for a
	 *  pin pointing at a cell that is `insufficientData` or missing entirely. Both can fire in the same
	 *  call (e.g. an operator pinned a model right after the auto-champion it replaced went stale). The
	 *  caller is responsible for delivering each to a human-visible channel; this function is pure of
	 *  that concern (mirrors `detectBaselineStaleness`'s own doc). */
	staleness: AttentionEvent[];
}

/**
 * Resolve `taskClass`'s baseline the way production code should — pin-honoring, staleness-checked,
 * self-recording — and persist the selection for the NEXT call to compare against. Without a persisted
 * previous value, `detectBaselineStaleness` has nothing real to run against; this is the wiring that
 * makes it fire in practice, at the one place `selectBaseline` already has a live caller
 * (`membrane-breaker-cadence.ts`).
 */
export function selectAndTrackBaseline(stateDir: string, doc: TaskClassMatrixDoc, taskClass: string, opts: { now?: number; env?: NodeJS.ProcessEnv } = {}): BaselineTrackResult {
	const now = opts.now ?? Date.now();
	const staleness: AttentionEvent[] = [];

	const pinnedModel = resolvePinnedModel(stateDir, taskClass, opts.env);
	if (pinnedModel) {
		const pinnedCell = doc.cells[taskClass]?.[pinnedModel];
		if (!pinnedCell || pinnedCell.insufficientData) {
			const event = detectBaselineStaleness(taskClass, pinnedModel, doc, now);
			if (event) staleness.push(event);
		}
	}

	const previous = readPersistedBaseline(stateDir, taskClass);
	if (previous) {
		const event = detectBaselineStaleness(taskClass, previous.model, doc, now);
		if (event) staleness.push(event);
	}

	const baseline = selectBaseline(doc, taskClass, { pinnedModel });
	if (baseline) recordSelectedBaseline(stateDir, taskClass, baseline.model, now);

	return { baseline, staleness };
}

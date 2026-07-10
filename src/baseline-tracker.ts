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
 *
 * MISSING vs CORRUPT (blind review follow-up finding #1): a MISSING tracker/pins file is the legitimate
 * first-boot case and resolves to "nothing persisted yet" — `{}` / no pin. A file that EXISTS but is
 * unreadable, unparseable (truncated/torn — see `writeState`'s atomic-rename note below), or has an
 * invalid top-level shape is CORRUPT, and this repo already has a hard rule against collapsing that into
 * the same "nothing yet" case: `convergence-oracle.ts#readFailures` throws on a corrupt failures sidecar
 * (eap-borrows fail-open finding #16) specifically so a corrupt file can never silently re-baseline a
 * ratchet. `readState`/`resolvePinnedModel` mirror that discipline via `classifyProbeFailure`'s
 * "corrupt-state" taxonomy (fail-closed, ALWAYS escalate) — they THROW rather than fall back to `{}`/
 * undefined. `selectAndTrackBaseline` is the one place that catches those throws: it turns them into an
 * `AttentionEvent` in the SAME `staleness` array a rotted persisted/pinned baseline already reports
 * through (so a human sees exactly one kind of thing: "this baseline can't be trusted right now"), holds
 * this round's comparison rather than trusting either the corrupt file or a manufactured empty one, and —
 * critically — never calls `recordSelectedBaseline` when the read was corrupt, so the on-disk file is
 * left exactly as it was for a human to inspect instead of being silently overwritten with a fresh
 * single-entry state that would also destroy every OTHER taskClass's persisted baseline sharing that
 * file. It still resolves and returns a usable `baseline` for THIS call from the pure computation over
 * `doc` (auto-champion or a validated pin) — a corrupt tracker escalates and holds the measurement, it
 * never blocks the land path that feeds it (mirrors this repo's "structural failures escalate, never
 * silently proceed AND never wedge the caller" rule).
 *
 * Non-atomic write (blind review follow-up finding #3): the original `writeState` called `writeFileSync`
 * directly on the destination path — no temp file, no rename — so a process killed mid-write (or, if
 * `state-lock.ts`'s single-daemon-per-stateDir invariant is ever bypassed, a second concurrent writer)
 * could leave a genuinely TORN file on disk: valid-looking JSON syntax up to the truncation point, or no
 * valid JSON at all. `writeState` now mirrors `convergence-oracle.ts#writeFailures`'s atomic-rename idiom
 * exactly: write to a UNIQUE-suffixed temp file (`.baseline-tracker.<pid>.<random>.tmp` — a unique
 * suffix, not `storage.ts#LocalStorageBackend`'s fixed `.tmp`, which two concurrent writers could still
 * collide on and tear) in the same directory, then atomically `renameSync` onto the real path. A reader
 * can now only ever observe the fully-written prior version or the fully-written new one — never a
 * partial mix — which is also why `readState` treats a parse failure as CORRUPT rather than as
 * "transient torn read, retry": under this write discipline a torn read is not expected to happen from
 * this module's own writes; if one is ever observed it means something OUTSIDE this module's write path
 * touched the file, which is exactly the kind of state a human should look at, not silently paper over.
 * (`state-lock.ts` already serializes at the DAEMON level — only one daemon process may hold a given
 * `stateDir` at a time — so the residual risk this closes is a single writer dying mid-write, or a
 * non-daemon process/script touching the file directly, not two live daemons racing each other.)
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { classifyProbeFailure } from "./classify-probe-failure.ts";
import { errText } from "./err-text.ts";
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

/** THROWS (classifyProbeFailure "corrupt-state") when the file EXISTS but is unreadable, unparseable, or
 *  has an invalid shape — never silently treated as "no previous selection". Missing file ⇒ `{}` (the
 *  legitimate first-boot case). See this module's doc for why the two must never collapse together. */
function readState(stateDir: string): PersistedBaselineState {
	const p = trackerPath(stateDir);
	if (!existsSync(p)) return {}; // MISSING — legitimate first boot, nothing persisted yet
	let raw: string;
	try {
		raw = readFileSync(p, "utf8");
	} catch (err) {
		throw new Error(classifyProbeFailure({ kind: "corrupt-state", detail: `baseline tracker at ${p} unreadable: ${errText(err)}` }).reason);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch (err) {
		throw new Error(classifyProbeFailure({ kind: "corrupt-state", detail: `baseline tracker at ${p} unparseable (possibly truncated/torn): ${errText(err)}` }).reason);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(classifyProbeFailure({ kind: "corrupt-state", detail: `baseline tracker at ${p} is not a JSON object` }).reason);
	}
	const out: PersistedBaselineState = {};
	for (const [taskClass, value] of Object.entries(parsed as Record<string, unknown>)) {
		const ok = value && typeof value === "object" && typeof (value as Partial<PersistedBaseline>).model === "string" && typeof (value as Partial<PersistedBaseline>).at === "number";
		if (!ok) {
			throw new Error(classifyProbeFailure({ kind: "corrupt-state", detail: `baseline tracker at ${p} has an invalid entry for taskClass "${taskClass}"` }).reason);
		}
		out[taskClass] = { model: (value as PersistedBaseline).model, at: (value as PersistedBaseline).at };
	}
	return out;
}

/** Atomic write: unique-suffixed temp file + rename (mirrors `convergence-oracle.ts#writeFailures`) so a
 *  reader NEVER observes a torn file — a process killed mid-write leaves either the prior full file or
 *  nothing (the rename never happened), never a partial one. Best-effort: a disk failure here must never
 *  break the land path that feeds it (matches every other write in this file's family). */
function writeState(stateDir: string, state: PersistedBaselineState): void {
	try {
		const dest = trackerPath(stateDir);
		const dir = path.dirname(dest);
		mkdirSync(dir, { recursive: true });
		const tmp = path.join(dir, `.baseline-tracker.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
		writeFileSync(tmp, JSON.stringify(state));
		renameSync(tmp, dest);
	} catch {
		/* best-effort: a disk failure must never break the land it records */
	}
}

/** The previously-persisted baseline for `taskClass`, or `undefined` on the very first selection ever
 *  made for it (nothing to compare staleness against yet). THROWS when the tracker file is corrupt —
 *  see this module's doc; callers on the land path must catch this and escalate, never let it propagate
 *  unhandled. */
export function readPersistedBaseline(stateDir: string, taskClass: string): PersistedBaseline | undefined {
	return readState(stateDir)[taskClass];
}

/** Record the model just selected as `taskClass`'s baseline — overwrites any prior entry. THROWS (and
 *  writes NOTHING) when the tracker file is corrupt: a read-modify-write that can't safely read the
 *  existing state must not blindly overwrite it with a fresh single-entry document, which would silently
 *  discard every OTHER taskClass's persisted baseline sharing this file — the file is left alone for a
 *  human to inspect instead. */
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

/**
 * Resolve an operator-configured pinned model for `taskClass`, or `undefined` when none is configured at
 * all (env var absent AND pins file absent/has no entry for this taskClass — both legitimate "no pin"
 * states). THROWS (classifyProbeFailure "unparseable"/"corrupt-state") on a MALFORMED pin rather than
 * silently resolving to "no pin" — a bad pin must be rejected loudly, never quietly ignored (blind review
 * follow-up finding #2):
 *   - the env var is SET but blank/whitespace-only: an operator explicitly configured this and got it
 *     wrong; falling through to the pins file (or no pin) would look like the pin took effect when it
 *     silently didn't.
 *   - the pins file EXISTS but is unreadable/unparseable/not an object: the same missing-vs-corrupt
 *     distinction `readState` makes — a MISSING pins file is "no pin configured", a file that exists but
 *     can't be read is corrupt state, not an empty configuration.
 * A pin naming a taskClass the file simply doesn't mention is still legitimate "no pin" (not every
 * taskClass needs one). Callers on the land path (`selectAndTrackBaseline`) must catch this and escalate
 * rather than let it propagate unhandled — this function itself does not soften the failure, by design.
 *
 * A KEY PRESENT but an INVALID VALUE (blind review follow-up: `{"light": ""}` or `{"light": 42}` inside
 * an otherwise-valid pins file) gets the same treatment, not the "no pin configured" silent fallthrough —
 * the file parses fine, so the missing-vs-corrupt distinction above doesn't catch it, but a present,
 * non-string/blank value is exactly as much an operator mistake as the blank-env-var case: a silently
 * ignored pin is a silently-disabled safety net, the same failure class this whole function exists to
 * reject. Only an ABSENT key (`value === undefined` — JSON has no `undefined`, so this is unambiguous)
 * stays a legitimate, silent "no pin for this taskClass".
 */
export function resolvePinnedModel(stateDir: string, taskClass: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const envKey = envPinKey(taskClass);
	const fromEnv = env[envKey];
	if (fromEnv !== undefined) {
		const trimmed = fromEnv.trim();
		if (trimmed) return trimmed;
		throw new Error(classifyProbeFailure({ kind: "unparseable", detail: `env pin ${envKey} is set but blank/whitespace-only` }).reason);
	}
	const p = pinsPath(stateDir);
	if (!existsSync(p)) return undefined; // MISSING file — legitimate "no pin configured"
	let raw: string;
	try {
		raw = readFileSync(p, "utf8");
	} catch (err) {
		throw new Error(classifyProbeFailure({ kind: "corrupt-state", detail: `baseline pins file at ${p} unreadable: ${errText(err)}` }).reason);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch (err) {
		throw new Error(classifyProbeFailure({ kind: "corrupt-state", detail: `baseline pins file at ${p} unparseable (possibly truncated/torn): ${errText(err)}` }).reason);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(classifyProbeFailure({ kind: "corrupt-state", detail: `baseline pins file at ${p} is not a JSON object` }).reason);
	}
	const value = (parsed as Record<string, unknown>)[taskClass];
	if (value === undefined) return undefined; // key absent — no pin configured for THIS taskClass, not corruption
	if (typeof value === "string" && value.trim()) return value.trim();
	// Key IS present but the value is not a usable pin (blank string, a number, `null`, …) — an operator
	// mistake, not a legitimate no-pin state. Reject loudly, same as the blank-env-var case above.
	throw new Error(
		classifyProbeFailure({ kind: "unparseable", detail: `baseline pins file at ${p} has an invalid pin for taskClass "${taskClass}": ${JSON.stringify(value)} (expected a non-blank string)` })
			.reason,
	);
}

export interface BaselineTrackResult {
	/** The baseline `selectBaseline` resolves for this call (pin-honoring), or `undefined` when neither
	 *  a valid pin nor an auto-champion is available. */
	baseline: TaskClassBaseline | undefined;
	/** Zero or more staleness/corruption escalations — a rotted persisted-previous baseline, a pin
	 *  pointing at a cell that is `insufficientData` or missing entirely, a corrupt tracker file, or a
	 *  corrupt/malformed pin. Multiple can fire in the same call. The caller is responsible for
	 *  delivering each to a human-visible channel; this function is pure of that concern (mirrors
	 *  `detectBaselineStaleness`'s own doc). */
	staleness: AttentionEvent[];
}

function corruptEvent(kind: "tracker" | "pin", taskClass: string, err: unknown, now: number): AttentionEvent {
	const detail = errText(err);
	return {
		id: `baseline-${kind}-corrupt:${taskClass}:${now}`,
		summary:
			kind === "tracker"
				? `Baseline tracker for taskClass "${taskClass}" could not be read — corrupt/torn state, previous baseline held for inspection`
				: `Baseline pin for taskClass "${taskClass}" could not be resolved — corrupt/invalid pin state`,
		detail,
		source: "notify",
		createdAt: now,
	};
}

/**
 * Resolve `taskClass`'s baseline the way production code should — pin-honoring, staleness-checked,
 * self-recording — and persist the selection for the NEXT call to compare against. Without a persisted
 * previous value, `detectBaselineStaleness` has nothing real to run against; this is the wiring that
 * makes it fire in practice, at the one place `selectBaseline` already has a live caller
 * (`membrane-breaker-cadence.ts`).
 *
 * Fail-closed, never fail-blocked: a corrupt tracker/pin file or a bad pin escalates via `staleness`
 * (finding #1/#2) but this function still resolves and returns a usable `baseline` for THIS call
 * whenever `doc` has one — it holds the measurement and reports the problem, it never refuses to answer
 * (a refusal that can neither clear nor escalate would just wedge the land path this feeds).
 */
export function selectAndTrackBaseline(stateDir: string, doc: TaskClassMatrixDoc, taskClass: string, opts: { now?: number; env?: NodeJS.ProcessEnv } = {}): BaselineTrackResult {
	const now = opts.now ?? Date.now();
	const staleness: AttentionEvent[] = [];
	let trackerCorrupt = false;

	// Pin resolution (finding #2: a corrupt/malformed pin must be rejected loudly, never silently ignored).
	let pinnedModel: string | undefined;
	try {
		pinnedModel = resolvePinnedModel(stateDir, taskClass, opts.env);
	} catch (err) {
		staleness.push(corruptEvent("pin", taskClass, err, now));
	}

	if (pinnedModel) {
		const pinnedCell = doc.cells[taskClass]?.[pinnedModel];
		if (!pinnedCell || pinnedCell.insufficientData) {
			const event = detectBaselineStaleness(taskClass, pinnedModel, doc, now);
			if (event) staleness.push(event);
			// finding #2: a bad/thin pin must not silently disable the compare (baseline undefined) nor
			// keep comparing against the ghost cell (selectBaseline would still return it if pinnedModel
			// were passed through) — fall back to the auto-champion explicitly, having already escalated.
			pinnedModel = undefined;
		}
	}

	// Previously-persisted comparison (finding #1: a corrupt tracker escalates, it is never read as "no
	// previous selection" — that would silently re-baseline against nothing).
	let previous: PersistedBaseline | undefined;
	try {
		previous = readPersistedBaseline(stateDir, taskClass);
	} catch (err) {
		trackerCorrupt = true;
		staleness.push(corruptEvent("tracker", taskClass, err, now));
	}
	if (previous) {
		const event = detectBaselineStaleness(taskClass, previous.model, doc, now);
		if (event) staleness.push(event);
	}

	const baseline = selectBaseline(doc, taskClass, { pinnedModel });
	// finding #1: a corrupt tracker file is left ALONE for inspection — `recordSelectedBaseline` does a
	// read-modify-write that can't safely merge without a real read, so skip the write entirely rather
	// than let it silently overwrite the file with a fresh single-entry state (which would also destroy
	// every OTHER taskClass's persisted baseline). The measurement itself is still returned above; only
	// the PERSISTENCE of this round's pick is held back until the file is fixed.
	//
	// Round-2 review follow-up: `readPersistedBaseline` above already proved the file readable a moment
	// ago (`trackerCorrupt` is false), but `recordSelectedBaseline` does its OWN read-modify-write — an
	// external TOCTOU corruption of the file in between (a foreign process, a concurrent daemon) makes
	// its internal `readState` throw too. Uncaught, that throw would escape this function entirely and
	// take the `staleness` array — already built above, possibly carrying a real corruption/pin/staleness
	// escalation — down with it, so the one thing this function promises ("never fail-blocked, always
	// deliver what staleness it found") would itself fail silently on the exact class of bug it exists to
	// catch. Caught, escalated via the SAME `corruptEvent` channel, and swallowed: `baseline` (already
	// computed above from the pure `doc`) is still returned, so this remains fail-closed on the *write*,
	// never fail-blocked on the *read*.
	if (baseline && !trackerCorrupt) {
		try {
			recordSelectedBaseline(stateDir, taskClass, baseline.model, now);
		} catch (err) {
			staleness.push(corruptEvent("tracker", taskClass, err, now));
		}
	}

	return { baseline, staleness };
}

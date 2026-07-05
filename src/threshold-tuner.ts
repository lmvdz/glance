/**
 * Confidence-threshold tuner (Epic 6 concern 08) — nudges the propose-only (`assist`-cap) confidence
 * floor toward the value that actually separates landed from rejected work, using Epic 5's per-run
 * confidence score (`src/confidence.ts`) correlated against the SAME land outcome concern 06's ledger
 * records. Deterministic, bounded, boost-only:
 *
 *  - "Boost-only" here means the tuner only ever LOOSENS the floor (moves it down) when the evidence
 *    shows it is overcautious (a majority of BELOW-floor runs are landing fine anyway) — it never
 *    ratchets the floor UP into blocking a class of work that has been landing cleanly. Raising the
 *    floor back up, if ever wanted, is an explicit operator action (`OMP_SQUAD_CONFIDENCE_FLOOR`), not
 *    something this tuner does silently.
 *  - Every adjustment is a single bounded step (`DEFAULT_STEP`), never a jump straight to a computed
 *    "optimal" value — a noisy small sample must not swing the gate.
 *  - Absence is neutral: a run with no confidence score contributes no evidence (the "absence = unknown,
 *    never penalize" rule DESIGN.md mandates fleet-wide).
 *  - Deterministic proof stays the sole land gate; this tuner only ever adjusts `assist`-cap eligibility,
 *    never a land decision.
 *
 * Storage mirrors `proof.ts`'s module-level settable root (`setProofRoot`) — `confidenceFloor()` in
 * squad-manager.ts is a bare function called from several sites with no `stateDir` in scope at every
 * call site; threading one through all of them would be a much larger, riskier diff for a feature that
 * is opt-in and off by default. `setThresholdTunerRoot` is called once, alongside `setProofRoot`, in
 * the manager's constructor.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { resolveStateDir } from "./state-dir.ts";

export interface ConfidenceOutcomeSample {
	confidence: number;
	landed: boolean;
	at: number;
}

interface ThresholdTunerState {
	floor: number;
	samples: ConfidenceOutcomeSample[];
}

const SAMPLE_CAP = 200;
const DEFAULT_STEP = 0.02;
const DEFAULT_MIN_FLOOR = 0.1;
const DEFAULT_MAX_FLOOR = 0.8;
const DEFAULT_MIN_SAMPLES = 20;
/** Below this the floor is considered overcautious: most of what it's currently blocking actually lands. */
const OVERCAUTIOUS_LAND_RATE = 0.7;

let tunerRoot = resolveStateDir();

/** Manager/org state root owns tuner storage; tests/standalone callers use the default. */
export function setThresholdTunerRoot(stateDir: string): void {
	tunerRoot = stateDir;
}

function statePath(stateDir: string): string {
	return path.join(stateDir, "threshold-tuner.json");
}

function readState(stateDir: string, defaultFloor: number): ThresholdTunerState {
	try {
		const p = statePath(stateDir);
		if (!existsSync(p)) return { floor: defaultFloor, samples: [] };
		const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
		if (!raw || typeof raw !== "object") return { floor: defaultFloor, samples: [] };
		const s = raw as Partial<ThresholdTunerState>;
		return { floor: typeof s.floor === "number" ? s.floor : defaultFloor, samples: Array.isArray(s.samples) ? s.samples : [] };
	} catch {
		return { floor: defaultFloor, samples: [] }; // corrupt/unreadable ⇒ start fresh at the operator's default
	}
}

function writeState(stateDir: string, state: ThresholdTunerState): void {
	try {
		writeFileSync(statePath(stateDir), JSON.stringify(state));
	} catch {
		/* best-effort: a disk failure must never break the land it records */
	}
}

/**
 * Pure fit: a single bounded step toward better agreement between low confidence and rejection.
 * NEVER raises `current` — only loosens it (moves down) when the evidence shows it is overcautious,
 * and only when there is enough evidence (`minSamples`) to act on. Exported standalone (no I/O) so
 * the fitting logic is fully unit-testable without touching disk.
 */
export function nextFloor(current: number, samples: ConfidenceOutcomeSample[], opts: { step?: number; min?: number; minSamples?: number } = {}): number {
	const step = opts.step ?? DEFAULT_STEP;
	const min = opts.min ?? DEFAULT_MIN_FLOOR;
	const minSamples = opts.minSamples ?? DEFAULT_MIN_SAMPLES;
	if (samples.length < minSamples) return current; // not enough evidence to move — stay put
	const below = samples.filter((s) => s.confidence < current);
	if (below.length === 0) return current; // nothing to learn about the floor's own boundary yet
	const belowLandRate = below.filter((s) => s.landed).length / below.length;
	if (belowLandRate >= OVERCAUTIOUS_LAND_RATE) return Math.max(min, current - step); // overcautious ⇒ loosen one step
	return current; // evidence doesn't (yet) justify a change — never raises
}

/**
 * Record one run's (confidence, landed) pair — the same land site concern 06 records its
 * model-outcome ledger from. `confidence === undefined` is a no-op (absence is neutral, never
 * evidence). Best-effort: caps the sample window so the file doesn't grow unbounded.
 */
export function recordConfidenceOutcome(stateDir: string, defaultFloor: number, confidence: number | undefined, landed: boolean, now = Date.now()): void {
	if (confidence === undefined) return;
	const state = readState(stateDir, defaultFloor);
	state.samples.push({ confidence, landed, at: now });
	if (state.samples.length > SAMPLE_CAP) state.samples = state.samples.slice(-SAMPLE_CAP);
	state.floor = nextFloor(state.floor, state.samples);
	writeState(stateDir, state);
}

/** The tuned floor for `defaultFloor` — `defaultFloor` seeds the tuner's very first read (before any
 *  evidence exists). `nextFloor` only ever moves DOWN from wherever the tuner currently sits, so the
 *  persisted floor is always <= its own starting point (it can lag a short while behind an operator
 *  who manually lowers `OMP_SQUAD_CONFIDENCE_FLOOR` further, until enough new evidence re-converges it —
 *  never the reverse: it can never drift ABOVE where it started). */
export function tunedConfidenceFloor(defaultFloor: number, stateDir: string = tunerRoot): number {
	return readState(stateDir, defaultFloor).floor;
}

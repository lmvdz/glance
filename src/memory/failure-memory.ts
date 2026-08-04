/**
 * Recurring-failure memory (agentic-learning-loop concern 05, downscoped) — when the observer's
 * existing fingerprint streak fires (the SAME failure recurring, `landFailureFindings`'s `≥cap`
 * check in observer.ts), annotate it ONCE with a root cause (reusing concern 04's `reflect()`) and
 * persist it so a later cold-start can warn the next agent it's about to retry a KNOWN-recurring
 * failure — not a BM25-similarity guess (rejected in DESIGN: false-analogy negative priming).
 *
 * Storage mirrors `land-ledger.ts` exactly (both on src/ledger.ts's uncached mapFile shape): the
 * annotations already live downstream of that exact ledger's streak, are fleet-wide (not tied to
 * any one worktree's lifetime — the worktree that tripped the streak may be long gone by the time
 * this is read), and are written from the SAME single-writer, single-event-loop context
 * (`Observer.tick()`) land-ledger.json already is. A per-worktree store (proof.ts's pattern) would
 * force enumerating live agents to find a reaped branch's worktree, which the whole point of this
 * fact (surviving past that worktree) rules out.
 */

import { mapFile } from "../ledger.ts";

export interface FailureAnnotation {
	/** The observer's stable dedup key, e.g. `land-failing:squad/abc123`. */
	fingerprint: string;
	repo: string;
	branch: string;
	rootCause: string;
	at: number;
}

/** fingerprint → its (one, most recent) annotation. Re-annotating an already-annotated fingerprint
 *  overwrites — there is only ever one root cause worth surfacing per recurring failure. */
export type FailureStore = Record<string, FailureAnnotation>;

const store = (stateDir: string) => mapFile<FailureAnnotation>(stateDir, "failure-annotations.json");

/** Corrupt/missing ⇒ empty (worst case: one failure's annotation is forgotten, never a crash). */
export function readFailureAnnotations(stateDir: string): FailureStore {
	return store(stateDir).read();
}

/** Record (or overwrite) one fingerprint's annotation. */
export function recordFailureAnnotation(stateDir: string, annotation: FailureAnnotation): void {
	const s = store(stateDir);
	const all = s.read();
	all[annotation.fingerprint] = annotation;
	s.write(all);
}

/** One fingerprint's annotation, or `undefined` if it was never annotated (or has been cleared). */
export function failureAnnotation(stateDir: string, fingerprint: string): FailureAnnotation | undefined {
	return readFailureAnnotations(stateDir)[fingerprint];
}

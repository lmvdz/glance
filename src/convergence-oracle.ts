/**
 * Verified-state oracle (Epic 7, leaf 01) — the disk contract shared by the TS convergence state
 * machine (writer, `src/convergence.ts`) and the bash Stop hook (reader, `scripts/continue-loop.sh`,
 * which cannot import TS and re-implements this module's path resolution inline). Purely the
 * persisted boundary object: no iteration/planning logic lives here.
 *
 * Paths derive from `resolveStateDir()` (`src/state-dir.ts:51`) so they land in the one canonical
 * glance state root. Writes are atomic (temp file + rename, mirroring the attachment write in
 * `src/squad-manager.ts:1640-1642`) so the hook never observes a half-written file.
 *
 * Two independent arm gates live here too (`arm`/`disarm`/`isArmed`): a sentinel FILE under
 * `<stateDir>/convergence/armed`. The hook additionally requires `OMP_SQUAD_LOOP_ARMED=1` — belt
 * and suspenders against an immortal session (see DESIGN.md §4/§5). This module only owns the file
 * half of that gate.
 */

import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { classifyProbeFailure } from "./classify-probe-failure.ts";
import { errText } from "./err-text.ts";
import { resolveStateDir } from "./state-dir.ts";
import type { VerifiedState } from "./types.ts";

export type { VerifiedState } from "./types.ts";

/** `<stateDir>/convergence` — the directory both the oracle file and the arm sentinel live under. */
export function convergenceDir(stateDir: string = resolveStateDir()): string {
	return path.join(stateDir, "convergence");
}

/** `<stateDir>/convergence/oracle.json` — mirrored inline by `scripts/continue-loop.sh`. */
export function oraclePath(stateDir: string = resolveStateDir()): string {
	return path.join(convergenceDir(stateDir), "oracle.json");
}

/** `<stateDir>/convergence/armed` — mirrored inline by `scripts/continue-loop.sh`. */
export function armPath(stateDir: string = resolveStateDir()): string {
	return path.join(convergenceDir(stateDir), "armed");
}

/**
 * Persist `state` atomically: write to a temp file in the same directory, then `rename` onto
 * `oraclePath` — a reader (the bash hook) never observes a partial write. Creates the convergence
 * dir if absent.
 */
export async function writeOracle(state: VerifiedState, stateDir: string = resolveStateDir()): Promise<void> {
	const dir = convergenceDir(stateDir);
	await fs.mkdir(dir, { recursive: true });
	const dest = oraclePath(stateDir);
	const tmp = path.join(dir, `.oracle.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	await fs.writeFile(tmp, JSON.stringify(state));
	await fs.rename(tmp, dest);
}

/** Fail-safe read: `undefined`/missing file or unparseable JSON both return `null` rather than throw. */
export async function readOracle(stateDir: string = resolveStateDir()): Promise<VerifiedState | null> {
	try {
		const raw = await fs.readFile(oraclePath(stateDir), "utf8");
		return JSON.parse(raw) as VerifiedState;
	} catch {
		return null;
	}
}

/** The verified-state fields a cold session needs to resume — a compact subset of VerifiedState. */
export type HandoffSummary = Pick<VerifiedState, "goalId" | "iteration" | "gap" | "budget" | "decision">;

/**
 * Session-handoff doc (Epic 7, leaf 06). A warm session eventually hits the context-window ceiling;
 * the outer `scripts/converge.sh` while-loop then relaunches a FRESH `claude -p "$(…--handoff)"`
 * session seeded by ONLY this doc. The on-disk oracle (+ the failures sidecar) persists across the
 * cold seam, so no verified gain is lost and the ratchet still holds. The doc is a human-readable
 * continuation prompt with an embedded JSON block so it also round-trips programmatically
 * (`seedFromHandoff`) for tests and any machine reader.
 */
export function handoffDoc(state: VerifiedState): string {
	const summary: HandoffSummary = { goalId: state.goalId, iteration: state.iteration, gap: state.gap, budget: state.budget, decision: state.decision };
	return [
		`You are continuing an autonomous convergence loop toward the goal "${state.goalId}".`,
		`A prior warm session made progress and handed off at the context-window boundary — resume seamlessly; do NOT restart from scratch.`,
		``,
		`Verified state so far — iteration ${state.iteration}, gap ${state.gap}, budget ${state.budget.spent}/${state.budget.cap}:`,
		"```json",
		JSON.stringify(summary),
		"```",
		``,
		`Each turn, run exactly:  bun src/convergence-run.ts --goal ${state.goalId} --once`,
		`then do the single unit of work its planned frontier names, and let the Stop hook re-inject you.`,
		`The loop ends when the oracle reaches a terminal decision (converged / escalate / budget-exhausted).`,
	].join("\n");
}

/** Inverse of `handoffDoc` — extract the embedded verified-state summary; `null` if the doc carries no valid block. */
export function seedFromHandoff(doc: string): HandoffSummary | null {
	const m = doc.match(/```json\s*(\{[\s\S]*?\})\s*```/);
	if (!m) return null;
	try {
		const p = JSON.parse(m[1]) as Partial<HandoffSummary>;
		if (typeof p.goalId === "string" && typeof p.iteration === "number" && typeof p.gap === "number" && p.budget && p.decision) return p as HandoffSummary;
	} catch {
		/* fall through */
	}
	return null;
}

/**
 * Failures SIDECAR — carries the PRIOR iteration's suite failure-set across the `--once` process
 * boundary so the ratchet can compare turn-over-turn. Kept OUT of the oracle deliberately: the oracle
 * is the pinned cross-process schema (§1) that the bash hook re-implements, and it must not carry a
 * variable-length failure list. `readFailures` returning `null` (missing) marks the BASELINE turn —
 * the first turn establishes the set and is never ratcheted (a red starting tree is not a regression).
 */
export function failuresPath(stateDir: string = resolveStateDir()): string {
	return path.join(convergenceDir(stateDir), "failures.json");
}

export async function writeFailures(failures: string[], stateDir: string = resolveStateDir()): Promise<void> {
	const dir = convergenceDir(stateDir);
	await fs.mkdir(dir, { recursive: true });
	const dest = failuresPath(stateDir);
	const tmp = path.join(dir, `.failures.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	await fs.writeFile(tmp, JSON.stringify(failures));
	await fs.rename(tmp, dest);
}

/**
 * `null` when no prior turn recorded a set (the baseline turn — the sidecar simply doesn't exist
 * yet). THROWS when the sidecar EXISTS but is unreadable/corrupt (eap-borrows finding #16): the OLD
 * behavior collapsed "no prior turn" and "prior turn's real data is gone" into the SAME `null`,
 * silently re-baselining on corruption — the caller could never tell "first run" from "the sidecar
 * that proved a real regression just vanished". A corrupt sidecar must escalate, never quietly become
 * this turn's fresh floor.
 */
export async function readFailures(stateDir: string = resolveStateDir()): Promise<string[] | null> {
	let raw: string;
	try {
		raw = await fs.readFile(failuresPath(stateDir), "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null; // no prior turn — legitimate baseline
		throw new Error(classifyProbeFailure({ kind: "corrupt-state", detail: `failures sidecar unreadable: ${errText(err)}` }).reason);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(classifyProbeFailure({ kind: "corrupt-state", detail: `failures sidecar unparseable: ${errText(err)}` }).reason);
	}
	if (!Array.isArray(parsed)) {
		throw new Error(classifyProbeFailure({ kind: "corrupt-state", detail: `failures sidecar at ${failuresPath(stateDir)} is not an array` }).reason);
	}
	return parsed as string[];
}

/** Drop the sidecar when a loop terminates so the NEXT goal starts at its own baseline. */
export async function clearFailures(stateDir: string = resolveStateDir()): Promise<void> {
	await fs.rm(failuresPath(stateDir), { force: true });
}

/**
 * Write the arm sentinel — one half of the dual arm gate (the other is `OMP_SQUAD_LOOP_ARMED=1`,
 * checked only by the hook/entrypoint, never here).
 *
 * The sentinel CONTENT is the owning session's identity (S1): `scripts/continue-loop.sh` compares
 * the harness's `session_id` (turn-end stdin) against this stamped identity and blocks ONLY on a
 * match — so even if an unrelated concurrent fleet session in the same state dir inherits both
 * gates (a stale env flag + this shared sentinel), a mismatched `session_id` makes the hook a no-op
 * for it, closing the "the env flag alone cannot immortalize" hole (DESIGN.md §5). An empty
 * identity degrades to presence-gating (backward compatible), which is still safe under the
 * project-scoped hook + non-persisted env flag; pass the real session id for the robust guarantee.
 */
export async function arm(stateDir: string = resolveStateDir(), identity = ""): Promise<void> {
	const dir = convergenceDir(stateDir);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(armPath(stateDir), identity);
}

/** Remove the arm sentinel. Idempotent — disarming an already-unarmed state never throws. */
export async function disarm(stateDir: string = resolveStateDir()): Promise<void> {
	await fs.rm(armPath(stateDir), { force: true });
}

/** Whether the arm sentinel file is present. Synchronous (mirrors the hook's `[[ -f "$armed" ]]` check). */
export function isArmed(stateDir: string = resolveStateDir()): boolean {
	return existsSync(armPath(stateDir));
}

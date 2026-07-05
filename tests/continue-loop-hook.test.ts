/**
 * Stop-hook driver (Epic 7, leaf 04) — scripts/continue-loop.sh. Drives the REAL bash script as a
 * subprocess against a fixture oracle in a throwaway state dir, exercising every branch of the
 * decision table in plans/meta-autonomous-fleet/epic-7-convergence-loop/DESIGN.md §4.
 *
 * The UNARMED case (last describe block) is the most important test in this whole epic: it proves
 * a Stop hook registered project-wide (leaf 05's .claude/settings.json) can NEVER make an ordinary,
 * unarmed Claude Code session immortal.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const HOOK = path.join(REPO_ROOT, "scripts", "continue-loop.sh");

interface Oracle {
	goalId?: string;
	iteration?: number;
	gap?: number;
	epsilon?: number;
	pendingEscalation?: boolean;
	budget?: { spent: number; cap: number };
	decision?: string;
	updatedAt?: number;
}

function tmp(): string {
	return mkdtempSync(path.join(tmpdir(), "continue-loop-hook-"));
}

function writeOracle(stateDir: string, oracle: Oracle): void {
	mkdirSync(path.join(stateDir, "convergence"), { recursive: true });
	writeFileSync(path.join(stateDir, "convergence", "oracle.json"), JSON.stringify(oracle));
}

/** `identity` is the sentinel content the hook matches the harness `session_id` against (S1).
 *  Defaults to "" (empty ⇒ presence-gated, the backward-compatible path). */
function armSentinel(stateDir: string, identity = ""): void {
	mkdirSync(path.join(stateDir, "convergence"), { recursive: true });
	writeFileSync(path.join(stateDir, "convergence", "armed"), identity);
}

/** Drive the hook with a RAW stdin string (used for the M1 empty/malformed-stdin fail-closed tests). */
async function runHookRaw(stateDir: string, stdin: string, envOverrides: Record<string, string | undefined> = {}): Promise<{ stdout: string; code: number }> {
	const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
	for (const [k, v] of Object.entries(envOverrides)) if (v !== undefined) env[k] = v;
	env.OMP_SQUAD_STATE_DIR = stateDir;
	const proc = Bun.spawn(["bash", HOOK], { cwd: REPO_ROOT, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	proc.stdin.write(stdin);
	proc.stdin.end();
	const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	return { stdout: stdout.trim(), code };
}

async function runHook(stateDir: string, input: object, envOverrides: Record<string, string | undefined> = {}): Promise<{ stdout: string; code: number }> {
	return runHookRaw(stateDir, JSON.stringify(input), envOverrides);
}

const CONTINUABLE_ORACLE: Oracle = { goalId: "g", iteration: 2, gap: 3, epsilon: 0, pendingEscalation: false, budget: { spent: 2, cap: 50 }, decision: "continue", updatedAt: 0 };

describe("continue-loop.sh — armed session, decision table", () => {
	test("armed + gap>epsilon + budget left ⇒ emits a block decision", async () => {
		const dir = tmp();
		try {
			armSentinel(dir);
			writeOracle(dir, CONTINUABLE_ORACLE);
			const { stdout, code } = await runHook(dir, { stop_hook_active: false }, { OMP_SQUAD_LOOP_ARMED: "1" });
			expect(code).toBe(0);
			const parsed = JSON.parse(stdout);
			expect(parsed.decision).toBe("block");
			expect(parsed.reason).toContain("iteration 2, gap 3");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("gap <= epsilon (converged) ⇒ empty stdout, exit 0", async () => {
		const dir = tmp();
		try {
			armSentinel(dir);
			writeOracle(dir, { ...CONTINUABLE_ORACLE, gap: 0 });
			const { stdout, code } = await runHook(dir, { stop_hook_active: false }, { OMP_SQUAD_LOOP_ARMED: "1" });
			expect(stdout).toBe("");
			expect(code).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("pendingEscalation=true ⇒ empty stdout (hand off to human)", async () => {
		const dir = tmp();
		try {
			armSentinel(dir);
			writeOracle(dir, { ...CONTINUABLE_ORACLE, pendingEscalation: true });
			const { stdout, code } = await runHook(dir, { stop_hook_active: false }, { OMP_SQUAD_LOOP_ARMED: "1" });
			expect(stdout).toBe("");
			expect(code).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("budget.spent >= budget.cap ⇒ empty stdout (hard cap)", async () => {
		const dir = tmp();
		try {
			armSentinel(dir);
			writeOracle(dir, { ...CONTINUABLE_ORACLE, budget: { spent: 50, cap: 50 } });
			const { stdout, code } = await runHook(dir, { stop_hook_active: false }, { OMP_SQUAD_LOOP_ARMED: "1" });
			expect(stdout).toBe("");
			expect(code).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("decision !== continue (e.g. already escalate) ⇒ empty stdout", async () => {
		const dir = tmp();
		try {
			armSentinel(dir);
			writeOracle(dir, { ...CONTINUABLE_ORACLE, decision: "escalate" });
			const { stdout, code } = await runHook(dir, { stop_hook_active: false }, { OMP_SQUAD_LOOP_ARMED: "1" });
			expect(stdout).toBe("");
			expect(code).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("stop_hook_active=true ⇒ empty stdout (infinite-loop guard, never re-block a hook-driven turn)", async () => {
		const dir = tmp();
		try {
			armSentinel(dir);
			writeOracle(dir, CONTINUABLE_ORACLE);
			const { stdout, code } = await runHook(dir, { stop_hook_active: true }, { OMP_SQUAD_LOOP_ARMED: "1" });
			expect(stdout).toBe("");
			expect(code).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("missing/unreadable oracle ⇒ empty stdout (fail-safe, never trap a session)", async () => {
		const dir = tmp();
		try {
			armSentinel(dir); // no oracle.json written at all
			const { stdout, code } = await runHook(dir, { stop_hook_active: false }, { OMP_SQUAD_LOOP_ARMED: "1" });
			expect(stdout).toBe("");
			expect(code).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("corrupt (non-JSON) oracle ⇒ empty stdout (fail-safe)", async () => {
		const dir = tmp();
		try {
			armSentinel(dir);
			mkdirSync(path.join(dir, "convergence"), { recursive: true });
			writeFileSync(path.join(dir, "convergence", "oracle.json"), "not json {{{");
			const { stdout, code } = await runHook(dir, { stop_hook_active: false }, { OMP_SQUAD_LOOP_ARMED: "1" });
			expect(stdout).toBe("");
			expect(code).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("continue-loop.sh — UNARMED session is a strict no-op (the critical safety property)", () => {
	test("sentinel file absent, env flag set ⇒ empty stdout, exit 0 (never traps an unrelated session)", async () => {
		const dir = tmp();
		try {
			writeOracle(dir, CONTINUABLE_ORACLE); // no armSentinel() call — sentinel absent
			const { stdout, code } = await runHook(dir, { stop_hook_active: false }, { OMP_SQUAD_LOOP_ARMED: "1" });
			expect(stdout).toBe("");
			expect(code).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("sentinel file present, env flag UNSET ⇒ empty stdout, exit 0", async () => {
		const dir = tmp();
		try {
			armSentinel(dir);
			writeOracle(dir, CONTINUABLE_ORACLE);
			const { stdout, code } = await runHook(dir, { stop_hook_active: false }, { OMP_SQUAD_LOOP_ARMED: undefined });
			expect(stdout).toBe("");
			expect(code).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("both gates absent (the default, unarmed state of any ordinary session) ⇒ empty stdout, exit 0", async () => {
		const dir = tmp();
		try {
			writeOracle(dir, CONTINUABLE_ORACLE);
			const { stdout, code } = await runHook(dir, { stop_hook_active: false });
			expect(stdout).toBe("");
			expect(code).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("env flag set to a non-1 value (e.g. \"0\") with sentinel present ⇒ still a no-op", async () => {
		const dir = tmp();
		try {
			armSentinel(dir);
			writeOracle(dir, CONTINUABLE_ORACLE);
			const { stdout, code } = await runHook(dir, { stop_hook_active: false }, { OMP_SQUAD_LOOP_ARMED: "0" });
			expect(stdout).toBe("");
			expect(code).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("continue-loop.sh — identity gate (S1): a session_id that doesn't match the sentinel is a no-op", () => {
	test("armed + env set + oracle continuable, but sentinel identity ≠ stdin session_id ⇒ empty stdout (never hijacks an unrelated session)", async () => {
		const dir = tmp();
		try {
			armSentinel(dir, "session-A"); // the convergence run's own identity
			writeOracle(dir, CONTINUABLE_ORACLE);
			// A DIFFERENT concurrent fleet session in the same state dir that inherited the env flag +
			// shares the sentinel — its turn-end session_id does not match, so the hook must not block it.
			const { stdout, code } = await runHook(dir, { stop_hook_active: false, session_id: "session-B" }, { OMP_SQUAD_LOOP_ARMED: "1" });
			expect(stdout).toBe("");
			expect(code).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("matching sentinel identity + session_id ⇒ still blocks (the guard doesn't over-block the owner)", async () => {
		const dir = tmp();
		try {
			armSentinel(dir, "session-A");
			writeOracle(dir, CONTINUABLE_ORACLE);
			const { stdout, code } = await runHook(dir, { stop_hook_active: false, session_id: "session-A" }, { OMP_SQUAD_LOOP_ARMED: "1" });
			expect(code).toBe(0);
			expect(JSON.parse(stdout).decision).toBe("block");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("empty sentinel identity (no stamp) + a stdin session_id ⇒ presence-gated block (backward compatible)", async () => {
		const dir = tmp();
		try {
			armSentinel(dir, ""); // legacy / no-identity sentinel
			writeOracle(dir, CONTINUABLE_ORACLE);
			const { stdout, code } = await runHook(dir, { stop_hook_active: false, session_id: "session-Z" }, { OMP_SQUAD_LOOP_ARMED: "1" });
			expect(code).toBe(0);
			expect(JSON.parse(stdout).decision).toBe("block");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("continue-loop.sh — M1: the infinite-loop guard fails CLOSED on bad stdin", () => {
	test("empty stdin while armed ⇒ empty stdout (no block)", async () => {
		const dir = tmp();
		try {
			armSentinel(dir);
			writeOracle(dir, CONTINUABLE_ORACLE);
			const { stdout, code } = await runHookRaw(dir, "", { OMP_SQUAD_LOOP_ARMED: "1" });
			expect(stdout).toBe("");
			expect(code).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("malformed (non-JSON) stdin while armed ⇒ empty stdout (no block)", async () => {
		const dir = tmp();
		try {
			armSentinel(dir);
			writeOracle(dir, CONTINUABLE_ORACLE);
			const { stdout, code } = await runHookRaw(dir, "not json {{{", { OMP_SQUAD_LOOP_ARMED: "1" });
			expect(stdout).toBe("");
			expect(code).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/**
 * Compliance evaluator (Epic 3) — pure policy checks over the three append-only ledgers (audit,
 * land-forced, land-failures) plus leaf 03's validator-override ledger, so `/api/governance`
 * (src/server.ts) reports real policy findings instead of only RBAC + capacity, and the Observer
 * loop (leaf 06) can file/dedup the same findings through observe → file → confirm.
 *
 * v1 is deliberately narrow: audit.jsonl + the two land ledgers only. `src/dispatch-ledger.ts` is a
 * candidate v2 source, out of scope here. Every check is a small, named, pure function over injected
 * deps (mirrors `ObserverDeps` in src/observer.ts) — no direct `fs` reads inside this module.
 */

import type { AuditQuery } from "./audit.ts";
import type { ForcedLand, LandLedger, ValidatorOverride } from "./land-ledger.ts";
import type { AuditEntry } from "./types.ts";

export type ComplianceSeverity = "low" | "high" | "structural";

/** One detected policy violation. */
export interface ComplianceFinding {
	/** Stable machine-readable policy id (e.g. "forced-land-without-proof"). */
	code: string;
	severity: ComplianceSeverity;
	/** What the finding is about (typically a branch name). */
	subject: string;
	detail: string;
	at: number;
}

/** External edges the evaluator reads through — all injected so it runs headless in tests.
 *  `readAudit` is reserved for a v2 audit-log policy; no v1 check consumes it yet, mirroring how
 *  `ObserverDeps` carries deps some checks don't use. */
export interface ComplianceDeps {
	readAudit: (q?: AuditQuery) => Promise<AuditEntry[]>;
	forcedLands: () => ForcedLand[];
	/** Optional — absent (pre-leaf-03 callers, or old tests) ⇒ the validator-override policy is skipped. */
	validatorOverrides?: () => ValidatorOverride[];
	landLedger: () => LandLedger;
	now?: () => number;
}

/** Consecutive failed auto-lands before a branch counts as "repeatedly failing" — reuses the
 *  manager's default cap (mirrors `landFailCap()` in src/observer.ts). */
function landFailCap(): number {
	return Number(process.env.OMP_SQUAD_AUTOLAND_FAIL_CAP) || 3;
}

/** Policy 1 — any forced (proof-bypassing) land is a HIGH finding naming the branch + actor. */
export function forcedLandFindings(forced: ForcedLand[], now: number): ComplianceFinding[] {
	return forced.map((f) => ({
		code: "forced-land-without-proof",
		severity: "high" as const,
		subject: f.branch,
		detail: `${f.branch} was force-landed without a passing proof gate by ${f.actor}: ${f.detail}`,
		at: f.at ?? now,
	}));
}

/** Policy 2 — any validator-override is a STRUCTURAL finding: a semantic veto was bypassed. */
export function validatorOverrideFindings(overrides: ValidatorOverride[], now: number): ComplianceFinding[] {
	return overrides.map((o) => ({
		code: "validator-override",
		severity: "structural" as const,
		subject: o.branch,
		detail: `${o.branch}: validator veto overridden by ${o.actor} (${o.reasonClass}): ${o.detail}`,
		at: o.at ?? now,
	}));
}

/** Policy 3 — a branch whose auto-land has failed the acceptance gate `cap`+ times in a row. */
export function landRepeatedlyFailingFindings(ledger: LandLedger, cap: number, now: number): ComplianceFinding[] {
	const out: ComplianceFinding[] = [];
	for (const [branch, entry] of Object.entries(ledger)) {
		if (entry.fails < cap) continue;
		out.push({
			code: "land-repeatedly-failing",
			severity: "high",
			subject: branch,
			detail: `${branch} has failed auto-land ${entry.fails} time(s) in a row. Latest failure:\n${entry.lastDetail}`,
			at: entry.at ?? now,
		});
	}
	return out;
}

/** Run every policy check over the injected ledgers. Empty ledgers ⇒ `[]`. Never throws: each dep
 *  read is a synchronous in-memory/JSON read (or already-caught by the caller), so nothing here
 *  needs its own try/catch — a caller building `ComplianceDeps` from disk is what stays best-effort. */
export async function evaluateCompliance(deps: ComplianceDeps): Promise<ComplianceFinding[]> {
	const now = (deps.now ?? Date.now)();
	const findings: ComplianceFinding[] = [];
	findings.push(...forcedLandFindings(deps.forcedLands(), now));
	if (deps.validatorOverrides) findings.push(...validatorOverrideFindings(deps.validatorOverrides(), now));
	findings.push(...landRepeatedlyFailingFindings(deps.landLedger(), landFailCap(), now));
	return findings;
}

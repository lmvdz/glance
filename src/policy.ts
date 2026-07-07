/**
 * Policy-as-data (plans/policy-and-cost-gates/ concern C-STORE, research #2) — a runtime-mutable rule
 * table + one pure evaluator, shared by every enforcement seam via a thin per-seam adapter.
 *
 * TIGHTEN-ONLY BY CONSTRUCTION: a rule can only ever carry `deny` or `ask` (there is no allow-rule in
 * the schema). Base state is allow; a table can only SUBTRACT capability, so no rule set can widen
 * what's permitted — the tighten-only invariant is unrepresentable-to-violate rather than enforced by
 * tier machinery. FAIL-OPEN throughout: a missing/malformed `policy.json` ⇒ empty rules ⇒ base allow,
 * and an uncompilable rule regex is skipped (logged by the caller), never thrown.
 */

import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { writeFileDurable } from "./dal/store.ts";

export type PolicySeam = "tool_call" | "land" | "dispatch";
export type PolicyDecision = "deny" | "ask";

/** All present fields AND-match; an absent field is a wildcard. A field that references a dimension the
 *  subject doesn't carry (e.g. `commandMatches` against a land subject) simply doesn't match. */
export interface PolicyWhen {
	seam?: PolicySeam;
	tool?: string;
	/** Regex SOURCE tested against a tool_call subject's `command`. */
	commandMatches?: string;
	/** Regex SOURCE tested against ANY of a land subject's `changedFiles`. */
	pathMatches?: string;
	/** Land: match when `changedFiles.length >= minDiffFiles`. */
	minDiffFiles?: number;
	/** Land: match when `commitsBehind >= minCommitsBehind`. */
	minCommitsBehind?: number;
}

export interface PolicyRule {
	id: string;
	decision: PolicyDecision;
	when: PolicyWhen;
	reason: string;
}

export interface PolicyDoc {
	rules: PolicyRule[];
}

export type PolicySubject =
	| { seam: "tool_call"; tool: string; command?: string }
	| { seam: "land"; changedFiles: string[]; commitsBehind?: number }
	| { seam: "dispatch"; model?: string; tier?: string };

export interface PolicyVerdict {
	decision: PolicyDecision;
	reason: string;
	ruleId: string;
}

const POLICY_VERSION = 1;

function compile(source: string): RegExp | undefined {
	try {
		return new RegExp(source, "i");
	} catch {
		return undefined; // uncompilable rule regex ⇒ the rule simply never matches (fail-open)
	}
}

/** Does `rule.when` match `subject`? A `when` condition that can't apply to this subject shape is a
 *  non-match (the rule doesn't govern this seam), NOT a wildcard. Never throws. */
function ruleMatches(rule: PolicyRule, subject: PolicySubject): boolean {
	const w = rule.when;
	if (w.seam !== undefined && w.seam !== subject.seam) return false;

	if (w.tool !== undefined) {
		if (subject.seam !== "tool_call" || subject.tool !== w.tool) return false;
	}
	if (w.commandMatches !== undefined) {
		if (subject.seam !== "tool_call" || subject.command === undefined) return false;
		const re = compile(w.commandMatches);
		if (!re || !re.test(subject.command)) return false;
	}
	if (w.pathMatches !== undefined) {
		if (subject.seam !== "land") return false;
		const re = compile(w.pathMatches);
		if (!re || !subject.changedFiles.some((f) => re.test(f))) return false;
	}
	if (w.minDiffFiles !== undefined) {
		if (subject.seam !== "land" || subject.changedFiles.length < w.minDiffFiles) return false;
	}
	if (w.minCommitsBehind !== undefined) {
		if (subject.seam !== "land" || (subject.commitsBehind ?? 0) < w.minCommitsBehind) return false;
	}
	// An entirely-empty `when` matches every subject of any seam (a deliberate blanket rule).
	return true;
}

/**
 * Evaluate `rules` against `subject`. DENY wins over ASK; among same-decision matches the FIRST wins.
 * No match ⇒ `undefined` (allow — the base state). Pure and total.
 */
export function evalPolicy(rules: PolicyRule[], subject: PolicySubject): PolicyVerdict | undefined {
	let ask: PolicyVerdict | undefined;
	for (const rule of rules) {
		if (!ruleMatches(rule, subject)) continue;
		if (rule.decision === "deny") return { decision: "deny", reason: rule.reason, ruleId: rule.id };
		if (rule.decision === "ask" && !ask) ask = { decision: "ask", reason: rule.reason, ruleId: rule.id };
	}
	return ask;
}

// ── Persistence ───────────────────────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Coerce one raw entry into a PolicyRule, or undefined if unusable (dropped — fail-open to fewer rules). */
function parseRule(raw: unknown): PolicyRule | undefined {
	if (!isRecord(raw)) return undefined;
	const id = typeof raw.id === "string" ? raw.id : undefined;
	const decision = raw.decision === "deny" || raw.decision === "ask" ? raw.decision : undefined;
	const reason = typeof raw.reason === "string" ? raw.reason : undefined;
	if (!id || !decision || reason === undefined) return undefined;
	const rw = isRecord(raw.when) ? raw.when : {};
	const when: PolicyWhen = {};
	if (rw.seam === "tool_call" || rw.seam === "land" || rw.seam === "dispatch") when.seam = rw.seam;
	if (typeof rw.tool === "string") when.tool = rw.tool;
	if (typeof rw.commandMatches === "string") when.commandMatches = rw.commandMatches;
	if (typeof rw.pathMatches === "string") when.pathMatches = rw.pathMatches;
	if (typeof rw.minDiffFiles === "number" && Number.isFinite(rw.minDiffFiles)) when.minDiffFiles = rw.minDiffFiles;
	if (typeof rw.minCommitsBehind === "number" && Number.isFinite(rw.minCommitsBehind)) when.minCommitsBehind = rw.minCommitsBehind;
	return { id, decision, when, reason };
}

/** Parse a raw JSON value into a PolicyDoc, dropping any malformed rule. Never throws. */
export function parsePolicyDoc(raw: unknown): PolicyDoc {
	if (!isRecord(raw) || !Array.isArray(raw.rules)) return { rules: [] };
	return { rules: raw.rules.map(parseRule).filter((r): r is PolicyRule => r !== undefined) };
}

function fileFor(stateDir: string): string {
	return path.join(stateDir, "policy.json");
}

/** Synchronous read for the AGENT-process tool-call hook (which can't await a store). Fail-open to
 *  `{rules:[]}` on any error. Callers should mtime-cache this so a hot tool loop doesn't re-read. */
export function readPolicyDocSync(stateDir: string): PolicyDoc {
	try {
		return parsePolicyDoc(JSON.parse(readFileSync(fileFor(stateDir), "utf8")));
	} catch {
		return { rules: [] };
	}
}

/** Durable, runtime-mutable policy table at `<stateDir>/policy.json`. Mirrors RuntimeSettingsStore. */
export class PolicyStore {
	private readonly file: string;

	constructor(stateDir: string) {
		this.file = fileFor(stateDir);
	}

	async load(): Promise<PolicyDoc> {
		try {
			return parsePolicyDoc(JSON.parse(await fs.readFile(this.file, "utf8")));
		} catch {
			return { rules: [] };
		}
	}

	async save(doc: PolicyDoc): Promise<void> {
		await writeFileDurable(this.file, JSON.stringify({ version: POLICY_VERSION, rules: doc.rules }, null, 2));
	}

	/** Replace the whole rule set (sanitized). Returns the persisted doc. */
	async setRules(rules: PolicyRule[]): Promise<PolicyDoc> {
		const doc = parsePolicyDoc({ rules });
		await this.save(doc);
		return doc;
	}

	/** Add one rule (replacing any existing rule with the same id). Returns the persisted doc. */
	async addRule(rule: PolicyRule): Promise<PolicyDoc> {
		const doc = await this.load();
		const rules = [...doc.rules.filter((r) => r.id !== rule.id), rule];
		return this.setRules(rules);
	}

	/** Remove a rule by id. Returns the persisted doc. */
	async removeRule(id: string): Promise<PolicyDoc> {
		const doc = await this.load();
		return this.setRules(doc.rules.filter((r) => r.id !== id));
	}

	exists(): boolean {
		return existsSync(this.file);
	}
}

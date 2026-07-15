/**
 * Agent profiles + runtime model options — pure parsing/rendering extracted from the
 * squad-manager god-file (it re-exports these, so import paths are unchanged).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { envBool } from "./config.ts";
import type { AgentProfile, McpServerSpec, ThinkingLevel } from "./types.ts";
import { getHarness } from "./harness-registry.ts";

export interface RuntimeModelOption {
	label: string;
	value: string;
}

export function modelOptionsFromRuntime(models: unknown): RuntimeModelOption[] {
	if (!Array.isArray(models)) return [];
	const seen = new Set<string>();
	return models.flatMap((item): RuntimeModelOption[] => {
		if (!item || typeof item !== "object") return [];
		const rec = item as Record<string, unknown>;
		const id = typeof rec.id === "string" ? rec.id.trim() : "";
		if (!id) return [];
		const provider = typeof rec.provider === "string" ? rec.provider.trim() : "";
		const value = provider ? `${provider}/${id}` : id;
		if (seen.has(value)) return [];
		seen.add(value);
		return [{ label: value, value }];
	});
}

export function profileOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): AgentProfile[] {
	const configured = parseProfiles(env.OMP_SQUAD_PROFILES, "env");
	const fallback: AgentProfile = {
		id: "default",
		name: "Default OMP operator",
		description: "Live omp --mode rpc session with the daemon's default model and write approvals.",
		runtime: "omp-operator",
		approvalMode: "write",
		default: true,
	};
	return configured.length ? configured : [fallback];
}

const THINKING_LEVELS = new Set<ThinkingLevel>(["minimal", "low", "medium", "high", "xhigh"]);

const MCP_TYPES = new Set<McpServerSpec["type"]>(["stdio", "sse", "http"]);

/** A string→string record, tolerant of a malformed shape (missing ⇒ undefined, non-string values dropped). */
function parseStringRecord(v: unknown): Record<string, string> | undefined {
	if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
	const out: Record<string, string> = {};
	for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
		if (typeof val === "string") out[k] = val;
	}
	return Object.keys(out).length ? out : undefined;
}

/** Parse `AgentProfile.mcp` — tolerant of malformed entries (dropped silently, like `capabilities`'
 *  string filter); an entry missing `name` or a valid `type` is not a server at all. Does NOT enforce
 *  the repo-source RCE rule — that's the caller's job (mirrors how `bin`/`harness` are parsed first,
 *  then sanitized by `source` below). */
function parseMcpServers(raw: unknown): McpServerSpec[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out = raw.flatMap((item): McpServerSpec[] => {
		if (!item || typeof item !== "object") return [];
		const r = item as Record<string, unknown>;
		const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : "";
		const type = typeof r.type === "string" && MCP_TYPES.has(r.type as McpServerSpec["type"]) ? (r.type as McpServerSpec["type"]) : undefined;
		if (!name || !type) return [];
		return [{
			name,
			type,
			command: typeof r.command === "string" ? r.command : undefined,
			args: Array.isArray(r.args) ? r.args.filter((v): v is string => typeof v === "string") : undefined,
			env: parseStringRecord(r.env),
			url: typeof r.url === "string" ? r.url : undefined,
			headers: parseStringRecord(r.headers),
			enabled: typeof r.enabled === "boolean" ? r.enabled : undefined,
		}];
	});
	return out.length ? out : undefined;
}

/** `source` distinguishes operator-set env profiles (fully trusted) from `.glance/profiles.json`
 *  (repo-committed — anyone who can open a PR can edit it). A "repo" profile is sanitized: `bin`
 *  is dropped outright (it flows unchecked to `Bun.spawn` — RCE if a repo could set it), `harness`
 *  is rejected unless it names a *verified* registered harness (an unverified one is already hidden
 *  from every other create surface; letting a repo file pick one anyway would be a backdoor around
 *  that gate), and `mcp` is dropped ENTIRELY (a `stdio` server is `{command,args}` — the SAME RCE
 *  class as `bin` — so there is no partial-trust merge, unlike env↔repo profile merging by id
 *  elsewhere: a repo profile simply may not define MCP servers). Each rejection logs a console.warn
 *  naming the field and profile id — loud, not a silent drop. */
function parseProfiles(raw: string | undefined, source: "env" | "repo" = "env"): AgentProfile[] {
	if (!raw?.trim()) return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap((item): AgentProfile[] => {
			if (!item || typeof item !== "object") return [];
			const r = item as Record<string, unknown>;
			const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : "";
			const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : id;
			const runtime = r.runtime === "flue-service" || r.runtime === "workflow" ? r.runtime : "omp-operator";
			const thinking = typeof r.thinking === "string" && THINKING_LEVELS.has(r.thinking as ThinkingLevel) ? (r.thinking as ThinkingLevel) : undefined;
			if (!id) return [];
			let bin = typeof r.bin === "string" ? r.bin : undefined;
			let harness = typeof r.harness === "string" ? r.harness : undefined;
			let mcp = parseMcpServers(r.mcp);
			if (source === "repo") {
				if (bin !== undefined) {
					console.warn(`[agent-profiles] repo profile "${id}" sets "bin" — dropped (a repo-committed profile cannot set a binary override, it would be arbitrary code execution)`);
					bin = undefined;
				}
				if (harness !== undefined && !getHarness(harness)?.verified) {
					console.warn(`[agent-profiles] repo profile "${id}" sets harness "${harness}" — rejected (repo-committed profiles may only select a verified registered harness)`);
					harness = undefined;
				}
				if (mcp !== undefined) {
					console.warn(`[agent-profiles] repo profile "${id}" sets "mcp" — dropped (a repo-committed profile cannot define inline MCP servers: a stdio server is {command,args}, the same arbitrary-code-execution class as "bin")`);
					mcp = undefined;
				}
			}
			return [{
				id,
				name,
				description: typeof r.description === "string" ? r.description : undefined,
				runtime,
				harness,
				bin,
				mcp,
				model: typeof r.model === "string" ? r.model : undefined,
				thinking,
				approvalMode: r.approvalMode === "always-ask" || r.approvalMode === "write" || r.approvalMode === "yolo" ? r.approvalMode : undefined,
				capabilities: Array.isArray(r.capabilities) ? r.capabilities.filter((v): v is string => typeof v === "string") : undefined,
				memory: typeof r.memory === "string" ? r.memory : undefined,
				default: r.default === true,
			}];
		});
	} catch {
		return [];
	}
}

/** Shareable project profile catalog, `<repoRoot>/.glance/profiles.json` — same array shape as
 *  `OMP_SQUAD_PROFILES` but sanitized as repo-sourced input (see `parseProfiles`). Missing file (the
 *  common case) or unreadable/corrupt JSON → `[]`, never throws. */
export function loadRepoProfiles(repoRoot: string): AgentProfile[] {
	try {
		const file = path.join(repoRoot, ".glance", "profiles.json");
		if (!fs.existsSync(file)) return [];
		return parseProfiles(fs.readFileSync(file, "utf8"), "repo");
	} catch {
		return [];
	}
}

/** Render a capability profile's tool-grant allow-list as a hard system-prompt constraint. This is the part
 *  of capability tool-scoping (#3) that reaches the omp child (via --append-system-prompt); host tool calls
 *  outside the list are additionally hard-denied at the onHostTool seam. Returns undefined for an empty grant. */
export function toolGrantsPrompt(grants: string[] | undefined): string | undefined {
	if (!grants || grants.length === 0) return undefined;
	return [
		"--- Capability tool grant (hard constraint) ---",
		`You are scoped to ONLY these tools: ${grants.join(", ")}.`,
		"Do not use, request, or attempt any tool outside this list. Tool calls outside the grant are denied by the host.",
	].join("\n");
}

// ── Membrane disciplines (eap-borrows concern 05) ──────────────────────────────────────────────────
// Prompt-only output disciplines: glance-native blocks (concepts from EAP, wording ours). Advisory
// text only — never enforced by the host, unlike toolGrantsPrompt's hard constraint above. v1 ships
// `VERDICT_FIRST_BLOCK` unconditionally on output-shaped judge/planner surfaces (validator.ts,
// planner.ts); both blocks are additionally offered to implementer units as opt-in profile tokens
// (below), double-gated so a single bad rollout can't silently degrade the whole fleet.

/** Never applies to a safety refusal, a destructive-action warning, or raw error text — those three
 *  carve-outs are byte-exact: the instruction below is deliberately worded to name them so a model
 *  reading it doesn't reach for "conclusion first" phrasing on text that must read unmodified. */
export const VERDICT_FIRST_BLOCK = [
	"--- Output discipline: verdict-first ---",
	"State your bottom-line verdict or conclusion in the FIRST sentence, before any supporting reasoning — " +
		"elaborate afterward, never before. This does NOT apply to (byte-exact carve-outs, unmodified either way): " +
		"a safety refusal, a destructive-action warning, or raw error text.",
].join("\n");

/** 7 rungs, climbed only as far as the task needs. Hard carve-outs always get full treatment
 *  regardless of rung — the whole point of a minimal-code discipline is a smaller footprint on the
 *  EASY paths, never on the ones where under-building is a real defect. */
export const MINIMAL_CODE_BLOCK = [
	"--- Output discipline: minimal-code ladder ---",
	"Match the code you write to the size of the problem — climb this ladder only as far as the task needs: " +
		"(1) no code, just answer or explain; (2) one expression; (3) one function; (4) one function plus one test; " +
		"(5) a small module; (6) a module plus tests; (7) a full feature with tests and docs. Hard carve-outs — " +
		"ALWAYS get full treatment no matter the rung: input validation, data-loss handling, and security-sensitive " +
		"code; every non-trivial path still gets at least one runnable check.",
].join("\n");

/** The only two recognized `membrane:*` profile-capability tokens (receipts.ts#EFFICIENCY_FLAG_PREFIX). */
const MEMBRANE_BLOCKS: Readonly<Record<string, string>> = {
	"membrane:verdict-first": VERDICT_FIRST_BLOCK,
	"membrane:minimal-code": MINIMAL_CODE_BLOCK,
};

/** Double gate #2 (DESIGN.md "Membrane placement": "profile opt-in AND OMP_SQUAD_MEMBRANE_PROFILES=1").
 *  Gate #1 is the profile itself naming a `membrane:*` token; this is the runtime kill switch for the
 *  WHOLE subsystem, OFF by default (see runtime-settings.ts's `OMP_SQUAD_MEMBRANE_PROFILES` — the SAME
 *  env var; `RuntimeSettingsStore.setFeatureFlag`/`applyFeatureFlags` writes it, so a persisted setting
 *  and this live env read never disagree, and the auto-disable breaker flips it here too). */
export function membraneProfilesEnabled(): boolean {
	return envBool("OMP_SQUAD_MEMBRANE_PROFILES", false);
}

/**
 * Apply double gate #2 plus unknown-token detection to a profile's REQUESTED membrane tokens
 * (receipts.ts#splitCapabilityTokens's `requested` output — gate #1 already passed by the time that's
 * non-empty). Gate #2 off ⇒ every membrane token is a silent no-op (an operator disabling the feature
 * is not a typo — no warning). Gate #2 on ⇒ an unrecognized `membrane:*` string DOES warn (once per
 * call): a typo would otherwise look like a working feature that silently never does anything. Returns
 * undefined when nothing survives, so callers can `[a, b, gateMembraneTokens(...), c].filter(Boolean)`
 * exactly like every other optional appendSystemPrompt segment.
 */
export function gateMembraneTokens(requested: string[] | undefined, profileId?: string): string[] | undefined {
	if (!requested?.length) return undefined;
	if (!membraneProfilesEnabled()) return undefined;
	const known = requested.filter((token) => {
		if (token in MEMBRANE_BLOCKS) return true;
		console.warn(`[agent-profiles] unrecognized membrane token "${token}"${profileId ? ` on profile "${profileId}"` : ""} — ignored (known tokens: ${Object.keys(MEMBRANE_BLOCKS).join(", ")})`);
		return false;
	});
	return known.length ? known : undefined;
}

/** Render the discipline text for an ALREADY-GATED token list (see `gateMembraneTokens` — this function
 *  does not itself re-check gate #2 or warn on unknown tokens, mirroring `toolGrantsPrompt`'s "pure
 *  render, gating is the caller's job" shape). Undefined for an empty/undefined list. */
export function membraneDisciplinePrompt(gatedTokens: string[] | undefined): string | undefined {
	if (!gatedTokens?.length) return undefined;
	const blocks = [...new Set(gatedTokens)].map((token) => MEMBRANE_BLOCKS[token]).filter((b): b is string => !!b);
	return blocks.length ? blocks.join("\n\n") : undefined;
}

// ── Evergreen Do-Not block (skills-hardening concern 04) ────────────────────────────────────────────
// Distilled from this repo's recorded recurring failure modes (memory lessons + failure-memory
// annotations), phrased to name the rationalization where one is known (the negative-space-spec
// pattern). UNLIKE the membrane blocks above, this is never profile-gated and never opt-in — it rides
// squad-manager.ts's UNCONDITIONAL appendSystemPrompt join (createWithId, alongside the primer +
// authored-spec joins), specifically NOT via `profile.memory` (only assembled `if (profile)` — a
// profile-less dispatched unit never reaches that branch: the exact delivery-gap class R3 fixed for the
// primer, since `dispatchSpawn` calls `create({repo, name, branch, task, issue})` with no profileId).
// Static repo-authored text, so — unlike the primer/authored-spec blocks, which fence fabric/issue-
// sourced content as untrusted — no fence is needed here.
export const DO_NOT_BLOCK = [
	"--- Do-Not: recurring failure modes ---",
	"Do not report the Vite/bundler chunk-size warning as a finding — it is known and benign in this repo.",
	"Do not re-run a failing verify loop a third time hoping for a different outcome — after two failures, stop and report the blocker.",
	'Do not treat a passing test suite as proof the gate ran — a gate that never executed also prints no failures; check for evidence the tests actually ran (e.g. "N pass").',
	"Do not trust `git grep 'a|b'` without -E — bare alternation silently matches nothing.",
	"Do not trust empty grep/search output from a wrapped shell — verify a null result with a second, differently-shaped query before concluding absence.",
	"Do not use bare `git stash`/`git stash pop` — the stash stack is shared across worktrees and other sessions; make a WIP commit instead.",
	"Do not conclude a feature is unwired from one call-site search — check exports, dynamic dispatch, and registration tables before claiming zero callers.",
	"Do not delete or overwrite a file you did not create without reading it first.",
	"Do not mark work done because the diff looks right — run the affected flow and observe it.",
	"Do not widen scope to fix adjacent code you were not asked to touch — report it instead.",
].join("\n");

/** Loose but code-shaped match for "this task/issue is about the `effect` library" — bare word "effect"
 *  is too noisy (it is common English), so this also accepts the shapes that only show up in code:
 *  an import specifier (`effect/...`, `from "effect"`) or a version pin (`effect@...`). Capital-E
 *  "Effect" (the module/type name) is the common case for prose task text. */
const EFFECT_TASK_PATTERN = /\bEffect\b|\beffect\/|from ["']effect["']|\beffect@/;

/** Resolved once at daemon start (module load), not per-spawn — `effectSkillPointerLine` below is
 *  called on every create(), and re-reading + re-parsing package.json that often is wasted work for a
 *  value that cannot change without a daemon restart. */
function resolveEffectVersion(): string | undefined {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		return pkg.dependencies?.effect ?? pkg.devDependencies?.effect;
	} catch {
		return undefined;
	}
}
const EFFECT_RESOLVED_VERSION = resolveEffectVersion();
const EFFECT_SKILL_DIR = path.join(import.meta.dir, "..", ".claude", "skills", "effect");

/**
 * A pointer line appended ONLY when (a) the unit's task/issue text looks Effect-shaped and (b) the
 * vendored `.claude/skills/effect` directory actually exists. (b) matters because this concern lands
 * BEFORE the concern that vendors the skill (skills-hardening concern 02) — without the gate, every
 * Effect-shaped unit would be pointed at a skill directory that doesn't exist yet. Checked fresh (not
 * cached) so the pointer starts firing the moment the skill lands, with no daemon restart required.
 *
 * `skillDir` defaults to this repo's real vendored path; callers never pass it — it's an injection seam
 * so tests can exercise the "directory exists" branch without mutating the real repo tree.
 */
export function effectSkillPointerLine(text: string | undefined, skillDir: string = EFFECT_SKILL_DIR): string | undefined {
	if (!EFFECT_RESOLVED_VERSION || !text || !EFFECT_TASK_PATTERN.test(text)) return undefined;
	if (!fs.existsSync(skillDir)) return undefined;
	return `This repo pins effect@${EFFECT_RESOLVED_VERSION}; load .claude/skills/effect before writing Effect code — its examples are compile-proven at that pin.`;
}

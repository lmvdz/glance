/**
 * Harness registry — the plug-and-play seam for running units on any coding-agent harness
 * (omp, pi, claude-code, codex, opencode, gemini-cli, …) behind the one `AgentDriver` contract.
 *
 * A harness is pure data here: a name, a wire PROTOCOL (`omp-rpc` | `acp`), the binary/command to
 * launch, a CapabilityDescriptor (what the runtime can and can't do), and a `verified` flag. The
 * SquadManager's `makeDriver` maps a descriptor's protocol onto a concrete driver class (RpcAgent
 * for omp-rpc, AcpAgentDriver for acp) — this module owns only selection, config, and capabilities,
 * never the transport code.
 *
 * Vocabulary decision (see plans/harness-agnostic-drivers/DESIGN.md): omp stays the internal event/
 * state vocabulary (Option B). Every non-omp driver translates its native protocol INTO omp's frame
 * shape (as AcpAgentDriver already does). So a harness descriptor never redefines the wire format —
 * it only says which transport speaks it and what the runtime is capable of.
 */

import * as path from "node:path";
import { harnessLineage } from "./model-lineage.ts";

export type HarnessProtocol = "omp-rpc" | "acp";

/** What a harness's runtime can and cannot do — read once at agent creation to gate behavior and
 *  degrade gracefully, instead of scattering `runtime === "acp"` string checks through the manager. */
export interface CapabilityDescriptor {
	/** Has a host-tool channel (omp `set_host_tools`). false ⇒ squad_message/squad_kb_search are
	 *  unavailable and their advertisement is skipped (documented, not a silent no-op). */
	hostTools: boolean;
	/** How tool approval is enforced. "native" = per-call request/approve round-trip; "none" = no
	 *  channel at all (runs with host perms — only `yolo` is coherent, stricter modes are rejected at
	 *  create()); "preauth-allowlist" = tools are declared up front, not negotiated per call. */
	toolApproval: "native" | "none" | "preauth-allowlist";
	/** Survives a daemon restart (a detached host over a socket, or ACP session/load). false ⇒ the
	 *  agent is excluded from the reattach/adopt path so a restart doesn't orphan-kill or cold-adopt it. */
	resumable: boolean;
	/** Can switch model mid-session. */
	modelSwitch: boolean;
	/** Honors a reasoning-effort / thinking level. */
	thinking: boolean;
	/** How omp-squad context (fabric primer, tool-grant scoping, appendSystemPrompt) reaches the agent.
	 *  "native" = a real system-prompt channel (omp/pi `--append-system-prompt`); "none" = no channel
	 *  (the agent runs unscoped — surfaced loudly); "mcp" = injected via an MCP server (ACP's only
	 *  spec-blessed context channel — see concern 06). */
	contextInjection: "native" | "none" | "mcp";
}

export interface HarnessDescriptor {
	name: string;
	protocol: HarnessProtocol;
	/** argv[0] for the harness binary. For omp-rpc this is the CLI (`omp`/`pi`); for acp it is the
	 *  ACP command's argv[0] (mirrors `acpCommand[0]`). */
	bin: string;
	/** ACP-only: the full launch command, e.g. `["gemini","--acp"]`, `["opencode","acp"]`,
	 *  `["npx","-y","@zed-industries/claude-code-acp"]`. omp-rpc harnesses leave this undefined. */
	acpCommand?: string[];
	/** ACP-only: how a pinned model joins the launch argv. The DEFAULT appends `--model <m>` to the end
	 *  of `acpCommand`, which is right for flag-style entrypoints (`auggie --acp --model m`). It is WRONG
	 *  for harnesses whose model flag belongs to a PARENT command rather than the ACP subcommand — grok's
	 *  `--model` is an option of `grok agent`, so `grok agent stdio --model m` dies with "unexpected
	 *  argument '--model'" (live-verified). Such harnesses override this to place the flag correctly. */
	acpModelArgv?: (model: string) => string[];
	/** omp-rpc-only: the approval-flag dialect (omp uses `--approval-mode <mode>`, pi uses
	 *  `--approve`/`--no-approve`). Kept here so the arg builder never hardcodes per-harness knowledge. */
	approvalArgs?: (mode: string) => string[];
	/** omp-rpc-only: whether omp-squad's soft-lease extension (`-e lease-hook.ts`) loads on this
	 *  harness. omp: yes; pi: unverified, so off (pi runs without soft-leasing — documented degradation). */
	leaseHook?: boolean;
	/** omp-rpc-only: whether the child emits an unsolicited `{"type":"ready"}` frame on startup. omp does;
	 *  pi does NOT (it's ready-on-first-command). When false, the agent-host probes with a get_state after
	 *  spawn and marks the child ready on the first response frame. Default true. */
	emitsReadyFrame?: boolean;
	capabilities: CapabilityDescriptor;
	/** false = registered but NOT smoke-verified against a live binary. Hidden from the create surfaces
	 *  unless `OMP_SQUAD_UNVERIFIED_HARNESS=1`. Only a live smoke flips this true — a green fake-server
	 *  test does not (see concern 08). */
	verified: boolean;
	/** Token/usage mapping for this harness is live-verified (field names confirmed against a real
	 *  session, not just typed against a spec). Absent/false ⇒ honest default: ACP's `parseUsage` is
	 *  unconfirmed against any live harness (acp-agent-driver.ts:118, "ponytail" note), so every ACP
	 *  descriptor is unset here until a live smoke confirms its usage_update field names. omp/pi ride
	 *  the same RPC usage frame omp's own dashboards have always trusted, so they're true. This is a
	 *  label only — concern 01's per-cell token-coverage publish gate is the actual enforcement. */
	usageVerified?: boolean;
	/** Human-facing caveat, e.g. "adapter mid-migration between orgs — pin a version". */
	note?: string;
}

export const DEFAULT_HARNESS = "omp";

const registry = new Map<string, HarnessDescriptor>();

export function registerHarness(d: HarnessDescriptor): void {
	registry.set(d.name, d);
}

export function getHarness(name: string): HarnessDescriptor | undefined {
	return registry.get(name);
}

export function hasHarness(name: string): boolean {
	return registry.has(name);
}

export function unverifiedHarnessesEnabled(): boolean {
	return process.env.OMP_SQUAD_UNVERIFIED_HARNESS === "1";
}

/** All registered harnesses; unverified ones only when `includeUnverified` (default: gated on
 *  OMP_SQUAD_UNVERIFIED_HARNESS=1) — so the create UI/CLI never offers a harness that half-works. */
export function listHarnesses(includeUnverified = unverifiedHarnessesEnabled()): HarnessDescriptor[] {
	return [...registry.values()].filter((d) => d.verified || includeUnverified);
}

// ── Honesty tiers (additive; the four `verified` gate sites above stay byte-identical) ─────────

/** Honest capability tier, computed from static `verified` × live binary detection — never a
 *  substitute for the `verified` gate, only a truthful label alongside it. */
export type HarnessTier = "verified" | "detected-unverified" | "registered-unverified";

export interface HarnessTierInfo {
	name: string;
	tier: HarnessTier;
	/** Mirrors the descriptor's static `verified` — the gate's own truth, unchanged. */
	verified: boolean;
	/** Binary resolvable on the daemon's actual launch PATH right now (see `resolveSpawnBin`). */
	binDetected: boolean;
	/** See `HarnessDescriptor.usageVerified`. */
	usageVerified: boolean;
	/** Set only when `verified:true` but the binary can't be found — a verified harness that will
	 *  fail to spawn is a worse trap than an honestly-unverified one, so this is surfaced loudly
	 *  instead of silently degrading to a green-looking row. */
	alert?: string;
	note?: string;
}

/** The argv[0] SPAWN actually launches for `d`: `resolveBin` for omp-rpc (per-agent/GLANCE_BIN
 *  override chain), the ACP command's own argv[0] for acp (squad-manager.ts's makeDriver never
 *  touches `d.bin` for ACP — see acpCommand usage there). Never `d.bin` unconditionally: that would
 *  report "codex not found" for the codex descriptor when the real launch is `npx`. */
export function resolveSpawnBin(d: HarnessDescriptor): string {
	if (d.protocol === "acp") return d.acpCommand?.[0] ?? d.bin;
	return resolveBin(d);
}

/** true when `bin` resolves on a PATH that matches how the daemon actually launches it: the raw
 *  env PATH, ALSO augmented with `<cwd>/node_modules/.bin` (npm/bun script invocation prepends
 *  this; a bare `Bun.which` from a differently-invoked process — e.g. this CLI itself — can miss it
 *  and falsely alarm on `omp`, which is never installed globally, only as a local devDependency). */
function binResolvable(bin: string, cwd: string = process.cwd()): boolean {
	const augmentedPath = `${path.join(cwd, "node_modules", ".bin")}${path.delimiter}${process.env.PATH ?? ""}`;
	return Bun.which(bin, { PATH: augmentedPath, cwd }) !== null;
}

/** Pure combinator: static `verified` × live `binDetected` → an honest tier + optional alert.
 *  Never used at a gate site — `verified` stays the sole enforcement bit everywhere it's checked. */
export function harnessTierInfo(d: HarnessDescriptor, cwd?: string): HarnessTierInfo {
	const bin = resolveSpawnBin(d);
	const binDetected = binResolvable(bin, cwd);
	const usageVerified = d.usageVerified === true;
	let tier: HarnessTier;
	let alert: string | undefined;
	if (d.verified) {
		tier = "verified";
		if (!binDetected) alert = `${d.name}: verified but "${bin}" was not found on the daemon PATH`;
	} else {
		tier = binDetected ? "detected-unverified" : "registered-unverified";
	}
	// npx-shelled acp adapters (claude-code, codex) resolve "npx" — a near-universal binary that says
	// nothing about the actual `-y @scope/pkg` adapter working. Documented, not hidden.
	const note = d.protocol === "acp" && (d.acpCommand?.[0] === "npx") ? [d.note, `binary check resolves "npx" only — a weak signal for the shelled ${d.acpCommand?.slice(1).join(" ")} adapter`].filter(Boolean).join("; ") : d.note;
	return { name: d.name, tier, verified: d.verified, binDetected, usageVerified, alert, note };
}

let tierCache: { at: number; cwd: string; rows: HarnessTierInfo[] } | undefined;
const TIER_CACHE_MS = 5_000; // short: cheap to recompute, but per-render `which()` on every list poll is wasteful/flappy

/** All REGISTERED harnesses (verified and not — the honest full roster) with tiers, cached briefly
 *  so a listing endpoint hit repeatedly (webapp poll, CLI table) doesn't `which()` on every call. */
export function listHarnessTiers(cwd: string = process.cwd()): HarnessTierInfo[] {
	const now = Date.now();
	if (tierCache && tierCache.cwd === cwd && now - tierCache.at < TIER_CACHE_MS) return tierCache.rows;
	const rows = [...registry.values()].map((d) => harnessTierInfo(d, cwd));
	tierCache = { at: now, cwd, rows };
	return rows;
}

/** Test-only: drop the cache so a test that registers/mutates harnesses sees fresh detection. */
export function _resetHarnessTierCacheForTests(): void {
	tierCache = undefined;
}

/**
 * True when a second VERIFIED harness is enabled whose static vendor pin (`harnessLineage`) differs
 * from the default harness's — the precondition for the per-provider degradation ladder (concern 06,
 * plans/research-sirvir/06-degradation-ladder.md) to have any real differentiation to act on. omp/pi/
 * opencode are multi-model runtimes with NO static vendor pin (`harnessLineage` reads "unknown" for
 * all three — see model-lineage.ts), so this stays false until a vendor-pinned ACP harness (claude-code,
 * gemini, codex, grok) is BOTH registered `verified:true` AND distinct from the default harness's lineage.
 *
 * As of the grok registration (2026-07-09) this is TRUE on a default `omp` fleet: grok is `verified:true`
 * (live ACP smoke) and pinned to `xai`, which differs from omp's `unknown` baseline. The ladder is
 * therefore ACTIVE, not inert — dispatch.ts now has a real second subscription lane to pause against,
 * which is exactly what concern 06 was built for. Removing grok (or flipping it back to `verified:false`)
 * returns this to false and the ladder to its logged-inert state.
 *
 * VERIFIED-ONLY by contract: `listHarnesses(false)` — the OMP_SQUAD_UNVERIFIED_HARNESS=1 escape hatch
 * (which lets `listHarnesses()`' default surface unverified harnesses on create UIs) must NOT let an
 * unsmoked codex/gemini registration convince the dispatcher a real second subscription lane exists.
 */
export function hasSecondVerifiedProviderLane(defaultHarness: string = globalDefaultHarness()): boolean {
	const baseline = harnessLineage(defaultHarness);
	return listHarnesses(false).some((d) => {
		if (d.name === defaultHarness) return false;
		const lineage = harnessLineage(d.name);
		return lineage !== "unknown" && lineage !== baseline;
	});
}

/** The operator's global default harness: `GLANCE_HARNESS` env, else "omp". */
export function globalDefaultHarness(): string {
	const h = process.env.GLANCE_HARNESS?.trim();
	return h && h.length > 0 ? h : DEFAULT_HARNESS;
}

/** Legacy `runtime` field → harness name. On-disk records predating `harness` carry `runtime:"omp"|"acp"`;
 *  `"acp"` could only ever have meant the hardcoded `auggie --acp`. Returns undefined for absent runtime. */
export function runtimeToHarness(runtime?: string): string | undefined {
	if (runtime === "acp") return "auggie";
	if (runtime === "omp") return "omp";
	return undefined;
}

/** Resolve the harness NAME for a record: explicit `harness` > legacy `runtime` alias > global default.
 *  This is the single migration choke point — never read `.harness` raw elsewhere. */
export function resolveHarnessName(p: { harness?: string; runtime?: string }): string {
	return p.harness ?? runtimeToHarness(p.runtime) ?? globalDefaultHarness();
}

/** Resolve the descriptor. Throws for an unknown name so create() fails loudly rather than silently
 *  falling back to omp (which is exactly the restart-respawns-ACP-as-omp bug this replaces). */
export function resolveHarness(p: { harness?: string; runtime?: string }): HarnessDescriptor {
	const name = resolveHarnessName(p);
	const d = registry.get(name);
	if (!d) throw new Error(`unknown harness "${name}" — registered: ${[...registry.keys()].join(", ") || "(none)"}`);
	return d;
}

/**
 * The full ACP launch argv for a descriptor, with an optional pinned model folded in. THE one place
 * that knows how a model joins an ACP command line — call sites must never re-append `--model`
 * themselves, because the flag's correct POSITION is per-harness (see `acpModelArgv`).
 *
 * Returns undefined for non-ACP (omp-rpc) harnesses, which carry no acpCommand.
 */
export function resolveAcpCommand(d: HarnessDescriptor, model?: string): string[] | undefined {
	if (!d.acpCommand) return undefined;
	if (!model) return [...d.acpCommand];
	if (d.acpModelArgv) return d.acpModelArgv(model);
	return [...d.acpCommand, "--model", model];
}

/**
 * Will `appendSystemPrompt` (fabric primer, tool-grant scoping, profile memory, authored spec) actually
 * REACH the agent this record will spawn?
 *
 * The registry has always DECLARED this per harness (`capabilities.contextInjection`), but nothing
 * consulted it: the harness scorecard credited a unit with "instructions" whenever a primer was BUILT,
 * regardless of whether the driver had any channel to deliver it. An `auggie`/ACP unit scored
 * `hasInstructions: true` while running with an empty system prompt — the scorecard was measuring our
 * intent, not the agent's reality. Same class of defect as the `primer-empty` metric that lived inside
 * the branch it was meant to measure. (gpt-5.6-sol)
 *
 * A workflow unit's context reaches its inner omp `RpcAgent`, and a sandboxed unit's reaches the omp
 * child inside the container — both native. ACP has no system-prompt slot at all; it delivers only when
 * the operator opts into the lossy first-turn injection (`OMP_SQUAD_ACP_CONTEXT=prompt`).
 */
export function contextReachesAgent(p: { harness?: string; runtime?: string; sandbox?: unknown; workflow?: unknown; flue?: unknown }, env: NodeJS.ProcessEnv = process.env): boolean {
	// A flue-service unit runs `flue run`. It is not an agent harness at all and has no system-prompt
	// channel of any kind — checked FIRST, because a flue unit may also carry a workflow. (gpt-5.6-sol)
	if (p.flue) return false;
	if (p.workflow || p.sandbox) return true; // inner agent is omp over rpc — a native channel
	let d: HarnessDescriptor;
	try {
		d = resolveHarness(p);
	} catch {
		return false; // unknown harness ⇒ never CLAIM delivery (create() will throw anyway)
	}
	if (d.capabilities.contextInjection === "native") return true;
	if (d.protocol === "acp") return env.OMP_SQUAD_ACP_CONTEXT === "prompt";
	return false;
}

/** Resolve the binary (argv[0]) for a descriptor: per-agent override > GLANCE_BIN for the default
 *  harness > the descriptor's own bin. GLANCE_BIN only overrides the DEFAULT harness (a custom omp
 *  fork at a nonstandard path), never every harness. */
export function resolveBin(d: HarnessDescriptor, perAgentBin?: string): string {
	if (perAgentBin) return perAgentBin;
	if (d.name === globalDefaultHarness() && process.env.GLANCE_BIN?.trim()) return process.env.GLANCE_BIN.trim();
	return d.bin;
}

// ── Built-in harnesses ──────────────────────────────────────────────────────────────────────────
// Registered at module load (pure data — no driver imports, no cycles). External harnesses default
// to verified:false and are hidden until a live smoke (concern 08) proves them.

const NATIVE_CAPS: CapabilityDescriptor = {
	hostTools: true,
	toolApproval: "native",
	resumable: true,
	modelSwitch: true,
	thinking: true,
	contextInjection: "native",
};

const ACP_CAPS: CapabilityDescriptor = {
	hostTools: false, // ACP has no host-tool channel — squad_message/squad_kb_search unavailable
	toolApproval: "native", // ACP session/request_permission round-trip
	resumable: false, // direct spawn, no detached host; session/load is capability-gated (concern 07)
	modelSwitch: false, // ACP unstable_setSessionModel — don't assume live model swap
	thinking: false, // no ACP thinking-level channel
	contextInjection: "none", // ACP has NO system-prompt slot (concern 06 — "none" v1, MCP is the real fix)
};

/** omp: the battle-tested default. `omp --mode rpc`, `--approval-mode <mode>`, soft-leasing on. */
registerHarness({
	name: "omp",
	protocol: "omp-rpc",
	bin: "omp",
	approvalArgs: (mode) => ["--approval-mode", mode],
	leaseHook: true,
	capabilities: NATIVE_CAPS,
	verified: true,
	usageVerified: true, // omp's own RPC usage frame — the mapping every daemon dashboard has always trusted
});

/** pi (@earendil-works/pi-coding-agent): same `--mode rpc` LF-JSONL protocol as omp (omp is a pi
 *  variant), so it rides the RpcAgent transport with a binary swap. Divergences: pi uses
 *  `--approve`/`--no-approve` (not `--approval-mode`); has NO host-tool channel and NO approval
 *  primitive (host perms — only yolo is coherent); soft-lease `-e` unverified so off. */
registerHarness({
	name: "pi",
	protocol: "omp-rpc",
	bin: "pi",
	// VERIFIED against pi v0.56.3 --help: pi has NO --approve/--no-approve/--approval-mode flag at all
	// (tools are gated via --tools/--no-tools, not per-call approval). So pi emits no approval flag — it
	// runs with its default tool permissions, matching toolApproval:"none". (create() only lets yolo
	// through for pi anyway.) `--mode rpc`, `--model`, `--thinking`, `--append-system-prompt` all confirmed.
	approvalArgs: () => [],
	leaseHook: false,
	emitsReadyFrame: false, // VERIFIED: pi v0.56.3 --mode rpc emits nothing on startup (ready-on-first-command)
	capabilities: {
		...NATIVE_CAPS,
		hostTools: false, // pi has no set_host_tools channel — squad_message/squad_kb_search vanish
		toolApproval: "none", // no approval channel — runs with host perms
		// resumable stays true: pi rides the same detached agent-host over a socket as omp.
	},
	// LIVE-VERIFIED 2026-07-06 end-to-end through the manager against pi v0.56.3: `--mode rpc` speaks omp's
	// RPC protocol — get_state returns an RpcSessionState-shaped frame AND the `{"type":"prompt","message"}`
	// command is accepted (`response/prompt/success:true`), same schema omp uses. Arg table (--mode rpc/
	// --model/--thinking/--append-system-prompt, no --approval flag) confirmed via --help. pi emits no ready
	// frame (host probes it). No host-tool channel, no approval primitive (yolo only). (The one turn that
	// ran failed on EXPIRED anthropic creds — environmental, not a protocol defect.)
	verified: true,
	usageVerified: true, // same RPC usage frame as omp — same live-verified mapping
	note: "same --mode rpc protocol as omp (live-verified); no host-tool channel, no approval primitive (yolo only)",
});

/** auggie (Augment) — the harness the legacy `runtime:"acp"` pointed at (`auggie --acp`). */
registerHarness({ name: "auggie", protocol: "acp", bin: "auggie", acpCommand: ["auggie", "--acp"], capabilities: ACP_CAPS, verified: false });

/** gemini-cli — native first-party ACP. */
registerHarness({ name: "gemini", protocol: "acp", bin: "gemini", acpCommand: ["gemini", "--acp"], capabilities: ACP_CAPS, verified: false });

/** opencode — native first-party ACP. LIVE-VERIFIED 2026-07-06 against opencode v1.1.8: `opencode acp`
 *  completes the initialize + session/new handshake and advertises {loadSession, mcpCapabilities:{http,sse},
 *  promptCapabilities:{embeddedContext,image}} — so ACP framing + handshake + the MCP context route (concern
 *  06) are all real here. (resumable stays false at the omp-squad level: we don't drive session/load yet.) */
registerHarness({ name: "opencode", protocol: "acp", bin: "opencode", acpCommand: ["opencode", "acp"], capabilities: ACP_CAPS, verified: true, note: "native first-party ACP; handshake live-verified" });

/** claude-code — via the mature `claude-code-acp` adapter (built on Anthropic's official Agent SDK). */
registerHarness({ name: "claude-code", protocol: "acp", bin: "npx", acpCommand: ["npx", "-y", "@zed-industries/claude-code-acp"], capabilities: ACP_CAPS, verified: false, note: "third-party ACP adapter over the official Claude Agent SDK; initialize handshake works but refuses to run nested inside another Claude Code session (unset CLAUDECODE)" });

/** codex — via the `codex-acp` adapter over `codex app-server`. Adapter is mid-migration between
 *  orgs; pin a version before relying on it. */
registerHarness({ name: "codex", protocol: "acp", bin: "npx", acpCommand: ["npx", "-y", "@agentclientprotocol/codex-acp"], capabilities: ACP_CAPS, verified: false, note: "adapter mid-migration between orgs — pin a version" });

/**
 * grok (xAI Grok Build) — native first-party ACP, no adapter: `grok agent stdio`.
 *
 * LIVE-VERIFIED 2026-07-09 against grok v0.2.93 (the bar opencode had to clear — a green fake-server
 * test does not count, see concern 08): `initialize` returns protocolVersion 1 with
 * `agentCapabilities:{loadSession:true, promptCapabilities:{embeddedContext:true}, mcpCapabilities:
 * {http:true,sse:true}}`, and `session/new` returns a real sessionId plus `models.availableModels:
 * [grok-4.5 (500k ctx, supportsReasoningEffort), grok-composer-2.5-fast]`.
 *
 * This is glance's FIRST vendor-pinned VERIFIED harness, so it is what flips
 * `hasSecondVerifiedProviderLane()` true and activates the degradation ladder (see that doc).
 *
 * Capabilities are deliberately conservative, matching what the ACP driver actually drives — not what
 * grok advertises:
 *  - `resumable:false` even though grok advertises `loadSession:true`, because SquadManager does not
 *    drive `session/load` yet (identical call to opencode's). Claiming true would feed the reattach
 *    path an agent it cannot actually restore.
 *  - `thinking:false` even though grok exposes `supportsReasoningEffort`, because AcpAgentDriver has no
 *    thinking-level channel to carry it.
 *  - `contextInjection:"none"`: grok's MCP capabilities are real (http+sse) and are the eventual
 *    concern-06 route, but we don't wire an MCP context server yet. Named, not faked.
 *
 * Auth is a cached token (`grok login` → ~/.grok/auth.json), NOT an env API key — so a spawned unit
 * inherits the operator's session and no key needs to reach the worktree.
 */
registerHarness({
	name: "grok",
	protocol: "acp",
	bin: "grok",
	acpCommand: ["grok", "agent", "stdio"],
	// `--model` is an option of `grok agent`, NOT of its `stdio` subcommand: the default trailing-append
	// would spawn `grok agent stdio --model m`, which exits with "unexpected argument '--model'".
	// LIVE-VERIFIED both ways (v0.2.93) — the flag must precede the subcommand. Found by an adversarial
	// cross-lineage review of this very commit; the initial `initialize` smoke passed no model and so
	// never exercised the argv a modeled unit actually spawns.
	acpModelArgv: (model) => ["grok", "agent", "--model", model, "stdio"],
	capabilities: ACP_CAPS,
	verified: true,
	note: "native first-party ACP (grok agent stdio); initialize + session/new live-verified; vendor-pinned xai — activates the degradation ladder",
});

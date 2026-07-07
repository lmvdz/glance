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

/**
 * True when a second VERIFIED harness is enabled whose static vendor pin (`harnessLineage`) differs
 * from the default harness's — the precondition for the per-provider degradation ladder (concern 06,
 * plans/research-sirvir/06-degradation-ladder.md) to have any real differentiation to act on. omp/pi/
 * opencode are multi-model runtimes with NO static vendor pin (`harnessLineage` reads "unknown" for
 * all three — see model-lineage.ts), so this stays false until a vendor-pinned ACP harness (claude-code,
 * gemini, codex) is BOTH registered `verified:true` AND distinct from the default harness's lineage.
 * Today none of the three are verified, so this is false and dispatch.ts logs the ladder as inert
 * instead of silently no-oping (the concern's explicit "name it, don't fake it" requirement).
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

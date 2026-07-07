# Harness-agnostic, plug-and-play unit runtime

## Outcome
Units run on any coding-agent harness (omp, pi, claude-code, codex, opencode, gemini-cli) behind
one driver seam, chosen by config, with per-harness capabilities known and degraded gracefully.

## Status — SHIPPED (2026-07-06)
**8/8 code concerns closed** (01-08); 09 = deferred follow-ons (documented). Full suite **1576 pass /
0 fail**, typecheck clean. **Live-verified on this box**: `opencode acp` (real ACP handshake, advertised
{loadSession, mcp, prompt} caps) and `pi --mode rpc` (get_state + the `{"type":"prompt"}` command speak
omp's protocol end-to-end through the manager) — both flipped `verified:true`. The live drive caught 3
real bugs unit tests missed: pi has no `--no-approve` flag (v0.56.3), pi emits no ready frame (added a
harness-aware get_state ready-probe), and cold restore/adopt dropped the harness (audit — reverted pi/ACP
to omp). claude-code-acp handshakes but refuses nested Claude Code sessions (env). gemini/codex binaries
absent → honestly unverified. Branch `worktree-harness-agnostic-drivers` (PR #80).

## Work
| Concern | Why it exists | Complexity | Touches |
| **Phase 1 — foundation + pi (ships, offline-verifiable)** | | | |
| 01 harness registry + first-class `harness` + migration | Replace the hardcoded `makeDriver` if-chain with a registry keyed by transport×protocol; normalize `runtime`→`harness` so restart doesn't respawn ACP units as omp | architectural | src/harness-registry.ts (new), src/squad-manager.ts, src/types.ts |
| 02 binary/harness config end-to-end | Wire GLANCE_HARNESS/GLANCE_BIN through the bootstrap (fixes the never-populated `bin`); per-harness command table; per-agent harness/bin override | mechanical | src/index.ts, src/squad-manager.ts, src/agent-host.ts, src/harness-registry.ts |
| 03 capability model + graceful degradation | CapabilityDescriptor per harness; replace `runtime==="acp"` string checks with capability checks; reject non-yolo for no-approval harnesses; hostTools:false skips advertisement | architectural | src/harness-registry.ts, src/squad-manager.ts, src/types.ts |
| 04 pi harness (the offline proof) | Register pi (protocol=omp-rpc, `pi --mode rpc`); `--approve` arg-table entry vs omp's `--approval-mode`; hostTools:false; lease-hook compat; prove a unit end-to-end | architectural | src/harness-registry.ts, src/agent-host.ts, src/squad-manager.ts |
| **Phase 2 — ACP tier (gated per-harness on live binaries)** | | | |
| 05 harden AcpAgentDriver into the universal on-ramp | Command-table parameterization (gemini/opencode/claude-agent-acp/codex-acp); close settled ponytails (framing, permission-kind enum); `pickOption` fails CLOSED; usage translation | architectural | src/acp-agent-driver.ts, src/harness-registry.ts |
| 06 ACP context-injection decision (system-prompt blocker) | ACP has no sysprompt slot; decide contextInjection:"none" (v1, loud) vs MCP-server route via session/new mcpServers (real fix for fabric primer + tool-grant scoping) | research | src/acp-agent-driver.ts, src/harness-registry.ts |
| 07 ACP reattach posture | ACP agents are direct spawns → daemon restart orphan-kills them; mark resumable:false + exclude from reattach/adopt path | architectural | src/squad-manager.ts, src/harness-registry.ts |
| 08 live verification + honest gating | Fake ACP/RPC test servers (offline); capability probe; unverified harnesses hidden behind OMP_SQUAD_UNVERIFIED_HARNESS=1; only live smoke flips `verified` | architectural | tests/, src/harness-registry.ts, src/index.ts |
| **Phase 3 — deferred (documented)** | | | |
| 09 deferred: mastra bridge, sandbox×ACP, workflow inner-harness | Record why these are out of this pass so they aren't re-proposed | mechanical | plans/ (doc) |

## Order
| Batch | Concerns | Why together / sequential |
| 1 | 01 → 02 → 03 → 04 | All touch src/squad-manager.ts + src/types.ts + src/harness-registry.ts — **SAME-FILE, must be sequential** (one implementer, in order). 01 defines the registry the rest hang off. |
| 2 | 05, 06, 07 | Phase 2; 05 first (driver seam), then 06/07 (gated on 05's hardened driver + live binaries) |
| 3 | 08 | Verification, after the ACP driver is real |
| — | 09 | Documentation |

## Dependency graph
| Concern | Blocked by | 30s check |
| 01 | — | `grep -n "makeDriver" src/squad-manager.ts` shows the if-chain at ~3190 |
| 02 | 01 | registry exists (`src/harness-registry.ts`) with a command-table field |
| 03 | 01 | registry exists to hang CapabilityDescriptor off |
| 04 | 01,02,03 | pi resolvable via registry+config+capabilities |
| 05 | 01,02,03 | `grep -n "ponytail" src/acp-agent-driver.ts` still shows the 9 TODOs |
| 06,07 | 05 | hardened ACP driver present |
| 08 | 05 | ACP driver present to verify |

## Notes
- **Phasing is a deliberate divergence** from the user's stated "Foundation + full ACP tier": the
  arbitration (see DESIGN.md) established the ACP tier is gated on live third-party binaries
  (untestable in CI) and has two unsolved architectural blockers (ACP has no system-prompt slot;
  ACP agents have no reattach). Phase 1 (foundation + pi) ships and proves the thesis offline;
  Phase 2 is decomposed-and-ready but gated per-harness on a live smoke.
- Proceeded over **36 plans with open concerns** (WIP scan 2026-07-06; much is worktree
  duplication) — research→plan pipeline continuation, scope pre-chosen by the user.
- **Vocabulary decision: keep Option B** (omp-as-vocabulary) — no neutral-type fork. See DESIGN.md
  for why C was rejected. This keeps blast radius small and is the single biggest de-risking.

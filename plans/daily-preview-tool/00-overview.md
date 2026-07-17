# Preview host-tool for driven agents (Epic F)

Parent: plans/daily-driver/00-meta.md · Arbitration: daily-driver-arbitration.md §10 (binding — the red-team security spec below is non-negotiable) · Landscape: daily-driver-landscape.md "Host tools / preview"

STATUS: expanded, open
PRIORITY: p2 — off the adoption path (arbitration §10, meta 00-meta.md epic table); wave 1 (epics A-D) ships and soaks first
REPOS: omp-squad
COMPLEXITY: architectural

## Outcome

A driven agent (omp today — the only harness with `caps.hostTools`) can take a screenshot of a page it's building, without the daemon hosting a browser, an MCP server, or a new dependency. It rides the existing host-tools seam (`src/rpc-agent.ts` `setHostTools`, `SQUAD_HOST_TOOLS` in `src/squad-manager.ts:247`, dispatched in `onHostTool` at `src/squad-manager.ts:7834`) the same way `squad_kb_search`/`squad_message`/`squad_report`/`squad_attention` already do. The daemon shells out to the `agent-browser` CLI (verified present at `/home/lars/.volta/bin/agent-browser`, a volta shim — confirmed it resolves and runs cleanly even with a stripped `PATH`/`HOME`) as a subprocess, exactly the way `src/vision.ts` shells out to a one-shot `omp -p` agent for the existing evidence-only vision pass. This is NOT that pass: vision is an autonomous best-effort observer; this is a tool an agent calls mid-turn, synchronously, for a specific origin+path it's told about.

## Locked decisions (binding, from arbitration §10 / meta 00-meta.md)

- **No MCP server, no new host dependency.** The daemon hosts no MCP server — settled architecture (landscape, "Host tools / preview"). The tool is a `HostToolDef` dispatched in `onHostTool`, not a new transport.
- **Visible only to `caps.hostTools` harnesses.** Gated the same way `registerHostTools` already gates the whole `SQUAD_HOST_TOOLS` block (`src/squad-manager.ts:7817-7823` reads `rec.harness?.capabilities`; ACP and pi are `hostTools:false` in `src/harness-registry.ts:306`/`:352` and never see it).
- **Origin registration is OPERATOR-tier only, never the agent** (concern 02). The tool's own params take a path within an already-registered origin — never a full URL — so an agent cannot name an arbitrary target at call time.
- **Absolute-path binary pinning at daemon boot, fail at registration** (concern 01). A volta-shim / non-login-shell PATH hazard is real; the tool must not silently 404 on first use.
- **Payload hygiene**: caps + file-reference storage, not base64-in-transcript (concern 03).
- **Cross-lineage review (codex AND grok) is mandatory** on concern 02 (SSRF/authz surface) per meta 00-meta.md's blanket rule for any auth-surface touch, and per arbitration §10 explicitly.

## Work

| Concern | Why it exists | Complexity | Touches |
|---|---|---|---|
| 01 preview-snapshot-tool | the host-tool itself: definition, dispatch, binary pinning, concurrency research | architectural | src/squad-manager.ts (SQUAD_HOST_TOOLS, onHostTool), src/agent-driver.ts (HostToolDef reuse, no change expected), daemon boot path |
| 02 origin-registration-ssrf | the actual security surface — operator-tier registration, daemon-origin denylist, inverted SSRF validation | architectural | new registry (project-registry.ts shape), src/ssrf.ts or sibling, src/authz.ts, src/server.ts |
| 03 payload-hygiene | caps + file-reference storage instead of base64-in-context/transcript | mechanical | tool response shape (01's handler), transcript/state-dir artifact storage |

## Order

| Batch | Concerns | Why |
|---|---|---|
| 1 | 01 | the tool must exist (and its binary-pinning boot behavior decided) before origin registration or payload shaping have a call site to attach to |
| 2 | 02, 03 | both BLOCKED_BY 01; disjoint files (registry+authz vs. response shape) — parallel once 01 lands |

## Out of scope (this epic)

- Any browser dependency added to the daemon's own process — the daemon never imports a browser library; it only spawns `agent-browser` as a subprocess, per the existing vision-pass precedent.
- Multi-tab / persistent session management beyond what concern 01's concurrency research recommends — v1 is one screenshot per call.
- A UI for registering preview origins — concern 02 defines the registration mechanism (operator-tier), a webapp affordance is a follow-up once a real consumer exists (mirrors the fleet-first-ide precedent of daemon-half-first, UI-later).

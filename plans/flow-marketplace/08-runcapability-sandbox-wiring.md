# M1 — runCapability → mandatory sandbox + the run-gate matrix
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: 07, 02, phase0-sandbox-hardening
TOUCHES: src/squad-manager.ts (runCapability, makeDriver), tests/marketplace-run-gate.test.ts (new), tests/marketplace-run-live.md (live)
MODE: afk

## Goal
No marketplace flow ever runs with host-agent privilege. An untrusted-source pack runs ONLY if it can be genuinely
contained today, and is fail-closed-blocked otherwise with a reason naming the missing link. **This is THE fix for
the defect both red teams found: `runCapability` never sandboxes.**

## Approach
Today `runCapability` (`squad-manager.ts:2024-2067`) dispatches every binding through `create` with **no `sandbox`
field** — flue (`:2054`), workflow (`:2064`), profile (`:2066`) all spawn plain host `RpcAgent`s. Flue additionally
runs arbitrary host binaries (`flue-service-driver.ts:142`) and can't be sandboxed (`create` rejects sandbox for
non-omp-rpc, `:4348`).

The **run-gate matrix**, keyed on the `sourceKind:"marketplace"` / `trusted:false` marker (concern 02):
- A marketplace pack's run MUST be constructible as `SandboxAgentDriver` (omp-rpc, worktree mount, `network:none`)
  from Phase 0's hardened sandbox, or it is **refused** with an explicit reason.
- **Profile bindings** → sandbox-constructible → run, forced `sandbox:{network:none, mount:worktree}`.
- **Workflow bindings** → inner coder/tester are hardcoded host `RpcAgent` (Phase-0 concern 07) → **run-blocked**:
  "requires WorkflowDriver containment (v2)".
- **Flue bindings** → structurally unsandboxable (`:4348`) → **run-blocked**: "flue not runnable in the marketplace
  (v3)".
- **`network` ≠ none** declared → **run-blocked**: "requires egress proxy (v2)".
- **MCP declared** → **run-blocked**: "requires in-container MCP (v2)" (a granted MCP server is daemon-adjacent RCE
  on the current path — `opts.mcp` bypasses `sanitizeRepoProfile` at `:4163`, spawned host-side at `:4419`).
- Declared `fsScope` beyond worktree → **run-blocked** (no safe enforcement without Phase 3).

**Signed ≠ safe** is the axiom: a signature is attribution; the container is the boundary. The advisory core-tool
grant (`:4134-4140`) is defense-in-depth UX, never the boundary — but inside a `network:none`, worktree-only,
no-daemon-env container, an in-sandbox `bash`/`read` is contained by the boundary (the buyer-code exfil-via-
authored-diff channel is NAMED, not a guarantee — DESIGN.md §7).

## Cross-Repo Side Effects
Hard-depends on `plans/phase0-sandbox-hardening` (PR #175): a hardened, wired `SandboxAgentDriver`. Its concern 06
(container hardening) + 07 (spawn policy, including sandbox-inheritance) are the substrate this wires marketplace
runs onto.

## Verify
- A marketplace profile pack runs sandboxed (`network:none`, worktree mount, no daemon env — assert the container
  args); a non-marketplace pack is unaffected.
- Each run-blocked class (workflow / flue / network≠none / MCP / fsScope-wide) refuses with its named reason
  (mutation-proven: remove a block → an unsafe run happens → test goes red).
- **Live acceptance (scratch daemon, Phase 0 landed):** a real marketplace profile flow, bought (stub broker),
  installed, RUN in the container, editing a demo repo, landed — with no network egress, no host-fs beyond the
  worktree, no daemon secret in the container. Recorded in this concern's Resolution with what was observed. This
  is the check that flips the marketplace from "wired" to "proven-safe"; a step that can't run states why.

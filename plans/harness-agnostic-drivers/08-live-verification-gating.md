# Live verification + honest harness gating
STATUS: open
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: tests/, src/harness-registry.ts, src/index.ts

## Goal
Prove harnesses actually work (not just that the driver plumbing does), and never present an
unverified harness as if it works — the repo's core `/make-it-work` discipline applied to itself.

## Approach
- **Fake servers (offline, CI-gating)**: an in-repo fake ACP JSON-RPC server (the injectable
  `AcpAgentDriverOptions.command` already exists for this) + a fake `--mode rpc` server (same wire as
  the existing omp fake). These prove the driver STATE MACHINE, not the harness.
- **Capability probe (informational)**: spin up each installable binary, run `initialize` +
  `session/new` only, diff the real `capabilities` against the registry's static descriptor. Validates
  framing + handshake without a model call. Realistic for pi and `npx claude-agent-acp`.
- **Honest gating**: `HarnessDescriptor.verified: boolean`. `verified:true` → listed/selectable.
  `verified:false` → **hidden unless `OMP_SQUAD_UNVERIFIED_HARNESS=1`**, and prints "smoke-only, not
  validated". A green fake-server test does NOT flip `verified` — only a live smoke against the real
  binary does.
- Live smoke: pi + `npx claude-agent-acp` are the most installable (no separate binary / paid
  account). gemini-cli/opencode/codex-acp = registered-but-unverified until a live smoke passes.

## Verify
- Fake-server unit tests green for both protocols; capability-probe runs against whatever's
  installable and records results.
- With no env, only `verified:true` harnesses (omp, + any live-smoked) appear in the create UI/CLI;
  with `OMP_SQUAD_UNVERIFIED_HARNESS=1` the rest appear with the warning.

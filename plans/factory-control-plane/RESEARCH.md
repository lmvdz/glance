# Research notes

Source: Factory/Droid docs at https://docs.factory.ai/welcome and related docs pages.

Transferable patterns chosen:

1. One control-plane runtime, many surfaces.
2. Autonomy as explicit execution mode.
3. Verification as orchestration before landing.
4. Inspectable replayable sessions.
5. Milestone-based multi-agent orchestration.
6. Deterministic lifecycle guards.

Patterns deliberately skipped for now:

- Plugin marketplace.
- Managed remote computers.
- Model router.
- Enterprise policy hierarchy.
- DLP/prompt-shield platform.
- MCP governance layer.

Reason: `omp-squad` already has the useful primitives: manager, worktrees, workflow runtime, proof/land gate, server/TUI, and agent drivers. The shortest path is to harden those, not clone Factory.

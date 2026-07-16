# Epic I — True in-place sessions (charter)

STATUS: blocked
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: architectural
BLOCKED_BY: adoption gate + A03 boundary-sync soaked ≥2 weeks of real daily use + E02 fail-closed per-turn checkpoints landed
MODE: hitl

## Charter (expand into plans/daily-in-place/ when unblocked)

Run a casual session's agent directly on the operator's real checkout — no worktree, no sync step. Wave 1 deliberately does NOT do this: boundary sync (worktree + gated patch-apply) delivers the visible-edits feel with none of the risk. This epic exists because true in-place may still be wanted after soak (dev-server hot-reload on agent edits, zero sync latency). It repeals OMPSQ-40 for one session class, which is why every prerequisite below is binding — the design red team demonstrated the draft's guardrails targeted seams that cannot enforce them.

## Locked prerequisites (from design review — every one, no subset)

- **Shell-command classifier at the harness native-approval seam.** The toolGrants gate (`onHostTool`) never sees shell commands — `git reset --hard` runs inside the harness process. Destructive-op denial must live at the native approval round-trip. Harnesses without a native approval channel (pi-class; anything create() forces to yolo) NEVER qualify for in-place — worktrees, period.
- **Detached agent-host must not outlive supervision on the live tree.** agent-host is designed to survive daemon restarts (a feature for worktrees, a disaster in-place): either invert detachment for in-place sessions (host dies with daemon — a documented exception to the dead-agent self-heal design) or gate every turn-start host-side on a fresh checkpoint receipt so an unsupervised host stops instead of proceeding. Daemon absence must never be encoded as permission to continue.
- **Pre-turn checkpoint is fail-closed with a coherence check.** Capture failure ⇒ turn refused + attention item (acceptance test: "checkpoint fails ⇒ turn does not start"). The capture walk is not atomic: record HEAD + index mtime before/after; on movement, discard and retry.
- **Restore is never a blind checkout.** On a live tree, ref-restore is `reset --hard` by another name. Materialize the ref into a scratch worktree or present hunk-level apply.
- **Human-race detect-and-pause.** Watch HEAD/index during a turn (presence/lease seam exists for signaling); on movement, pause the turn and raise a ladder item. Name the residual same-file race honestly in the plan doc.
- **Attribution bracketing.** Checkpoint at turn-start AND turn-end so human inter-turn edits never blend into agent diffs; promote-to-unit diffs against turn-end refs only.
- **Non-git directories: refuse in-place** (or visibly degraded with the strictest approval posture) — a casual gesture must not silently carry zero safety net.
- **Ephemeral project hygiene** carries over from A02 (auto-unregister unless promoted).
- Cross-lineage review (codex AND grok) mandatory — this is a git-write path repealing a safety invariant.

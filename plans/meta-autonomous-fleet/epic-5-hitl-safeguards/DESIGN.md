# Epic 5 sub-plan — design decisions the leaves depend on

Three judgment calls the parent epic left open. Made here so every leaf is a zero-decision handoff.

## D1 — Confidence is a deterministic run-end score, computed from what exists TODAY

The epic seed lists three inputs: validator agreement (Epic 3), test coverage, and `codegraph_impact`
blast radius. Ground truth after exploration:

- **Validator agreement does not exist yet** — Epic 3 (independent validator) is a *parallel* trust
  epic, not a dependency of 5. There is no runtime validator verdict on a receipt or DTO today
  (`grep` for `validatorVerdict`/`independentValidator` in `src/` → nothing runtime; the
  `acceptanceCriteria` hits are plan/tier2 text, not a run signal).
- **`codegraph_impact` is an MCP tool agents call, not a server-side API** the daemon can invoke
  inside `finalizeRun`. Using it at run-end would mean shelling an MCP round-trip on the hot path.

Decision: **the scorer is a pure function of signals already on the record at `finalizeRun`** —
`rec.dto.verificationState` (the deterministic proof state: `fresh`/`stale`/`failed`/`none`) and
`receipt.filesTouched.length` (blast-radius proxy). It accepts an **optional** `validator` signal that
is `undefined` today; when Epic 3 lands a verdict it folds in with **zero code change to callers**.
Absent validator ⇒ **neutral, never penalize** (the same "absence = unknown" rule the learning-loop
plan mandates). This keeps Epic 5 shippable *before* Epic 3 and makes it strictly better after.

Formula (`src/confidence.ts`, pure, unit-tested — range clamped to `[0,1]`):

```
base 0.5
proof fresh    → +0.30    stale → 0    failed/none → −0.30
filesTouched ≤ 3  → +0.10   > 12 → −0.20   (else 0)      // blast radius
validator (optional): pass → +0.10   fail → −0.40   absent → 0
clamp to [0,1]
```

The exact weights ARE the decision — implementers do not re-tune them. Threshold tuning is Epic 6's
job (referenced, not built here).

## D2 — A report is NON-blocking, so it does NOT ride `rec.dto.pending`

The epic seed says "non-blocking `PendingRequest` variant (`source:"report"`)". **Do not implement it
that way.** `rec.dto.pending.length` is load-bearing: `blockedReason()` (`squad-manager.ts:552`) turns
any non-empty pending into `"waiting for operator input"`, which `effectiveAutonomyMode` (`autonomy.ts:31`)
caps to `observe`, and `derive()` flips status to `input`. Pushing a "report" pending would **block the
agent** — the exact opposite of the primitive's purpose.

Decision: reports are a **separate append-only channel**. New `AgentReport` type, a `reports?:
AgentReport[]` field on `AgentDTO` (mirrored in `dto.ts`), and a **new `attentionItems` branch** that
renders reports as `severity:'warn'`, `kind:'report'` rows with a `view` action carrying the proposed
diff/summary. The `squad_report` host tool responds to the agent **immediately** (modeled on the
non-blocking `handlePeerMessageTool` at `squad-manager.ts:4748`, NOT the blocking pending path at
`onHostTool:4703`) — the agent keeps running; the human sees the report at leisure. This is the whole
point: "I'm unsure, here's a proposal" without stopping the line.

## D3 — The steering lane's drift trigger is activity-staleness

The epic wants steer "hung off an attentionItems row" but does not name the trigger. Options considered:
flapping (already owns a `restart` row), out-of-scope produce-audit (advisory/low-sev, not surfaced),
ETA overrun (`etaAt` is a soft hint, often absent). Decision: trigger on **activity staleness** —
`status === 'working' && Date.now() - lastActivity > STALL_MS` (default 15 min, env
`OMP_SQUAD_STALL_MS`) — the only robustly-computable, always-present drift signal on the DTO. Renders a
new `kind:'stalled'`, `severity:'warn'` row whose action is `steer`. `steer` opens the same inline
composer the `answer` flow uses and sends `{type:'prompt', id, message}` (a fresh steering turn — no
`clientTurnId`, distinguishing it from answering a pending). Same command the low-confidence report row
can also offer, but one-action-per-row keeps report=`view`, stalled=`steer`.

## Ordering & dependencies

`01` (types) unblocks `02`+`03` (parallel). `05` (report channel) is independent of `02/03`. `06`
(escalation) is the join: needs `02` (a confidence number), `03` (the cap), and `05` (the report
channel). `04` (steer) is fully independent. `07` (learning-to-agents) is Epic 6 territory — a stub,
not a leaf.
</content>

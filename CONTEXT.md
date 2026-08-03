# Domain glossary

Names for the concepts this codebase is built around. Architecture reviews and new code
should use these terms; sharpen or extend this file as concepts crystallize. (Architecture
*vocabulary* — module, interface, seam, depth, locality — comes from the codebase-design
skill; this file names the *domain*.)

## The memory lane (`src/memory/`)

Canonical spec: `plans/research-long-horizon-agent-memory/POSITION.md`. The lane's shape is
**a ledger with regenerated projections** — event-sourcing, not retrieval.

- **Decision** — one assertion on a feature's record (`FeatureDecision`). Sources: `plan`,
  `human`, `agent`, `model-delta`. Decisions are appended, never edited.
- **Supersession** — the only way a decision dies: a later decision names it in
  `supersedes`, the write stamps `supersededBy`/`supersededAt` atomically. Invalidate,
  never delete; one current assertion per subject; history stays addressable.
- **Active-set exclusion** — superseded decisions are EXCLUDED from anything an agent's
  context is built from (fabric, primer, kb-search), not labeled: a stale fact reaching a
  prompt gets adopted regardless of labeling (the compliance trap, arXiv 2607.10608).
- **Model-delta** — the evidence-gated decision class: a mental-model delta recorded
  mid-run via `squad_record_decision`, required to carry `evidence` anchors naming files
  the run actually touched (`validateModelDelta` — the lane's anti-slop floor).
- **Decision ledger** — the write path enforcing all of the above:
  `src/memory/decision-ledger.ts`.
- **Fabric** — the read-side projection: a scoped snapshot of decisions, failures,
  symptoms, episodes, answers, digests, hot areas (`src/memory/fabric.ts`).
- **Primer** — the budgeted, region-structured context block a cold-starting unit
  receives, built from the fabric (`buildContextPrimer`). Must-see items surface by
  state/region, never by relevance score.
- **Exhaust** — the runtime-owned append-only record everything above is derived from:
  receipts, digests, transcripts, gate logs. Projections must be rebuildable from it.
- **Teaching surfaces** — the producer-first artifacts units leave for future agents and
  the operator: **symptoms** (how a defect looked from outside, where to look),
  **after-action reports**, **weekly episodes**, **answers**, **digests**.
- **Work graph** — nodes + typed node records (`src/memory/nodes.ts`,
  `node-records.ts`): the substrate decisions, instructions, objections, and handovers
  anchor to.

## The fleet

- **Unit** — one worktree-isolated agent run managed by the daemon (`SquadManager`).
- **Landing** — a unit's branch reaching main through the proven-merge gate lane.
- **Room** — the chat/channel surface humans and units share (channels, cards, threads).
- **Harness** — a driveable coding agent CLI (claude-code, codex, grok, …) behind the
  `AgentDriver` seam.

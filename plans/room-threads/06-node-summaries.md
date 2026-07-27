# Node summaries — the interface between nodes
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/nodes.ts, src/after-action.ts, src/squad-manager.ts, tests
BLOCKED_BY: 01
MODE: afk

## Goal
What flows between nodes is a summary, never a raw log. Each node maintains a current statement of
itself; raw history stays addressable at the node but is not what propagates.

## Approach
1. **Two summaries per node, not one.** They are different documents shaped by their consumer:
   - *upward* (escalation): what happened, what is needed, what it cost
   - *downward* (inherited context): goal, constraints, decisions taken
   Prior art: mattpocock/skills `productivity/handoff` shapes its output by "what the next session
   will focus on" — the same idea, applied to two directions instead of one successor.

2. **Reference, never duplicate.** Adopt the handoff skill's core rule verbatim in spirit: do not
   restate content already captured in a plan doc, PR, gate log or after-action — point at it by path
   or URL. A summary that restates its sources is just the log again, and it is the reason naive
   summarisation grows without bound.

3. **Regenerate, never append.** This is the load-bearing rule. Rebuild the summary from history on
   each state transition rather than growing it by accretion. Append-only context has no recovery
   path: the supervising session before this plan's was killed by accumulated context it could not
   shed, because every turn re-sent the whole thing. Regenerated context lets a bad turn stay a bad
   turn instead of becoming a permanent inheritance for everything downstream.

4. **When to compact resolves itself once (2) holds.** The original worry was cost and drift on a
   node that is still changing. A references-plus-current-state summary is small, so regenerating on
   every state transition is cheap — no separate scheduler, no "summarise a moving target" problem.
   Settling additionally freezes the upward summary into the node's after-action record.

5. After-action reports are ALREADY this artifact for settled units and already retain `channelId`
   (PR #252). Extend rather than duplicate.

6. Redact on generation — summaries propagate further than the messages they came from.

7. **Every terminal transition regenerates — including abnormal ones.** Settling is not the only
   exit. A worker that crashes or is killed still owns a node, and the daemon still owns that node's
   exhaust (receipts, transcripts, gate logs) outside the dead context window. A sweep detects nodes
   whose worker vanished without a frozen upward summary and regenerates one from the exhaust, marked
   *reconstructed post-mortem* so it reads as evidence, not self-report. This closes the sharp version
   of DESIGN.md's "live compaction" risk: knowledge orphaned because the context window died before
   the summary write, not because summarising a moving target is hard.
   (Source: plans/research-long-horizon-agent-memory/BRIEF.md, Rank 1.)

8. **The downward summary has a numeric budget: ≤800 tokens**, enforced at generation — regeneration
   must fit or tighten, with rule (2)'s references-not-restatement doing the compression. It is
   injected frozen at worker spawn via the existing primer path and never rewritten mid-session;
   freshness arrives at the next spawn. (Anchor: Hermes Agent ships ~3,500 chars of core memory,
   frozen per session precisely for prefix-cache stability — see the research brief, Rank 4.)

9. **Only currently-valid facts enter a downward summary — superseded decisions are excluded, not
   annotated.** Labels do not defuse stale memory: agents adopt a conflicting fact at its first
   decision point regardless of presentation (the compliance trap, arXiv 2607.10608 — effect
   independent of labeling/placement, damage scaling with model strength). Superseded-but-addressable
   (02's rule) serves the record and deliberate historical reads; the action-path context a worker
   spawns with gets the filtered view.

10. **Regeneration is a gated loop, not a one-shot transform.** Each regenerated summary is checked
    for recoverability against its own ground truth — the exact identifiers, decision statements,
    and drill-down targets named in the source records must be answerable from the summary plus its
    references. Fail → regenerate less aggressively: more budget to verbatim material, less to
    prose. Never ship an unvalidated compression (the measured cliff: 18,282→122 tokens dropped
    task accuracy 66.7%→57.1% — arXiv 2607.21503). **What must survive verbatim is a declared
    per-kind policy, not a summarizer judgment call**: unit nodes preserve gate verdicts and file
    paths verbatim; plan nodes preserve decision statements; prose context is always abstractable.
    (Source: plans/research-agentic-context-management/BRIEF.md, Ranks 1+3.)

## Cross-Repo Side Effects
None.

## Verify
- Upward and downward summaries of the same node differ, and each contains what its consumer needs.
- A summary references its plan doc / PR rather than quoting them; assert no verbatim restatement.
- Regeneration is idempotent: same history in, same summary out.
- A poisoned turn dropped from history disappears from the regenerated summary — pin the recovery
  path (E_pollution recovery).
- A settled node's upward summary matches its after-action record.
- Kill a worker mid-run: its node still gets an upward summary, sourced from receipts/transcripts,
  marked reconstructed (orphaned-state guard).
- A downward summary that cannot fit its budget fails generation loudly rather than shipping oversize
  (E_abstraction guard: tightening must drop restatement, never the exact identifiers).
- A superseded decision appears in no downward summary, even labeled — assert absence, not
  annotation (E_anachronism / compliance-trap guard).
- A regenerated summary that fails its recoverability check (a verbatim-policy field missing) is
  retried less aggressively, not shipped — and the retry preserves the field (validated-compaction
  gate).

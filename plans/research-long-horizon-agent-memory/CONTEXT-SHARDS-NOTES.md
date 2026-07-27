# Context shards (HumanLayer) — transcript notes

**Date**: 2026-07-25 · Source: "Building a Shared Memory System for AI Coding Agents"
(YouTube rTn8Vhdt-Jo, AI That Works stream; Dex/HumanLayer + Vaibhav/BAML), transcript read in
full from the SRT. Companion to [BRIEF.md](BRIEF.md), [POSITION.md](POSITION.md),
[RELATED-WORK.md](RELATED-WORK.md). Practice-axis source: a live spec session, not a paper —
capture the design arguments, not just the feature.

## What context shards are

Team-shared agent memory mined from session exhaust. A cross-session supervisor (small
structured-output inference calls, not an agent) reads user+assistant messages across the whole
team's sessions and extracts **session statements**: things people keep telling the agent
("Mary is main, not main", "never `--no-verify`"). Candidates go through human-in-the-loop triage
(allow/deny/dismiss), can be shared to the team, toggled always-on (injected into the system
prompt programmatically — HumanLayer owns the harness), and eventually "baked" by PR into the
repo's CLAUDE.md. Nightly cron is the primary trigger; Slack messages and memory-feedback events
trigger the same pipeline.

## The schema (whiteboarded live)

```
SessionStatement {
  fact: string
  citations: Citation[]        // array length = evidence strength
}
Citation {
  personId                     // who said it
  quote: string                // exactly what they said
  conversationContext: string  // why they said it — summary of the moment
}
```

## Key design arguments worth keeping

1. **Volume as the write gate ("the volume-based memory system").** What promotes a memory is
   not one model decision ("update my memory file") but analytics over recurrence across sessions
   and users. Dex/Vaibhav's framing: you accept a *lagging* memory in exchange for one that is
   never useless — "20% of the possible memories, all really useful, applied at the right time,
   beats everything you might want to remember applied all the time." Precision-over-recall
   applied to the WRITE side, which our position only states for the read side.
2. **The additive-set failure.** Vaibhav on CodeRabbit-style memory: "it's a purely additive set…
   after two months I have 300 things… they've all effectively converged into being the same as
   claude memories." Every panelist independently treats unbounded accretion as the death mode.
   Their mitigations: high promotion bar, human triage, dismiss-as-snooze (30 days, resurfaces
   only if you're *still* saying it), and a sketched decay supervisor ("reads all the active
   shards for a session and figures out which ones haven't been used in a while").
3. **One version of truth for the team.** Vaibhav rejects personal shards outright: aggregate
   over everyone's sessions ("if five people on my team are doing the same thing, probably the
   sixth should too"), one shared library, repo-committed, "only things that are truly forever."
   Dex keeps a second axis: always-on vs conditionally-activated (supervisor selects shards
   mid-session from conversation contents).
4. **No new inbox.** Vaibhav refuses a triage surface: deliver candidates to Slack, yes/no from
   the phone. "Give me the inbox I already use."
5. **Iterate, don't just allow/deny.** The human wants to *steer* a candidate ("this is what the
   rule should actually be — scan all our agent logs and update it"), i.e. prompt-triggered
   regeneration of a fact with evidence re-scan, not binary triage.
6. **Supervisor demystified.** "Anyone that tells you they have a supervisor agent — they just
   have a couple of prompts that inject more prompts into the main loop." ~15 small pipelines on
   tool-use hooks, Haiku-tier, structured outputs, sub-second. Cost tiering stated plainly: ~$100
   main loop, ~$10 supervisor; batch/nightly for cron, fast path for interactive triggers.
7. **Rollout discipline.** Admin-only review view first; triage the generations by hand, turn the
   bad ones into an eval set, then widen exposure ("build up your eval set before you put the
   firehose in front of customers").

## Mapping to our work

| Their idea | Our coordinate | Status |
|---|---|---|
| Session statements mined from exhaust by a cross-session supervisor | L0 → L1 distillation through a single writer (POSITION §2) | Convergent |
| Citation array (who/quote/context) as evidence for a fact | Drill-down pointers / typed traceable facts (tencentdb brief Rank 2, `sourceReceiptId`) | Convergent — their citation schema is a good concrete shape for fabric facts |
| **Volume-gated promotion** (recurrence across sessions/users promotes a candidate) | **NEW** — our position has no promotion criterion for L1 facts; glance's Rank 1 consolidation can key on recurrence with citations as receipts | Candidate addition |
| Additive-set convergence to slop | The unbounded-growth failure pole (tencentdb brief tension #6); primer pollution (fabric.ts decisions, zero dedup) | Convergent, from dogfooding not theory |
| Dismiss = snooze 30 days, resurface only if still recurring | Negative memory with TTL + re-evidence check | NEW nuance — a deny-list entry that expires against fresh evidence |
| Decay-out unused shards (sketched) | Decay ranking (room-threads 04), precision-over-recall (L3) | Convergent |
| Staged adoption: candidate → triaged → team-shared → PR into repo | A promotion ladder ending in repo-committed truth; glance analog: fact → conventions.md → commit | Convergent; the PR-at-the-end step matches "cards are proofs" / human-review-only contract |
| Deliver triage to the inbox you already have (Slack) | DIRECTION.md: the room is the home screen; needs-you cards ride the push latch | Convergent — glance's room IS the answer to "no new inbox" |
| Conditionally-activated shards selected mid-session by a supervisor | In-window-adjacent; blocked for glance (turn-boundary constraint) — the analog is spawn-time selection into the primer | Known cut, their debate confirms the cost concern (Vaibhav: boot-lag worry) |
| Iterate-on-memory (prompt-triggered fact rewrite with log re-scan) | Regeneration triggered by human steer; fits the room's composer verbs | NEW nuance for the conventions/consolidation lane |

## What this does NOT change

- No supersession/validity semantics in their design (facts are allow/deny/dismissed, not
  superseded with windows) — the additive-set complaint is the disease; our L1 validity fields
  remain the sharper cure. Their volume gate and our supersession compose: recurrence promotes,
  contradiction supersedes.
- Conditional mid-session activation stays cut for glance (control-point mismatch, POSITION §5).

## Candidate follow-ups (not yet applied)

1. Add **frequency-gated promotion with citation receipts** to the fabric consolidation lane
   (upgrades tencentdb Rank 1/2): a decision fact is promoted into the primer only after N
   recurrences across ≥2 sessions, carrying `citations[{agentId, receiptLine, quote}]`.
2. Adopt the **snooze-with-re-evidence** shape for dismissed candidates (deny entries expire
   unless recurrence continues).
3. POSITION §2 L1 could state a promotion criterion (recurrence) alongside the supersession rule
   — currently the position says how facts die but not how they earn their way in.

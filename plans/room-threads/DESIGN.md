# Design: another axis of depth

Visual review of this design: https://claude.ai/code/artifact/0cc5bc55-b43e-410b-b751-e5ce7824c8a9

## The problem

`#fleet` renders entity-keyed data with a conversational renderer. Every card already carries
`refs: { unitId, planId, landId, issueId }` — the audit log is already keyed to entities — and the
timeline discards that structure to re-sort by timestamp, the one attribute that says nothing about
what an entry is or whether it matters. Threads are then bolted on to recover what was discarded.

This is visible as an oscillation, not a preference. Concern 26 was filed because `#fleet` had become
544 cards of pure noise; concern 27 was filed because removing the noise revealed that nothing
signalled at all. We have been tuning a volume knob on a lane that should have been split.

A feed is correct for conversation — low volume, genuinely sequential, meaning from adjacency. It is
wrong for parallel stateful work, where what you need is not "what happened in order" but "what is
the state of everything, and what is waiting on me". It also fights the standing law that needs-you
is near-empty *by design*: a feed makes that a scrolling exercise rather than a glance.

## Approach

**A node is the unit of work and the unit of conversation at once.** One object type with a parent
link — a plan, a unit, a subagent, a landing are all nodes at different depths. Channels bind to
nodes. The UI is two coupled panes: state on one side, that node's conversation on the other.
Drilling into state changes both.

Lane separation then stops being a rule we enforce and becomes a property of addressing: `unit-spawned`
lands at the unit node because that is what it is about, and never touches the root.

## Key Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Thread primitive | A node in the work graph | Slack-style reply chain | A reply chain has no state, so nothing about it says whether it matters now. A node has state, owner, history — you can ask it "what needed me this week". |
| Node types | One type + parent link | Separate unit / plan / PR types | They nest and the interaction is identical at every depth; three types means three renderers and three special cases. |
| Channel creation | Lazy, on first message | One per node up front | A 100-node tree would be 97 dead rooms. Zulip gets this right by accident: a topic exists because someone spoke. |
| Upward flow | Escalation only | Propagate all activity | Propagating everything rebuilds the firehose one level up — the exact failure being fixed. |
| Downward flow | Context inheritance | Copy messages down | Down carries the goal and constraints as pinned context, not duplicated conversation. Up carries events, down carries context; they are not symmetric. |
| Ranking | State picks region, velocity orders within it | Single "hot" score | A single score lets a chatty healthy thread outrank a silent blocked one. Needs-you must be a region, never a score. |
| Decay | Score with a half-life, stable layout | Force-directed spatial layout | Decay is right (stigmergy: trails fade without traffic — the thing Slack threads never do). Moving *position* destroys the spatial memory that makes a board beat a feed. |
| Visibility | Nodes inherit channel membership | Separate genesis/invite model | Two visibility models can disagree about who may see what — we shipped and fixed exactly that bug this week. |
| Overlap detection | Extend `ownershipConflict` from paths to goals | Adopt GraphRAG | We declare the graph (`refs`, ownership, `BLOCKED_BY`); GraphRAG's value is *inferring* one from unstructured text. Paying to re-derive declared structure is the same category error as the feed. |
| Cross-boundary disclosure | Existence + owner, never content | Full visibility, or silence | The law-firm conflict check: the system knows, and reveals that a conflict exists without disclosing the other matter. |

## Standing rule: name things the way a person recognises them

Found in the concern 23 cold boot, and it generalises past the two cards it was found on. The room
speaks *system* where it should speak *human*:

- a card's REPO chip showed `/home/lars/.claude/jobs/…/love…` — an absolute path truncated past the
  point of carrying information. The question the chip answers is "which repo", and the answer to
  that is a name.
- its BRANCH chip showed `squad/doc-greet-mrzklccg-3-26b99e03`, whose only human part is buried
  between a generated prefix and a hash.
- "Capabilities" sits in the standing rail named after its implementation (a capability-pack
  registry), answering a question asked once during setup, and is empty until someone imports a pack.

The rule every concern in this plan inherits: **identity at a glance, address on demand.** Show the
name; keep the exact value one hover or one click away. Shortening must never mean losing. And a
surface earns a place in the rail by answering a question someone has *repeatedly* — setup-shaped
things belong behind the command palette.

## Risks

- **Rebuilds the room's centre pane.** Supersedes A-M1's assumption that a linear stream is the
  primary surface. The card grammar and doors (concerns 12–16) survive untouched — they are exactly
  what a node timeline renders.
- **Auto-promotion can become its own noise.** Needs the worthiness discipline concern 26 forced on
  card kinds, or the side panel is the new firehose.
- **It is a DAG, not a tree.** A unit can serve two plans; a PR closes issues across them. Multi-homing
  is what makes navigation ambiguous if it is not decided deliberately.
- **Navigation can yank the chat pane.** If clicking the tree swaps the conversation out mid-read,
  people learn to distrust the tree. Select and enter must be different acts.
- **Live compaction is unsolved.** Settling is an obvious trigger; a long-running plan node needs to
  compact while still changing, and summarising a moving target is the hard part.

## Open Questions

None blocking decomposition. The DAG shape, navigation model, and live-compaction trigger are each
filed as their own concern rather than resolved here — they are design work with real substance, not
gaps in this brief.

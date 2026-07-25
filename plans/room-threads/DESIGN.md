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


## The design, established

The visual and voice direction is settled. Reference implementation, self-contained and runnable:
[`reference/quiet-inbox.html`](reference/quiet-inbox.html) — four screens (busy, quiet, a decision,
the decision arrived at too late), with screenshots alongside it.

**The copy is the design.** This is the finding that matters most, and every concern inherits it. The
reference does not label states, it explains them:

- "Three of these at once is a defect in the work, not a list for you to keep."
- "Nothing has needed you since 09:41 · 6h 12m of unbroken autonomy · longest run this month 9h 04m"
- "Wren cannot merge her own work. Everything else in the fleet is still moving."
- "Wren waited 46 minutes, then closed her own session rather than hold a machine open. That is the
  rule she was given, not a crash."

Each states a fact AND what it means. A string that only names a state is not finished.

### Six patterns that are now requirements

| Pattern | What it means |
|---|---|
| **Autonomy as a streak** | Needs-you is not a count, it is a broken record. Show elapsed unbroken autonomy and the best run this month. Zero is an achievement, not an empty list. |
| **Consequences under every option** | Each control carries a sentence saying what will happen. "Four files land on main. Wren moves straight on to 3.3 without asking again." No control acts without saying what it does. |
| **A free-text third option** | Every decision offers "answer in words", which the agent interprets. This is what keeps a decision screen part of a conversation instead of becoming a form. |
| **Evidence decays** | Preserved results carry their age and what to do about it: "These results are 34 minutes old. Whoever picks this up should re-run them against today's main." |
| **Blast radius, unprompted** | Every interruption states what is NOT affected — "44 units unaffected", "Nothing else in the tree depends on it". Answer the anxious question before it is asked. |
| **Collapsed runs carry a verdict** | A folded run of events summarises and judges: "38 events · Wren, Pike, Ash +5 · tests, patches, two commits · nothing unusual." |

### Addressing and identity

Work is numbered and spoken: `3.2`, `3.2.1`, `3.3.2`. From the reference's own footnote — *"say 'three
point two' out loud and you both mean the same unit."* That is the addressability principle made
usable, and it replaces the branch-slug identifiers the current room shows.

Agents have names and persistent identity (Wren, Pike, Ash, Juno, Tam, Bex, Rune, Vale, Orin), each
with a role and a live one-line status. A conversation with a team, not a log from a process pool.

### Raw values are footnotes

`agent_exit wren@3.2 · 14:48:02` appears in the bottom-left corner of the too-late screen while the
human sentence carries the meaning. That is the placement rule for every internal identifier.

### Reconciliation needed before build

- The reference is almost entirely monospace. `brand.md` specifies mono for identifiers and system
  sans for prose, and the long explanatory sentences — the best thing in the design — would read
  better in sans. Test a mixed setting before committing.
- It introduces a second warm tone, `#D9A03C`, separating ALARM from ACTION (`#F0A35A`). This is a
  good idea not currently in `brand.md` and should be added there rather than dropped.
- Its neutral ramp runs slightly cooler than `brand.md`'s ink surfaces. Reconcile toward brand.md.

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

# Where the voice plan fits

Reconciling `~/cavern/opencoven-viz/plans/voice-orchestrated-room-integration` (5 concerns) against
`plans/room-threads` (21 concerns). Two plans, one webapp, one daemon. This says what lands when, and
which decisions each plan should stop making independently.

The voice plan is good and it already shares this plan's instincts — the journal is the record and
socket frames are not, agent-authored payloads never masquerade as a human instruction, raw tool
actions are diagnostic rather than results, a dead call is never rendered as reconnectable. The
problem is not disagreement. It is that both plans are quietly designing the same three things.

## Timeline

| Voice concern | Lands | Why |
|---|---|---|
| 01 OMP record and control plane | **Now, in parallel** | Different repos (`~/src/oh-my-pi`, `opencoven-viz`), no blockers, zero collision with anything here. It is also the long pole. Nothing in omp-squad gates it and it should not wait. |
| 02 Project calls into durable records | **After room-threads 17** | It invents retention, artifact immutability and decision durability that 17 and 11 already own. See below. |
| 05 Operating defaults | **Partly already decided** | One of its four open questions is answered by concern 12, which is built. The rest are Lars's and can be taken any time. |
| 03 Room-native call workspace | **After room-threads 03** | Both rebuild `HubShell` and the channel timeline. Whichever lands second throws the first away. |
| 04 Cross-project verification | **Last, unchanged** | Correctly sequenced already. |

Critical path to voice 03: room-threads 02 and 20 → room-threads 03 → voice 03. That is not a reason
to reorder either plan; it is a reason to start voice 01 today rather than treating the two as one
sequential program.

## The three things both plans are designing

### 1. A call binds to a NODE, not a channel

Voice 02 specifies "a durable call-binding record keyed by thread/channel and `callId`". Room-threads
01 (built) makes a node the unit of work AND of conversation, with channels bound to nodes and
membership inherited rather than re-modelled.

Keying the call to a channel re-introduces the exact bug this plan has now fixed twice — two
visibility models that can disagree about who may see what. It shipped once as `visibleAnswer` versus
`canReadAgent` (PR #252) and again as escalation cards addressed to org-public `#fleet` from a private
room (PR #263). A call binding that resolves membership its own way is the third instance waiting.

**Bind the call to a node id.** The node already carries the channel, and the channel already carries
membership. One model, one answer.

### 2. A voice decision is already a `decision` record

Voice 02 specifies "a voice-specific attention source" for decisions. Room-threads 11 (built) defines
a durable `decision` node record: what was asked, the options offered, what the human chose verbatim,
who decided, how long they took, and why it reached a human at all.

These are complementary, not competing, and the seam is clean:

- The **OMP arbiter owns the live state machine** — `open → awaiting-confirmation → answered | expired
  | cancelled | failed`. That is voice 01's, and nothing here should duplicate it.
- **On `answered`, the daemon writes a `decision` node record.** That is the durable evidence.

Doing this costs almost nothing and buys something real: rule proposals (concern 11) would then learn
from voice decisions for free. "Four times you were asked this on a call and four times you said yes"
is exactly the pattern the proposer already looks for, and voice is where a person answers most
readily. Without the shared record, voice decisions accumulate in a separate store and the fleet never
learns from the surface the human uses most.

A second attention *source* is fine — the ladder and push infrastructure are shared already. A second
decision *record* is not.

### 3. Artifact immutability is concern 17

Voice 02 specifies copy-on-ready snapshots, owned by the room store, pinned by content hash, surviving
worktree removal, with copy failures rendered as visible evidence rather than broken links.

Room-threads 17 specifies that decisions and their then-known evidence survive whole, that compaction
declares its cut and its authorizer, that a compacted record is labelled as compacted at every read,
and that stale evidence is marked stale at the point of transfer.

These are the same concern seen from two directions, and 17 is unbuilt — so there is no legacy to
reconcile, only a decision to make once. **Concern 17 should own the retention model and voice
artifacts should be an instance of it**, which also gets voice artifacts the age-and-staleness
semantics its own plan does not currently specify. A snapshot pinned by content hash still needs to
say "these results are 34 minutes old; re-run them against today's main".

## One of voice 05's open questions is already answered

Voice 05 asks "which decision categories require UI-only resolution in a deployment".

Concern 12 is built and answers it: credentials, spend, deletion, publishing and legal-edge actions
always reach a person, no learned rule may widen that, and it is enforced server-side. Those
categories are UI-only by construction — not by deployment policy, and not by a setting.

Two consequences for the voice plan:

- The arbiter must not let a **voice** resolution settle a decision in that class either. Voice 01's
  "require a second confirmation act for consequential work" is close but is a confirmation strength
  question; the boundary is a different axis and is absolute.
- A `DelegationGrant` is the only door, and it is per-action, attributable and revocable. If a
  deployment wants voice to settle something in the class, that is a grant with a person's name on it
  — not a config key.

The other three (transcript retention default, idle-hangup duration, whether the older S2S dispatcher
lane survives) are genuine preference forks and are Lars's.

## Smaller alignments worth taking

- **Unforgeable provenance is one mechanism, not two.** Voice 01 removes agent-controlled option
  payloads from human attribution and composes the delivering turn inside the arbiter from the label
  the person saw. Room-threads 02's amendment requires manager-authored proof cards that a unit cannot
  forge. Same defect class, same shape — one mechanism should serve both.
- **"Raw tool actions are diagnostic" is concern 27's worthiness rule** already enforced in
  `squad-manager.ts`. Voice 03 should reuse it rather than re-deriving a filter, or the two will drift
  and one surface will start showing `yield` again.
- **Voice 03's decision door** — question, real options, consequences, recommendation visible but never
  pre-selected, free-text not required — is concern 10's voice plus the reference design's
  "consequences under every option" and "a free-text third option". It should inherit those, not
  restate them.
- **Voice 02's `(callId, journalSeq)` idempotent projection key** is the right shape and is stronger
  than anything room-threads currently specifies for replay. Concern 02 should borrow it.

## What this does not change

The voice plan's architecture stands. Two planes with one arbiter is right, the journal-as-record
decision is right, and excluding the visualizer from V1 is right. Nothing above asks it to be
re-planned — it asks it to stop independently designing durability, decision records and artifact
retention that this plan already owns, and to bind to a node.

# Phase-5 bridge: glance land receipts as atrium proposals

**Status:** proposed — awaiting human review. This document authorizes no implementation.

**Date:** 2026-08-12

**Authorities:** the glance#208 thread comment (2026-08-12); atrium `init.md` Phase 5 (`init.md:528-541`); atrium `plans/room-entity-capabilities/ARCHITECTURE.md` (2026-08-04) as both the rigor bar and the doc this extends; glance#388.

**Trees read:** glance at `campaign/phase5-bridge` (off `origin/main`); atrium at `699842e` ("Land the humans-and-agents-as-peers campaign onto main"), read-only.

**Reopen if wrong.** Every claim below is anchored to a file and a line in one of those two trees. If an anchor has moved, the claim it carries is unverified until someone re-reads it. Three claims in particular are load-bearing and named as such in "What would falsify this" at the end.

---

## 1. The loop this is designing

glance lands changes. Each land produces a receipt: what merged, what proved it, who reviewed it, what it cost, and where main returns to if it were reverted. Today that receipt is an HTML file on disk, a JSONL index row, and a PR comment.

Atrium keeps a semantic ledger where every line says which of two things it is: `~`, a reading nothing has checked, or `✓`, the same sentence after a person accepted it (`README.md:19-22`). A machine can draft the list; a machine can never be the thing that certifies it.

The bridge is one sentence: **a glance land receipt crosses into atrium as a `~`, and a human's acceptance is the `✓`.** glance is the workforce; atrium is the record of what the workforce did that anybody vouched for. Nothing glance produces is ever a fact in atrium until a person says so, and the enforcement of that is not the bridge's own good behaviour — it is `reduce.ts:698`, which refuses regardless of what the bridge intends.

This is a Phase-5 answer in `init.md`'s sense (`init.md:534-539`: integrate Coven, integrate QM, invoke coding agents directly, or build a narrow internal runner). It is the third option, narrowed: glance is invoked outside atrium and reports back. It proposes no execution runtime inside atrium and no way for atrium to start a glance run. That direction is deliberately out of scope; see §8.

---

## 2. Contradictions found while verifying this ticket

The ticket (glance#388) and its inherited framing make four factual claims that the trees do not support. They are corrected here rather than carried forward.

**2.1 — "Agent participant" is no longer future.** The ticket, and `ARCHITECTURE.md:32` ("Agent participant — future") and `:209` ("Do not extend today's `model` string into an agent identity"), describe a durable machine principal that does not exist yet. It exists. Atrium's HEAD commit is `699842e`, "Land the humans-and-agents-as-peers campaign onto main". Specifically:

- `packages/db/src/schema.ts:239` — `principalKind = pgEnum('principal_kind', ['human', 'agent'])`.
- `packages/db/src/schema.ts:289` — `users.principal_kind`, `NOT NULL DEFAULT 'human'`, immutable after provisioning by a BEFORE UPDATE trigger and, since drizzle/0018, a BEFORE INSERT companion (`schema.ts:271-288`).
- `packages/db/src/schema.ts:219` — `actorKind = pgEnum('actor_kind', ['human', 'agent', 'model', 'system'])`. Four values, not three.
- `packages/core/src/common.ts:314-319` — the `Actor` union carries `{ kind: 'agent', userId: Id }`.
- `packages/core/src/common.ts:332-334` — `actorUserId()`, the predicate that separates "has an identity" from "is a person", precisely because those two questions stopped coinciding.
- `apps/server/src/session.ts:50` — `Session.principalKind`, required, no `?? 'human'` default anywhere.

`ARCHITECTURE.md` is dated 2026-08-04 and its evidence section (`:15-16`: "An authenticated session identifies only a human `userId`"; "Core's trusted actor is an out-of-band union of `human`, `model`, and `system`") is stale against the tree it describes. That document remains the rigor bar for *form*. It is no longer accurate as a survey of *fact*. This document treats `ARCHITECTURE.md`'s slice 4 ("Agent identity and participation", `:257`) as **shipped**, and designs slice 4½ — an agent that stages readings — on top of it.

**2.2 — the "reduce.ts:698 actor floor" is correctly cited, but it is a floor against `isHuman`, not against `model`.** `authority.ts:226-228` is `actor.kind === 'human'`. `common.ts:287-290` states the consequence outright: `agent`, `model` and `system` are all machines and every certification gate refuses all three by the same predicate. Giving glance an `agent` principal buys it an identity and buys it nothing whatsoever in certification authority. That is the design's whole point, and it is worth stating that it is a property of the existing code rather than a restraint this document is adding.

**2.3 — the glance-side anchors in the ticket's framing are wrong.** The receipt schema is not in `src/squad-manager.ts`; it is `src/rail/receipt/types.ts:95-132`. `validatorGate` stamping is not in `squad-manager.ts`'s land lane; it is `src/validator.ts:838-843` (the stamper) called from `src/validator.ts:914` (inside the gate). What lives in the land lane is the *call* (`squad-manager.ts:5324-5340`) and the *receipt assembly* (`squad-manager.ts:4800-4820`). The ranges given (~4319–5810) do contain the land lane; they do not contain the schema or the stamp.

**2.4 — `ARCHITECTURE.md` has no section titled "What this document does NOT authorize".** Its discipline is real but is expressed as a status line (`:3`, "This document authorizes no implementation") plus refusals scattered through the body (`:9`, `:141`, `:163`, `:166`, `:209`, `:239`, `:261`). §8 below writes that discipline out as an explicit section, which is a change in form and not a claim about what `ARCHITECTURE.md` contains.

---

## 3. Seam A — glance receipt production

### 3.1 What a land receipt is

`LandReceipt` — `src/rail/receipt/types.ts:95-132`. Five groups, every field:

| group | field | line | notes |
|---|---|---|---|
| what landed | `repo: string` | `:98` | `"owner/repo"` slug |
| | `branch: string` | `:99` | |
| | `commit?: string` | `:101` | absent when nothing merged |
| | `message?: string` | `:104` | landed commit subject |
| | `files: string[]` | `:106` | base-relative |
| | `insertions?` / `deletions?` | `:107-108` | |
| | `landed: boolean` | `:110` | the merge truth |
| | `at: number` | `:112` | epoch ms |
| what proved it | `gate: LandReceiptGate` | `:115` | `status` `:65`, `command?` `:67`, `unprovenGreenRejected` `:69`, `newRegressions` `:72`, `baseWasRed` `:74`, `detail?` `:76` |
| who reviewed it | `validation?: ValidationRecord` | `:120` | absent when no validator ran |
| | `panel?: PanelVerdict[]` | `:122` | T5, parked, never populated today |
| rollback | `rollbackPoint?: string` | `:126` | the `head0` main returns to |
| | `forcedWithoutProof: boolean` | `:128` | |
| cost | `cost: LandReceiptCost` | `:131` | `costUsd?` `:81`, `costUnknown` `:84`, `model?` `:86`, `tokens?` `:88` |

`GateStatus` (`:62`) is a six-value union with documented semantics at `:47-61`: `green`, `red-baseline`, `failed`, `unproven-rejected`, `no-gate`, `forced`. Three of those six are honest amber or red states. A bridge that renders "landed" without carrying the gate status would be laundering four of them into the fifth.

### 3.2 Where it is built

`SquadManager.emitLandReceipt` — `src/squad-manager.ts:4757-4830`, literal construction at `:4800-4820`. Called fire-and-forget from `landInner` at `:4747`, guarded by `if (!result.retryable)` — a retryable deferral is not a land and gets no receipt.

Attribution SHAs come from the land's own in-lock values (`result.head0`, `result.landedCommit`, `:4774-4775`), never a post-hoc HEAD read; the comment at `:4769-4773` names the TOCTOU that motivated it. The file list, LOC and subject are read from those fixed SHAs (`:4786-4796`), and a git fault leaves the field blank rather than fabricating one (`:4781-4785`).

### 3.3 The validator stamp

`validatorGate` — `src/validator.ts:851-924`, called from `SquadManager.runValidatorGate` at `src/squad-manager.ts:5324-5335`. The record is stamped onto the agent DTO at `:5337`, which is what `landInner` snapshots and hands to `emitLandReceipt`.

The reviewer-precision stamp is applied by `withFreshReviewerPrecision` — `src/validator.ts:838-843` — called **unconditionally, cache hit or miss**, at `src/validator.ts:914`. Its three honest outcomes:

- `skipped` / `inconclusive` verdicts pass through untouched (`:839`) — those never resolved a reviewer identity.
- No determinable lineage yields `{ lineage: "unknown", n: 0, survived: 0, provisional: true }` (`:841`) — explicitly never defaulted to the `native` bucket.
- Otherwise `reviewerPrecisionStampFor(tag, path)` (`:842`), reading the repo-committed ledger.

`ReviewerPrecisionStamp` — `src/memory/reviewer-weights.ts:221-254`: `lineage` `:223`, `n` `:226`, `survived` `:228`, `survivedRate?` `:232` (own key only when `n > 0`), `provisional` `:235`, `rejected?` `:240`, `corrupt?` `:247`, `unreadable?` `:253`. The last two exist to keep "the ledger could not be trusted" distinguishable from "no history yet" — a distinction the bridge must preserve verbatim or it fabricates a measurement.

Backing data: `plans/.reviews/reviewer-ledger.jsonl`, path constant at `src/memory/reviewer-weights.ts:219`, sole writer `scripts/reviewer-ledger.ts` (the `add` branch, `:27-49`), entry shape `ReviewerLedgerEntry` at `src/memory/reviewer-weights.ts:56-71`.

### 3.4 The countable substrate

`landReceiptIndexRow` — `src/rail/receipt/write.ts:59-83`. Pure, and already the structured projection the bridge wants: `at`, `repo`, `branch`, `commit?`, `landed`, `forced`, `gateStatus`, `precision?`. `LandReceiptIndexRow` is `src/rail/receipt/types.ts:167-183`, with its honesty invariants stated at `:161-166`: `precision` present only when a validator ran, never coerced to a zero-precision object; `landed` is the merge truth independent of `gateStatus`.

Persistence: `writeLandReceipt` — `src/rail/receipt/write.ts:148-183`. HTML written with `flag: "wx"` at `:159` (immutable, five retries on collision, never overwrite); the index row appended at `:165` inside its own inner try/catch so an index failure warns to stderr (`:171`) and undercounts rather than losing the receipt.

### 3.5 What exists as an outbound path today

Exactly three hops leave the machine, and none of them is a structured export from the daemon:

1. `postReceiptComment` — `src/rail/receipt/write.ts:190-200`, `gh pr comment` at `:198`, called at `src/squad-manager.ts:4824`. Ships rendered Markdown, not the object.
2. `postAgentPrCheck` — `src/rail/wedge/post-check.ts`, a GitHub check-run carrying `receiptToCheckOutput`. Its only caller in this checkout is the CLI `scripts/post-wedge-check.ts:113`; the daemon does not call it.
3. `TraceExportQueue` — `src/trace-exporter.ts:178`, the one real outbound network exporter framework (SSRF allowlist `:62`, env wiring `:233-241`). It ships `RunReceipt.spans`, never a `LandReceipt`.

**There is no webhook, publish, or export path for a `LandReceipt`.** The bridge is new surface on the glance side, not a rewiring of existing surface. `TraceExportQueue` is the closest existing pattern to copy for boundedness and failure isolation.

### 3.6 The harness ingest analogy

`HarnessIngester` — `src/ingest/harness.ts:28-33`: a `name` and an idempotent `ingest({stateDir, repo, now?})`. Dispatched by `ingestAllHarnesses` (`:43-56`), throttled per `(stateDir, repo, harness)` at `:47`, failure-isolated at `:52-54` so one broken ingester cannot sink the rest. Registered as a one-line array: `src/ingest/index.ts:16`.

This is the shape a receipt exporter should take on the glance side — a named, idempotent, throttled, failure-isolated plugin — and it is called out here because the bridge should not invent a second plugin idiom in the same codebase.

### 3.7 What identity a glance unit has

`newAgentId` — `src/spawn-identity.ts:66-68`: `` `${name}-${base36 time}-${base36 seq}-${8 hex}` ``. Process-local sequence (`:58`), random suffix, and the branch and worktree derive from it rather than from the display name (`:60-64`).

Tenancy is **not** in the id. It is in the state directory: `src/manager-registry.ts:132` — `path.join(this.deps.root, "orgs", orgId)`, with the operator stamped per-org at `:134`. A `LandReceipt` therefore carries no org or tenant field at all; its tenancy is implied by which `stateDir` its `land-receipts/` directory sits under.

**Consequence, stated plainly: a glance unit id is not a principal.** It is ephemeral (per spawn), process-local (the sequence resets on restart), unauthenticated, and carries no tenancy. It is provenance data. §4 designs the principal separately.

---

## 4. Seam B — atrium proposal consumption

### 4.1 The only door

`atrium_append_core_event` is the only way a row reaches `core_events` (`README.md:856`). Above it, `ledger.append` (`apps/server/src/ledger.ts:426`) takes an `AppendRequest` (`:317-350`):

- `roomId` `:319` — checked against the event's own.
- `actor: Actor` `:321` — "the trusted actor, derived from the authenticated session. **Never a payload.**"
- `authorize?(tx)` `:340` — re-checked *inside* the append transaction, after the ledger lock (`:322-338` names the TOCTOU it closes).
- `build(assigned)` `:342` — the event, once the ledger has assigned id and timestamp.
- `project(context)` `:349` — projections in the same transaction; a failed projection takes the event down.

The actor is out-of-band by construction. `packages/core/src/events.ts:12-29` states it: the event schema has no place to put an actor, and `CoreEvent` refuses at parse time an input that carries one (`events.ts:178-185`), so a forged actor is an error with a message, not a silently dropped field. Storage is two columns — `core_events.actor_kind` `packages/db/src/schema.ts:449` and `core_events.actor_id` `:450` — written by the same transaction that assigns `room_seq` (`schema.ts:441-448`).

### 4.2 The actor floor

`reduce.ts:698-741`, inside `applyObjectAccepted`. Three gates, in order:

1. **Type minting** (`:714-718`). `modelMintingGate(object.type)` (`authority.ts:189-223`) returns a refusal for `decision`, `commitment`, `objective`; `null` for `claim` and `open_question`. Combined with `!isHuman(actor)`, a non-human may not mint those three types at all, **whether or not a proposal was cited** — the comment at `:712-713` names the exact move it blocks: an interpreter accepting its own decision proposal.
2. **Verified claims** (`:724-727`). No non-human transition of a claim to `verification: 'verified'`. "Nothing model-accepted ever renders as fact" (`:722-723`).
3. **Proposal-less objects** (`:737-741`). A machine has exactly one route to a fact: propose it, and have the proposal accepted. Without this gate "the whole acceptance boundary is optional" (`:734-736`).

Downstream in the same function: citation must be real, open and type-matching (`:743-749`); proposer binding via `actorMatchesProposer` (`:786`); the full receipt path for non-humans (`:819`, `:832`); the confidence floor (`:850`); `uncertifiedTypeRefusal` (`:876`); `selfStagedReadingRefusal` (`:897`).

`isHuman` is `actor.kind === 'human'` (`authority.ts:226-228`). An `agent` actor is refused by all of the above exactly as a `model` is (`common.ts:287-290`).

### 4.3 The tables

**`proposals`** — `schema.ts:1002-1082`. Relevant columns: `id` `:1005`, `roomId` `:1006`, `interpretationId` `:1009`, `type` `:1012`, `payload` `:1013`, `confidence` `:1014`, `proposerKind` `:1015`, `proposerModel` `:1016`, `proposerUserId` `:1017`, `stagedByKind` `:1037`, `stagedById` `:1038`, `quote` `:1048`, `status` `:1049` (default `'proposed'`), `decidedBy` `:1050`, `decidedAt` `:1051`, `rejectedReason` `:1052`, `createdAt` `:1053`.

The `proposer_*` / `staged_by_*` split (`:1018-1036`) is the single most useful thing in the schema for this bridge. `proposer_*` is *what the reading claims to be*; `staged_by_*` is *who typed it*. `staged_by_*` is deliberately shaped like `core_events.actor_kind`/`actor_id` rather than like `proposer_*`, because the stager is an `Actor` and therefore has a `system` variant `proposer_kind` cannot spell (`:1028-1035`). Constraints: `proposals_proposer_identified` `:1060-1064`, `proposals_staged_by_id_matches_kind` `:1072-1075`, `proposals_staged_by_id_not_blank` `:1076-1079`.

`stagedBy` is not a parameter. `reduce.ts:567` sets `stagedBy: actor` — the trusted append actor, projected at `apps/server/src/projections.ts:264-265`. A caller cannot claim to have been typed by someone else.

**`proposal_sources`** — `schema.ts:1091-1113`. Three columns: `roomId` `:1094`, `proposalId` `:1097`, `messageId` `:1098`. PK on `(proposalId, messageId)` `:1101`, and two **composite** foreign keys — `proposal_sources_proposal_same_room_fk` `:1102-1106` and `proposal_sources_message_same_room_fk` `:1107-1111` — that make it structurally impossible for a proposal in room A to cite a message in room B (`:1086-1090`).

`messages` — `schema.ts:912-957`: `id` `:915`, `seq` `:917`, `roomId` `:918`, `authorId` `:921` (FK to `users.id`), `body` `:922`, `replyToId` `:923`, `clientMessageId` `:925`, `attachments` `:927`, `mentionUserIds` `:929`, `createdAt` `:930`.

**`interpretations`** — `schema.ts:977-997`. The idempotency mechanism is `uniqueIndex('interpretations_message_version_key').on(messageId, interpretationVersion)` at `:995`.

**`command_receipts`** — `schema.ts:926-967`. PK `(roomId, actorKind, actorId, commandName, idempotencyKey)` `:944-947`, with `payloadFingerprint` (server-computed SHA-256) `:937`, and `firstRoomSeq`/`lastRoomSeq` composite-FK'd back to `core_events` `:948-957`. Two checks matter to this design: `command_receipts_actor_has_identity` (`:958`, `actor_kind <> 'system'`) and `command_receipts_actor_id_not_blank` (`:959`). **An `agent` actor can own a command receipt; a `system` actor cannot.**

### 4.4 The five-step pattern the bridge is judged against

`apps/server/src/jobs/interpret.ts:33-72` states the contract:

1. **Claim** (`:39-47`) — every message this run will read gets an `interpretations` row first. The unique index is the idempotency mechanism; a racing worker claims nothing, a retry reuses its own `pending` rows, yielding the same interpretation id, therefore the same content-addressed proposal ids, therefore a `proposal_recorded` the reducer refuses as already recorded. "Zero duplicates across retries is a consequence of those two facts, not a check somebody remembered to write."
2. **Route** (`:48-53`) — tier chosen from raw text before any call.
3. **One call** (`:54-55`) — the whole window in one prompt.
4. **Judge** (`:56-57`) — `validateProposalProvenance` then `decideAcceptance`, both from `packages/core`; nothing re-implemented locally.
5. **Append** (`:58-60`) — through `ledger.append`, "the same seam the socket layer uses, so the receipt window, the actor rules and the projections are the ones the rest of the system already has".
6. **Settle** (`:61-63`) — rows to `succeeded`; a message that arrived mid-flight gets a follow-up job rather than being dropped.

And the prohibition (`:65-71`): never render as a person's words something they did not write.

**Transactional enqueue** — `apps/server/src/queue.ts:287-306`. `boss.send(...)` with `db: fromDrizzle(tx, sql)` at `:303`: the job row is written by the caller's transaction, "so it commits with the message or not at all. A crash between the two is not a state this can reach — there is no 'between'" (`:283-285`).

**Canonical ingest line** — `packages/ingest/src/validate.ts:33-46`: `IngestMessage` is a `z.strictObject` of `{id, author, ts, text, reply_to?, attachments?}`. `id` must be "stable, source-derived, and reproducible: never a random uuid" (`:34`). `ts` "comes from the source; never from a local clock" (`:38`). Serialization is canonical and clock-free (`packages/ingest/src/jsonl.ts:4-14`). This is the discipline the bridge's own wire format should copy even though the bridge does not use `packages/ingest` itself: same source, same bytes.

---

## 5. The durable machine principal

### 5.1 What the principal is

**One atrium `users` row per glance deployment-and-tenant, with `principal_kind = 'agent'`.** Not per unit, not per repo, not per run.

- It is a `users` row (`schema.ts:266-300`), so it can hold a session, a workspace membership, a room membership, and its own name on what it wrote (`:258-264`).
- `principal_kind = 'agent'` (`:289`), set at provisioning and immutable thereafter — a BEFORE UPDATE trigger refuses any change, and since drizzle/0018 a BEFORE INSERT companion refuses a row whose kind disagrees with what that uuid has already appended (`:271-283`).
- Its appends carry `actor_kind = 'agent'`, `actor_id = <its users.id>` (`schema.ts:202-208`). The database checks the agreement: `atrium_core_events_invariants` reads `users.principal_kind` for the id in `actor_id` and refuses a row whose `actor_kind` disagrees, "so an agent's session cannot append history that reads as a person's, nor the reverse" (`:205-208`).

**Why not per unit.** A glance unit id (`src/spawn-identity.ts:66-68`) is minted per spawn, sequenced by a process-local counter that resets on daemon restart, and carries no tenancy. Provisioning a `users` row per unit would mint an unbounded, immutable, never-revocable identity population keyed on something that is not stable across a restart — and `principal_kind` is deliberately unchangeable (`schema.ts:272-275`), so every mistake is permanent. Unit ids belong in the proposal payload as provenance, where they are data and can be wrong without corrupting the identity table.

**Why not per org inside atrium's own tenancy.** Atrium's tenancy boundary is the workspace (`schema.ts:302-304`). glance's is `<root>/orgs/<orgId>/` (`src/manager-registry.ts:132`). These are two independent tenancy schemes and this document does **not** propose reconciling them. One glance-org maps to one atrium workspace by explicit human provisioning, one principal each. Anything more automatic is the tenant gate contract, which belongs to G3 and is not designed here.

### 5.2 What it can and cannot do — extending `ARCHITECTURE.md`'s capability matrix

`ARCHITECTURE.md:58-69` is a five-column matrix. Its "Agent participant" column was aspirational when written; against the tree at `699842e` most of it is now enforced code. The rows below reproduce that column and add a sixth, **Land-receipt bridge** — the specific agent principal this document designs — with the enforcing anchor for each cell.

| Act | Agent participant (ARCHITECTURE.md `:58-69`) | Land-receipt bridge (this document) | enforced at |
|---|---|---|---|
| Read conversation | granted scope | its own room only; never reads to act | room membership |
| Author chat | granted, as self | **yes** — posts the receipt message as itself | `messages.authorId` → its `users.id`, `schema.ts:921`; `commands.ts:1505-1508` |
| Be mentioned | while active and mentionable | yes, inert — a mention starts nothing | `ARCHITECTURE.md:71`, `:129` |
| Mention a target | granted chat plus same-room visible target | no — the receipt message mentions nobody | design choice, §6.5 |
| Stage a semantic proposal | granted proposal type | **`claim` only** | `modelMintingGate`, `authority.ts:189-223` |
| Certify `✓` | never | **never** | `reduce.ts:714-718`, `:724-727`, `:737-741`; `isHuman`, `authority.ts:226-228` |
| Correct accepted state | never | **never** | `reduce.ts` corrections are human-only |
| Assign work | never in v1 | **never** | not proposed |
| Execute a tool/action | explicit action/resource grant | **none inside atrium** | §8 |
| Grant or delegate | never | **never** | `ARCHITECTURE.md:69` |
| *(new)* Accept its own reading | — | **never, by policy on top of the code** | §6.6 |
| *(new)* Supersede / reject its own reading | — | **no** — refused, a side effect of Option B (§7.4) | `actorMatchesProposer`, `authority.ts:401-405`; `reduce.ts:599`, `:645` |

Two rows deserve their own paragraph.

**"Certify `✓` — never" is not this document's promise.** It is `reduce.ts`. If the bridge were rewritten tomorrow to attempt a `✓`, the reducer would refuse it, write a `fail` row, and change no state. The bridge is not trusted; it is *bounded*. That distinction is the reason this design is worth having at all.

**"Accept its own reading — never, by policy"** is the one place this document is stricter than the code. `modelMintingGate` returns `null` for `claim` (`authority.ts:214-216`), so a machine *may* auto-accept a sufficiently confident claim; `README.md:154` calls that "#4's auto-accept path" and it is deliberate. A land receipt must not use it. See §6.6.

### 5.3 The blocker: `Proposer` has no agent variant

This is the honest centre of the design and the thing a reviewer should test first.

`Proposer` — `packages/core/src/proposal.ts:19-21` — is a two-variant union: `{kind:'model', model}` and `{kind:'human', userId}`. There is no `agent`. `common.ts:308-312` says the omission is deliberate and says why: a proposal's proposer decides whether the acceptance engine demands a receipt window and whether θ applies, and "nothing about 'an agent holds an account' answers any of them".

Two ends enforce it:

- `apps/server/src/commands.ts:1516-1521` — `draftToProposal` throws when `session.principalKind !== 'human'`. The reasoning is at `:1486-1509`: the two available moves were to record an agent's proposal as a human's or to refuse it, and recording it as a human's is "a reading that is not a person's, stored as a person's, skipping the receipt gate a human acceptance skips".
- `packages/core/src/authority.ts:401-405` — `actorMatchesProposer` returns `false` for an agent actor. The doc at `:392-399`: no proposal in any room was ever staged by an agent, so there is none for it to own; "this is not a policy choice about agents made here — it follows from `Proposer`".

**Two ways forward, and this document picks the second.**

*Option A — widen `Proposer` with an agent variant.* Correct in the long run, and `commands.ts:1501-1503` names it precisely: "When `Proposer` gains an agent variant with the two questions above answered, this refusal is what a reviewer deletes, and `actorMatchesProposer` in `@atrium/core` is the other end that has to move with it." It requires answering, for an agent proposer: does the reading need a receipt window checked against the messages it cites (`acceptance.ts:663`), and does θ apply (`acceptance.ts:828`)? Those are atrium's questions, not glance's. This document does not answer them and does not propose that anyone answer them in order to ship a bridge.

*Option B — proposer `model`, stager `agent`.* The proposal is recorded with `proposer_kind = 'model'`, `proposer_model = "glance/<harness>"`, and — because `reduce.ts:567` derives `stagedBy` from the trusted append actor — `staged_by_kind = 'agent'`, `staged_by_id = <the bridge principal's users.id>`. Nothing is widened. Nothing is mislabelled: the reading genuinely *is* machine-produced (`proposer`), and the thing that typed it genuinely *is* the glance agent principal (`staged_by`). That is exactly the distinction `schema.ts:1018-1027` introduced the columns to record.

Option B is what §6 specifies. Its cost is stated in §6.6 and §7.5.

**Is Option B routing around `commands.ts:1516`?** No — and this is the claim the gauntlet should press hardest on. That refusal is scoped to `draftToProposal`, the socket command path. An in-process job constructs its `Proposal` directly and calls `ledger.append` — which is what `interpret.ts` does today (`interpret.ts:414-419`, appending with `actor: {kind:'model', model}`). `commands.ts:1477-1484` and `authority.ts:392-399` both anticipate a legitimate in-process staging caller and describe it in the future tense. The bridge is that caller. But "the doc anticipated a caller like me" is a weaker warrant than "the doc anticipated me", and a reviewer who disagrees should say so before this ships rather than after.

---

## 6. Receipt → proposal translation

### 6.1 The transport, in one paragraph

The glance daemon does not write to atrium's database and does not speak atrium's socket protocol. It emits a receipt envelope to an atrium-side ingest endpoint; an **in-process atrium job** — sibling to `interpret.ts`, obeying the same six-step contract (§4.4) — is what posts the message, stages the proposal, and appends both. The trust boundary is atrium's, held where atrium already holds it, and the glance side is a producer that atrium validates like any other untrusted input. Nothing in this document proposes that glance hold an atrium database credential.

### 6.2 The wire envelope

Derived from `landReceiptIndexRow` (`src/rail/receipt/write.ts:59-83`) plus the fields a human needs to judge, and canonicalized on `packages/ingest`'s discipline (`validate.ts:33-46`, `jsonl.ts:4-14`): fixed key order, no clock read on the emitting side, optional fields omitted rather than emitted null.

```
{
  bridge_version: 1,
  receipt_id:     string,   // §6.4 — stable, derived, never random
  repo:           string,   // LandReceipt.repo          types.ts:98
  branch:         string,   // LandReceipt.branch        types.ts:99
  commit:         string?,  // LandReceipt.commit        types.ts:101
  message:        string?,  // LandReceipt.message       types.ts:104
  landed:         boolean,  // LandReceipt.landed        types.ts:110
  at:             string,   // ISO-8601 from LandReceipt.at (epoch ms) types.ts:112
  gate: {
    status:               GateStatus,  // types.ts:62
    command:              string?,     // types.ts:67
    unproven_green_rejected: boolean,  // types.ts:69
    new_regressions:      string[],    // types.ts:72
    base_was_red:         boolean,     // types.ts:74
  },
  forced_without_proof: boolean,       // types.ts:128
  rollback_point:       string?,       // types.ts:126
  files_changed:        number,        // |LandReceipt.files|  types.ts:106
  insertions:           number?,       // types.ts:107
  deletions:            number?,       // types.ts:108
  validation: {                        // OMITTED ENTIRELY when no validator ran
    verdict:   string,                 // ValidationRecord.verdict   src/types.ts:284
    precision: {                       // OMITTED when unstamped
      lineage:    string,              // reviewer-weights.ts:223
      n:          number,              // :226
      survived:   number,              // :228
      corrupt:    true?,               // :247
      unreadable: string?,             // :253
    }?,
  }?,
  cost: { usd: number?, unknown: boolean, model: string?, tokens: number? },  // types.ts:79-89
  unit: { agent_id: string?, org_id: string? },   // provenance only — NOT a principal (§5.1)
}
```

Four omissions are deliberate and each is an absence-honesty rule inherited from the glance side:

- `validation` absent ≠ `validation.verdict = "skipped"`. Absent means no validator ran (`types.ts:118-120`).
- `precision` absent ≠ `n: 0`. Absent means unstamped; `n: 0` means measured-and-empty (`types.ts:136-140`).
- `corrupt` / `unreadable` are carried, not flattened. They mean "the ledger could not be trusted", which is not "no history" (`reviewer-weights.ts:241-253`).
- `cost.unknown: true` is not `cost.usd: 0`. A genuinely free run is a real zero (`types.ts:80-84`).

The full `files` array is reduced to a count. A receipt message that lists two hundred paths is not a sentence a human can accept; the paths stay in glance's HTML receipt, which the message links.

### 6.3 The message anchor — what "the message a receipt cites" is

`proposal_sources` requires a `message_id` that composite-FKs into `messages` in the same room (`schema.ts:1107-1111`). There is no way to stage a proposal whose provenance is a URL, an external id, or nothing. So the bridge must **first post a message, then cite it.**

That message is authored by the bridge principal — `messages.authorId` is an FK to `users.id` (`schema.ts:921`), which the agent principal has, and `commands.ts:1505-1508` states explicitly that an agent may post messages. Its body is the receipt, rendered as prose, ending in a link to glance's HTML receipt. Something like:

> `glance landed feat/x onto main in lmvdz/glance as a1b2c3d — acceptance gate green (bun run check), no new regressions, reviewed by codex (12 findings adjudicated, 9 survived). Rollback point 9f8e7d6. $0.42. Receipt: <link>`

The `quote` on the proposal (`proposals.quote`, `schema.ts:1048`) is a verbatim span of that message body — the sentence the reading rests on. `schema.ts:1039-1047` explains why the column exists: it is what every attribution rule is computed from, and a projection carrying the citation list but not the sentence renders a `~` nobody can check by eye.

**This is a design decision with a real cost, stated plainly.** It means every land posts a room message, whether or not anyone wanted one. A busy fleet floods the room. Two mitigations are available and neither is free: post only receipts above a materiality bar (which makes the ledger silently partial), or batch a window of lands into one message citing one proposal per land (which makes `quote` spans harder to keep verbatim and couples unrelated lands into one transaction). This document does not choose between them; §9 lists it as unresolved. What it does refuse is the third option — a proposal with no message anchor — because the schema refuses it too.

### 6.4 What kind of proposal

**`type: 'claim'`.** Not `decision`, not `commitment`, not `objective` — `modelMintingGate` (`authority.ts:189-196`) makes all three unmintable by any non-human, and staging one the reducer will refuse at acceptance is staging a `~` that can never become `✓`. A land receipt is a claim about the world in the ordinary sense: *this branch landed, this gate said this*.

`ClaimPayload` (`packages/core/src/objects.ts:43-48`) carries `statement`, `claimant: Id`, and `verification` (defaulting to `'unverified'`). Two consequences:

- `verification` is `'unverified'`. `reduce.ts:724-727` refuses any non-human transition to `'verified'`, and `README.md:153` explains that an accepted claim keeps its truth status in a separate field which is what the glyph renders. A person accepting the receipt is saying "I accept this reading", not "I have re-run the gate".
- `claimant` must resolve to an identity. It is the **bridge principal's `users.id`** — glance is the claimant. Not the human who spawned the unit, and not a `null`. `interpret.ts:65-71` forbids resolving a name to anyone who did not write the sentence, and the sentence here is the bridge's own message.

`confidence` is `real NOT NULL` in `[0,1]` (`schema.ts:1014`, `:1059`). A land receipt is not a probabilistic reading — the bridge is not guessing what the gate said, it is reporting it. The honest value is `1.0`, meaning "this is a faithful transcription", and it must not be read as "this land was good": `gate.status` carries that, and four of its six values are not green. A reviewer should check that the render never conflates the two.

### 6.5 Field map

| receipt envelope | proposal / message | anchor |
|---|---|---|
| rendered prose | `messages.body` | `schema.ts:922` |
| bridge principal | `messages.authorId` | `schema.ts:921` |
| the posted message's id | `proposal_sources.messageId` | `schema.ts:1098` |
| room the principal is provisioned into | `proposal_sources.roomId`, `proposals.roomId` | `:1094`, `:1006` |
| — | `proposals.type = 'claim'` | `:1012` |
| statement sentence + claimant | `proposals.payload` (`ClaimPayload`) | `:1013`; `objects.ts:43` |
| `1.0` | `proposals.confidence` | `:1014` |
| — | `proposals.proposerKind = 'model'` | `:1015` |
| `"glance/<harness>"` | `proposals.proposerModel` | `:1016` |
| bridge principal (derived from append actor) | `proposals.stagedByKind = 'agent'`, `stagedById` | `:1037-1038` via `reduce.ts:567` |
| the receipt sentence, verbatim | `proposals.quote` | `:1048` |
| — | `proposals.status = 'proposed'` (default) | `:1049` |
| `receipt_id` | idempotency key, §6.6 | `schema.ts:935` |
| everything not in the sentence | link in the message body to glance's HTML receipt | `src/rail/receipt/write.ts:159` |

The last row is a decision: the receipt's structured detail does **not** become proposal payload. The payload is a sentence a person can read and accept. Everything else stays on the glance side behind a link, because a payload nobody reads is a payload nobody is really accepting.

### 6.6 Idempotency and the transactional boundary

**`receipt_id` is derived, never random.** `packages/ingest/src/validate.ts:34` states the rule for corpus ids and the same reasoning applies: a retried emit must produce the same id or the retry becomes a duplicate land in the ledger. The derivation is `sha256(repo, branch, commit ?? "", at)` — the same tuple that makes glance's own receipt filename collision-resistant (`src/rail/receipt/write.ts:39-43`). A land with no commit (a rejected land) still has a distinct `(branch, at)`.

**Two idempotency layers, mirroring `interpret.ts`:**

1. *At the door.* `command_receipts` (`schema.ts:926-967`), keyed `(roomId, actorKind, actorId, commandName, idempotencyKey)` with a server-computed `payloadFingerprint`. The bridge principal is `actor_kind = 'agent'` with a non-blank `actor_id`, so it satisfies `command_receipts_actor_has_identity` (`:958`) and `command_receipts_actor_id_not_blank` (`:959`) — a `system` actor would not. `commandName = 'bridge_land_receipt'`, `idempotencyKey = receipt_id`. A duplicate emit replays the existing rows rather than writing new ones, which is what `AppendBatchRequest.idempotency` (`ledger.ts:359-365`) already does for `stage_semantic_command` (`commands.ts:1086-1091`).
2. *At the fold.* `interpret.ts:396-412` checks the reducer's own state before appending, because the reducer would refuse a duplicate as `applied_with_issue` — which still writes a ledger row that changes nothing, and "rows are history and history is replayed". The bridge does the same check for the same reason.

**The transactional boundary is one `appendBatch`.** The message and the proposal are causally inseparable — a proposal citing a message that does not exist violates `proposal_sources_message_same_room_fk` (`schema.ts:1107-1111`), and a receipt message with no reading is noise. `AppendBatchRequest` (`ledger.ts:353-370`) takes multiple `builds` under one lock with `requireClean: true` (`:367`), which refuses the whole causal unit if any reducer step reports a business issue. That is exactly the shape `stage_semantic_command` uses (`commands.ts:1060-1063`).

Projections commit in the same transaction as the ledger row (`ledger.ts:343-349`): "a ledger row whose projection is missing is a state the next reader disagrees with".

**The bridge never accepts.** It stages `~` and stops. `modelMintingGate` would permit a machine acceptance of a claim (`authority.ts:214-216`) and the θ floor would gate it; this design declines that path on purpose, because the entire product claim of the bridge is that a person's acceptance is the certification. A bridge that auto-accepted its own receipts would produce a ledger of `✓` lines nobody read, which is the failure `README.md:124-126` exists to prevent. **This is the second claim the gauntlet should attack: the restraint is policy, not code, and policy can be edited by whoever is on call at 3am.** The mitigation available today is `selfStagedReadingRefusal` (`authority.ts:516`, guards at `:537`/`:546`/`:549`), which refuses a *human* accepting a machine-attributed reading they themselves staged — it does not stop the bridge accepting its own. If that guarantee needs to be code, it belongs in `reduce.ts` as a floor on `staged_by_kind = 'agent'`, and this document does not propose that change.

**Who may accept.** Any human member of the room. `selfStagedReadingRefusal`'s guard at `authority.ts:546` returns `null` — no refusal — when the stager is not the accepting human, and the stager here is the agent principal. Whether *any* human should be able to certify a land they did not review is `ARCHITECTURE.md:234`'s open question ("Which human may certify a third-party claim...?"), inherited unresolved and not narrowed here.

---

## 7. Failure honesty

Every quiet default, named.

**7.1 — A malformed receipt.** Refused at the ingest boundary against a strict schema, in the shape `packages/ingest/src/validate.ts:33` uses (`z.strictObject`: an unknown key is an error, not an ignored field). A refused receipt produces no message, no proposal, and no ledger row. It is recorded on the glance side as an un-exported receipt and surfaces in the bridge's own error count. **It is not partially ingested**, and it is not coerced: a missing `gate.status` does not default to `green`, a missing `validation` does not become a skipped verdict, and a missing `precision` does not become `n: 0`. The absence-honesty rules of §6.2 apply at the reader as well as the writer.

**7.2 — The bridge is down.** The glance land completes. This is not negotiable: `src/squad-manager.ts:4743-4747` already makes receipt emission best-effort and fire-and-forget after a terminal land, with the comment stating it "never gates or delays the land it records", and `emitLandReceipt`'s own contract (`:4751-4756`) degrades every fault to a log line. The bridge inherits that posture. A bridge outage means atrium's ledger is **behind**, never wrong.

Behind must be visible. glance's own precedent is `writeLandReceipt`'s index-append failure (`src/rail/receipt/write.ts:164-175`), which warns to stderr precisely because "a persistent append failure would otherwise under-report the gate's evidence with no signal at all". The bridge needs the same: an unexported-receipt count that a human can see. **A silent backlog is the failure mode this design is most exposed to**, because the ledger looks correct and is merely incomplete, and incompleteness is invisible by construction.

Catch-up is safe because `receipt_id` is derived (§6.6): re-emitting the backlog after an outage replays rather than duplicates. Catch-up is **not** ordered — receipts arrive in whatever order the retry drains — and `core_events.room_seq` will record the arrival order, not the land order. The land order is in the payload (`at`), and any view that sorts by `room_seq` and calls it chronology is wrong.

**7.3 — Atrium refuses the append.** `ledger.append` throws for `rejected` and `malformed` but **does not throw for `applied_with_issue`** — `interpret.ts:483-496` names this exactly: "`append` returning is not the reducer having applied it... a *business* refusal writes its row, fans it out marked, and changes no state". The bridge must inspect `issues` on the result and treat a non-empty `issues` as a failure to record, not as a success. Treating a returned append as an applied append is the fail-open this bullet exists to forbid.

**7.4 — A human rejects.** `proposals.status` moves to `'rejected'` with `rejectedReason` (`schema.ts:1049`, `:1052`). Nothing on the glance side changes: the land already happened, the code is already on main, and a rejected receipt does not un-land anything. What a rejection means is *"this reading is not one I will certify"* — the human declining to vouch. The bridge does not retry a rejected receipt, does not re-stage it, and does not escalate it. It also does not treat rejection as an error: a rejected `~` is a working ledger, not a broken bridge.

The bridge **may** supersede its own reading when a receipt is corrected — `reduce.ts:599` (rejection binding) and `:645` (supersession binding) gate both on `actorMatchesProposer`, and `README.md:680-685` states the reasoning: withdrawing a staged reading destroys nothing. It may **not** supersede an accepted decision; that is human-only (`README.md:673`).

One consequence of Option B (§5.3) lands here and is worth naming: `actorMatchesProposer` (`authority.ts:401-405`) returns `false` for an `agent` actor, and the bridge's proposals carry `proposer_kind = 'model'` with no matching `model` actor. **The bridge therefore cannot withdraw its own reading either** — both binding gates refuse it, and only a human can reject or supersede a bridge proposal. That is a strictly-safe direction to fail in, but it means "the bridge retracts a receipt it got wrong" is not a capability this design has, and §9 should be read with that in mind.

**7.5 — The reading is machine-attributed and the room cannot tell what checked it.** With Option B (§5.3) the proposal reads `proposer_kind = 'model'`, `proposer_model = "glance/<harness>"`. A reader who looks only at `proposer_*` sees a model reading and may reasonably assume an interpretation pipeline produced it from room conversation. It did not; it came from outside. `staged_by_kind = 'agent'` with the bridge principal's id is what disambiguates (`schema.ts:1018-1027` introduced the columns for precisely this class of confusion), and **any UI that renders `proposer` without `staged_by` will mislead**. This is a real cost of Option B and the third thing the gauntlet should attack.

**7.6 — The receipt says a land happened that did not.** Nothing in this design verifies glance's claim against the repository. The proposal is a faithful transcription of what glance reported, and `confidence: 1.0` means transcription fidelity, not truth. A compromised or buggy glance can stage a `~` asserting a land that never occurred. The floor that holds is that it stays `~`: it takes a human to make it `✓`, and `reduce.ts:724-727` refuses any machine route to `verification: 'verified'` even after acceptance. Independent verification against the repository — checking the commit exists on main — is not designed here and is listed in §9.

**7.7 — The room is gone, the principal is not a member, or membership was revoked mid-append.** `AppendRequest.authorize` runs inside the transaction after the ledger lock (`ledger.ts:322-340`), and the database refuses an unauthorized actor on its own (`:334-338`). The append fails closed and the receipt stays unexported, joining the 7.2 backlog. There is no anonymous fallback, no `system`-actor path, and no "post it to the default room". A bridge principal that has lost its membership is a bridge that is down.

**7.8 — The reviewer ledger could not be read.** Carried through, never flattened. `unreadable` (`reviewer-weights.ts:248-253`) means the file could not be read — distinct from simply absent, which is normal and never sets it. `corrupt` (`:241-247`) means too many rejected lines to trust the survivors. Both force `n = 0` upstream and both must remain distinguishable from an honest empty history in the receipt sentence. A message reading "reviewed by codex (0 findings)" when the truth is "the ledger was unreadable" is the exact class of defect the stamp's design notes call out by name.

---

## 8. What this document does NOT authorize

Mirroring `ARCHITECTURE.md`'s discipline (`:3`, `:9`, `:141`, `:163`, `:166`, `:209`, `:239`, `:261`), written out explicitly.

1. **No implementation.** No schema migration, no code, no endpoint. The schema sketches in §6 are prose about shapes, not diffs.
2. **No atrium writes of any kind.** `/home/lars/atrium` was read only. No file in it was created, modified, or deleted by this work.
3. **No widening of `Proposer`.** Option A in §5.3 is described and explicitly not chosen. `packages/core/src/proposal.ts:19-21` stands unchanged, and the two acceptance-semantics questions at `common.ts:308-312` remain unanswered.
4. **No deletion of `commands.ts:1516`'s refusal.** The socket path continues to refuse an agent staging a proposal. This document designs an in-process caller and argues (§5.3) that this is the caller `commands.ts:1477-1484` anticipated; it does not authorize anyone to relax the socket refusal on the strength of that argument.
5. **No execution runtime inside atrium.** No way for atrium to start, stop, schedule, or configure a glance run. `init.md:528-541` says the execution contract should be chosen once it is known; this bridge deliberately learns what the *reporting* contract looks like first, and reporting is one-directional by design. `init.md:250-264`'s "do not initially build" list — PTY supervision, harness adapters, sandboxing, credential injection, fleet scheduling — is untouched.
6. **No certification authority for any machine.** Not by the bridge, not by an agent principal, not by policy exception. `reduce.ts:698-741` is the enforcement and this document proposes no change to it.
7. **No auto-acceptance**, including on the path `authority.ts:214-216` leaves open for claims. §6.6.
8. **No tenant gate contract.** How a glance org maps to an atrium workspace, who provisions the principal, and what isolation that mapping guarantees belong to G3. §5.1 assumes a one-to-one mapping created by explicit human provisioning and designs nothing further.
9. **No agent grants, capability records, assignments, or execution receipts.** `ARCHITECTURE.md:209` defers those to the future agent slice and `:82` sketches their shape. The bridge needs none of them: it reads nothing it must be granted and executes nothing.
10. **No mention, attention, or notification behaviour.** The receipt message mentions nobody. `ARCHITECTURE.md:71` separates mention, assignment, and execution; this design touches none of the three.
11. **No claim that a `~` receipt is evidence of anything.** An unaccepted receipt is a reading. Counting `~` receipts as landed-work-with-oversight would be the same category error the glyphs exist to prevent (`README.md:172-179`).
12. **No revision of `ARCHITECTURE.md`.** §2.1 reports that its evidence section is stale against the tree. Correcting that document is its authors' call, not this one's.

---

## 9. Unresolved before implementation

- **Message volume** (§6.3). One room message per land floods a busy room. Materiality bar, batching, or a dedicated receipts room — each has a cost and none is chosen here.
- **Independent verification** (§7.6). Should atrium check that the claimed commit exists on the claimed branch before staging? That would need repository access atrium deliberately does not have (`init.md:515`).
- **Who may certify** (`ARCHITECTURE.md:234`). Inherited unresolved. Whether any room member may `✓` a land they did not review is a live question this bridge makes concrete rather than answers.
- **`Proposer`'s agent variant** (§5.3). Option A remains the correct long-run answer and requires atrium to answer `acceptance.ts:663` and `:828` for an agent proposer.
- **The bridge cannot retract its own reading** (§7.4). Under Option B its proposals are `proposer_kind = 'model'` with no matching model actor, so `actorMatchesProposer` refuses its own rejection and supersession. A wrong receipt can only be withdrawn by a human. Fixed for free by Option A; unfixable under Option B without a new gate.
- **Backlog visibility** (§7.2). What surface shows "N receipts unexported for M hours", and to whom.
- **Whether the bridge's no-auto-accept restraint should be code** (§6.6). Today it is policy. A `staged_by_kind = 'agent'` floor in `reduce.ts` would make it structural; that is an atrium change and is not proposed.

---

## 10. What would falsify this

Three claims carry the design. If any is wrong, the document is wrong and should be reopened rather than patched.

1. **Atrium already has a durable agent principal** — `schema.ts:239`, `:289`, `:219`; `common.ts:314-319`; `session.ts:50`. If these are a branch artifact rather than main, §5 has no foundation and the design reverts to `ARCHITECTURE.md`'s future tense. Verified against HEAD `699842e` on 2026-08-12.
2. **`reduce.ts:567` derives `stagedBy` from the trusted append actor**, so an agent-actor append yields `staged_by_kind = 'agent'` without widening `Proposer`. If `stagedBy` is caller-supplied anywhere, Option B (§5.3) is an attribution the caller chose rather than one the system observed, and the honesty argument for it collapses.
3. **`proposal_sources` structurally requires an in-room `messages` row** — `schema.ts:1107-1111`. If provenance can be satisfied any other way, §6.3's message-per-land cost is self-imposed and the volume problem in §9 dissolves.

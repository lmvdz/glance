# Phase-4 bridge: glance land receipts as atrium proposals

**Status:** proposed — awaiting human review. This document authorizes no implementation.

**Date:** 2026-08-12 (round 2 — revised against gauntlet round 1)

**Authorities:** the glance#208 thread comment (2026-08-12); atrium `init.md` Phase 4 (`init.md:513-526`); atrium `plans/room-entity-capabilities/ARCHITECTURE.md` (2026-08-04) as both the rigor bar and the doc this extends; glance#388 and its round-1 gauntlet receipt.

**Trees read:** glance at `campaign/phase5-bridge` (off `origin/main`); atrium at `699842e`, read-only.

**Reopen if wrong.** Every claim below is anchored to a file and a line. Round 1 established that this promise is only as good as the sweep behind it: my round-1 atrium anchors were taken from a stale read of the tree and drifted per-file (schema.ts by +93 in its tail, `reduce.ts` by +8, `authority.ts` by up to +81, `ledger.ts`/`commands.ts`/`queue.ts`/`interpret.ts` not at all). Every atrium anchor in this revision was re-derived from `699842e` immediately before writing. The drift was never uniform, and any future correction pass should re-derive rather than apply an offset.

**What changed in round 2.** §5 is new — the trust seam, which round 1 left blank. The staged object is re-typed from `claim` to `decision` (§7.4), which reverses round 1's central reasoning. §7.5 answers provenance honesty, §7.6 rebuilds idempotency on a content hash, §8.5 adds the durable outbox. §10 names what this inherits rather than absorbing it. One receipt directive is **not** followed as written and is argued against with the code in §7.4.

---

## 1. The loop this is designing

glance lands changes. Each land produces a receipt: what merged, what proved it, who reviewed it, what it cost, and where main returns to if it were reverted.

Atrium keeps a semantic ledger where every line says which of two things it is: `~`, a reading nothing has checked, or `✓`, the same sentence after a person accepted it (`README.md:19-22`). A machine can draft the list; a machine can never be the thing that certifies it.

The bridge is one sentence: **a glance land receipt crosses into atrium as a `~`, and a human's acceptance is the `✓`.** glance is the workforce; atrium is the record of what the workforce did that somebody vouched for.

**This is `init.md` Phase 4, not Phase 5**, and Phase 4 is the stronger warrant. `init.md:513-526`: "The first agent does not need repository access. It can: propose state changes... That tests agent participation without requiring an execution runtime." That is exactly this bridge — it proposes state changes and needs no repository access, because glance already has the repository and atrium never touches it. Phase 5 (`init.md:528-541`) is about *adding execution*, choosing an execution contract once one is demanded. This design deliberately does not choose one. Round 1 filed it under Phase 5 and thereby claimed more scope than it wanted.

---

## 2. Contradictions found while verifying this ticket

The ticket and its inherited framing make four factual claims the trees do not support.

**2.1 — "Agent participant" is no longer future.** `ARCHITECTURE.md:32` ("Agent participant — future") and `:209` describe a durable machine principal that does not exist yet. It exists. Atrium HEAD is `699842e`, "Land the humans-and-agents-as-peers campaign onto main":

- `packages/db/src/schema.ts:239` — `principalKind = pgEnum('principal_kind', ['human', 'agent'])`.
- `packages/db/src/schema.ts:289` — `users.principal_kind`, `NOT NULL DEFAULT 'human'`, immutable after provisioning (BEFORE UPDATE trigger, plus a BEFORE INSERT companion since drizzle/0018).
- `packages/db/src/schema.ts:219` — `actorKind = pgEnum('actor_kind', ['human', 'agent', 'model', 'system'])`. Four values.
- `packages/core/src/common.ts:314-319` — the `Actor` union carries `{ kind: 'agent', userId: Id }`.
- `packages/core/src/common.ts:332-334` — `actorUserId()`, the predicate separating "has an identity" from "is a person".
- `apps/server/src/session.ts:50` — `Session.principalKind`, required, no `?? 'human'` fail-open.

`ARCHITECTURE.md`'s evidence section (`:15-16`) is stale against its own tree. It remains the rigor bar for form; it is no longer a survey of fact. §10 states precisely what this design inherits from it and what it does not.

**2.2 — the actor floor gates on `isHuman`, not on `model`.** `authority.ts:307` is `actor.kind === 'human'`. `common.ts:287-290` states the consequence: `agent`, `model` and `system` are all machines and every certification gate refuses all three by the same predicate. An agent principal buys identity and zero certification authority.

**2.3 — the glance-side anchors in the framing are wrong.** The receipt schema is `src/rail/receipt/types.ts:95-132`, not `squad-manager.ts`. The `validatorGate` stamp is `src/validator.ts:838-843`, called from `:914`. What is in the land lane is the gate call (`squad-manager.ts:5324-5340`) and receipt assembly (`:4800-4820`).

**2.4 — `ARCHITECTURE.md` has no section titled "What this document does NOT authorize".** Its discipline is a status line (`:3`) plus refusals at `:9`, `:141`, `:163`, `:166`, `:209`, `:239`, `:261`. §9 writes that out explicitly — a change in form, not a claim about that document's contents.

---

## 3. Seam A — glance receipt production

### 3.1 What a land receipt is

`LandReceipt` — `src/rail/receipt/types.ts:95-132`:

| group | field | line |
|---|---|---|
| what landed | `repo` `:98` · `branch` `:99` · `commit?` `:101` · `message?` `:104` · `files` `:106` · `insertions?`/`deletions?` `:107-108` · `landed` `:110` · `at` `:112` | |
| what proved it | `gate: LandReceiptGate` `:115` — `status` `:65`, `command?` `:67`, `unprovenGreenRejected` `:69`, `newRegressions` `:72`, `baseWasRed` `:74`, `detail?` `:76` | |
| who reviewed it | `validation?: ValidationRecord` `:120` · `panel?` `:122` (T5, parked) | |
| rollback | `rollbackPoint?` `:126` · `forcedWithoutProof` `:128` | |
| cost | `cost: LandReceiptCost` `:131` — `costUsd?` `:81`, `costUnknown` `:84`, `model?` `:86`, `tokens?` `:88` | |

`GateStatus` (`:62`, semantics at `:47-61`) is six values: `green`, `red-baseline`, `failed`, `unproven-rejected`, `no-gate`, `forced`. Four are amber or red. Any rendering that collapses them into "landed" is laundering.

### 3.2 Where it is built

`SquadManager.emitLandReceipt` — `src/squad-manager.ts:4757-4830`, construction at `:4800-4820`, called fire-and-forget from `landInner` at `:4747` under `if (!result.retryable)`. Attribution SHAs come from the land's own in-lock values (`:4774-4775`); the TOCTOU that motivated it is named at `:4769-4773`.

### 3.3 The validator stamp

`validatorGate` — `src/validator.ts:851-924`, called from `src/squad-manager.ts:5324-5335`, stamped onto the DTO at `:5337`.

`withFreshReviewerPrecision` — `src/validator.ts:838-843` — applied unconditionally, cache hit or miss, at `src/validator.ts:914`. Three honest outcomes: `skipped`/`inconclusive` pass through (`:839`); no determinable lineage yields `{lineage:"unknown", n:0, survived:0, provisional:true}` (`:841`), never defaulted to `native`; otherwise the real stamp (`:842`).

`ReviewerPrecisionStamp` — `src/memory/reviewer-weights.ts:221-254`: `lineage` `:223`, `n` `:226`, `survived` `:228`, `survivedRate?` `:232` (own key only when `n > 0`), `provisional` `:235`, `rejected?` `:240`, `corrupt?` `:247`, `unreadable?` `:253`. Ledger at `plans/.reviews/reviewer-ledger.jsonl` (path constant `:219`), sole writer `scripts/reviewer-ledger.ts:27-49`.

### 3.4 The countable substrate

`landReceiptIndexRow` — `src/rail/receipt/write.ts:59-83`, pure. `LandReceiptIndexRow` — `src/rail/receipt/types.ts:167-183`, honesty invariants at `:161-166`.

`writeLandReceipt` — `src/rail/receipt/write.ts:148-183`: HTML with `flag:"wx"` at `:159`; index row appended at `:165` inside its own try/catch, warning to stderr at `:171` so a persistent failure undercounts visibly rather than silently.

### 3.5 What leaves the machine today

Three hops, and the round-1 claim that "no export path carries receipt content" was too strong:

1. `postReceiptComment` — `src/rail/receipt/write.ts:190-200`, `gh pr comment` at `:198`, called at `src/squad-manager.ts:4824`. Rendered Markdown.
2. **`postAgentPrCheck` — `src/rail/wedge/post-check.ts`, a GitHub check-run that does carry receipt content**, projected by `receiptToCheckOutput` (`src/rail/wedge/receipt-adapter.ts:79`) from a `LandReceipt` decoded through `LandReceiptSchema` (`src/rail/wedge/receipt-schema.ts:77-95`). Its only caller in this checkout is the CLI `scripts/post-wedge-check.ts:113`; the daemon does not call it.
3. `TraceExportQueue` — `src/trace-exporter.ts:178`, SSRF allowlist at `:62`, env wiring at `:233`. Ships `RunReceipt.spans`, never a `LandReceipt`.

So the accurate statement is: **the daemon has no automatic structured export of a `LandReceipt`; a manual CLI path (2) already serializes one.** That path is the existing precedent for the envelope in §7.2, and its schema is the precedent for validating one.

### 3.6 The ingest plugin idiom

`HarnessIngester` — `src/ingest/harness.ts:28-33`: a `name` plus an idempotent `ingest({stateDir, repo, now?})`. Dispatched by `ingestAllHarnesses` (`:43-56`), throttled per `(stateDir, repo, harness)` at `:47`, failure-isolated at `:52-54`. Registered in one line: `src/ingest/index.ts:16`. The bridge's glance-side emitter should take this shape rather than invent a second plugin idiom.

### 3.7 What identity a glance unit has

`newAgentId` — `src/spawn-identity.ts:66-68`: name + base36 time + process-local sequence (`:58`) + 8 hex. Tenancy is not in the id; it is the state directory (`src/manager-registry.ts:132`, `path.join(root, "orgs", orgId)`).

**A glance unit id is not a principal.** Ephemeral, process-local, unauthenticated, untenanted. It is provenance data.

---

## 4. Seam B — atrium proposal consumption

### 4.1 The only door, and the only trust seam

`atrium_append_core_event` is the only way a row reaches `core_events` (`README.md:856`). Above it, `ledger.append` (`apps/server/src/ledger.ts:428`) / `ledger.appendBatch` (`:429`) take an `AppendRequest` (`:317-350`) or `AppendBatchRequest` (`:353-370`):

- `actor: Actor` (`:321`, `:355`) — "the trusted actor, derived from the authenticated session. Never a payload."
- `authorize?(tx)` (`:340`, `:356`) — re-checked inside the append transaction, after the ledger lock (`:322-338`).
- `build` / `builds` (`:342`, `:368`) — events, once ids and timestamps are assigned.
- `project?(context)` (`:349`, `:369`) — projections in the same transaction.
- `idempotency?` (`:359-365`) and `requireClean?` (`:367`) on the batch form.

The actor is out-of-band by construction: the event schema has no place to put one and `CoreEvent` refuses at parse time an input that carries one (`packages/core/src/events.ts:12-29`). Storage is two columns — `core_events.actor_kind` `schema.ts:533`, `actor_id` `:534`.

**And there is exactly one trust seam in the whole server.** `apps/server/src/ws-auth.ts:11-25`: "The WebSocket trust boundary. Exactly one function decides whether a socket may exist: `authenticateUpgrade`. It runs *before* the handshake completes, so an unauthenticated client is refused with an HTTP 401 and never becomes a connection at all — there is no 'connected but anonymous' state for a later handler to forget about." And `:24`: "The realtime protocol (#22) builds on this seam and **should not widen it**."

Atrium has no HTTP command surface. Round 1 specified an "ingest endpoint" without saying what authenticates it, which is the hole §5 fills.

### 4.2 The actor floor

`reduce.ts:706-750`, inside `applyObjectAccepted`. Three gates in order:

1. **Type minting** — `:722`, `modelMintingGate(object.type)` (`authority.ts:253`) refuses `decision`, `commitment`, `objective` for any non-human, **whether or not a proposal was cited** (`reduce.ts:718-721` names the move it blocks: an interpreter accepting its own decision proposal).
2. **Verified claims** — `:732`. No non-human transition of a claim to `verification: 'verified'`.
3. **Proposal-less objects** — `:746`. A machine has one route to a fact: propose it and have the proposal accepted.

Downstream: proposer binding `:786`; the receipt path for non-humans; `selfStagedReadingRefusal` (`authority.ts:516`); `selfVerificationRefusal` (`authority.ts:762`).

`isHuman` is `actor.kind === 'human'` (`authority.ts:307`) — an `agent` is refused exactly as a `model` is.

### 4.3 The acceptance engine, and why the type choice is arithmetic

`decideAcceptance` dispatches in a fixed order. For a **model** proposer, in order:

| gate | line | outcome |
|---|---|---|
| window absent | `acceptance.ts:663-670` | `discard` / `visibility: 'none'` — `missing_message_context` |
| rejecting provenance problems | `:726` | `discard` / `none` — `provenance_failed` |
| referring provenance problems | `:766` | `pending` / `quiet` — `receipt_not_certifiable` |
| `confidence < θ_min` | `:855-863` | `discard` / `none` — `below_theta_min` |
| `θ_min ≤ confidence < θ_auto` | `:871-879` | `pending` / **`quiet`** — `theta_band` |
| third-party commitment at ≥θ_auto | `:889-898` | `pending` / `needs_you` |
| `!rule.autoAccept` at ≥θ_auto | `:907-915` | `pending` / **`needs_you`** — `never_auto_accepts` |
| text not certifiable | `:967-976` | `pending` / `needs_you` |
| otherwise | `:980-987` | `auto_accept` / `accepted` |

The θ table — `policy.ts:128-132`:

| type | θ_auto | θ_min | autoAccept |
|---|---|---|---|
| `decision` | 0.7 | 0.5 | **false** |
| `commitment` | 0.75 | 0.5 | **false** |
| `objective` | 0.75 | 0.5 | **false** |
| `claim` | 0.7 | 0.5 | **true** |
| `open_question` | 0.6 | 0.4 | **true** |

And attention: `attention.ts:827` — `if (verdict.visibility !== 'needs_you')` skips. **Only `needs_you` mints an attention item.** `quiet` and `accepted` both reach nobody's Needs-you surface.

### 4.4 The interpretation worker will read the bridge's own messages

`claimWindow` — `apps/server/src/jobs/interpret.ts:648-673`. Its drain query is:

```sql
FROM messages m LEFT JOIN LATERAL (...) i ON TRUE
WHERE m.room_id = ${roomId}::uuid
  AND (i.id IS NULL OR i.status = 'pending')
ORDER BY m.seq ASC LIMIT ${config.maxWindowMessages}
```

**There is no author filter and no author-kind filter.** Every message in the room is drained, including one the bridge posted. And `projections.ts:212` calls `onMessagePosted` unconditionally for every `message_posted` event, in the same transaction, which is what enqueues the interpretation pass (`queue.ts:287-306`).

So a bridge-posted receipt message is fed to the interpreter, which stages *its own* readings of the receipt text — and `claim` and `open_question` auto-accept at or above θ (`policy.ts:130-131`, `interpret.ts:468-480`). This hazard is independent of what type the bridge itself stages. §7.7 makes the exclusion a precondition.

`ARCHITECTURE.md:213` named exactly this migration as a prerequisite "before agents exist", and `:255` schedules it as slice 2. It is unshipped.

### 4.5 The tables

**`proposals`** — `schema.ts:1095-1175`: `id` `:1098`, `roomId` `:1099`, `interpretationId` `:1102`, `type` `:1105`, `payload` `:1106`, `confidence` `:1107`, `proposerKind` `:1108`, `proposerModel` `:1109`, `proposerUserId` `:1110`, `stagedByKind` `:1130`, `stagedById` `:1131`, `quote` `:1141`, `status` `:1142`, `decidedBy` `:1143`, `rejectedReason` `:1145`. Constraints: `proposals_confidence_range` `:1152`, `proposals_proposer_identified` `:1154`, `proposals_staged_by_id_matches_kind` `:1166`, `proposals_staged_by_id_not_blank` `:1170`.

The `proposer_*` / `staged_by_*` split (`:1111-1129`) is the schema's most useful feature here: `proposer_*` is *what the reading claims to be*, `staged_by_*` is *who typed it*. **`stagedBy` is not a parameter** — `reduce.ts:567` sets `stagedBy: actor` from the trusted append actor, projected at `projections.ts:264-265`.

**`proposal_sources`** — `schema.ts:1184-1207`: `roomId` `:1187`, `proposalId` `:1190`, `messageId` `:1191`; composite FKs `proposal_sources_proposal_same_room_fk` `:1196` and `proposal_sources_message_same_room_fk` `:1201`.

**`messages`** — `schema.ts:1007-1050`: `id` `:1010`, `seq` `:1012`, `roomId` `:1013`, `authorId` `:1016`, `body` `:1017`, `replyToId` `:1018`, `clientMessageId` `:1020`. **`authorId` is nullable** — it is `.references(users.id, {onDelete:'set null'})` with no `.notNull()`, so a NULL author is the deleted-user tombstone state, not an identity a writer may choose.

**`interpretations`** — `schema.ts:1070-1090`, idempotency at `uniqueIndex('interpretations_message_version_key')` `:1088`.

**`command_receipts`** — `schema.ts:926-967`: PK `(roomId, actorKind, actorId, commandName, idempotencyKey)` `:945`, `payloadFingerprint` `:937`, `firstRoomSeq`/`lastRoomSeq` `:938-939`. Checks: `command_receipts_actor_has_identity` `:958` (`actor_kind <> 'system'`) and `command_receipts_actor_id_not_blank` `:959`. An `agent` actor can own a receipt; a `system` actor cannot.

### 4.6 The pattern the bridge is judged against

`interpret.ts:33-72` — Claim, Route, One call, Judge, Append, Settle. The idempotency argument (`:39-47`) is the model: the unique index means a retry reuses its own rows, yielding the same interpretation id, the same content-addressed proposal ids, and a `proposal_recorded` the reducer refuses as already recorded — "a consequence of those two facts, not a check somebody remembered to write."

Two failure disciplines to inherit:

- **Append-returned is not applied** (`:482-496`): `append` throws for `rejected` and `malformed` but **not** for `applied_with_issue`, which writes a row and changes no state. `issues` is the only thing that answers it.
- **Rows stay `pending` on a provider fault** (`:232-245`); only the dead-letter handler moves them to `failed`, because only it knows the retries are done.

`semanticCommandFingerprint` — `commands.ts:160-164` — hashes `['stage_semantic_command/v1', roomId, messageId]`. **Ids only.** Copying that domain would let a replay with a flipped `gate.status` return success against a stored receipt; §7.6 does not copy it.

---

## 5. The trust seam (round 2 — new)

Round 1 specified an envelope, a principal, an idempotency scheme, a transaction and seven failure modes, and never said **who may call, how the caller authenticates, or how an envelope binds to the principal.** Its failure section refused *malformed* input and never once refused *unauthorized* input. Flip the input and the output moves: any host that could reach the endpoint could stage `~` under glance's identity. `ARCHITECTURE.md:181` states the invariant that was missed, verbatim: "Actor identity is derived at a trusted seam and stored outside caller-controlled event payloads."

### 5.1 The shape

**The bridge is an atrium-side authorized worker, not a writer that glance reaches.** Three parts, and the boundary between them is the whole design:

1. **glance emits.** The glance-side exporter (§3.6's idiom) writes envelopes to a durable outbox (§8.5) and delivers them over an authenticated transport to atrium. It holds no database credential, no `ledger.append` handle, and no ability to name an actor.
2. **Atrium authenticates and stages the delivery.** The delivery lands in a staging table, not in `core_events`. Authentication resolves *which provisioned bridge principal this delivery is from*, and the resolved principal is a property of the authenticated channel — never a field in the envelope.
3. **An in-process worker appends.** A pg-boss worker, sibling to `interpret.ts`, drains the staging table and calls `ledger.appendBatch` with `actor: {kind:'agent', userId: <the principal resolved in step 2>}`. This is the only component that touches the ledger, and it runs inside atrium with atrium's own credentials, exactly as the interpretation worker does.

The actor is therefore derived at a trusted seam — atrium's authentication of the delivery — and carried to the append as a server-side value. **No envelope field ever names an actor**, and an envelope that contains one is refused rather than having the field ignored, mirroring `events.ts:12-29`'s treatment of a payload-carried actor.

### 5.2 Which seam authenticates

`ws-auth.ts:24` says the realtime seam "should not widen it", and that instruction is honored: this does not add a machine login to the WebSocket upgrade.

The honest position is that **atrium has no surface for this today and one must be added**, and adding it is an atrium decision this document does not make. What it does specify is the contract any such surface must satisfy:

- **The principal is resolved from the credential, never from the payload.** A delivery carries no `principal_id`, `actor`, `org`, or `workspace` field. Whatever those would say is read from what the credential resolves to.
- **The credential belongs to a provisioned `users` row with `principal_kind = 'agent'`** (`schema.ts:289`), and the resolution fails closed when it names a row that is absent, is `principal_kind = 'human'`, or lacks membership in the target room. The database enforces the second of those independently: `atrium_core_events_invariants` reads `users.principal_kind` for the id in `actor_id` and refuses a row whose `actor_kind` disagrees (`schema.ts:202-208`), so a mis-resolved principal writes nothing rather than writing history under the wrong kind.
- **The credential is revocable without a deploy**, and revocation takes effect at the next delivery and at the next append — `authorize?(tx)` (`ledger.ts:340`) is re-checked inside the append transaction, so a credential revoked mid-flight fails the append rather than committing under a stale check.
- **The credential is not a session and does not confer one.** It authenticates deliveries. It does not open a socket, cannot post an arbitrary message, and cannot invoke any command handler.
- **Rate and size are bounded per principal**, because a bridge that can post unboundedly is a bridge that can bury a room.

Two candidate surfaces exist and this document does not choose between them: an authenticated HTTP ingest route (new surface, needs its own trust seam written and reviewed), or reusing Better Auth's session machinery for an agent principal so the existing seam resolves it (no new trust code, but it widens what `ws-auth.ts:24` asks not to widen). §11 lists this as unresolved. **Naming the contract is this document's job; choosing the mechanism is atrium's.**

### 5.3 What the seam refuses

Every one of these is a closed door, not a degraded path:

| condition | result |
|---|---|
| no credential, or an unrecognized one | refused at the seam; nothing staged |
| credential resolves to a `human` principal | refused; the DB would refuse the append anyway (`schema.ts:202-208`) |
| principal is not a member of the target room | refused; `authorize` would refuse inside the transaction (`ledger.ts:340`) |
| envelope carries an actor-shaped field | refused as malformed, not stripped |
| envelope references a room the principal has no membership in | refused; the room selector (§7.3) is validated against membership, never trusted |
| delivery over the rate/size bound | refused with backpressure; glance's outbox retries (§8.5) |

---

## 6. The durable machine principal

### 6.1 What it is

**One atrium `users` row per glance deployment-and-tenant, with `principal_kind = 'agent'`.** Not per unit, not per repo, not per run.

- A `users` row (`schema.ts:266-300`) can hold a session, a workspace membership, a room membership, and its own name on what it wrote (`:258-264`).
- `principal_kind = 'agent'` (`:289`) is set at provisioning and immutable (`:271-283`).
- Its appends carry `actor_kind = 'agent'`, `actor_id = <its users.id>` (`schema.ts:202-208`), and the database checks the agreement.

**Why not per unit.** A glance unit id (`src/spawn-identity.ts:66-68`) is per-spawn, process-local, and untenanted. Provisioning a `users` row per unit would mint an unbounded population of permanently immutable identities keyed on something that does not survive a restart. Unit ids belong in the envelope as provenance.

**Why one per tenant.** Atrium's tenancy boundary is the workspace (`schema.ts:302-306`); glance's is `<root>/orgs/<orgId>/` (`src/manager-registry.ts:132`). One glance-org maps to one atrium workspace by explicit human provisioning. Reconciling the two schemes is the tenant gate contract and belongs to G3.

### 6.2 Capability matrix — extending `ARCHITECTURE.md:58-69`

`ARCHITECTURE.md`'s "Agent participant" column was aspirational when written; against `699842e` most of it is enforced code. The sixth column is the specific principal this document designs.

| Act | Agent participant (`ARCHITECTURE.md:58-69`) | Land-receipt bridge | enforced at |
|---|---|---|---|
| Read conversation | granted scope | its own room only | room membership |
| Author chat | granted, as self | **yes** — posts the receipt message as itself | `messages.authorId` `schema.ts:1016`; `commands.ts:1505-1508` |
| Be mentioned | while active and mentionable | yes, inert | `ARCHITECTURE.md:71` |
| Mention a target | granted chat plus visible target | no | design choice |
| Stage a semantic proposal | granted proposal type | **`decision` only** | §7.4 |
| Certify `✓` | never | **never** | `reduce.ts:722`, `:732`, `:746`; `isHuman` `authority.ts:307` |
| Correct accepted state | never | **never** | `reduce.ts` corrections are human-only |
| Assign work | never in v1 | **never** | not proposed |
| Execute a tool/action | explicit grant | **none inside atrium** | §9 |
| Grant or delegate | never | **never** | `ARCHITECTURE.md:69` |
| *(new)* Accept its own reading | — | **never, and structurally impossible for `decision`** | `modelMintingGate` `authority.ts:253`; `reduce.ts:722` |
| *(new)* Supersede / reject its own reading | — | **no** — refused | `actorMatchesProposer` `authority.ts:401-405`; `reduce.ts:599`, `:645` |

Two rows carry weight.

**"Certify `✓` — never" is `reduce.ts`, not this document's promise.** A rewritten bridge attempting a `✓` is refused, writes a `fail` row, and changes no state. The bridge is bounded, not trusted.

**"Accept its own reading" is now structural, not policy.** This is the largest single improvement from round 1. Round 1 staged `claim`, which `modelMintingGate` permits a machine to accept (`authority.ts:263-266`), so "the bridge does not auto-accept" was a policy anyone could edit away. Staging `decision` moves the guarantee into the reducer: `modelMintingGate('decision')` returns `'decision_acceptance'` and `reduce.ts:722` refuses any non-human acceptance of it, whatever the confidence and whatever the bridge's code says.

### 6.3 The `Proposer` constraint

`Proposer` — `packages/core/src/proposal.ts:19-21` — is `{kind:'model', model}` or `{kind:'human', userId}`. No `agent`. `common.ts:308-312` says why: a proposal's proposer decides whether the acceptance engine demands a receipt window and whether θ applies, and "nothing about 'an agent holds an account' answers any of them."

Both ends enforce it: `commands.ts:1516-1521` (`draftToProposal` throws when `session.principalKind !== 'human'`) and `authority.ts:401-405` (`actorMatchesProposer` returns `false` for an agent actor).

**The design stages with `proposer_kind = 'model'`, `proposer_model = "glance/<harness>"`, and — because `reduce.ts:567` derives it from the trusted append actor — `staged_by_kind = 'agent'`, `staged_by_id = <the bridge principal>`.** Nothing is widened and nothing is mislabelled: the reading is machine-produced, and the thing that typed it is the glance agent principal. That is precisely the distinction `schema.ts:1111-1129` introduced the columns to record.

**Round 1 defended this with a warrant; round 2 replaces the warrant with a lock.** The round-1 argument was that `commands.ts:1477-1484` anticipates "a legitimate in-process staging caller" and the bridge is it. The gauntlet was right that this is weak: the caller that text anticipates is atrium's own interpretation worker, which is a `model` actor reading room conversation, not an external system's agent principal. The `commands.ts:1516` refusal names this act at the only seam that exists.

What makes it sound is not the warrant but §5: the bridge is not a caller that reaches `ledger.append` from outside. It is an atrium-side worker consuming an authenticated delivery, running with atrium's credentials, in atrium's process, subject to atrium's `authorize` re-check. The socket refusal at `commands.ts:1516` stays exactly as it is, and this design does not ask for it to be relaxed — it never goes through `draftToProposal` at all, for the same reason `interpret.ts` does not.

The long-run correct answer is still to widen `Proposer` with an agent variant, which `commands.ts:1501-1503` describes: "this refusal is what a reviewer deletes, and `actorMatchesProposer` is the other end that has to move with it." That requires answering, for an agent proposer, whether the reading needs a receipt window (`acceptance.ts:663`) and whether θ applies (`acceptance.ts:828`). Those are atrium's questions and this document does not answer them.

---

## 7. Receipt → proposal translation

### 7.1 Flow

glance emits an envelope to its durable outbox → delivers it over the authenticated transport (§5) → atrium stages it → the bridge worker drains staging, posts a receipt message and stages one `decision` proposal citing it, in one `appendBatch` → the proposal renders `~` in Needs-you → a human accepts, producing `✓`, or rejects.

### 7.2 The envelope

Derived from `landReceiptIndexRow` (`src/rail/receipt/write.ts:59-83`) plus what a human needs to judge, canonicalized on `packages/ingest`'s discipline (`validate.ts:33-46`; `jsonl.ts:4-14`): fixed key order, optional fields omitted rather than null.

```
{
  bridge_version: 1,
  receipt_id:  string,   // §7.6 — content hash, never a clock+branch tuple
  repo:        string,   // types.ts:98      branch: string      // :99
  commit:      string?,  // :101             message: string?    // :104
  landed:      boolean,  // :110             at: string          // ISO-8601 from :112 — see §7.9
  gate: { status, command?, unproven_green_rejected, new_regressions[], base_was_red },  // :62-76
  forced_without_proof: boolean,  // :128    rollback_point: string?  // :126
  files_changed: number,          // |files| :106
  insertions: number?, deletions: number?,  // :107-108
  validation: {                   // OMITTED ENTIRELY when no validator ran
    verdict: string,              // src/types.ts:284
    precision: { lineage, n, survived, corrupt?, unreadable? }?,  // OMITTED when unstamped
  }?,
  cost: { usd: number?, unknown: boolean, model: string?, tokens: number? },  // :79-89
  unit: { agent_id: string?, org_id: string? },  // provenance only — NOT a principal (§6.1)
}
```

**No actor, principal, room, or workspace field.** Those are resolved at the seam (§5.1) or derived (§7.3). An envelope carrying one is refused, not ignored.

Four absence-honesty rules, inherited from the glance side and enforced at the reader as well as the writer:

- `validation` absent ≠ `verdict: "skipped"` (`types.ts:118-120`).
- `precision` absent ≠ `n: 0` (`types.ts:136-140`).
- `corrupt`/`unreadable` are carried, never flattened (`reviewer-weights.ts:241-253`).
- `cost.unknown: true` ≠ `usd: 0` (`types.ts:80-84`).

The `files` array reduces to a count; the paths stay in glance's HTML receipt behind the link.

### 7.3 The room selector

Round 1 never said which room a receipt lands in. The mapping is `(principal, repo) → room_id`, held in an atrium-side configuration table written by a human at provisioning time, and:

- It is **not** in the envelope. A delivery that could name its own room could post into any room its principal happens to be a member of, and the repo string is glance-controlled.
- A `repo` with no mapping is **refused**, not routed to a default. A default room is how one tenant's receipts land in another's.
- The resolved room is validated against the principal's membership before the append, and again inside it via `authorize` (`ledger.ts:340`).

### 7.4 What kind of proposal — and where I disagree with the receipt

**`type: 'decision'`, `decidedBy: null`, `status: 'active'`, `confidence: 0.9`.**

Round 1 chose `claim` and the reasoning was inverted. The correction, with the mechanism:

- **`claim` auto-accepts.** `policy.ts:131` — `claim: {thetaAuto: 0.7, thetaMin: 0.5, autoAccept: true}`. A machine-staged claim at ≥0.7 reaches `acceptance.ts:980-987` and returns `auto_accept`. Round 1 believed the gated types were the ones a machine could never turn into `✓` and therefore the wrong choice; in fact `claim` is one of the two types a machine *can* accept, and `modelMintingGate` returns `null` for it (`authority.ts:263-266`).
- **An accepted claim does not produce the promised `✓`.** `README.md:153`: "an accepted claim keeps its truth status in a separate `verification` field, and that field is what the glyph renders." It stays `~` until a second, disinterested human verifies it, and `selfVerificationRefusal` (`authority.ts:762`) gates even that. So `claim` is simultaneously the type a machine may certify and the type whose human acceptance does not certify.
- **`decision` is the loop.** `policy.ts:128` — `autoAccept: false`, so it never auto-accepts at any confidence. `modelMintingGate('decision')` (`authority.ts:253-256`) refuses any non-human acceptance at `reduce.ts:722`. And a *human* accepting a machine-staged decision is exactly the product sentence: the acceptance mints the object, `humanTouchedAt` is set, and the line renders `✓`.

**Not `commitment`:** `CommitmentPayload.owner` is a non-nullable `Id` (`objects.ts:28-33`) and is an attribution field (`attribution.ts:62`), so `attributed_person_not_author` (`escalation.ts:804`) would demand the owner authored a cited message. The only candidate is the bridge itself, and "glance undertakes to land this" is false — the land already happened. `decision` takes `decidedBy: Id.nullable().default(null)` (`objects.ts:20-24`), and null is honest: no person decided this, the gate did.

`decidedBy: null` also routes it correctly. `attention.ts:184`: "nobody is named on this decision, so any member of the room can settle it... A decision is never accepted by inference; it waits for a person."

**The semantic strain, named.** A land receipt is not obviously "what the group decided". The honest reading is that the decision under certification is *"we accept this land into the record"* — the statement is phrased that way, and the human accepting is adopting the change on the room's behalf. This is the least-bad fit among five types, not a natural one, and a reviewer who thinks the ledger should not carry land receipts as decisions is raising a real objection that this document cannot dissolve.

#### The confidence directive is inverted, and I am not following it as written

The receipt directs: *"Set confidence inside [θ_min, θ_auto) so needs_you visibility is arithmetic, not policy."* The goal is right and I have adopted it. **The arithmetic is backwards for gated types, and following it would reintroduce the exact invisibility it was meant to cure.**

`acceptance.ts:866-880`, verbatim in its comment: "**The band: θ_min ≤ c < θ_auto** — One cell for every type, **decisions included**. Shown quietly in current state as unconfirmed, **never in Needs-you**." The code returns `visibility: 'quiet'` at `:876`. And `attention.ts:827` mints an item only for `needs_you`. So a decision at confidence 0.6 — inside [0.5, 0.7) — produces a `~` that reaches no attention surface at all.

The path that *does* produce `needs_you` for a decision is `acceptance.ts:907-915`: `if (!rule.autoAccept)`, reached only **at or above θ_auto**. `decision.autoAccept` is `false` (`policy.ts:128`), so ≥θ_auto is safe — it cannot auto-accept, and it is the only band that surfaces.

So: **confidence 0.9, which is ≥ θ_auto (0.7) for `decision`.** Tracing the full dispatch: window present (§7.5) → provenance clean → `0.9 ≥ 0.5` → `0.9 ≥ 0.7`, so no `theta_band` → not a commitment → `!autoAccept` → **`pending` / `needs_you`** (`:913`) → attention item minted (`attention.ts:827`). The receipt's goal is met exactly: visibility is arithmetic, driven by the θ table and the `autoAccept` flag, with no policy layer between the number and the surface.

Round 1's `confidence: 1.0` was wrong for a different reason than the receipt gave — with `claim` it hit `auto_accept` at `:980`, and `visibility: 'accepted'` never reaches Needs-you either. Both round-1 and the receipt's proposed band fail; the ≥θ_auto band on a non-auto-accepting type is the one that works.

Confidence 0.9 means transcription fidelity, not land quality. `gate.status` carries quality, and four of its six values are not green. A renderer that conflates them is a defect (§7.5).

### 7.5 Provenance honesty

`proposal_sources` requires a `message_id` composite-FK'd into `messages` in the same room (`schema.ts:1201-1206`). There is no way to cite a URL or an external id. So the bridge posts a message and cites it.

That message is authored by the bridge principal — `messages.authorId` is an FK to `users.id` (`schema.ts:1016`), and `commands.ts:1505-1508` states an agent may post messages. The `quote` (`schema.ts:1141`) is a verbatim span of that body.

**And this neutralizes the provenance check, which must be said plainly.** `validateProposalProvenance` (`escalation.ts:1011`) exists to check a model's reading against words *a person wrote*: `quote_not_found` (`escalation.ts:709`) asks whether the quote appears in a cited message, `attributed_person_not_author` (`:780`) asks whether a named claimant or owner authored one. When the machine both writes the message and quotes itself, every one of those passes by construction. The gate is satisfied and has verified nothing. The bridge is not exploiting a hole — the check was built for a different shape of input — but a reader who sees a clean provenance result on a bridge proposal must not read it as independent corroboration. It is a tautology.

Two consequences, both accepted rather than solved:

- **The envelope is carried in the payload.** The proposal's payload includes the full envelope alongside the statement, so a human accepting is accepting something checkable against glance's own artifacts, and so a later reader can recompute the sentence from the data instead of trusting the render. This is the substitute for a provenance check that cannot do its usual job.
- **Renderer fidelity is not enforced anywhere.** Nothing checks that the receipt sentence is a faithful transcription of the envelope. A renderer bug that prints "gate green" for `gate.status: "failed"` produces a message whose quote matches, whose provenance validates, and whose statement is false — and every gate in the system passes it. The only defenses are that the envelope travels in the payload so the discrepancy is *discoverable*, and that the render is a pure function of the envelope and should be property-tested as one. Neither is a guarantee. **This is the sharpest remaining edge in the design** and §11 keeps it open.

### 7.6 Identity, idempotency, and the fingerprint domain

**`receipt_id` is a content hash over the canonical envelope.** Round 1 derived it from `(repo, branch, commit ?? "", at)` and justified that by citing `src/rail/receipt/write.ts:39-43` as using the same tuple. **That citation was false.** `landReceiptFilename` builds `${branch}-${at}-${uniq}`, and `uniq` is `token` when supplied, otherwise `Math.random()` (`:41`); `writeLandReceipt:156` passes `receipt.commit` as the token on attempt 0 and `undefined` on retries. So when there is no commit — a rejected or forced land, which is exactly the `forcedWithoutProof` class that most needs recording — glance reaches for randomness precisely where round 1 claimed the tuple was sufficient. Two same-millisecond no-commit lands on one branch would collide, and one receipt would be silently dropped as a duplicate.

The derivation is therefore `sha256(canonical_json(envelope_without_receipt_id))`, over the whole envelope. Two lands that differ in any field — gate status, cost, precision, insertions — are different receipts. Two deliveries of the same land are byte-identical and collapse, which is the property the outbox needs.

**`proposal.id` is derived, not random.** `uuidv5(bridge_namespace, receipt_id)`. This mirrors `interpret.ts:39-47`'s content-addressed proposal ids, and it is what makes the fold-level check work: a retry that reaches the reducer with an already-recorded proposal id is refused as already recorded rather than staging a second `~`.

**Two idempotency layers, mirroring `interpret.ts`:**

1. *At the door* — `command_receipts` (`schema.ts:926-967`), keyed `(roomId, actorKind, actorId, commandName, idempotencyKey)` `:945`. The bridge principal is `actor_kind = 'agent'` with a non-blank id, satisfying `:958` and `:959` (a `system` actor would not). `commandName = 'bridge_land_receipt'`, `idempotencyKey = receipt_id`.
2. *At the fold* — check the reducer's own state before appending, as `interpret.ts:394-412` does, because a duplicate is refused as `applied_with_issue`, which still writes a history row that changes nothing.

**The fingerprint domain is the full envelope, not ids.** `semanticCommandFingerprint` (`commands.ts:160-164`) hashes `['stage_semantic_command/v1', roomId, messageId]` — ids only, correct for that command because the message body is already immutable. Copying it here would be a hole: a replay under the same `receipt_id` with a flipped `gate.status` would match the stored fingerprint and return the *original* success, so the corrected receipt would be silently swallowed. `payloadFingerprint = sha256(canonical_json(envelope))` instead. A genuine retry matches and replays; a changed envelope mismatches and is refused as a conflict, which is a loud, correct failure rather than a quiet wrong one.

**Two writers, one room.** The bridge and the interpretation worker both stage proposals into the same room with no shared idempotency key, and they can race on the same message. §7.7's exclusion is what keeps them from reading each other's output; without it, the interpreter's readings of a bridge message have their own ids and neither layer above would notice.

### 7.7 The interpretation exclusion — a required precondition

Per §4.4, `claimWindow` (`interpret.ts:648-673`) drains every message in the room with no author filter, and `onMessagePosted` (`projections.ts:212`) enqueues unconditionally. So without an exclusion, the interpreter reads the bridge's receipt messages and stages *its own* readings of them, and `claim`/`open_question` readings auto-accept at θ (`policy.ts:130-131`, `interpret.ts:468-480`). The result is accepted ledger state derived from a machine's message with no human anywhere in the path — the precise outcome the whole design exists to prevent, arriving by a route the bridge does not control.

**This is a precondition, not a mitigation, and it is unshipped.** `ARCHITECTURE.md:213` names it: "core currently allows model auto-acceptance for claims and open questions. The target invariant requires all nonhuman output to remain `~`. This needs an explicit semantic-policy migration and updated tests **before agents exist**." `:255` schedules it as slice 2.

Three candidate exclusions, none of which this document authorizes:

1. **An author-kind filter in `claimWindow`** — join `users` and exclude `principal_kind = 'agent'` authors. Narrow, structural, and one query. Its cost: it silently makes agents unreadable to interpretation forever, which is a product decision well beyond this bridge.
2. **A dedicated receipts room with no interpreter installed.** Requires interpretation to be per-room installable; `ARCHITECTURE.md:40` describes an interpreter as installed rather than joined, which suggests it is, but that is a doc claim and not one I verified in code. Cheapest if true.
3. **Slice 2 shipped in full** — machine output never auto-accepts, at which point the interpreter reading a bridge message produces a `~` a human must accept, which is merely noisy rather than unsound.

**Whichever is chosen, the bridge must not ship before one of them is in place.** A bridge deployed against today's interpreter is unsound regardless of how carefully §7.4 chose its type.

### 7.8 Field map, message id, and build order

| envelope / derived | destination | anchor |
|---|---|---|
| rendered prose | `messages.body` | `schema.ts:1017` |
| bridge principal | `messages.authorId` | `:1016` |
| the minted `messageId` | `proposal_sources.messageId` | `:1191` |
| resolved room (§7.3) | `proposal_sources.roomId`, `proposals.roomId` | `:1187`, `:1099` |
| — | `proposals.type = 'decision'` | `:1105` |
| statement, `decidedBy: null`, `status: 'active'` | `proposals.payload` | `:1106`; `objects.ts:20-24` |
| `0.9` | `proposals.confidence` | `:1107` |
| — | `proposals.proposerKind = 'model'` | `:1108` |
| `"glance/<harness>"` | `proposals.proposerModel` | `:1109` |
| bridge principal, from the append actor | `staged_by_kind`/`staged_by_id` | `:1130-1131` via `reduce.ts:567` |
| the receipt sentence, verbatim | `proposals.quote` | `:1141` |
| `uuidv5(ns, receipt_id)` | `proposals.id` | `:1098` |
| `receipt_id` | `command_receipts.idempotency_key` | `:935` |
| `sha256(canonical_json(envelope))` | `command_receipts.payload_fingerprint` | `:937` |
| the full envelope | proposal payload, beside the statement (§7.5) | `:1106` |

**The message id is minted by the bridge, not taken from the event id.** Round 1 leaned on the `stage_semantic_command` analogy, which is false in a way that matters: that command cites a message a *person already posted*, so it has an id to cite. The bridge creates both. The live path mints one with `randomUUID()` (`commands.ts:885`) and puts it in the `message_posted` event payload; the bridge does the same, and **the same value** goes into the proposal's `provenance.messageIds`. Round 1 left this unstated, and a reader implementing it would have reached for the event id, which is a different value.

**Build order and `project` are load-bearing.** `AppendBatchRequest.builds` (`ledger.ts:368`) is ordered:

1. `builds[0]` → `message_posted` carrying the minted `messageId`.
2. `builds[1]` → `proposal_recorded` whose `provenance.messageIds` is `[that same messageId]`.

with `requireClean: true` (`:367`) and a `project` (`:369`) that writes the `messages` row before the proposal's projection writes `proposal_sources`. Without the `project` the FK `proposal_sources_message_same_room_fk` (`schema.ts:1201`) has no row to point at; without the order, the proposal is reduced before the message exists and `decideAcceptance` returns `missing_message_context` (`acceptance.ts:670`). Both fail closed — but for reasons no reader could predict from round 1's text, which is why they are stated.

### 7.9 `at` is a glance-host clock read

`LandReceipt.at` is `Date.now()` on the glance host (`squad-manager.ts:4809`). `packages/ingest`'s discipline is explicit that a timestamp "comes from the source; never from a local clock" (`validate.ts:38`) — and here glance *is* the source, so the rule is satisfied in letter. What it costs:

- The land order in `at` and the ledger order in `core_events.room_seq` are different orderings, and after an outage catch-up (§8.5) they will disagree. Any view that sorts by `room_seq` and calls it chronology is wrong.
- A glance host with a skewed clock produces receipts that sort wrongly against each other and against room messages. Nothing detects this.
- `at` no longer participates in identity (§7.6 moved to a content hash), so a clock error is a display defect rather than a correctness one. That is the main reason this is acceptable.

---

## 8. Failure honesty

**8.1 — Unauthorized delivery.** Refused at the seam per §5.3. Nothing staged, nothing appended, no message posted. Round 1 refused *malformed* and never refused *unauthorized*; that was the round's Critical.

**8.2 — Malformed envelope.** Refused against a strict schema in the shape `validate.ts:33` uses (`z.strictObject` — an unknown key is an error, not an ignored field), and rejected *after* authentication, so a malformed delivery from a valid principal is distinguishable from an anonymous one. No partial ingest, no coercion: a missing `gate.status` does not default to `green`, a missing `validation` does not become a skipped verdict, a missing `precision` does not become `n: 0`. The absence rules of §7.2 apply at the reader.

**8.3 — The bridge is down.** The glance land completes. `squad-manager.ts:4743-4747` already makes receipt emission best-effort and fire-and-forget, and `emitLandReceipt`'s contract (`:4751-4756`) degrades every fault to a log line. A bridge outage means atrium's ledger is **behind**, never wrong.

Behind must be visible. glance's own precedent is the index-append warning (`src/rail/receipt/write.ts:164-175`), which exists because a persistent failure "would otherwise under-report the gate's evidence with no signal at all". The bridge needs an unexported-receipt count and age that a human can see. **A silent backlog is this design's most exposed failure mode**, because the ledger looks correct and is merely incomplete.

**8.4 — Atrium refuses the append.** Two different failure models, and round 1 described the wrong one for the call it specified:

- `ledger.append` throws for `rejected` and `malformed` but **not** for `applied_with_issue` (`interpret.ts:483-496`) — a business refusal writes its row, fans it out marked, and changes no state. A caller must inspect `issues`.
- `ledger.appendBatch` with `requireClean: true` (`ledger.ts:367`) **refuses the whole causal unit** if any reducer step reports a business issue, and throws.

The bridge uses `appendBatch(requireClean: true)`, so the honest statement is: **a business refusal throws and nothing commits — neither the message nor the proposal.** The delivery stays unsettled and is retried. Round 1 specified `appendBatch` in one section and `append`'s "inspect `issues`, do not treat a return as applied" discipline in another; those are inconsistent, and the batch's model is the operative one. The `append` discipline is retained only as the reason `requireClean` is set rather than omitted.

**8.5 — Durable outbox and catch-up.** Round 1 had no answer for "atrium was down and then glance restarted".

`index.jsonl` cannot reconstruct an envelope — `landReceiptIndexRow` (`write.ts:59-83`) drops `message`, `cost`, `insertions`/`deletions`, `rollbackPoint`, `gate.command`, `gate.newRegressions` and `gate.detail`. The HTML receipt is a render, not a source. `TraceExportQueue` (`src/trace-exporter.ts:178`) is in-memory and lossy across a restart.

So the bridge writes a durable outbox of its own: one append-only record per land, holding the **complete envelope** and a delivery state, beside `land-receipts/` under the org's `stateDir` (`manager-registry.ts:132`), written in the same best-effort block as `writeLandReceipt` and with the same posture — an outbox write failure warns and never fails the land. On restart the emitter drains undelivered records oldest-first. Because `receipt_id` is a content hash (§7.6) and `command_receipts` dedupes at the door, re-delivery of an already-landed envelope replays rather than duplicates.

Catch-up is **not** ordered. Receipts arrive in drain order and `room_seq` records arrival, not land order (§7.9).

**8.6 — A human rejects.** `proposals.status` moves to `'rejected'` with `rejectedReason` (`schema.ts:1142`, `:1145`). Nothing on the glance side changes: the land happened, the code is on main, a rejection does not un-land anything. It means "this reading is not one I will certify". The bridge does not retry, re-stage, or escalate it, and does not treat it as an error.

**The bridge cannot withdraw its own reading either.** `actorMatchesProposer` (`authority.ts:401-405`) returns `false` for an agent actor, and both the rejection binding (`reduce.ts:599`) and the supersession binding (`:645`) gate on it. A wrong receipt can only be withdrawn by a human. Safe direction, real limitation, and it means "the bridge retracts a receipt it got wrong" is not a capability this design has. A corrected land is a **new** receipt with a different content hash and therefore a new `~`; the stale one stays until a person rejects it.

**8.7 — The receipt claims a land that did not happen.** Nothing verifies glance's claim against the repository. `confidence: 0.9` is transcription fidelity, not truth. A compromised or buggy glance can stage a `~` asserting a land that never occurred. What holds is that it stays `~`: `modelMintingGate` (`authority.ts:253`) plus `reduce.ts:722` refuse any machine acceptance of a decision, so it takes a person. Independent verification is §11.

**8.8 — Room, membership, or credential lost mid-flight.** `authorize` runs inside the append transaction after the ledger lock (`ledger.ts:340`), and the database refuses an unauthorized actor independently (`schema.ts:202-208`). The append fails closed and the delivery joins the 8.5 backlog. No anonymous fallback, no `system`-actor path, no default room.

**8.9 — The reviewer ledger could not be read.** Carried through, never flattened. `unreadable` (`reviewer-weights.ts:248-253`) means the file could not be read — distinct from absent, which is normal and never sets it. `corrupt` (`:241-247`) means too many rejected lines to trust the survivors. A sentence reading "reviewed by codex (0 findings)" when the truth is "the ledger was unreadable" is the exact defect class the stamp's own design notes name.

---

## 9. What this document does NOT authorize

1. **No implementation.** No migration, no code, no endpoint. The sketches in §7 are prose about shapes.
2. **No atrium writes.** `/home/lars/atrium` was read only; nothing in it was created, modified, or deleted.
3. **No widening of `Proposer`.** `packages/core/src/proposal.ts:19-21` stands; the two acceptance-semantics questions at `common.ts:308-312` remain unanswered.
4. **No relaxation of `commands.ts:1516`.** The socket path continues to refuse an agent staging a proposal. §6.3 designs an in-process worker that never reaches `draftToProposal`; it does not authorize touching the socket refusal.
5. **No new trust seam.** §5.2 states the contract any ingest surface must satisfy and explicitly declines to choose the mechanism. Nobody may read §5 as approval to add an HTTP route or to widen `ws-auth.ts:24`.
6. **No change to `claimWindow`.** §7.7 names three candidate exclusions and authorizes none. Choosing one is atrium's slice-2 decision.
7. **No execution runtime.** No way for atrium to start, stop, schedule, or configure a glance run. `init.md:250-264`'s "do not initially build" list is untouched. This is Phase 4 (`init.md:513-526`) precisely because it needs no repository access.
8. **No certification authority for any machine**, by bridge, agent principal, or policy exception.
9. **No auto-acceptance.** Structurally impossible for `decision` (§6.2), and not sought.
10. **No tenant gate contract.** §6.1 assumes a human-provisioned one-to-one org↔workspace mapping and designs nothing further. G3 owns it.
11. **No agent grants, capability records, assignments, or execution receipts** (`ARCHITECTURE.md:82`, `:209`). The bridge reads nothing it must be granted and executes nothing.
12. **No mention, attention-routing, or notification behaviour.** The receipt message mentions nobody; the attention item is minted by the existing engine (`attention.ts:827`), not by the bridge.
13. **No claim that a `~` receipt is evidence.** An unaccepted receipt is a reading. Counting `~` receipts as landed-work-with-oversight is the category error the glyphs exist to prevent (`README.md:172-179`).
14. **No revision of `ARCHITECTURE.md`.** §2.1 reports it stale; correcting it is its authors' call.

---

## 10. What this inherits — named, not absorbed

This design sits on top of `ARCHITECTURE.md`'s staged plan (`:252-261`) and does not complete it. Its own sequencing, quoted:

> **`:255`** — "2. **Machine-certification alignment:** decide and migrate model claim/open-question auto-acceptance so code and the chosen invariant agree."
> **`:256`** — "3. **Human authority completion:** specify and enforce which human may certify third-party claims, commitments, assignments, and grant agents."
> **`:261`** — "Each slice has an observable boundary and can ship or be rejected independently. No later slice is smuggled into the typed-reference schema."

**Slice 2 is a hard precondition, not a risk.** §7.7: without one of the three exclusions, the interpreter reads bridge messages and auto-accepts its own claim readings of them. The bridge is unsound until this is closed, and no amount of care inside the bridge closes it.

**Slice 3 is an inherited gap the bridge widens.** `ARCHITECTURE.md:234` asks "Which human may certify a third-party claim, commitment, or assignment? This must resolve current 'any human' gaps rather than inherit them." Today any human member may accept a bridge decision — `selfStagedReadingRefusal` (`authority.ts:516`) does not fire, because its guard (`:537`, `:546`) returns null when the stager is not the accepting human, and the stager is the agent principal. So any room member may `✓` a land they did not review, did not run, and may not understand. The bridge does not create that gap; it makes it load-bearing, because a land receipt is precisely the kind of thing a passer-by will accept to clear a Needs-you badge.

**Both are named preconditions for T-FINAL (#389)**, not items this document absorbs or claims to have handled. Per `:261`, neither slice is smuggled in here: this document proposes no migration for either.

---

## 11. Unresolved before implementation

- **Which ingest mechanism** (§5.2) — a new authenticated HTTP surface, or Better Auth session machinery for an agent principal. The contract is specified; the mechanism is atrium's call.
- **Which interpretation exclusion** (§7.7) — author-kind filter, uninterpreted room, or full slice 2. Blocking.
- **Renderer fidelity** (§7.5) — nothing enforces the sentence faithfully transcribes the envelope, and every existing gate passes a mis-rendered receipt. Property-testing the render as a pure function is a mitigation, not a guarantee.
- **Message volume** — one room message per land floods a busy room. A materiality bar makes the ledger silently partial; batching couples unrelated lands into one transaction and strains verbatim `quote` spans. Neither chosen.
- **Whether a land receipt should be a `decision` at all** (§7.4) — the least-bad fit among five types, not a natural one.
- **Independent verification** (§8.7) — would require repository access atrium deliberately does not have (`init.md:515`).
- **Who may certify** (§10, `ARCHITECTURE.md:234`) — inherited unresolved, and this bridge makes it concrete.
- **`Proposer`'s agent variant** (§6.3) — the long-run answer; requires atrium to answer `acceptance.ts:663` and `:828`.
- **Backlog visibility** (§8.3) — what surface shows "N receipts unexported for M hours", and to whom.
- **Clock skew** (§7.9) — undetected, currently display-only.

---

## 12. What would falsify this

Round 1's three falsifiers were confirmed by all three critics and are retained. Three more are added for the round-2 design.

1. **Atrium has a durable agent principal** — `schema.ts:239`, `:289`, `:219`; `common.ts:314-319`; `session.ts:50`. *Confirmed round 1.*
2. **`reduce.ts:567` derives `stagedBy` from the trusted append actor**, so an agent-actor append yields `staged_by_kind = 'agent'` without widening `Proposer`. If `stagedBy` were caller-supplied, §6.3's honesty argument collapses. *Confirmed round 1.*
3. **`proposal_sources` structurally requires an in-room `messages` row** — `schema.ts:1201-1206`. *Confirmed round 1.*
4. **`decision` never auto-accepts and reaches `needs_you` only at ≥θ_auto** — `policy.ts:128` (`autoAccept: false`), `acceptance.ts:871-879` (the band is `quiet`), `:907-915` (`never_auto_accepts` → `needs_you`), `attention.ts:827`. If `autoAccept` for `decision` were ever flipped true, or if the band returned `needs_you`, §7.4's confidence choice inverts.
5. **`claimWindow` has no author filter** — `interpret.ts:648-673`. If it gained one, §7.7 stops being a blocking precondition.
6. **`modelMintingGate('decision')` refuses non-human acceptance regardless of proposal or confidence** — `authority.ts:253-256`, `reduce.ts:722`. This is what makes "no auto-acceptance" structural rather than policy; if it were relaxed, §6.2's central row reverts to an editable promise.

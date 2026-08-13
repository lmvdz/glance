# Phase-4 bridge: glance land receipts as atrium proposals

**Status:** proposed — awaiting human review. This document authorizes no implementation.

**Date:** 2026-08-12 (round 3 — revised against gauntlet rounds 1 and 2)

**Authorities:** the glance#208 thread comment (2026-08-12); atrium `init.md` Phase 4 (`init.md:513-526`); atrium `plans/room-entity-capabilities/ARCHITECTURE.md` (2026-08-04); glance#388 and its round-1 and round-2 gauntlet receipts.

**Trees read:** glance at `campaign/phase5-bridge`; atrium at `699842e`, read-only. Anchors touched in round 4 were re-verified against atrium HEAD `240b26e` — one commit past the `699842e` baseline (a docs-only lint-comment fix, no code change), and every touched anchor holds unchanged at both.

**Reopen if wrong.** Every anchor was re-derived from `699842e` immediately before writing. Round 1's anchors drifted per-file and were rebuilt in round 2; round 2's spot-checks all matched.

---

## 0. The finding this document now leads with

Three rounds of review converged on something larger than a defect list. **Atrium's acceptance engine structurally resists the shape this bridge assumed** — "stage a reading into the room and let the ledger surface it." A blind, code-verified precondition review (round 4) reduced the resistance to **two** genuine atrium preconditions, neither of which is a bug.

The engine is built on one premise: *a machine reading is an extraction from messages people wrote, and it is certifiable to the degree the surrounding conversation corroborates it.* A land receipt is not that. It is a machine **reporting on the outside world**, and it arrives as the newest thing in the room with nothing after it and nothing before it that it was read out of. Every gate that makes machine readings safe is measuring a property a land receipt cannot have.

That is not a patch list. It is the code telling the truth about what Phase 5 would have to fund. So this document now does two jobs:

1. **§4 — what ships today**, with zero atrium changes: receipts as room messages, and a human-staged path into the ledger. This is real and it is degraded, and §4.3 says exactly how.
2. **§12 — what atrium must build** before the automatic `~ → ✓` loop is sound: **two** preconditions (P1 and P3), each quoting the code that forces it.

Everything between is the bridge design that becomes correct once §12 is funded.

### Disposition of every blocker raised across four rounds

| blocker | disposition | where |
|---|---|---|
| Trust seam is unlocked (`mintAgentSession` issues a real session) | **SOLVED** | §6 |
| Full envelope stripped by `DecisionPayload`'s zod | **SOLVED** | §9.3 |
| Certifiable window — receipt is always the newest message | **NAMED — P1 (atrium)** | §12.1 |
| Interpretation exclusion is policy, no author filter exists | **NAMED — P3 (atrium)** | §12.2 |
| Attention persistence only via the interpreter | **SOLVED — bridge-side** | §7.3 |
| `proposal.id` not tenant/room scoped against a global PK | **SOLVED** | §9.5 |
| Content hash is content-identity, not occurrence-identity | **SOLVED** | §9.5 |
| §8.5 outbox does not survive the fire-and-forget crash window | **SOLVED** | §10.5 |
| Credential revocation not re-checked at append | **SOLVED** | §6.4 |
| Staging insert not transactionally tied to the enqueue | **SOLVED** | §7.2 |

**Two atrium preconditions, not three.** Round 3 named three; round 4's code-verified review demoted attention-persistence to bridge-side work (`reconcileStoredAttention` is exported and self-contained — §7.3), leaving **P1 (§12.1)** and **P3 (§12.2)** as the genuine atrium asks. Both are confirmed against code; the demoted one is now a step of the bridge worker.

**Vindicated from round 1:** the `0.9` / `never_auto_accepts` confidence choice. Round 1's remedy — confidence inside `[θ_min, θ_auto)` — was refuted against `acceptance.ts:866-880`, which returns `quiet` for every type in that band, "decisions included". That remains the design (§9.4), though P1 means it is not yet reachable.

---

## 1. The loop this is designing

glance lands changes; each land produces a receipt. Atrium keeps a ledger where every line says whether it is `~` (a reading nothing has checked) or `✓` (the same sentence after a person accepted it) — `README.md:19-22`.

The intended loop: **a land receipt crosses into atrium as `~`, and a human's acceptance is the `✓`.**

**This is `init.md` Phase 4, not Phase 5.** `init.md:513-526`: "The first agent does not need repository access. It can: propose state changes... That tests agent participation without requiring an execution runtime." That is this bridge exactly — glance holds the repository, atrium never touches it. Phase 5 (`:528-541`) is about *adding execution*, and this design deliberately chooses no execution contract.

---

## 2. Contradictions found while verifying this ticket

**2.1 — "Agent participant" is no longer future.** `ARCHITECTURE.md:32` and `:209` describe a machine principal that does not exist. It exists, at HEAD `699842e`:

- `packages/db/src/schema.ts:239` — `principalKind = pgEnum('principal_kind', ['human', 'agent'])`.
- `packages/db/src/schema.ts:289` — `users.principal_kind`, immutable after provisioning (`:271-283`).
- `packages/db/src/schema.ts:219` — `actorKind = pgEnum('actor_kind', ['human', 'agent', 'model', 'system'])`.
- `packages/core/src/common.ts:314-319` — `Actor` carries `{ kind: 'agent', userId: Id }`.
- `apps/server/src/session.ts:50` — `Session.principalKind`, required, no `?? 'human'` fail-open.

`ARCHITECTURE.md`'s evidence section (`:15-16`) is stale against its own tree. §11 states what this design inherits from it.

**2.2 — the actor floor gates on `isHuman`, not on `model`.** `authority.ts:307` is `actor.kind === 'human'`; `common.ts:287-290` states that `agent`, `model` and `system` are all refused by the same predicate. An agent principal buys identity and zero certification authority.

**2.3 — the glance-side anchors in the framing are wrong.** The receipt schema is `src/rail/receipt/types.ts:95-132`; the `validatorGate` stamp is `src/validator.ts:838-843`, called from `:914`. The land lane holds the gate call (`squad-manager.ts:5324-5340`) and receipt assembly (`:4800-4820`).

**2.4 — `ARCHITECTURE.md` has no "does NOT authorize" section.** Its discipline is `:3` plus refusals at `:9`, `:141`, `:163`, `:166`, `:209`, `:239`, `:261`. §13 writes it out.

---

## 3. Seam A — glance receipt production

### 3.1 The receipt

`LandReceipt` — `src/rail/receipt/types.ts:95-132`: `repo` `:98`, `branch` `:99`, `commit?` `:101`, `message?` `:104`, `files` `:106`, `insertions?`/`deletions?` `:107-108`, `landed` `:110`, `at` `:112`, `gate` `:115`, `validation?` `:120`, `panel?` `:122`, `rollbackPoint?` `:126`, `forcedWithoutProof` `:128`, `cost` `:131`.

`LandReceiptGate` `:64-77`; `GateStatus` `:62` is six values (`green`, `red-baseline`, `failed`, `unproven-rejected`, `no-gate`, `forced`), four of them amber or red.

### 3.2 Where it is built

`emitLandReceipt` — `src/squad-manager.ts:4757-4830`, construction at `:4800-4820`, called fire-and-forget from `landInner` at `:4747` under `if (!result.retryable)`. That call site is §10.5's problem.

### 3.3 The validator stamp

`validatorGate` — `src/validator.ts:851-924`, called from `squad-manager.ts:5324-5335`, stamped at `:5337`. `withFreshReviewerPrecision` — `src/validator.ts:838-843` — applied unconditionally at `:914`; unknown lineage yields an explicit `{lineage:"unknown", n:0, ...}` (`:841`) rather than defaulting to `native`.

`ReviewerPrecisionStamp` — `src/memory/reviewer-weights.ts:221-254`, including `corrupt?` `:247` and `unreadable?` `:253`, which keep "could not be trusted" distinguishable from "no history".

### 3.4 The countable substrate

`landReceiptIndexRow` — `src/rail/receipt/write.ts:59-83`, pure; honesty invariants at `types.ts:161-166`. `writeLandReceipt` — `write.ts:148-183`, HTML with `flag:"wx"` at `:159`, index appended at `:165` with its own try/catch warning at `:171`.

### 3.5 What leaves the machine today

`postReceiptComment` (`write.ts:190-200`, `gh pr comment` at `:198`); `postAgentPrCheck` (`src/rail/wedge/post-check.ts`), which **does** carry structured receipt content via `receiptToCheckOutput` (`receipt-adapter.ts:79`) but is CLI-only (`scripts/post-wedge-check.ts:113`); `TraceExportQueue` (`src/trace-exporter.ts:178`), which ships spans, not receipts. So: **no automatic daemon-side structured export exists.**

### 3.6 The plugin idiom and unit identity

`HarnessIngester` — `src/ingest/harness.ts:28-33`, dispatched by `ingestAllHarnesses` (`:43-56`), throttled `:47`, failure-isolated `:52-54`, registered in one line (`src/ingest/index.ts:16`).

`newAgentId` — `src/spawn-identity.ts:66-68`: per-spawn, process-local sequence (`:58`), untenanted. Tenancy is the state directory (`src/manager-registry.ts:132`). **A unit id is provenance, not a principal.**

---

## 4. What ships today

Before the design, the honest floor. With **zero atrium changes**, two things are already possible and one is not.

### 4.1 Receipts as room messages — works today

The bridge principal is an `agent` (§8), and `commands.ts:1505-1508` states plainly what an agent may do:

> "Note what is NOT restricted: an agent may post messages, answer, resolve attention, set presence and advance its seen cursor. Staging a `~` reading is the one participant act whose meaning depends on a vocabulary that has not been extended yet."

So glance receipts can land in an atrium room as messages, authored by the bridge principal, today. That delivers the human-visible half of the value — the room sees what the fleet landed — and it needs no schema change, no new type, and no engine change.

### 4.2 A human-staged path into the ledger — works today

A human may stage a proposal citing **any** message in the room, including a bridge-authored one, via the `record_proposal` command (`commands.ts:1050-1056`) carrying a `ProposalDraft` (`commands.ts:220-227`) whose provenance the caller supplies. `draftToProposal` (`commands.ts:1510-1534`) sets `proposer: {kind:'human', userId: session.userId}` at `:1528`.

That matters because a human proposer **skips every machine-receipt gate**. `acceptance.ts:828-848` returns `pending` / `needs_you` for `proposal.proposer.kind === 'human'` immediately, with the comment at `:823-827`: "θ does not apply. #4's thresholds calibrate *extraction* confidence, and a person's self-report is not that number."

So today's working loop is: **bridge posts the receipt → a person stages it → a person accepts it → `✓`.**

Not via `stage_semantic_command`, which cannot reach a bridge message: its `prepare` requires `eq(messages.authorId, session.userId)` (`commands.ts:1073-1076`) — a person may only stage from their own message.

### 4.3 What this floor costs, stated plainly

- **Two human acts, not one.** The design's whole claim was that the machine drafts and the human only certifies. Here the human drafts too.
- **The attribution is wrong.** `proposer_kind = 'human'` says a person read this out of the room. Nobody did; glance reported it. The ledger records a human judgement that was not exercised — the same class of dishonesty `schema.ts:1111-1129` introduced `staged_by_*` to prevent, arriving from the other direction.
- **It does not scale.** One human act per land is exactly the cost the fleet exists to remove.

**This floor is not the destination and should not be shipped as though it were.** It is what exists while §12 is unfunded, and it is worth stating because a reader deciding whether to fund §12 should know the alternative is real rather than nothing.

---

## 5. Seam B — atrium proposal consumption

### 5.1 The door

`ledger.append` (`ledger.ts:428`) / `appendBatch` (`:429`) take `actor: Actor` (`:321`, `:355`) — "derived from the authenticated session. Never a payload"; `authorize?(tx)` (`:340`, `:356`) re-checked inside the append transaction; `build`/`builds` (`:342`, `:368`); `project?` (`:349`, `:369`); `idempotency?` (`:359-365`) and `requireClean?` (`:367`) on the batch.

The actor is out-of-band by construction: `CoreEvent` refuses at parse time an input carrying one (`events.ts:12-29`). Storage is `core_events.actor_kind` `schema.ts:533` / `actor_id` `:534`.

### 5.2 The actor floor

`reduce.ts:706-750`: type minting `:722` (`modelMintingGate`, `authority.ts:253`) refuses `decision`/`commitment`/`objective` for any non-human whether or not a proposal was cited; verified claims `:732`; proposal-less objects `:746`. `isHuman` is `authority.ts:307`.

### 5.3 The acceptance engine

For a **model** proposer, in dispatch order:

| gate | line | outcome |
|---|---|---|
| window absent | `acceptance.ts:663-670` | `discard` / `none` |
| rejecting provenance problems | `:726` | `discard` / `none` |
| **referring provenance problems** | **`:758-768`** | **`pending` / `quiet`** — `receipt_not_certifiable` |
| `confidence < θ_min` | `:855-863` | `discard` / `none` |
| `θ_min ≤ c < θ_auto` | `:871-879` | `pending` / `quiet` — "decisions included... never in Needs-you" |
| third-party commitment ≥θ_auto | `:889-898` | `pending` / `needs_you` |
| `!rule.autoAccept` ≥θ_auto | `:907-915` | `pending` / `needs_you` |
| text not certifiable | `:967-976` | `pending` / `needs_you` |
| otherwise | `:980-987` | `auto_accept` / `accepted` |

θ table — `policy.ts:128-132`: `decision` 0.7/0.5/**false**, `commitment` 0.75/0.5/false, `objective` 0.75/0.5/false, `claim` 0.7/0.5/**true**, `open_question` 0.6/0.4/**true**.

Attention: `attention.ts:827` — `if (verdict.visibility !== 'needs_you')` skips. **Only `needs_you` mints an item.**

### 5.4 The tables

**`proposals`** `schema.ts:1095-1175`: `id` `:1098`, `roomId` `:1099`, `interpretationId` `:1102`, `type` `:1105`, `payload` `:1106`, `confidence` `:1107`, `proposerKind` `:1108`, `proposerModel` `:1109`, `stagedByKind` `:1130`, `stagedById` `:1131`, `quote` `:1141`, `status` `:1142`, `decidedBy` `:1143`, `rejectedReason` `:1145`. Constraints `:1152`, `:1154`, `:1166`, `:1170`. **`stagedBy` is not a parameter** — `reduce.ts:567` sets it from the trusted append actor, projected at `projections.ts:264-265`.

**`proposal_sources`** `:1184-1207`, composite FKs `:1196`, `:1201`. **`messages`** `:1007-1050`; `authorId` `:1016` is **nullable** (the deleted-user tombstone, not a writer's choice); `body` `:1017` is `text NOT NULL`. **`interpretations`** `:1070-1090`, unique key `:1088`. **`command_receipts`** `:926-967`, PK `:945`, `payloadFingerprint` `:937`, checks `:958-959` (`actor_kind <> 'system'`).

### 5.5 The pattern to inherit

`interpret.ts:33-72` — Claim, Route, One call, Judge, Append, Settle. Two disciplines: **append-returned is not applied** (`:482-496` — `applied_with_issue` writes a row and changes no state), and **rows stay `pending` on a fault** (`:232-245`).

`semanticCommandFingerprint` (`commands.ts:160-164`) hashes ids only — §9.5 does not copy that domain.

---

## 6. The trust seam — solved

Rounds 1 and 2 both filed this as the design's Critical. Round 1 left it blank; round 2 showed round 1's remedy was false against the code. Here it is against the code.

### 6.1 Why a session cannot be the credential

`packages/auth/src/principal.ts:197-227` — `mintAgentSession` calls `context.internalAdapter.createSession(input.userId, false)` (`:220`) and returns a Better Auth cookie. The file says why (`:40-48`): "The session an agent holds is therefore the same object, in the same table, read back by the same library call (`getAtriumSession` → `auth.api.getSession`) as a person's."

That is exactly the problem. `ws-auth.ts:11-25` accepts **any** valid session with no capability restriction, and `commands.ts:1505-1508` grants an authenticated agent the right to post messages, answer, resolve attention, set presence, and advance its cursor. **An agent session is ambient participant capability.** Round 2 was right: round 1's claim that "the credential is not a session and does not confer one" was false.

What *is* true today, and is the foundation of the fix — `principal.ts:30-34`:

> "An agent principal is provisioned with **no credential**: no password row, no OAuth account. Even reachable, the interactive routes have nothing to authenticate it with."

So no external party can obtain an agent session today. `mintAgentSession` is callable only by code already holding the `auth` and `db` handles — an operator, a migration, or a harness (`:35-38`). The seam is closed by *absence*, and the design's job is to add an ingest path without opening it.

### 6.2 The shape

**Three components, and the boundary between them is the design:**

1. **glance emits.** The glance-side exporter writes envelopes to a durable outbox (§10.5) and delivers them over an authenticated transport. It holds no database handle, no `auth` handle, no `ledger.append` handle, and no ability to name an actor.
2. **Atrium verifies the delivery and stages it.** Verification resolves *which provisioned bridge principal this delivery is from*. The delivery lands in a staging table, not in `core_events`.
3. **An in-process worker appends.** A pg-boss worker, sibling to `interpret.ts`, drains staging and calls `ledger.appendBatch` with `actor: {kind:'agent', userId: <resolved principal>}` — exactly as `interpret.ts:414-419` appends with a `model` actor. **This worker never holds a session**, because `ledger.append` takes an `Actor`, not a `Session`.

The actor is therefore derived at a trusted seam and carried server-side, satisfying `ARCHITECTURE.md:181`. No envelope field names an actor, and an envelope containing one is refused rather than stripped (§10.2).

### 6.3 What makes "not a session" structurally true

An ingest credential that could be exchanged for a session would be a session. Four properties make the exchange unreachable rather than merely unintended:

1. **The secret lives where Better Auth does not look.** A `bridge_credentials` table holding `(principal_user_id, key_id, secret_hash, created_at, revoked_at, allowed_repos)`. Better Auth reads its own `account`/`session` tables; it has no adapter for this one. The bridge principal keeps `principal.ts:32-34`'s posture — no password row, no OAuth account — so every interactive route still has nothing to authenticate it with.
2. **The verifier cannot mint.** The verification module does not import `AtriumAuth` and holds no reference to `auth.api` or `internalAdapter`. It returns `{ principalUserId, allowedRepos }` and nothing else. This is the same discipline `packages/auth` already applies to itself — one configuration, one library call — expressed as an import boundary, and it is testable as one: a boundary test asserting the module's import graph excludes `@atrium/auth` is the mechanism, not the comment.
3. **`mintAgentSession` refuses a bridge principal by name.** It already refuses a `human` principal with a message explaining why (`principal.ts:209-213`). The bridge principal needs the same refusal, keyed on a column that marks it ingest-only. This is the **one line of atrium code the solve requires**, and it belongs beside the refusal that already exists rather than in a new place.
4. **The credential is scoped, not general.** It authenticates *deliveries* — it cannot open a socket, invoke a command handler, or post an arbitrary message. The only thing it can cause is a staging row, and the only thing that reads staging is the worker in §6.2(3).

### 6.4 What the seam refuses

| condition | result |
|---|---|
| no credential, or unrecognized | refused; nothing staged |
| credential revoked | refused at verification **and** re-checked at append (below) |
| principal resolves to `human` | refused; the DB would refuse the append too (`schema.ts:202-208`) |
| principal not a member of the target room | refused; `authorize` refuses inside the transaction (`ledger.ts:340`) |
| envelope carries an actor-shaped field | refused as malformed, not stripped |
| `repo` outside the credential's `allowed_repos` | refused; the room selector is not envelope-supplied (§9.2) |
| over the per-principal rate/size bound | refused with backpressure; the outbox retries |

**Revocation is re-checked at append**, which round 2 correctly found missing. `AppendRequest.authorize?(tx)` (`ledger.ts:340`) runs inside the append transaction after the ledger lock, and its docstring (`:322-338`) exists for exactly this time-of-check/time-of-use gap. The bridge worker's `authorize` callback re-reads `bridge_credentials.revoked_at` **and** the principal's room membership in that transaction, and throws to refuse. A credential revoked between delivery and append fails the append rather than committing under a stale check.

### 6.5 What this costs

This is new atrium surface: a table, a verifier, a delivery consumer, and one refusal in `mintAgentSession`. It is small and it is not nothing, and §13 forbids reading §6 as authorization to build it. What §6 claims is that the design is *specifiable against the real auth code* without widening `ws-auth.ts:24` — not that it exists.

---

## 7. The bridge worker

### 7.1 Shape

A pg-boss worker, sibling to `interpret.ts`, obeying the same six-step contract (§5.5). It is the only component that touches the ledger.

### 7.2 Staging and enqueue are one transaction

Round 2 found the staging insert untied to the enqueue. The fix is the pattern already in the tree: `queue.ts:287-306`, `boss.send(..., { db: fromDrizzle(tx, sql) })` at `:303`, whose docstring (`:283-285`) is exact — "the job row is written by the caller's transaction, so it commits with the message or not at all. A crash between the two is not a state this can reach — there is no 'between'."

So the delivery-verification handler inserts the staging row and enqueues the bridge job **in one transaction**, through `fromDrizzle(tx, sql)`. Without it there is a window in which a delivery is durable and nothing will ever read it — the identical defect `queue.ts:20-28` records having already been caught once.

### 7.3 The worker persists its own attention — bridge-side, not an atrium precondition

Round 3 named this an atrium precondition (P2), on the worry that a proposal's attention item is persisted only by the interpretation worker's Settle step (`interpret.ts:550`), which P3's exclusion (§12.2) disables. **Round 4's code-verified review resolved it the way §12.2 hypothesized: it is bridge-side work, and this is where it lives.**

`reconcileStoredAttention` (`apps/server/src/attention-projection.ts:36-102`) is **exported and self-contained.** Its signature is `{ db, state, roomId, messages, now }` (`:36-42`) — it does not call `coreState()` itself; the caller supplies `state`, as the interpretation worker does at `interpret.ts:552` (`state: deps.ledger.coreState()`). The bridge worker holds `deps.ledger` and `deps.db`, so after its `appendBatch` it calls `reconcileStoredAttention` identically, with its own room and its own `coreState()`. This is a step of the worker, not a missing atrium capability.

Two things make it safe rather than merely possible:

- **Idempotent persist.** The write is `onConflictDoUpdate` keyed on `(userId, subjectKind, subjectId, class)`, so a bridge persist and a later interpretation pass over the same room converge on one row rather than double-counting. The double-count worry round 3 raised is unfounded against the conflict key.
- **The window is the worker's obligation.** The one real duty is passing an appropriately bounded room window in `messages` — the same discipline `interpret.ts` applies with its `readContext` collar (`interpret.ts:546-549`), which folds a bounded forward tail rather than the whole future room so that unrelated later conversation cannot silently reclassify a staged reading. The bridge worker owes the same bound. This is a bridge-side test surface, not an atrium migration.

**It is moot until P1 anyway.** While every bridge proposal resolves `quiet` (§12.1), `attention.ts:827` skips it regardless of who calls the reconciler — there is no `needs_you` item to persist. This step only becomes live once P1 is solved and the proposal reaches `needs_you`; it is specified here so that when P1 lands, the bridge worker is already complete rather than acquiring a new atrium dependency.

---

## 8. The durable machine principal

**One atrium `users` row per glance deployment-and-tenant, `principal_kind = 'agent'`** (`schema.ts:289`), immutable after provisioning (`:271-283`), appends carrying `actor_kind='agent'` / `actor_id=<users.id>` with the DB checking agreement (`:202-208`).

**Not per unit** — a unit id is per-spawn, process-local and untenanted (§3.6); a `users` row per unit is an unbounded population of permanently immutable identities keyed on something that does not survive a restart.

**One glance-org ↔ one atrium workspace**, by explicit human provisioning. Reconciling glance's `orgs/<orgId>` (`manager-registry.ts:132`) with atrium's workspace (`schema.ts:302-306`) is the tenant gate contract and belongs to G3.

### 8.1 Capability matrix — extending `ARCHITECTURE.md:58-69`

| Act | Agent participant (`:58-69`) | Land-receipt bridge | enforced at |
|---|---|---|---|
| Read conversation | granted scope | its own room only | room membership |
| Author chat | granted, as self | **yes** | `schema.ts:1016`; `commands.ts:1505-1508` |
| Be mentioned | while mentionable | yes, inert | `ARCHITECTURE.md:71` |
| Mention a target | granted + visible target | no | design choice |
| Stage a semantic proposal | granted proposal type | **`decision` only** | §9.4 |
| Certify `✓` | never | **never** | `reduce.ts:722`, `:732`, `:746`; `authority.ts:307` |
| Correct accepted state | never | **never** | corrections are human-only |
| Assign work | never in v1 | **never** | not proposed |
| Execute a tool/action | explicit grant | **none inside atrium** | §13 |
| Grant or delegate | never | **never** | `ARCHITECTURE.md:69` |
| *(new)* Hold a session | — | **never** | §6.3 |
| *(new)* Accept its own reading | — | **never, structurally** | `authority.ts:253`; `reduce.ts:722` |
| *(new)* Supersede / reject its own reading | — | **no** — refused | `authority.ts:401-405`; `reduce.ts:599`, `:645` |

"Accept its own reading" is structural rather than policy because the staged type is `decision`: `modelMintingGate('decision')` returns `'decision_acceptance'` (`authority.ts:253-256`) and `reduce.ts:722` refuses any non-human acceptance of it at any confidence.

### 8.2 The `Proposer` constraint

`Proposer` (`proposal.ts:19-21`) is `human | model`, no `agent`, deliberately (`common.ts:308-312`). Enforced at `commands.ts:1516-1521` and `authority.ts:401-405`.

The bridge stages `proposer_kind = 'model'`, `proposer_model = "glance/<harness>"`, with `staged_by_kind = 'agent'` derived from the append actor (`reduce.ts:567`). Nothing is widened; the reading is machine-produced and the thing that typed it is the glance agent principal — the distinction `schema.ts:1111-1129` exists to record.

**What makes this sound is §6, not a warrant.** Round 1 argued `commands.ts:1477-1484` anticipates this caller; round 2 correctly rejected that (the anticipated caller is atrium's own interpretation worker). The bridge never reaches `draftToProposal`, for the same reason `interpret.ts` does not: it is an in-process worker calling `ledger.appendBatch` with a server-derived actor. `commands.ts:1516` stays exactly as it is and §13.4 forbids relaxing it.

---

## 9. Receipt → proposal translation

### 9.1 The envelope

Derived from `landReceiptIndexRow` (`write.ts:59-83`) plus what a human needs, canonicalized on `packages/ingest`'s discipline (`validate.ts:33-46`; `jsonl.ts:4-14`).

```
{
  bridge_version: 1,
  receipt_id:   string,   // §9.5 — occurrence-scoped content hash
  occurrence:   number,   // §9.5 — monotonic per (stateDir), assigned once at outbox write
  repo, branch, commit?, message?, landed, at,       // types.ts:98-112
  gate: { status, command?, unproven_green_rejected, new_regressions[], base_was_red },  // :62-76
  forced_without_proof, rollback_point?,             // :128, :126
  files_changed, insertions?, deletions?,            // :106-108
  validation?: { verdict, precision?: {lineage,n,survived,corrupt?,unreadable?} },  // OMITTED when absent
  cost: { usd?, unknown, model?, tokens? },          // :79-89
  unit: { agent_id?, org_id? },                      // provenance only, NOT a principal
}
```

**No actor, principal, room, or workspace field.** Those are resolved at the seam (§6) or derived (§9.2).

Four absence rules, enforced at reader and writer: `validation` absent ≠ `verdict:"skipped"`; `precision` absent ≠ `n:0`; `corrupt`/`unreadable` carried, never flattened; `cost.unknown` ≠ `usd:0`.

### 9.2 The room selector

`(principal, repo) → room_id`, held atrium-side, written by a human at provisioning. **Not in the envelope** — a delivery that named its own room could post into any room its principal belongs to, and `repo` is glance-controlled. An unmapped `repo` is refused, never defaulted. The resolved room is checked against membership before the append and again inside it via `authorize`.

### 9.3 Where the envelope durably lives — solved

Round 2 found the fatal flaw in round 2's own remedy: round 2 said "the raw envelope travels in the payload", and **it does not survive**. `DecisionPayload` is `z.object({statement, decidedBy, status})` (`objects.ts:19-24`) — a plain `z.object`, which strips unknown keys, and neither `objects.ts` nor `proposal.ts` uses `strictObject` or `passthrough` anywhere. An envelope stuffed into the payload is silently dropped before it reaches Postgres, so provenance and transcription could not be reconstructed from the stored proposal.

**The envelope lives in the message body.** `messages.body` is `text('body').notNull()` (`schema.ts:1017`) — free text, no schema, no stripping. The receipt message is the prose sentence followed by the canonical envelope in a fenced block:

```
glance landed feat/x onto main in lmvdz/glance as a1b2c3d — acceptance gate green
(bun run check), no new regressions, reviewed by codex (12 adjudicated, 9 survived).
Rollback point 9f8e7d6. $0.42. Receipt: <link>

```json
{ "bridge_version": 1, "receipt_id": "…", … }
```
```

Four reasons this is the right home and not a workaround:

- It is **the cited message**, so the envelope is exactly what `proposal_sources` points at. Provenance and payload are the same artifact.
- Messages are append-only, so it is as durable as the ledger row.
- `quote` (`schema.ts:1141`) is the **prose sentence**, a substring of the body, so the quote check still resolves against a real span.
- It needs no schema change, which matters when §12 already asks atrium for three.

The cost: the room carries JSON a human did not write. The renderer should collapse the block by default. That is a presentation problem, and presentation problems are the right kind to have here.

### 9.4 What kind of proposal

**`type: 'decision'`, `decidedBy: null`, `status: 'active'`, `confidence: 0.9`.**

Round 1 chose `claim` on inverted reasoning. `claim` **auto-accepts** (`policy.ts:131`, `autoAccept: true`) and `modelMintingGate` returns `null` for it (`authority.ts:263-266`) — it is one of the two types a machine *may* accept. And an accepted claim does not produce `✓` anyway: `README.md:153` — "an accepted claim keeps its truth status in a separate `verification` field, and that field is what the glyph renders" — it stays `~` until a second human verifies, gated further by `selfVerificationRefusal` (`authority.ts:762`).

`decision` inverts both: `autoAccept: false` (`policy.ts:128`) so it never auto-accepts at any confidence, and a human accepting a machine-staged decision is the product sentence.

**Not `commitment`:** `CommitmentPayload.owner` is a non-nullable `Id` (`objects.ts:28-33`) and an attribution field (`attribution.ts:62`), so `attributed_person_not_author` (`escalation.ts:804`) would force the bridge to name itself owner of a land that already happened. `decision.decidedBy` is `Id.nullable().default(null)` (`objects.ts:22`), and null is honest — no person decided this, the gate did. It also routes correctly: `attention.ts:184` — "nobody is named on this decision, so any member of the room can settle it."

**Confidence 0.9, and why not the band.** `acceptance.ts:866-880`, its own comment: "**The band: θ_min ≤ c < θ_auto** — One cell for every type, **decisions included**. Shown quietly... **never in Needs-you**", returning `visibility: 'quiet'` at `:876`. The only path to `needs_you` for a decision is `:907-915` (`!rule.autoAccept`), reachable at or above θ_auto, and `decision.autoAccept` is false so ≥θ_auto cannot auto-accept. Hence 0.9 against θ_auto 0.7. Confidence means transcription fidelity, not land quality; `gate.status` carries quality.

**This choice is correct and currently unreachable.** P1 (§12.1) intercepts before θ is consulted at all.

**The semantic strain, named.** A land receipt is not obviously "what the group decided". The honest reading is that the decision under certification is *"we accept this land into the record"*. Least-bad among five types, not natural, and §14 keeps it open.

### 9.5 Identity and idempotency

**`receipt_id` is occurrence-scoped, not content-scoped.** Round 2 was right that a pure content hash is content-identity: two genuinely distinct lands with byte-identical envelopes collapse into one. That is reachable — a no-commit land (rejected or forced, the `forcedWithoutProof` class) has no SHA to distinguish it, and two on the same branch in the same millisecond produce the same bytes.

So the envelope carries an `occurrence` ordinal, monotonic per `stateDir`, **assigned once when the outbox record is written** and never recomputed. `receipt_id = sha256(canonical_json(envelope_including_occurrence, excluding receipt_id))`. Re-delivery of the same occurrence is byte-identical and collapses (the property the outbox needs); two distinct lands never collapse (the property round 2 found missing).

Round 1's derivation from `(repo, branch, commit ?? "", at)` was justified by citing `write.ts:39-43`, and **that citation was false**: `landReceiptFilename` builds `${branch}-${at}-${uniq}` where `uniq` falls back to `Math.random()` (`:41`), and `writeLandReceipt:156` passes `receipt.commit` as the token — so glance itself reaches for randomness in exactly the no-commit case.

**`proposal.id` is tenant-scoped.** Round 2 found `uuidv5(ns, receipt_id)` unscoped against a globally-unique PK (`proposals.id`, `schema.ts:1098`) — two tenants producing identical envelopes would collide across the tenancy boundary. So `proposal.id = uuidv5(bridge_namespace, principal_user_id + ':' + room_id + ':' + receipt_id)`. Deterministic, which is what makes the fold-level duplicate check work (`interpret.ts:394-412`), and scoped, which is what keeps it from being a cross-tenant channel.

**Two layers**, mirroring `interpret.ts`: `command_receipts` at the door (`schema.ts:926-967`, key `:945`; the agent principal satisfies `:958-959` where a `system` actor would not), `commandName='bridge_land_receipt'`, `idempotencyKey=receipt_id`; and the fold-state check before appending.

**The fingerprint domain is the full envelope.** `payloadFingerprint = sha256(canonical_json(envelope))`, not `semanticCommandFingerprint`'s ids-only shape (`commands.ts:160-164`) — under which a replay with a flipped `gate.status` would match and return the *original* success, silently swallowing the correction. A genuine retry matches and replays; a changed envelope mismatches and is refused as a conflict, which is loud and correct.

### 9.6 Field map, message id, build order

| source | destination | anchor |
|---|---|---|
| prose + fenced envelope | `messages.body` | `schema.ts:1017` |
| bridge principal | `messages.authorId` | `:1016` |
| the minted `messageId` | `proposal_sources.messageId` | `:1191` |
| resolved room (§9.2) | `proposal_sources.roomId`, `proposals.roomId` | `:1187`, `:1099` |
| — | `proposals.type='decision'` | `:1105` |
| statement, `decidedBy:null`, `status:'active'` | `proposals.payload` | `:1106`; `objects.ts:19-24` |
| `0.9` | `proposals.confidence` | `:1107` |
| `"glance/<harness>"` | `proposerKind='model'`, `proposerModel` | `:1108-1109` |
| from the append actor | `staged_by_kind`/`staged_by_id` | `:1130-1131` via `reduce.ts:567` |
| the prose sentence, verbatim | `proposals.quote` | `:1141` |
| `uuidv5(ns, principal:room:receipt_id)` | `proposals.id` | `:1098` |
| `receipt_id` / envelope hash | `command_receipts` key / fingerprint | `:935`, `:937` |

**The message id is minted by the bridge**, as the live path does (`commands.ts:885`, `messageId: randomUUID()`), and **the same value** goes into the proposal's `provenance.messageIds`. Round 1 leaned on the `stage_semantic_command` analogy, which is false: that command cites a message a person already posted, so it has an id to cite; the bridge creates both.

**Build order and `project` are load-bearing.** `builds` (`ledger.ts:368`) is ordered: `[0]` `message_posted` carrying the minted id, `[1]` `proposal_recorded` citing it, with `requireClean: true` (`:367`) and a `project` (`:369`) writing the `messages` row before the proposal's projection writes `proposal_sources`. Without the `project`, FK `proposal_sources_message_same_room_fk` (`schema.ts:1201`) has nothing to point at; without the order, `decideAcceptance` returns `missing_message_context` (`acceptance.ts:670`).

### 9.7 `at` is a glance-host clock read

`LandReceipt.at` is `Date.now()` on the glance host (`squad-manager.ts:4809`). glance *is* the source, so `validate.ts:38`'s rule is satisfied in letter. Costs: land order (`at`) and ledger order (`room_seq`) diverge after any catch-up; a skewed host sorts wrongly and nothing detects it. Since §9.5 moved identity off the clock, this is a display defect rather than a correctness one.

---

## 10. Failure honesty

**10.1 — Unauthorized delivery.** Refused per §6.4. Nothing staged, appended, or posted.

**10.2 — Malformed envelope.** Refused against a strict schema (`z.strictObject`, as `validate.ts:33` uses — an unknown key is an error), *after* authentication, so a malformed delivery from a valid principal is distinguishable from an anonymous one. No coercion: a missing `gate.status` does not default to `green`, a missing `validation` does not become `skipped`, a missing `precision` does not become `n:0`.

**10.3 — Bridge down.** The land completes. `squad-manager.ts:4743-4747` already makes receipt emission best-effort. The ledger goes **behind**, never wrong — and behind must be visible, per glance's own precedent at `write.ts:164-175` (a persistent index-append failure "would otherwise under-report the gate's evidence with no signal at all"). An unexported count and age must surface. **A silent backlog is this design's most exposed failure mode.**

**10.4 — Atrium refuses the append.** The bridge uses `appendBatch(requireClean: true)` (`ledger.ts:367`), which **refuses the whole causal unit** and throws — neither message nor proposal commits, and the delivery is retried. This differs from `append`, which does not throw for `applied_with_issue` (`interpret.ts:483-496`); round 1 specified `appendBatch` in one place and `append`'s discipline in another, and the batch's model is operative.

**10.5 — The crash window, and the outbox — solved.** Round 2 found that `void this.emitLandReceipt(...)` (`squad-manager.ts:4747`) is fire-and-forget **after** the land returns, so a crash between the merge and the outbox write loses the receipt permanently. An outbox written inside `emitLandReceipt` inherits that window.

Two changes, both glance-side:

1. **The outbox append moves into the land's own durable section**, before `landInner` returns — beside the land ledger write, not in the post-hoc best-effort block. It is a local append of an already-computed envelope, so it does not call git, `gh`, or the network, and it does not reintroduce the latency the fire-and-forget posture exists to avoid. It must not *gate* the land (a failed append warns), but it must *happen before the land returns*, which is a different property from the one `:4743-4746` currently guarantees.
2. **A restart reconciler**, because (1) narrows the window and cannot close it: any local write can be lost to a crash after the merge is durable in git. On startup the emitter compares the land ledger against the outbox and re-derives envelopes for lands with no outbox record. This is the same absence-detecting posture as the index-append warning, applied to the residue.

Why the outbox must exist at all: `index.jsonl` cannot reconstruct an envelope — `landReceiptIndexRow` (`write.ts:59-83`) drops `message`, `cost`, `insertions`/`deletions`, `rollbackPoint`, `gate.command`, `gate.newRegressions` and `gate.detail`. The HTML is a render. `TraceExportQueue` (`trace-exporter.ts:178`) is in-memory and lossy across a restart.

Catch-up is **not** ordered; `room_seq` records arrival, not land order (§9.7).

**10.6 — A human rejects.** `proposals.status` → `'rejected'` with `rejectedReason` (`schema.ts:1142`, `:1145`). Nothing on the glance side changes; the land happened. Not retried, not re-staged, not escalated, not an error.

**The bridge cannot withdraw its own reading.** `actorMatchesProposer` (`authority.ts:401-405`) returns `false` for an agent actor, and both the rejection binding (`reduce.ts:599`) and supersession binding (`:645`) gate on it. Only a human can withdraw. A corrected land is a **new** receipt with a new occurrence and a new `~`; the stale one stays until a person rejects it.

**10.7 — A receipt claims a land that did not happen.** Nothing verifies glance's claim against the repository. `0.9` is transcription fidelity, not truth. What holds is that it stays `~`: `authority.ts:253` plus `reduce.ts:722` refuse any machine acceptance of a decision.

**10.8 — Membership or credential lost mid-flight.** `authorize` runs inside the append transaction (`ledger.ts:340`) and re-reads both (§6.4); the DB refuses independently (`schema.ts:202-208`). Fails closed into the 10.5 backlog. No anonymous fallback, no `system` actor, no default room.

**10.9 — The reviewer ledger could not be read.** Carried through, never flattened: `unreadable` (`reviewer-weights.ts:248-253`) is distinct from absent, `corrupt` (`:241-247`) from empty. "reviewed by codex (0 findings)" when the ledger was unreadable is the defect class the stamp's own notes name.

---

## 11. What this inherits — named, not absorbed

`ARCHITECTURE.md`'s staged plan (`:252-261`), quoted:

> **`:255`** — "2. **Machine-certification alignment:** decide and migrate model claim/open-question auto-acceptance so code and the chosen invariant agree."
> **`:256`** — "3. **Human authority completion:** specify and enforce which human may certify third-party claims, commitments, assignments, and grant agents."
> **`:261`** — "Each slice has an observable boundary and can ship or be rejected independently. No later slice is smuggled into the typed-reference schema."

**Slice 2** is subsumed by P3 (§12.2) — the same migration, reached from a different direction.

**Slice 3 is an inherited gap this bridge widens.** `ARCHITECTURE.md:234` asks "Which human may certify a third-party claim, commitment, or assignment? This must resolve current 'any human' gaps rather than inherit them." Today any room member may accept a bridge decision: `selfStagedReadingRefusal`'s guard (`authority.ts:537`, `:546`) returns null when the stager is not the accepting human, and the stager is the agent principal. So anyone may `✓` a land they did not review. The bridge does not create the gap; it makes it load-bearing, because a land receipt is exactly what a passer-by clears to empty a Needs-you badge.

**Both are named preconditions for T-FINAL (#389)**, not items absorbed here. Per `:261`, no migration for either is proposed in this document.

---

## 12. Preconditions atrium must build before this bridge is sound

**Two** preconditions, P1 and P3. Each is forced by code quoted below, each blocks the automatic `~ → ✓` loop, and **neither is solvable on the glance or bridge side without defeating the property the code exists to protect.** §4 is what exists until they are funded.

Round 3 named a third — attention persistence — which round 4's code-verified review demoted to bridge-side work; it now lives at §7.3, not here. The numbering below keeps P1 and P3 by name to match the review record; there is no P2 in the atrium-precondition set.

### §12.1 — P1 — A certification path for readings whose provenance is not room conversation

**The blocker.** The bridge's receipt message is necessarily the newest message in the room, and the proposal cites it. `escalation.ts:2107-2112`:

```ts
const readSomethingUnchosenAfterTheSentence = messages
  .slice(lastCited + 1)
  .some((message) => !cited.has(message.id));
if (!readSomethingUnchosenAfterTheSentence) {
  return unscanned('window_ends_at_the_citations');
}
```

`laterRevision`'s `unscanned` answers are all `refer` (`escalation.ts:1058`), and a referring problem returns `pending` / **`quiet`** / `receipt_not_certifiable` at `acceptance.ts:758-768` — **before** θ, the type table, or `never_auto_accepts` are consulted at all. The refusal text (`escalation.ts:1827`) states the reasoning: "the window carries nothing after the newest message this proposal cites... whether a later message takes it back was never established."

So under the flow §9 advertises, the `~` lands `quiet` and never reaches Needs-you. This is the same failure class as round 1's `1.0` and round 1's remedy band — reached a third independent way.

**Why this is not patchable from the bridge side.** One uncited later message satisfies the predicate, so the bridge could post a second "sealer" message after the receipt. **That is dishonest and this document refuses it.** The gate asks whether the *room* contradicted the sentence; answering it with a second message in the machine's own voice is the §9.3 tautology one level up — manufacturing the corroboration the check exists to look for. A gate satisfied by its subject is not a gate.

Nor is waiting for organic room traffic acceptable: it makes a receipt's visibility depend on unrelated conversation, and in a quiet room it never surfaces at all.

**Why atrium's own history says this is the right place to fix it.** `policy.ts:618-627` records this exact deadlock, from the other side:

> "`drizzle/0006` defined the receipt window as *exactly the cited messages*; `laterRevision` below refuses any window that ends at the citations, because a window that stops there carries no evidence about what came after the quoted sentence. So the SQL could not produce a window the TypeScript would certify, and **every non-human acceptance was refused**."

That was resolved by widening the window to carry the cited messages plus the room's next `maxLaterMessagesCarried` (`policy.ts:660`, `:673` — 201). A bridge receipt has no "next": it *is* the end of the room. The window is complete and empty, and the gate correctly reports that nothing corroborates the sentence — because nothing does, and nothing ever will, because the sentence was not read out of the room.

**What atrium must decide.** The engine has one category of machine reading — *extracted from conversation, certifiable to the degree conversation corroborates it*. A land receipt is a second category — *reported by an identified machine about the world outside the room*, whose corroboration is the reporter's identity and the artifacts it links, not the surrounding messages. Atrium must decide whether that category exists and what certifies it. Plausible shapes, none authorized here: a proposer variant whose acceptance path does not run `laterRevision`; or an explicit "reported, not extracted" provenance kind that routes past the receipt gates to `needs_you` on the strength of the authenticated principal.

**This is the Phase-5 decision input.** The question is not "how do we get glance receipts into the ledger" — it is "does the ledger admit machine testimony about the outside world, and on what warrant."

### §12.2 — P3 — A structural interpretation exclusion for machine-authored messages

**The blocker.** `claimWindow` (`interpret.ts:648-673`) drains:

```sql
FROM messages m LEFT JOIN LATERAL (...) i ON TRUE
WHERE m.room_id = ${roomId}::uuid
  AND (i.id IS NULL OR i.status = 'pending')
ORDER BY m.seq ASC LIMIT ${config.maxWindowMessages}
```

**No author filter and no author-kind filter exist.** And `projections.ts:212` calls `onMessagePosted` unconditionally for every `message_posted` event, in the same transaction, which is what enqueues the pass.

So the interpreter reads the bridge's receipt messages and stages *its own* readings of them — and `claim` and `open_question` auto-accept at θ (`policy.ts:130-131`; `interpret.ts:468-480`). Accepted ledger state derived from a machine's message with no human in the path, arriving by a route the bridge does not control and cannot close from its own side, because **there is no filter to build the exclusion on.** Confirmed at HEAD: `claimWindow`'s `WHERE` is `room_id` plus the pending predicate and nothing else (`interpret.ts:648-673`), and `messages` has no author-kind column at all — only `authorId` (`schema.ts:1016`) — so an exclusion cannot be expressed without a change to atrium.

**What atrium must build**, one of two:

1. An author-kind filter in `claimWindow` — join `users` and exclude `principal_kind = 'agent'`. Narrow and structural, and it genuinely needs the join because `messages` carries no kind of its own. Its cost is a product decision well beyond this bridge: agents become permanently unreadable to interpretation.
2. `ARCHITECTURE.md:255`'s slice 2 in full — machine output never auto-accepts — after which the interpreter reading a bridge message produces a `~` a human must accept, which is noisy rather than unsound.

A third candidate round 3 floated — a receipts room with no interpreter installed — is **verified absent and dropped.** There is no per-room interpreter installation in the tree (no `installInterpreter`, no per-room registry), and `ARCHITECTURE.md:40` says the opposite of what round 3 read into it: "processes may pool work for many rooms; 'one worker process per room' is not an identity or consistency requirement" — a pooled shared service, not a per-room opt-out. So P3 reduces to the two real migrations above, which strengthens rather than weakens it.

**This is the same migration `ARCHITECTURE.md:213` already named** as a prerequisite "before agents exist". It is unshipped.

---

## 13. What this document does NOT authorize

1. **No implementation.** No migration, no code, no endpoint. The sketches in §6, §9 and §12 are prose about shapes.
2. **No atrium writes.** `/home/lars/atrium` was read only.
3. **No new trust surface built on §6's say-so.** §6 specifies a contract and its structural properties; building the credential table, the verifier, the delivery consumer, or the `mintAgentSession` refusal is an atrium decision. §6.5 says so.
4. **No relaxation of `commands.ts:1516`.** The socket path continues to refuse an agent staging a proposal.
5. **No widening of `Proposer`.** `proposal.ts:19-21` stands; `common.ts:308-312`'s two questions remain unanswered.
6. **No change to `claimWindow`, `laterRevision`, or the acceptance engine.** §12 names two preconditions and authorizes neither of them. Choosing among P1's and P3's options is atrium's.
7. **No session for the bridge principal, ever.** §8.1's new row. `mintAgentSession` must refuse it.
8. **No execution runtime.** `init.md:250-264`'s "do not initially build" list is untouched. This is Phase 4 precisely because it needs no repository access.
9. **No certification authority for any machine.**
10. **No auto-acceptance.** Structurally impossible for `decision`, and not sought.
11. **No tenant gate contract.** G3 owns it; §8 assumes a human-provisioned one-to-one mapping.
12. **No agent grants, capability records, assignments, or execution receipts** (`ARCHITECTURE.md:82`, `:209`).
13. **No mention or attention-routing behaviour.** The receipt message mentions nobody.
14. **No claim that a `~` receipt is evidence.** Counting unaccepted receipts as landed-work-with-oversight is the category error the glyphs exist to prevent (`README.md:172-179`).
15. **No shipping of §4 as though it were the destination.** §4.3 states its three costs.
16. **No revision of `ARCHITECTURE.md`.** §2.1 reports it stale; correcting it is its authors' call.

---

## 14. Unresolved

- **Which P1 shape** — a proposer variant, or a "reported, not extracted" provenance kind (§12.1).
- **Which P3 option** — author-kind filter, or full slice 2 (§12.2). The per-room-interpreter third option is verified absent and dropped.
- **Renderer fidelity** — nothing enforces that the prose sentence faithfully transcribes the envelope beside it. §9.3 makes the discrepancy *discoverable* (both are in the same message body) but not *detected*. Property-testing the render as a pure function of the envelope is a mitigation, not a guarantee.
- **Whether a land receipt should be a `decision`** (§9.4) — least-bad among five, not natural.
- **Message volume** — one message per land floods a busy room; a materiality bar makes the ledger silently partial, batching couples unrelated lands into one transaction.
- **Independent verification** (§10.7) — would need repository access atrium deliberately does not have (`init.md:515`).
- **Who may certify** (§11, `ARCHITECTURE.md:234`) — inherited unresolved, made load-bearing here.
- **Backlog visibility** (§10.3) — what surface shows "N unexported for M hours", and to whom.
- **Clock skew** (§9.7) — undetected, display-only.

---

## 15. What would falsify this

1. **Atrium has a durable agent principal** — `schema.ts:239`, `:289`, `:219`; `common.ts:314-319`; `session.ts:50`. *Confirmed rounds 1–2.*
2. **`reduce.ts:567` derives `stagedBy` from the trusted append actor.** If it were caller-supplied, §8.2's honesty argument collapses. *Confirmed rounds 1–2.*
3. **`proposal_sources` structurally requires an in-room `messages` row** — `schema.ts:1201-1206`. *Confirmed rounds 1–2.*
4. **A window that ends at its citations is refused** — `escalation.ts:2107-2112` → `:1058` (`refer`) → `acceptance.ts:758-768` (`quiet`). If a bridge receipt could reach `needs_you` while citing only its own newest message, **P1 dissolves and §9 works as written.**
5. **`reconcileStoredAttention` is exported and self-contained** — `attention-projection.ts:36-102`, signature `{db, state, roomId, messages, now}`; the caller supplies `state` (`interpret.ts:552`). This is what makes attention persistence a bridge-worker step (§7.3) rather than an atrium precondition. If it secretly depended on interpretation-worker-only context, it would revert to a precondition. *Confirmed round 4.*
6. **`claimWindow` has no author filter and `messages` has no author-kind column** — `interpret.ts:648-673`, `schema.ts:1016`. If either existed, P3 dissolves. *Confirmed round 4.*
7. **`mintAgentSession` issues a real Better Auth session** — `principal.ts:197-227`, `:218`. If an agent session were already capability-restricted, §6 is over-built.
8. **`DecisionPayload` strips unknown keys** — `objects.ts:19-24`, a plain `z.object` with no `passthrough`. If payloads survived intact, §9.3 could put the envelope there instead of the message body.
9. **`decision` never auto-accepts and reaches `needs_you` only at ≥θ_auto** — `policy.ts:128`; `acceptance.ts:871-879`, `:907-915`; `attention.ts:827`.

# RED TEAM A — systems correctness findings on the-room DESIGN-DRAFT (Round 2)

All load-bearing claims checked against source. Most severe first.

## CRITICAL

### C1. The ChannelStore-on-JsonlLog decision destroys irreplaceable human messages — "no new durability promise invented" is a category error

**EVIDENCE:** `src/jsonl-log.ts` is explicit about its contract: rotation renames to `<path>.1` **clobbering any previous `.1`** — "NOT a durable forensic record beyond that... one generation deep" (jsonl-log.ts:13-18, 109-120). Default cap 2MB, ring 500. Worse for restart: `hydrate()` seeds the ring from the **live file only**, never `.1` (jsonl-log.ts:124-142) — so a daemon restart just after a rotation shows a near-empty channel even though history exists on disk. Worse still for crash: `append()` is fire-and-forget through a promise chain nothing flushes on shutdown (jsonl-log.ts:51-58, 92-107) — a human's message can be echoed to every peer over WS, then silently vanish on restart. Every existing JsonlLog instance (transitions, push-taps, friction, compaction) holds **derived, re-derivable telemetry**. Channel messages are the first **primary, human-authored, irreplaceable** data proposed for this substrate. An org's entire chat history capped at ~4MB across two generations, with silent permanent destruction beyond that, is a new use the discipline was never designed for. The draft's own Uncertainties flags the sizing problem but Decision 2 ships anyway.

**SUGGESTION:** Split the durability classes. Cards/projections are re-derivable — lossy is fine. Human messages are not. In DB mode the per-org store seam already persists primary rows: `applyCommand` writes audit via `this.store.appendAudit` — "DB mode persists to the per-org audit table; FileStore is a no-op" (src/squad-manager.ts:6971-6981). Channel entries as store rows in DB mode (JsonlLog ring as hot tail/cache only), JSONL with rotation disabled or multi-generation in file mode, plus an awaited flush on graceful shutdown. This is *less* new machinery than tuning JsonlLog for a use it disclaims.

### C2. Multiplayer has no identity substrate on the transport it needs — WS actors are per-role synthetics, and file mode has no per-human identity at all

**EVIDENCE:** `SocketData` carries only `{id: number, role, orgId, bootstrapAdmin}` — no user id (src/server.ts:368-378). `actorForSocket` mints `{ id: "web:" + ws.data.role, ... }` in DB mode (src/server.ts:1162-1163): **every admin in an org is the same actor `web:admin`** on the WS path. Real per-human identity (`db:${session.user.id}`, displayName) exists only on the HTTP path with a resolved session (src/server.ts:1755-1760). In file mode, all paths collapse to `actorForRole(role)` — role-synthetic, no humans distinguishable. Human↔human messages (who said this?), presence (who is online?), membership (who is in this channel?) all require stable per-human identity; the socket layer — the natural transport for chat and only possible source for presence — doesn't have it. The problem is one level below RBAC: attribution.

**SUGGESTION:** Design decision required: (a) resolve the session at WS upgrade (the cookie already rides the upgrade headers — comment at src/server.ts:1354) and stamp `userId`/`displayName` into SocketData; presence derives from per-user socket sets; (b) state explicitly what file mode gets — single shared identity ("the operator") with multiplayer channels DB-mode-only is defensible, but must be said.

### C3. The flagship door is dead on arrival for its most common click — IntervenceView requires a live roster agent, has no route, and every re-query endpoint is resident-only

**EVIDENCE:** Slice-1 proof is gate-verdict card → IntervenceView, clicked "days later" per Decision 3. But: `App.tsx:58` resolves the target via `agents.find((a) => a.id === interveneAgentId)` against the **live roster**; `IntervenceView.tsx:312-316` renders "No agent selected to step into." when that fails; `openIntervene` (webapp/src/context/TaskContext.tsx:297-302) subscribes to a live transcript. A gate verdict matters most at/after land — exactly when the unit is removed (roster drop) or, DB mode, its whole manager evicted after 10min idle (src/manager-registry.ts:150-156). Re-query surface is resident-only: `GET /api/agents/:id/diff` 404s without a live DTO (src/server.ts:2958-2962), `GET /api/agents/:id/transcript` serves the live buffer with no fetch-by-entryId (src/server.ts:2932-2941), `GET /api/agents/:id` dead-placeholder or 404 (src/server.ts:2927-2931). **No route to deep-link**: the SPA has no router; the only hash-deep-linkable surface is Design Review (`#/review/:taskId`, TaskContext.tsx:303-306). IntervenceView is reachable only via in-memory context state — the door doesn't survive a reload, let alone a shared URL. The demo works in scratch-daemon (click seconds after emission, agent resident); the real thing dead-ends.

**SUGGESTION:** (a) swap flagship to **needs-you (pending request) → IntervenceView** — target live-by-construction; gate-verdict ships as a doorless proof card (face carries verdict/agreement/confidence pinned at emission) until a receipt-backed surface exists; or (b) keep gate-verdict but build the missing substrate: hash route for IntervenceView, disk-backed read endpoint over done-proof/receipts/ValidationRecord for departed units, explicit "unit landed/gone — here's the proof record" post-mortem mode. (a) is slice-1-sized; (b) is not.

## SIGNIFICANT

### S1. Channel membership ("who can see") is unenforceable by the chosen fan-out — broadcastTo is an org bucket, not a channel bucket

**EVIDENCE:** Step 1 promises a membership model. `broadcastTo` serializes once and delivers to **every socket in the org's bucket** (src/server.ts:3239-3253). No per-channel filtering primitive exists; any non-public channel's entries hit every org member's WS. File mode worse: `broadcast` is global (src/server.ts:3223-3235). So slice 1 either has no real membership (org-public, membership is decoration) or needs a new per-channel socket-filter layer — a brand-new leak class, unbudgeted.

**SUGGESTION:** Org-public channels in slice 1, delete the membership model from step 1. Per-channel visibility ships together with its own fan-out filter and tests. Don't ship a membership table whose semantics the transport ignores.

### S2. The ack/mention plan contradicts steer's deliberate clientTurnId omission — and the fix is webapp-side work classified as "daemon, invisible"

**EVIDENCE:** Step 3 calls ack/nack "(daemon, invisible)"; step 6 gates mention-steer on it. But `steerCommand` **deliberately carries no clientTurnId** (documented decision, webapp/src/lib/agent-control.ts:131-139) — a mention-steer emits nothing a `{type:"command-ack", clientTurnId, ...}` event could correlate with; the silent drop (`if (!rec) return;`, src/squad-manager.ts:7019-7020) stays silent for exactly the path claimed fixed. `clientTurnId` is also overloaded: `answerCommand` sets `clientTurnId: requestId` (agent-control.ts:127-129), daemon echoes it onto the appended user entry for optimistic reconciliation (src/squad-manager.ts:7061, src/types.ts:194-195). Daemon-side workable (nothing keys pending-resolution off it — verified), but concern-04 dedupe must not collide with requestId-valued turn ids.

**SUGGESTION:** State: steerCommand (and channel mention path) mints a fresh clientTurnId, reversing the documented omission; dedupe scope accommodates requestId-valued ids from the answer path. Reclassify part of step 3 as webapp work.

### S3. Nothing stops a client forging a proof card — "cards are proofs" needs a server-side authorship rule the draft never states

**EVIDENCE:** Cards are channel entries with `event: {kind, payload}`. Humans post channel entries. The draft never says event-kind-bearing entries are **manager-authored only** — if the channel-post command accepts the envelope, any operator-tier client can post `event.kind: "gate-verdict"` with a fabricated face, rendering identically to a real proof for every other human. `applyCommand` RBAC gates command *types* by role (src/squad-manager.ts:6961-6971), not payload fields. Existing fencing (fenceUntrusted + redact) defends **model prompts**; a card rendered to humans is a different trust surface with no defense specified.

**SUGGESTION:** Client-authored channel posts carry text only; the `event` field is stripped/rejected at the channel append chokepoint; projection (manager-authored) is the sole writer of event-bearing entries. Plus a test alongside the no-running-status test.

### S4. Multiplayer concurrent steer is unarbitrated and invisible — and the mention path itself violates the "complete projection" invariant

**EVIDENCE:** No per-unit in-flight guard; a prompt to a working agent is a straight-through mid-turn steer (src/squad-manager.ts:7022-7061). Shared channels make concurrent steer the normal case — two humans @mention the same agent within a turn; both injections interleave into one driver turn, no ordering, no conflict signal, no mutual awareness. Compounding: a steer appends to the **unit's** transcript (:7061), not the channel — human B watches behavior change with no visible cause in the room. The mention path acts on a unit silently from every other member's perspective. Residency races: DB-mode evict/lazily-recreate race documented (src/squad-manager.ts:7005-7012); client-side residency check is stale by applyCommand time (ack/nack degrades to visible nack — acceptable once S2 fixed).

**SUGGESTION:** Every mention-steer is *also* appended to the channel as an entry (attribution + visibility — what makes the room the complete projection); pick a concurrency stance for slice 1 — even "last-write-wins, both steers visible in-channel" is fine if stated; silence is not.

### S5. The unit→channel projection mapping is undefined — and most units have no channel, so "layer 1 is the complete projection" is false by construction

**EVIDENCE:** Step 4: events "projected into the relevant channel(s)" — "relevant" undefined. Channels are not bound to units. Units spawned from CLI, TUI, factory, automation loops — the majority today — belong to no channel. Their gate/land events project nowhere (invariant broken: system acts silently) or everything dumps into one default channel (firehose burying human messages). The recipient-set problem that killed the outbox, one layer up, unaddressed.

**SUGGESTION:** (a) a unit records its originating channel at spawn/mention time (`channelId` on CreateAgentOptions/persisted record), and (b) a designated org default channel (e.g. #fleet) receives projections for unbound units, with card-kind filtering. Both cheap; neither in the draft.

### S6. "The rendering grammar already exists" is overclaimed for the flagship kind — GateWidget is a live answer form, not a verdict renderer, and no structured gate-verdict emission exists to project

**EVIDENCE:** `GateWidget` binds `{request: PendingRequest, onAnswer: (value) => void}` — a **live pending input request with an answer affordance** (webapp/src/components/chat/GateWidget.tsx:7-13), not a historical verdict; rendering it in a shared channel offers every org member an answer box into someone else's agent. No gate-verdict display component exists; validation/confidence render off the live DTO in AgentMetaBar. Daemon-side, the "gate" summary is a free-text system append at the *commission* gate (src/squad-manager.ts:6873); `ValidationRecord` (src/types.ts:448-467) is the *validator* verdict read before land; proofGate/verify is a third thing. Step 2 assumes an emission that must be created, at a gate never named. Settles the designer's flagged uncertainty in the bad direction: step 5 is component construction plus a new daemon emit, not thin wiring.

**SUGGESTION:** Name the gate (the verify-before-land ValidationRecord matches "proofs from the trust layer"), specify the structured emit site, budget a new GateVerdictCard component. Do not reuse GateWidget.

### S7. Pointer-cards dangle even while the unit is alive — MAX_TRANSCRIPT trims entryId targets and no by-entry endpoint exists

**EVIDENCE:** Transcripts shift-trim at 800 entries (src/squad-manager.ts:247, 10808); `GET /api/agents/:id/transcript` returns the live buffer whole-or-since-seq, no fetch-by-entryId (src/server.ts:2932-2941). `id`/`seq` optional on older persisted entries (src/types.ts:187-190). `{unitId, entryId}` is dereferenceable only within an unacknowledged window.

**SUGGESTION:** Demote `entryId` to an optional hint the door may fail to resolve (render from `face`, fall back to "entry no longer available"), or don't carry it in slice 1. Never build door behavior requiring entry deref.

## MINOR

### M1. No channel cursor/resume protocol
Transcript polling has seq + `?since=`; channel entries reuse the envelope but JsonlLog assigns no seq (`idOf` optional/unused, src/jsonl-log.ts:29). WS drop → reconnect has no defined re-sync. Specify per-channel monotonic seq + since-param now.

### M2. Kinds-without-readers re-imports the killed registry pattern
Step 2 defines seven kinds "not all wired to a door yet." Binding concern-01 verdict: ≥1 reader **per kind**. Define only kinds shipping with a reader in the same slice; rest are names-reserved in a comment, not defined payload shapes.

### M3. The channel append path needs its own redact chokepoint, and the fencing helper isn't shareable yet
All transcript ingress redacts via `SquadManager.append` (src/squad-manager.ts:10791-10812). ChannelStore is a *new* append point; human messages need redaction too (humans paste secrets). `neutralizeDelimiters` is module-private in digest.ts (:167); public composed helper is `fenceUntrusted` — but fencing defends model prompts, while channel rendering to humans is the S3 surface. Step 1's tests include "channel append redacts".

## SIMPLER ALTERNATIVES MISSED

1. **Store rows, not a new log discipline** (fixes C1): the per-org store seam already persists primary rows in DB mode (audit-table pattern, src/squad-manager.ts:6971-6981; storage seam src/dal/storage.ts). Channel entries as store rows + ring cache is less machinery than JsonlLog-plus-membership-plus-rotation-tuning; durability for the only irreplaceable data falls out free.
2. **Needs-you as the slice-1 door** (fixes C3): live-by-construction target, identical card→door convention; gate-verdict ships as doorless proof card whose face *is* the proof.
3. **Org-public channels in slice 1** (fixes S1): membership is the single biggest rebuild-Slack invitation; deleting it removes a fan-out rewrite and an unresolved RBAC composition problem.

## VERDICT

The two-layer grammar and webapp-leads call survive review. The slice as specified does not: its flagship demo path (C3) dead-ends in production conditions, its chat substrate loses human messages by design (C1), and its multiplayer premise has no identity substrate on the wire (C2). All three are design-level decisions, fixable before any code — but each currently points implementation at the wrong target.

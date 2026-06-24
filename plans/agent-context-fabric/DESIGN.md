# Design: Agent-Context-Fabric (north-star Pillar 1)

> Source: north-star **Pillar 1** (`plans/meta-harness/NORTH-STAR.md`) — agents communicate in a hierarchy,
> introspect a shared context, and that introspection surfaces patterns + product-enhancement opportunities
> the harness feeds back into itself. Decomposition seeded by the verified EXPLORE landscape
> (`'/home/lars/.omp/agent/sessions/-sui-omp-squad/2026-06-24T05-28-41-218Z_019ef81a-1c02-7000-ac74-2bea0dd1e082/local/g1-explore-landscape.md'`), then reshaped by the adversarial pass below.
>
> Hardened by an adversarial design pass (#1 target: comms SAFETY). Findings are folded in; several reshaped
> the design — the concern order was inverted (scope spine + pull fabric BEFORE push messaging), agent-origin
> actors became an explicit single-capability allowlist (never a role in the viewer/operator/admin chain),
> peer messages became advisory-only (can inform, can NEVER steer), and the "context-heat graph" was found to
> be a **phantom seam** (corrected to a cross-run `receipts` aggregation).

## Problem

The introspection engine is half-built and the communication half does not exist:

- **`scout.ts`** harvests each working agent's *new reasoning* into latent backlog items, deduped by
  title-token Jaccard, filed to Plane with `[scout]` + a `do-not-auto-land` triage marker. It files **per-agent
  ITEMS**, never cross-agent/cross-run **PATTERNS**.
- **`observer.ts`** audits operational state (red gate, stale branches, land failures) → Plane, with a clean
  dedup/cap/triage-marker safety model.
- **`digest.ts`/`summarizer.ts`** distil per-agent cold-start resume context (zero-token); **`receipts.ts`**
  holds per-run `filesTouched`/tokens/cost JSONL; **`leases.ts`** holds who-is-editing-what.
- **`ClientCommand`** (`types.ts:499-509`) has prompt/answer/interrupt/kill/restart/remove/create/snapshot/
  subscribe/commission — **no peer-message variant**. Agents are steered only by operators.
- **`parentId`/`featureId`/`owns`** are structural metadata only — there is no model of *who may message or
  introspect whom*.

So: agents are islands. The three verified gaps are (1) no agent→agent message command, (2) no hierarchy
permission model, (3) scout files items not patterns.

### Verified-source corrections to the landscape (re-read before finalizing — per the assignment)

1. **The "context-heat graph" is a phantom seam.** The landscape (and NORTH-STAR §"What already exists") name
   `dal/context.ts` as a cross-run heat store with `OMP_SQUAD_HEAT_HALFLIFE_MS` decay. **It does not exist.**
   `src/dal/context.ts` is the org-scoping `withOrg` RLS helper (MT-SaaS P0). There is no `src/context/`
   directory, no `heat`/`HALFLIFE` symbol anywhere in `src/`, and `OMP_SQUAD_HEAT_HALFLIFE_MS` is a
   **commented-out** line in `.env.example:84`. The real cross-run "what ran hot / who touched Y" source is
   **`receipts.ts`** (`RunReceipt.filesTouched`, one JSONL line per run) — whose own ceiling comment states it
   has **"no cross-run aggregate queries … upgrade path: move to sqlite only if those aggregate queries become a
   real need."** C2 fills exactly that documented upgrade path with a zero-cost in-memory aggregation — no new
   store, no phantom dependency. (Confirmed with `PlanFleetObservability`: their observability plan derives
   "hot areas" from `receipts.filesTouched` identically; neither plan assumes a heat store.)
2. **Agents do not issue `ClientCommand`s — surfaces do.** The agent→manager origination seam is the
   **host-tool** path: omp emits `host_tool_call` frames (`rpc-agent.ts:275-276`), the manager handles them in
   `onHostTool` (`squad-manager.ts:1711`) and replies via `respondHostTool` (`rpc-agent.ts:377-379`). C3
   originates a peer message by intercepting a **reserved tool name** in `onHostTool`.
3. **`Actor` has no "agent" origin today.** `Actor.origin` is `"local" | "remote"` (`types.ts`), role tiers
   are `viewer ⊂ operator ⊂ admin`. There is no agent identity in the authz model — `authz.ts` explicitly
   **DEFERS** "agent-API-key permissions (agent:interact / agent:create scopes)". C1 adds exactly one agent
   capability (message), not the deferred scope system.

## Approach

Four ordered concerns. The linchpin decision (from the red team) is **safety ordering**: a permission spine
ships first, the read (pull) fabric second, the write (push) message primitive third on top of both, and the
pattern→opportunity loop last. This realizes the operator-delegated **pull-first** fork: pull is the
loop-free, injection-bounded way agents get peer context; push is a small, bounded, advisory escalation.

**C1 — Hierarchy + scope spine (the permission primitive).** Lands first; every cross-agent capability is
scoped by it from day one (no window where data escapes scope).
- Add `"agent"` to `Actor.origin` and a constructor for an agent-origin actor (`{ id: <agentId>, origin:
  "agent" }`) — identity comes from the authenticated sender, NEVER a payload field.
- Pure function `scopeFor(actor, roster): Set<agentId>` = the agents an actor may see/address: **self + same
  `featureId` peers + parent chain (`parentId`) + children**. Federated/remote agents are NEVER in scope (only
  presence/leases federate; cross-operator messaging is out of scope). Org isolation falls out for free — a
  `SquadManager` only holds its own org's roster (per `mt-isolation`).
- **The escalation guard** in `applyCommand`, BEFORE the role ladder: an `origin === "agent"` actor may issue
  **only** the message command (C3) and only to in-scope targets; every other command is denied + audited.
  Agent actors are NEVER assigned a role in the viewer/operator/admin chain.

**C2 — Introspection context fabric (PULL, read-only).** BLOCKED_BY C1 (scope).
- A typed, read-only query over **distilled facts with provenance** — never raw transcripts:
  - per-agent state from `AgentDTO` (doing/`activity`/`todo`/`owns`/`featureId`/`issue`),
  - the cold-start distillation from `digest.ts` (goal/summary/files/left-off),
  - cross-run **hot areas / who-touched-Y** from a zero-cost aggregation over `receipts/*.jsonl`
    (`RunReceipt.filesTouched`, recency-weighted) — the real replacement for the phantom heat graph,
  - the reasoning harvest (`scout` `[scout]`-tagged items),
  - current ownership from `leases.ts` (`leasesFor`).
- Each returned fact carries its source agent id + run id (provenance). Results are **scoped by C1**
  (`scopeFor`) and org (per-manager). Exposed as a manager method + a viewer-tier `GET /api/fabric` (server.ts
  route pattern, auth-gated like `/api/leases`).

**C3 — Inter-agent message primitive (PUSH, bounded + advisory).** BLOCKED_BY C1 (scope/escalation guard);
soft-after C2 (pull is the preferred path).
- New `ClientCommand` variant `{ type: "message"; to: string; text: string }` (no `from` — the sender is the
  authenticated actor, anti-spoof). Maps to `commandTier` = **operator** for human surfaces; agent-origin
  actors reach it via the C1 allowlist (NOT via a role).
- Origination seam: a reserved host tool (`squad_message`) intercepted in `onHostTool` → built into the
  command with an agent-origin actor → routed through `applyCommand` (authz + audit). A non-reserved host tool
  keeps its current human-gated behavior unchanged.
- **Delivery is advisory, never steering**: append fenced+redacted context to the target's transcript
  (`fenceUntrusted("peer message from <id>", redact(text))`, the exact guard digests use at
  `squad-manager.ts:1435`). It NEVER calls `prompt`/`abort`/`stop` and NEVER force-wakes a turn. An idle
  recipient sees it on its next natural turn; a stopped recipient → clean send failure. Steering stays
  operator-only.
- **Anti-abuse**: per-sender budget `OMP_SQUAD_PEERMSG_BUDGET` (reuse the `superviseBudget` Map pattern,
  `squad-manager.ts:1401-1404`), a message-size cap, and scope-bounded targets (C1). Advisory-only delivery
  means no automatic reply ⇒ no chatter loop.

**C4 — Pattern→opportunity loop.** BLOCKED_BY C2 (fabric aggregates); reuses Scout/Observer filing.
- A new `opportunity.ts` loop modeled exactly on `observer.ts` (NOT editing observer.ts): a **windowed**,
  zero-token clustering over open `[scout]`-tagged items + the C2 hot-areas aggregate. Cluster by the exported
  `scout` `jaccard`/`titleTokens` (no LLM per pair). A cluster with ≥`OMP_SQUAD_OPPORTUNITY_MIN` members across
  distinct runs/agents emits **ONE** `[opportunity]` Plane issue (deduped by a stable cluster fingerprint in
  `opportunity-seen.json`, mirroring `observer-seen.json`), capped by `OMP_SQUAD_OPPORTUNITY_MAX`, filed with
  the `do-not-auto-land` triage marker. At most ONE LLM call to *name* a NEW cluster (Scout-style one-shot),
  cached by fingerprint. Surfaced via a viewer-tier `GET /api/opportunities` panel (filtered `[opportunity]`
  issues).

## Key Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Concern order | scope (C1) → pull fabric (C2) → push message (C3) → loop (C4) | landscape order msg→hierarchy→fabric→loop | Safety: the scope spine must exist before any cross-agent exposure; pull is loop/injection-free so push can be a small advisory addition. Realizes the pull-first fork (A20). |
| Agent authz | `origin:"agent"` + explicit single-capability allowlist (message only), enforced pre-role-ladder | give agents an `operator` role to send messages | operator-tier also grants create/commission/prompt/interrupt — an agent could escalate (A1). Allowlist is the only escalation-safe shape; matches authz.ts's DEFERRED agent-scope note. |
| Message power | Advisory append only; never steer/kill; never auto-wake | deliver as `prompt()` so the recipient acts now | A `prompt` IS steering — an agent could drive/kill another via a crafted message (A2). Advisory-only makes steering inexpressible by agents; operators keep `prompt`/`interrupt`/`kill`. |
| Sender identity | From the authenticated actor; command carries only `to`+`text` | `from` in the payload | A payload `from` lets A impersonate the coordinator (A4). |
| Untrusted handling | `fenceUntrusted` + `redact` on delivery (digest.ts guard) | trust peer text | Cross-agent prompt injection + secret leakage (A3). Same guard the resume digest already relies on. |
| "Hot areas" source | Zero-cost aggregation over `receipts/*.jsonl` `filesTouched` | the `dal/context.ts` heat graph | The heat graph is a **phantom** (corrected above); receipts is the real source and its own deferred upgrade path. No new store (A17). |
| Opportunity dedup | Stable **cluster** fingerprint in `opportunity-seen.json` | per-item filing | The acceptance bar: ≥N runs ⇒ ONE opportunity, not N tickets (A10). Mirrors observer-seen.json. |
| Clustering cost | Windowed + zero-token Jaccard + ≤1 LLM naming per NEW cluster, capped | re-cluster all history each tick | Unbounded O(n²) + token burn (A9). Window + reuse scout's zero-token dedup bound it. |
| No new store / queue / dep | Fabric = query over existing JSONL/md/Plane/DTO; delivery = synchronous transcript append; C4 = one seen-map JSON | sqlite fabric, a message broker, an agent RBAC system | ponytail: extend seams, smallest diff (A17/A18/A19). |

## Risks (known ceilings — mark with `ponytail:` comments in code)

| Risk | Severity | Mitigation / ceiling |
|---|---|---|
| Fencing is advisory, not a hard sandbox — B's model may still be influenced by injected peer text | known ceiling | Same blast radius as any tool output B reads; B's own actions still pass B's approval/authz; advisory-only (no forced turn/tool-exec). Upgrade: a stricter peer-context content policy if abuse appears. |
| Advisory delivery to an idle agent is best-effort (seen on next turn; never if it never runs again) | known ceiling | Reliable path is the C2 pull fabric; guaranteed steer is the operator `prompt`. Upgrade: a per-target outbox if reliable async push is needed. |
| Per-sender budget resets per process lifetime (Map), like `superviseBudget` | known ceiling | Bounds runaway sends per run; a daemon-lifetime cap. Upgrade: a persisted/windowed budget if abuse spans restarts. |
| Coordinator broadcast to N children = N deliveries (N× token cost) | bounded | Each delivery counts against the per-sender budget; size-capped. |
| C4 LLM naming call cost | bounded | ≤1 per NEW cluster, cached by fingerprint, capped by `OMP_SQUAD_OPPORTUNITY_MAX`; the clustering itself is zero-token. |
| Org scoping relies on the per-org `SquadManager` (mt-isolation) holding only its org's roster | dependency | True today in DB mode; `scopeFor` adds no cross-org path. If a single manager ever spans orgs, `scopeFor` must also filter by `orgId` — noted as a `ponytail:` guard. |

## Red Team Concerns Addressed

| # | Concern | Severity | Resolution |
|---|---|---|---|
| A1 | agent privilege escalation via command | critical | `origin:"agent"` explicit allowlist (message only), pre-role-ladder deny+audit (C1). |
| A2 | steer/kill another agent via a message | critical | Message = advisory append only; never `prompt`/`abort`/`stop`; never auto-wake (C3). |
| A3 | cross-agent prompt injection | critical | `fenceUntrusted` + `redact` on delivery; advisory-only (C3). |
| A4 | sender impersonation | high | Sender = authenticated actor; payload carries only `to`+`text` (C1/C3). |
| A5 | chatter / feedback loop A→B→A | high | Advisory delivery ⇒ no auto-reply; per-sender budget; size cap (C3). |
| A6 | token/cost burn | high | Per-sender budget + size cap + scope-bounded targets (C3). |
| A7 | out-of-scope addressing / introspection | medium | `scopeFor` bounds both messaging targets AND fabric results; remotes never in scope; org via per-manager (C1/C2). |
| A8 | host-tool risk gate (source==="tool" never auto-answered) | medium | `onHostTool` intercepts ONLY the reserved tool name inline; other host tools keep human-gated behavior (C3). |
| A9 | cross-run clustering cost/scale | high | Windowed + zero-token Jaccard + ≤1 LLM naming/new cluster, capped (C4). |
| A10 | opportunity spam (N tickets/pattern) | high | Stable cluster-fingerprint dedup in opportunity-seen.json (C4). |
| A11 | premature/one-off opportunity | medium | `OMP_SQUAD_OPPORTUNITY_MIN` members across distinct runs before qualifying (C4). |
| A12 | fan-out parentId interaction | medium | Scope defined over existing parentId/featureId — fan-out branches are first-class members, no new tree (C1). |
| A13 | federation viewer-only remotes | medium | Remote actors are viewer (cannot send message); remote agents aren't in `this.agents` (not addressable). No new cross-operator surface (C1). |
| A14 | delivery to idle/stopped target | medium | Idle ⇒ injected on next turn (digest pattern); stopped ⇒ clean send failure; never queued forever (C3). |
| A15 | audit gap | medium | Routed through `applyCommand` (audits when need≠viewer) + explicit `recordAudit("message", to)` for agent-origin (C1/C3). |
| A16 | fabric leaks raw transcripts | low | Fabric returns distilled facts + provenance only; never raw entries (C2). |
| A17 | new store over-build | ponytail | Query over existing JSONL/md/Plane/DTO; no new persistence (C2). |
| A18 | message broker over-build | ponytail | Synchronous transcript append; no queue (C3). |
| A19 | agent RBAC over-build | ponytail | One capability (message), not a scope system (C1). |
| A20 | pull-vs-push ordering | significant | Inverted to scope→pull→push→loop; pull-first realized (all concerns). |

## Shared-file coordination (with `PlanFleetObservability` / G2)

- **`receipts.ts`** — G2 makes **additive-only** changes (`traceId?`, `spans?`); `readReceipts`/`receiptPath`/
  `RunReceipt.filesTouched` signatures are preserved. C2 **imports** these read-only and **does not edit**
  `receipts.ts`. The cross-run aggregation lives in the new fabric module, reading `receipts/*.jsonl` itself.
- **`observer.ts`** — neither plan edits it. C4 creates a **new sibling** `opportunity.ts` modeled on it; G2
  only reads the audit log.
- **`dal/context.ts`** — phantom heat seam; neither plan depends on it (both derive "hot areas" from
  `receipts.filesTouched`). Recorded so the correction is not lost.

## Open Questions
None blocking. One deferred-by-decision: a persisted/windowed per-sender message budget (the Map is
process-lifetime, like `superviseBudget`) — add only if cross-restart abuse appears.

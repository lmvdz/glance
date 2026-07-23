# Design: buzz borrows — hive-mind patterns for glance

Source: `plans/research-buzz/BRIEF.md` (block/buzz research, 2026-07-21). Adversarial round: 1 designer draft, 2 red-team critiques (26 findings, 5 critical), arbiter resolution below. Two of the seven original concepts were fundamentally reshaped by the red team; the rest were amended.

## Approach

Borrow buzz's practice lessons as native glance mechanisms; adopt no dependency. The plan that survived review is smaller and flatter than the draft: no new event substrate, no durable outbox, no reaper-coupled revocation. Seven concerns, almost fully independent — four daemon-side landable now, two deliberately small p2s, one filed into the t3-face lane's own sequencing.

The two big reversals, and why:

- **Outbox → landed-context at dispatch.** The draft's durable unit outbox targeted recipients by `requires`/`produces` overlap. Red team proved the recipient set is structurally near-empty: the spawn gate (`requiresConflict`) *forbids* a unit with overlapping `requires` from coexisting with the producer, so dependents spawn after the land and emit-time targeting finds nobody. And the proposed store (`JsonlLog`) is a self-described best-effort lossy ring — three silent-loss modes for a "durable" queue. The felt gap (a dependent knowing its producer's result) is served at the moment dependents actually exist: dispatch. A manager-authored "recently landed" block joins the prompt at composition time, read from the land-assessment store and transitions log that already record every attempt from real usage.
- **Grants: reaper never reads them.** The draft dropped revoked agents out of `protectedIds()` and let passive reap kill them. Both red-teamers independently showed this re-arms the PR #217 friendly-fire class: a semantically-wrong-but-successful membership query (empty result ≠ error) mass-unprotects the fleet, and reaping a host doesn't remove the agent — `ensureConnected` respawns it into a kill loop. Revocation now requires positive evidence (an explicit revocation row) and enforces through the front door: `manager.remove()`, which tombstones durably and settles pendings. The reap path is untouched.

## Key Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Event substrate | None; optional `TranscriptEntry.event` field + kind constants only | New per-org events.jsonl + EVENT_KINDS registry + SquadEvent arm | With the outbox cut, the substrate had one consumer; a substrate earns existence at the second consumer |
| Sibling awareness | Landed-context block at dispatch/steer prompt composition | Durable outbox with watermarks and turn-boundary drain | Recipient set for the outbox is ~empty by construction (spawn gate); dispatch is when dependents exist |
| Untrusted strings in manager-authored blocks | `neutralizeDelimiters` + `redact` on names/branches/details, always | "Manager-known metadata is safe" | Unit names are agent/user-chosen; fences are escapable without neutralization |
| Transcript verdict entries | Append-only, one entry per stage | In-place coalescing via id/seq | Delta-poll cursor contract only re-fetches `running` entries; coalescing is invisible to pollers, and `running` gets falsified by settle-on-exit |
| Revocation semantics | Positive-evidence row → `manager.remove()`; no reaper coupling, no better-auth FK | Lazy membership join in `protectedIds()`; passive reap | Absence-of-evidence kill decisions are the exact PR #217/#216 scar; remove() is the durable, settling, respawn-proof path |
| Friction rules pipeline | /dogfood-drain drafts a PR; fenced inputs, structured rule schema, lint, human merge | Automated loop writing DO_NOT_BLOCK directly | Rules enter every unit's system prompt — a prompt-injection surface with fleet-wide blast radius; the human gate is load-bearing |
| Orchestration measurement | Health report over land-assessment + transitions stores (real usage) | Checked-in synthetic fixtures on scratch-daemon | Fixture benchmarks rot (REGRESSION_GATE precedent); the stores already hold every real attempt; scratch-daemon has a live-contamination scar |
| Mention-as-dispatch | Daemon ack/nack now; composer semantics spec-first in the t3-face lane | Extend trigger menu directly | Reply lands in the target's transcript (no shared room yet), `@` is already bound to task mentions, and steers can drop silently — semantics before wiring |

## Risks

- **Landed-context block relevance**: a naive "recent lands" list burns context tokens on lands the unit doesn't care about. Mitigation: filter by `requires` overlap when declared, cap the block, include fleet-wide lands only as one-line summaries.
- **Friction distillation remains a lethal-trifecta shape** (attacker-writable input, LLM summarizer, repo write). Mitigations are layered (fencing, schema, lint, human merge) but the surface should stay small: one PR per drain, DO_NOT_BLOCK capped (~15 rules, replace-to-add beyond).
- **Grants serve no felt problem yet** (single-tenant reality; no member-removal flow in use). Accepted: it's p2, small, and shapes the trust story before multi-tenant load arrives — but it is the first concern to cut under time pressure.
- **t3-face dependency**: the mention concern's value only closes when the chat surface renders cross-unit replies; that is the t3-face lane's call, per the 2026-07-18 sequencing directive.

## Red Team Concerns Addressed

| Concern | Severity | Resolution |
|---|---|---|
| Outbox recipient set structurally empty (spawn gate forbids coexistence) | critical | Outbox cut; replaced by landed-context at dispatch |
| "Durable" outbox on JsonlLog (lossy ring, clobbered rotation, best-effort spool) | critical | Outbox cut; no delivery-state store exists in the plan |
| Grants: membership-absence inference → mass unprotect → fleet reap | critical | Positive-evidence revocation only; reaper never reads grants |
| Grants: reap vs `ensureConnected` respawn fight | critical | Enforcement via `manager.remove()` (durable tombstone, settles pendings) |
| Mention presumes shared-room reply; `@` trigger already bound to tasks | critical | Composer work moved to t3-face lane, spec-first; daemon ack/nack extracted as its own small concern |
| `unit.result` at `isGenuineCompletion` fires per turn, not per result | significant | No result event at turn boundaries; landed-context reads land terminals only |
| Envelope substrate has a single consumer | significant | C1 dissolved into the unit-room concern's type addition |
| In-place coalescing invisible to delta pollers; `running` falsified by settle | significant | Append-only per stage; length budgets instead of noisegate |
| Name/branch injection past a hand-rolled fence | significant | All agent-influenced strings neutralized + redacted in every manager-authored block |
| Cross-hierarchy channel + self-subscribed broad `requires` on spawned children | significant | Outbox cut removes the channel; landed-context is dispatch-time, manager-composed, and respects `scopeSource` |
| Watermark/seq restart-safety, advance-point ambiguity | significant | Moot — no watermarks in the surviving design |
| Friction pipeline is a prompt-injection trifecta | significant | Fenced inputs, structured schema, diff lint, provenance-in-fences, human merge |
| Background land assessment appends after record removal | significant | Resolve record by id at emit time; drop silently if gone; emits stay at call sites, hook stays observe-only |
| Benchmark rots; grading nondeterminism; scratch-daemon contamination scar | significant | Reshaped to a report over real-usage stores; synthetic fixtures deferred with mandatory fresh-init isolation if ever built |
| Steer denials/dedupes are silent over WS | significant | `clientTurnId` ack/nack events; prompt-to-missing-id returns a surfaced error |
| DO_NOT_BLOCK unbounded growth; repo-specific leakage; no clustering key | minor | ~15-rule soft cap replace-to-add; repo-agnostic rule requirement; clustering named as LLM judgment, not a countable threshold |

## Open Questions

None — all red-team findings adjudicated above. The one deliberate deferral (composer mention semantics) is filed as a spec-first concern owned by the t3-face lane, not an open question here.

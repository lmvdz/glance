# Research Brief: block/buzz — hive-mind communication platform

## Provenance

- **Date**: 2026-07-21
- **Question**: glance's fleet is hub-and-spoke (the daemon mediates everything; units never talk to each other). Buzz is Block's agent-to-agent "hive mind" workspace. *What does agent-as-peer communication buy in practice, why does Block dogfood it daily, and which of its patterns transfer to glance's orchestration, steering, and comprehension lanes?* (Bare-URL analog target → practice axis leads, per /research Phase 0.)
- **Target project**: glance (omp-squad) — daemon-orchestrated agent fleet; north-star bottleneck on record: *foundation-loved daily driver; Lars only plans/reviews/comprehends* (DIRECTION.md, omp#208).
- **Sources**:
  - https://github.com/block/buzz — HEAD `fd55ab662450a81a9ce49397f0e42aec0e4cb765` (2026-07-21T19:24Z), Apache-2.0, created 2026-03-06 (as `block/sprout`, renamed in place — `block/sprout` 301-redirects), 990★ / 99 forks / ~186 open issues+PRs at inspection.
  - Show HN: https://news.ycombinator.com/item?id=48632977 (submitter `tlongwell-block`, a top-3 committer)
  - HN launch thread: https://news.ycombinator.com/item?id=48995213
  - PR #2129 (dogfood learnings → base prompt), PR #1504 (harbor-buzz-orchestra benchmark harness)
  - RuntimeWire headline (body unreachable — LOW-CONFIDENCE, headline only)
  - Target-side map: codegraph explore of this repo at time of writing (paths cited inline below)
- Scouts read source via `gh api`/raw fetches only; nothing was cloned, built, or executed.

---

## Scout brief 1 — artifact axis (how it's built)

**What it is**: a self-hostable, Nostr-protocol team workspace (channels/threads/DMs/canvases/git hosting/workflows/voice) where humans and AI agents are protocol-level peers — same keypair identity model, same event shapes, same audit trail. The pitch: replace "chat + forge + bots + CI dashboards + release tools + search + glue" with one signed event log.

**Architecture**
- Single relay (`buzz-relay`, Axum) is the source of truth. Clients (Tauri/React desktop, Flutter mobile, CLI, agents) speak Nostr NIP-01 over WebSocket or signed HTTP (NIP-98). Hub/broker, not mesh — a newer `buzz-relay-mesh` crate adds an inter-relay QUIC mesh (iroh + scuttlebutt gossip) for horizontal pod scaling, off by default.
- Postgres is canonical storage (monthly range-partitioned events table); Redis is fan-out + ephemeral presence only. Postgres FTS for search (no separate service). SHA-256 hash-chained append-only audit log, single-writer via `pg_advisory_lock`.
- **Everything is an event**: messages, reactions, workflow steps, review approvals, git pushes, presence — Nostr events distinguished only by integer `kind` (81 kinds in `buzz-core/src/kind.rs`; 20000–29999 ephemeral/not-stored, 40000+ custom). Adding a feature = adding a kind; old clients ignore unknown kinds.
- **Branch-as-channel**: opening a git branch spawns a channel where NIP-34 patches, CI results, review, and the merge decision co-locate. The relay serves git smart-HTTP directly (`/git/{owner}/{repo}/*`) with S3-backed storage.
- Event pipeline: auth → sig verify → channel-membership check (transactional, TOCTOU-safe) → Postgres insert → Redis publish → three-tier fan-out (channel+kind index → channel wildcard → global scan, global subs excluded from private channels as a security boundary) → async search/audit/workflow triggers.

**Identity & trust**
- Every actor, human or agent, is a secp256k1 keypair. No separate account system, no "bot" type.
- **NIP-OA Owner Attestation**: an agent's events stay authored by the *agent's own* key but carry a signed authorization tag from the owner's key (with kind/time conditions covered by the signature) — explicitly not authorship reassignment.
- **NIP-AA Agent Authentication**: an agent whose owner is an active relay member gets "virtual membership" — no separate enrollment; revoke the owner and every agent they vouched for is cut off at next connect. Automatic cascade revocation, zero manual agent cleanup.
- Scope enum (14 scopes) exists; a 4-tier rate-limit config (human / agent-standard / agent-elevated / agent-platform) is defined but **not enforced anywhere** — documented gap.

**Agent surface**
- `buzz-acp`: bridges relay `@mention` events → any ACP-speaking coding agent subprocess (Goose, Codex, **Claude Code** named explicitly) over stdio JSON-RPC. Pools 1–32 subprocesses, per-channel queue/dedup/batching (at most one prompt in flight per channel), crash-respawn. **Mention-as-dispatch**: agents are summoned by being @mentioned in a room, like teammates.
- `buzz-agent`: Block's own from-scratch minimal ACP agent — built instead of reusing Goose, explicitly for auditability ("a senior engineer can read both binaries in a sitting").
- `buzz-dev-mcp`: MCP server with shell + `str_replace` file-edit + todo tools. `buzz-cli`: JSON-in/JSON-out agent-first CLI with documented exit codes. `sprig`: single multicall binary (argv[0] dispatch) distributing the whole agent toolchain, size-optimized for fresh-host installs.
- Goose relationship is directional: buzz *consumes* Goose/Codex/Claude Code as pluggable runtimes; Goose does not reference buzz. Not a Cargo dependency.

**Verification investment** (unusual for a self-declared "prototype"): TLA+ spec for the multi-tenant relay + an independent Rust conformance crate that replays production traces against the spec's transition relation *without sharing production code* ("a bug in shared helpers could hide from both"), plus a Tamarin spec for the auth protocol.

**Stack**: Rust workspace, 25 crates; Tokio/Axum/sqlx(Postgres)/Redis/iroh/rmcp; Tauri+React desktop; Flutter mobile. `buzz-core` is zero-I/O by policy (bans tokio/sqlx/redis/axum) — the shared trust boundary is runtime-agnostic. Subsystem crates are forbidden from calling each other; only the relay orchestrates.

LOW-CONFIDENCE: prior name "Sprout" inferred from Cargo metadata + asset paths (confirmed separately by practice scout via the `block/sprout` redirect and PR #2 title). Not read in depth: mobile source, Tauri backend, several vision/formal docs, `benchmarks/harbor-buzz-orchestra` internals.

---

## Scout brief 2 — practice axis (who uses it, why it wins)

**Dogfooding — unusually hard evidence**
- ~1,756 commits over 4.5 months; three Block engineers (wesbillman 530, wpfleger96 354, tlongwell-block 344) are ~70% of them. Small dedicated core, not a broad OSS community.
- **94 commits co-authored by "Brain"**, an internal Block AI agent (email on `sprout-oss.stage.blox.sqprod.co` — internal staging infra) — buzz's own agents build buzz.
- Codex runs autonomously against the repo filing security fixes as `[codex]`-prefixed commits tied to internal finding IDs (`BUZZ-SEC-007` etc.).
- PR #2129 folds "hard-earned operating learnings" into the agent base prompt, citing an internal "buzz-launch report, 2026-07-19": *"each of these encodes a mistake that was made more than once in practice before the rule existed."*
- A maintainer commit: "fix: cleanup old screenshots that my agents committed."
- README routes Block employees **away from the OSS build** onto an internal build "pre-wired to the Block relay and agent provider" — buzz is Block's actual daily internal tool; the OSS repo is the downstream generalization.
- PR #1504: a dedicated Terminal-Bench-style harness (`harbor-buzz-orchestra`) to *measure* their own agent-team orchestration quality continuously.

**Change history as usage diary**
- Cadence: 21 desktop releases in 11 days (v0.4.0→v0.4.21, 2026-07-10→07-21); same-day fixes still landing at inspection time. Early feature issues closed same-day.
- Churn map (most→least fought-over): (1) desktop onboarding flow — the single most-touched, most-broken surface; (2) agent/harness plumbing — turn timeouts, stall detection, relay reconnect, ACP rate-limit pacing, harness pin/restart — the functional core, structural fixes; (3) relay correctness/scale; (4) chat/inbox/timeline — scroll anchoring, virtualization, repeated "fix X again" regressions; (5) release/CI tooling; (6) mobile.
- What lingers: cosmetic/speculative UI stalls as 6-week draft PRs; open bugs cluster on **platforms the internal team doesn't dogfood** (Windows Codex setup, macOS malware false-positive, Goose setup #2245, "Claude agents fail silently when default model requires usage credits" #2265). The internal build sidesteps the OSS onboarding path — so it rots for external users. Dogfood-path divergence is visible in the bug tracker.

**The team's own account (README)**: "The bet is that one community can do what teams currently fake with chat, forges, bots, CI dashboards, release tools, search indexes, and a pile of glue code." Canonical self-stories: *incident memory* (agent answers "have we seen this error?" from six months of channel history), *branch as room*, *a release that writes itself* (workflow-triggered agent drafts notes, posts for human 👍, ships). Non-goals: "Not blockchain. Not an AI replacement plan — buzz works best when humans stay in the loop and agents stay in the room."

**Zero-config opinions**: single machine, single relay, one community, `ws://localhost:3000`; a team plus its agents, not swarm scale; agents get real identities, never bot accounts.

**Reception**: Show HN praise for incident memory and non-impersonating agent auth; skepticism on switching cost ("no one churns Slack for this"), on multi-agent data-leakage risk once agents are full room members (a Slack employee's structural critique), and on whether Nostr is value or "a processing tax." Comparisons drawn to Google Wave ("ahead of its time, ultimately failed").

---

## Target-side map: how glance communicates today (verified paths)

- **Hub-and-spoke**: `SquadManager` (`src/squad-manager.ts:855`) owns all units; all "communication" is the manager appending to a unit's transcript and emitting `SquadEvent`s. Units hold no references to each other.
- **One stunted agent-to-agent channel**: `squad_message` tool → `deliverPeerMessage` (`src/squad-manager.ts:7197`) — advisory transcript append, 5/run budget, scope-checked, fenced as untrusted. The code names its own ceiling: *"durable/reliable push needs an outbox, which is intentionally out of scope."*
- **Steer in**: `POST /api/command` (`src/server.ts:3185`) → `applyCommand` → driver `prompt`/`steer`. **Attention out**: `PendingRequest` + `squad_attention` → `AttentionStore` (`src/attention.ts`) → needs-you ladder (`attention-ladder.ts`).
- **Cross-unit coordination is isolation, not communication**: worktrees, `requires`/`produces` scope conflicts (`:5966`), advisory lease gossip (`leases.ts`), plan-DAG `blockedBy`. **A sibling has no way to learn another unit landed** — no result feed exists; awareness is orchestrator-mediated.
- **Bus half-built already**: durable `JsonlLog<T>` (automation.jsonl, transitions.jsonl, friction.jsonl), live `SquadEvent` emitter, WS `broadcast`/`broadcastTo(orgId)` (`server.ts:3223`). `FederationBus` (`src/federation.ts:58`) already declares `sendMessage`/`onMessage`/`TeamMessage` and anticipates a `RelayFederationBus` — but is operator-to-operator only, with authority-stripping on the wire (`remoteCommandActor`, `federation.ts:337`).
- **Tenancy constraint**: per-org `SquadManager` behind `ManagerRegistry`; tenant orgs strictly confined; any shared substrate must preserve org confinement and the untrusted-wire model.

---

## Dissect: concept extraction

| Concept | How buzz implements it | Transferable? | Why / why not |
|---|---|---|---|
| Everything is a kind-tagged event in one signed log | Nostr events, integer `kind`, 81 kinds; feature = new kind; old clients ignore unknown kinds | YES (pattern) | glance has 4+ parallel logs (transcripts, automation, transitions, friction, audit) with no shared envelope; the kind-dispatch discipline is portable without Nostr |
| Mention-as-dispatch | `buzz-acp`: relay @mention → ACP subprocess, per-channel queue, one in-flight prompt per channel, crash-respawn | YES | glance's chat surface (t3-face) + steer lane exist; @mention as the dispatch/steer verb is the missing ergonomic |
| Branch-as-channel / unit-as-room | git branch spawns a channel; patches, CI, review, merge decision co-locate | YES | glance's unit transcript is already the room; gates/land assessment/review findings arrive scattered across UI panels instead of in it |
| Sibling awareness by shared room | agents in a channel see each other's events natively | YES (adapted) | glance's named gap (`deliverPeerMessage` ceiling); needs outbox + subscription, not a full workspace |
| Owner attestation / cascade revocation | NIP-OA/NIP-AA: agent signs as itself + carries owner's signed grant; revoking owner cuts off all its agents | YES | maps onto DB-mode org membership; today agent lifecycle/cleanup is manual and reaping has misfired (friendly-fire reap) |
| Ops-learnings → base prompt | PR #2129: repeated real-world failures distilled into harness system-prompt rules, in-repo, reviewed | YES | glance has friction ledger + failure-memory but no curated pipeline into the dispatch prompt |
| Self-benchmark of orchestration | harbor-buzz-orchestra Terminal-Bench harness | YES | glance verifies units live but never scores its own orchestration end-to-end |
| Humans and agents share one identity shape | one keypair type, no bot accounts | PARTIAL | philosophically aligned (agents as teammates) but glance's SSO/cookie human model works; not worth restructuring |
| Nostr as substrate | NIP-01 wire, relay, Schnorr sigs | NO | a whole second runtime (Rust relay + Postgres + Redis) for portability glance doesn't need; HN's "processing tax" critique applies doubly to a single-daemon TS system |
| Independent conformance checker | replay production traces against a spec with zero shared code | YES (idea) | matches glance's fail-open scar tissue ("green fake"); heavyweight, niche |
| Internal build ≠ OSS build | Block employees skip the OSS onboarding entirely | CAUTIONARY | the bug tracker shows off-dogfood-path surfaces rot; glance's equivalent: whatever Lars doesn't drive daily will lie |

---

## Abstract: ranked transferable concepts (strategist)

Ranked against the **named bottleneck**: glance must become the foundation-loved daily driver in which Lars only plans, reviews, and comprehends — with the standing sequencing directive (2026-07-18) that the desktop t3code look/feel reaches LOVED state before new feature surfaces. Concepts are ranked by impact on that bottleneck; the sequencing note at the end says when each can land.

**1. Concept: Durable unit outbox — siblings learn results without the orchestrator**
**Pattern**: agent-to-agent messages and unit lifecycle results (landed, failed, produced X) go through a durable, addressable outbox with delivery semantics — not a fire-and-forget transcript append. Consumers subscribe; undelivered messages survive restarts and wake the recipient's next turn.
**Mechanism**: promote `deliverPeerMessage` (`src/squad-manager.ts:7197`) from append-only to an outbox backed by the existing `JsonlLog<T>` primitive; on unit settle/land, auto-emit a result event to units that declared `requires` on its `produces`; deliver on the recipient's next turn boundary (no interrupt — keeps the advisory, no-authority trust stance). Route through the `FederationBus` seam (`federation.ts:58`) so cross-host works for free and org confinement + authority-stripping are inherited.
**Value for glance**: closes the one coordination gap the codebase itself names — today a sibling learns of a landing only via orchestrator re-dispatch, which burns Lars-adjacent orchestration attention. Fewer stalled `requires` units, fewer needs-you entries. Directly serves "needs-you near-empty by design."
**Where it applies**: `src/squad-manager.ts` (`deliverPeerMessage`, `handleAgentTool`, settle path from PR #216), `src/federation.ts`, `src/types.ts` (`TeamMessage`), new `JsonlLog` outbox file per org.
**Build vs Buy**: build — ~200 lines on existing seams. Buzz's relay is the wrong tool; the pattern is the prize.

**2. Concept: Mention-as-dispatch in the chat surface**
**Pattern**: @mentioning an agent in a conversation *is* the dispatch/steer verb. Per-conversation queue, one prompt in flight per room, dedup/batching, crash-respawn — chat is the control plane, not a viewer over one.
**Mechanism**: buzz-acp's loop: watch room events → filter mentions of your identity → queue per channel → prompt the harness via ACP → post replies as events. Glance already has every piece: ACP drivers, the steer lane (`applyCommand` type `prompt`), and the t3-face chat surface under construction (R3, PR #215). The delta is wiring @mention in the composer to `applyCommand` targeting the mentioned unit, with a per-unit in-flight guard.
**Value for glance**: this is *the* daily-driver ergonomic — Lars steers by talking, in the surface he's already looking at, instead of navigating to a unit and using a separate steer control. It's also our lead reinforced: t3code research concluded "steer stays our lead"; buzz demonstrates the loved form of that lead in daily practice at Block.
**Where it applies**: webapp composer (t3-face chat surface), `src/server.ts` command routing, `applyCommand` in `src/squad-manager.ts`.
**Build vs Buy**: build; it's UI wiring plus a queue guard. Sequencing: this *is* chat-surface construction, so it rides the t3-face lane rather than competing with it.

**3. Concept: Friction → base-prompt distillation loop**
**Pattern**: operational failures agents hit more than once get distilled into reviewed, in-repo rules in the harness's base/system prompt — the harness itself learns, not just the memory of the orchestrator. Each rule cites the incident that earned it.
**Mechanism**: periodic pass (fits /dogfood-drain cadence) over friction.jsonl + learning ledger; cluster repeat failures; land the distilled rule as a PR touching the dispatch prompt assembly, one rule per scar, with provenance comments. Buzz's PR #2129 is the template — "each of these encodes a mistake that was made more than once in practice."
**Value for glance**: attacks repeat agent failure directly (the make-it-work loop keeps re-finding the same classes); converts the already-collected friction ledger from a triage artifact into harness behavior. Zero UI cost, fully agent-side — consistent with no-ops philosophy.
**Where it applies**: dispatch prompt assembly in `src/squad-manager.ts`, `friction.jsonl`/`FrictionLog`, the /dogfood-drain skill.
**Build vs Buy**: build — it's a workflow habit plus a prompt file, not infrastructure.

**4. Concept: Unit-as-room — everything about a unit co-locates in its transcript**
**Pattern**: the unit's conversation is the single spine where patches, gate results, review findings, sibling advisories, land assessment, and the merge decision all appear as first-class entries — comprehension means reading one room, not assembling five panels.
**Mechanism**: buzz's branch-as-channel: every event about the branch lands in the branch's channel. Glance analog: emit gate verdicts, land-assessment output, review findings, and the merge decision *into the unit transcript* (kind-tagged entries, see #5) rather than only into side stores; the t3-face timeline then renders them as typed cards.
**Value for glance**: Lars's comprehension lane is the product. Today land assessment (PR #201), validator veto (PR #67), attention, and transcript are separate surfaces; co-location is what makes before-after comprehension effortless. Buzz's most-loved self-story ("branch as room") is precisely this.
**Where it applies**: transcript append path in `src/squad-manager.ts`, land-assessment emit points, t3-face timeline card types (H3 card spec from PR #215).
**Build vs Buy**: build. Sequencing: card rendering is t3-face work; the emit side can land earlier and invisibly.

**5. Concept: Kind-tagged event envelope over the existing logs**
**Pattern**: one envelope shape (id, ts, actor, kind, payload) across every event the system emits; features add kinds, consumers ignore unknown kinds; old readers never break.
**Mechanism**: define a `kind` registry and wrap `SquadEvent` + `JsonlLog` entries in the envelope incrementally (new kinds first, migrate old logs opportunistically). No new storage, no Nostr, no signatures initially — the discipline, not the protocol. This is the substrate #1 and #4 ride on.
**Value for glance**: today each log has its own shape, so every new consumer (comprehension digests, fabric KB, webapp panels) needs bespoke parsing; a shared envelope makes the event log queryable as one stream — buzz's "incident memory" story (search six months of history) becomes cheap.
**Where it applies**: `src/types.ts` (`SquadEvent`), `JsonlLog` call sites (`automation-log.ts`, transitions, friction), fabric indexing.
**Build vs Buy**: build, incrementally; adopting Nostr wholesale is explicitly rejected (second runtime, "processing tax", prototype-maturity dependency).

**6. Concept: Owner-attestation lifecycle for agent identities**
**Pattern**: an agent acts under its own identity but carries a revocable, condition-scoped grant from its owning principal; revoking the principal cascades to every agent it vouched for — no orphaned agent cleanup, no impersonation.
**Mechanism**: in DB mode, tie every spawned unit/host identity to the org membership that created it (grant record with scope + expiry, checked at connect/dispatch); org-membership revocation invalidates all dependent grants at next use.
**Value for glance**: the registry friendly-fire reap (PR #217) and the ACP permission-gate hole (#157) are both symptoms of agent lifecycle being inferred rather than granted; explicit grants make "should this agent exist right now" a lookup, not a heuristic.
**Where it applies**: `src/manager-registry.ts`, DB schema, host handshake/canary path.
**Build vs Buy**: build a minimal grant table; skip Schnorr/Nostr keys — org-scoped tokens suffice inside one daemon.

**7. Concept: Orchestration self-benchmark**
**Pattern**: a repeatable harness that scores the *orchestrator* (dispatch → coordinate → land) on benchmark tasks, so orchestration regressions are measured, not anecdotal.
**Mechanism**: buzz built harbor-buzz-orchestra on Terminal-Bench. Glance analog: a scripted scratch-daemon run (existing /scratch-daemon rig) over a fixed task set, scoring land rate/steer count/wall clock, run per release.
**Value for glance**: the regression gate covers units; nothing scores the fleet loop end-to-end. Lower priority — the daily-driver program partially covers this via live adoption counters.
**Where it applies**: `/scratch-daemon` + `REGRESSION_GATE` machinery.
**Build vs Buy**: build later; small.

**Cautionary (not a concept to build): dogfood-path divergence.** Buzz's bug tracker shows exactly where the internal build diverges from the OSS path — Windows/macOS onboarding rots because Block doesn't walk it. Glance's standing scar ("green fake shipped a fix that failed live") is the same law: any surface Lars doesn't drive daily will lie. Weigh every new surface against whether it's on his actual path.

**Sequencing note**: the standing directive (2026-07-18) is desktop look/feel to LOVED state before feature surfaces. #3, #5, #6, #7 and the emit-side of #4 are agent/daemon-side and don't compete with that lane. #2 and the render-side of #4 *are* the t3-face chat-surface lane — they should be folded into its existing plan (H3 cards, composer) rather than opened as a parallel front. #1 is small, invisible to the UI, and closes a self-documented gap; it can land any time.

**Overall build-vs-buy**: borrow patterns, adopt nothing. Buzz is Apache-2.0 and very active (near-daily releases) but self-declared prototype maturity, Rust relay + Postgres + Redis + Tauri — a second platform, not a library. Its value to glance is that Block is running the experiment we'd otherwise have to run ourselves — agents-as-peers in one event log, dogfooded daily — and publishing the answers as commits.

# Research brief: Mastra Code → omp-squad (glance)

**Date:** 2026-07-06
**Target project:** omp-squad / glance — persistent autonomous multi-agent coding fleet.
**Research question:** What is Mastra Code's "Observational Memory", how does its
no-compaction / mid-task-resume architecture work, and what is transferable to omp-squad,
whose long-running units lose context to compaction and whose units die mid-task?

**Sources:**
- https://code.mastra.ai/llms.txt (index), /modes.md, /goals.md
- https://mastra.ai/docs/memory/observational-memory (OM deep dive)
- https://mastra.ai/docs/harness/overview (conversation-as-channel / AgentController)
- https://mastra.ai/blog/anatomy-of-a-coding-agent (harness "runs for hours")

---

## 1. Scout brief — what Mastra Code is

Terminal AI coding agent (Claude-Code-shaped) built on three Mastra primitives —
**Harness, Agent, Memory**. Differentiator: long sessions that never compact and survive
terminal restarts.

### Observational Memory (OM) — the marquee idea

Instead of *reactively* summarizing at the token limit (compaction, which drops
requirements), OM *continuously* compresses in the background with two auxiliary agents:

- **Observer** — fires when raw messages exceed a threshold (default **30k tokens**).
  Writes a few hundred tokens of dated, bulleted observations: decisions, facts, state
  changes, current task, suggested next response. Runs **asynchronously** at 20% intervals
  (~6k tokens) so the main agent never pauses; `blockAfter` = 1.2× forces a synchronous
  observation if buffering falls behind.
- **Reflector** — fires when observations exceed **40k tokens**. Condenses and merges,
  preserving completion markers and dates.
- Three-tier context stack: **recent raw messages → observation log → reflections**.
  Typical compression **5–40×** (e.g. 4.2k→0.1k tokens) with decision integrity preserved.

Observation log format — dated, bulleted, severity dots:
```
Date: 2026-01-15
- 🔴 12:10 User building Next.js + Supabase auth, due Jan 22
  - 🟡 12:12 Asked about middleware for protected routes
  - 🔴 12:15 App name is "Acme Dashboard"
```
Temporal gap markers inserted when 10+ min pass between messages (resumption cue).

### Two design decisions worth stealing

1. **Append-only monotonic log → warm prompt cache.** Observations only grow at the end,
   so the cached prompt prefix stays stable across turns (cheaper/faster). OM even fires on
   **idle** and on **provider/model switch**, tuned to each provider's cache TTL (Anthropic
   ~5 min, Gemini 24 h), to recompress *before* the cache expires.
2. **Retrieval is opt-in, in-context by default.** Observations live *in the context
   window* — no RAG round-trip, no retrieval-error hallucination. A `recall` tool browses
   raw history behind an observation range only when needed.

### Supporting pieces

- **Extractors** — schema'd (Zod) structured facts (current task, user profile, workspace
  facts) persisted alongside the log and shown back each cycle for iterative refinement.
- **Token-tiered model selection** (`ModelByInputTokens`) — cheap model under 5k tokens,
  bigger at 40k+. Default Observer model `gemini-2.5-flash`.
- Storage adapters: Postgres / SQLite / Mongo. Thread scope (default) vs resource scope (exp).

### Harness — conversation-as-durable-channel

A conversation is a durable pub/sub channel, not a function call. **Session state** (mode,
model, thread binding, permission grants, follow-up queue, token usage, **goal
objective+judge+attempt-count**) persists to backend storage; on restart
`selectOrCreateThread()` reloads exact context and the agent **picks up mid-task instead of
starting over**. Queue messages / inject mid-stream steering without killing the run.
Multi-surface locking (take-new-before-release-old) stops two terminals owning one thread.

### Goals

`/goal <objective>` runs a **judge model** each turn → `done` / `continue` / `waiting`.
Goal lives in **thread metadata** (survives restarts with objective, judge, attempt count,
limit). Judge feedback becomes a **system reminder** next turn.

### Modes / subagents

- Build (full tools) · Plan (read-only, submits structured plan → auto-Build on approval)
  · Fast (<200 words, faster model, answers from knowledge not codebase search).
- Each mode remembers its own model.
- Subagents: *non-forked* (no thread id, parent history doesn't leak) vs *forked* (clones
  parent thread to keep prompt cache warm, blocks dangerous tools).

---

## 2. Comparator table — pattern vs omp-squad reality (verified paths)

| Mastra pattern | omp-squad reality (verified file:path) | Gap today |
|---|---|---|
| **Background Observer+Reflector over a live session** | No live mid-session compaction. Post-hoc only: `src/summarizer.ts` (zero-token TF-IDF+TextRank, ≤400 sentences) → `src/digest.ts` `buildDigest()` writes `<stateDir>/digests/<id>.md` at **run-end**. `src/reflection.ts` `reflect()` (model `haiku`) writes an append-only dated per-worktree JSONL note **between failed fixup attempts** — conceptually a Reflector. (`src/observer.ts` is a Plane-backlog auditor — name collision only.) | No append-only decisions/facts/current-task log written **during** a live turn; a long unit that never finishes a run/fixup cycle gets no compaction and loses requirements to context pressure. |
| **Append-only log → warm prompt cache; recompress on idle/provider-switch** | Not exploited. Digest/reflection are files, not an in-context monotonic prefix; no cache-TTL-aware recompression. | omp-squad pays full cache-miss cost on long units and never recompresses ahead of cache expiry. |
| **Retrieval opt-in, in-context by default** | `src/fabric-search.ts` BM25 recall + `buildContextPrimer()` is **cold-start-only** (primer at agent creation, `src/squad-manager.ts:2942`). | No live in-context growing log; recall is a one-shot primer, not a continuously-updated tier. |
| **Extractors (schema'd facts each cycle)** | `src/fabric.ts` typed facts (`FabricAgentFact`, `FabricDigestFact`, `FabricDecisionFact`, `FabricFailureFact`, …) + `src/fabric-search.ts`. | Facts are **derived at run boundaries** (digest/scout/decision), not a per-turn schema'd extraction of "current task / workspace facts". |
| **Conversation-as-channel / mid-task resume** | `PersistedAgent` (`src/types.ts:749`) persists `model`/`task`/`workflowState` to `state.json`; `src/workflow/engine.ts:48` `run(goal,{resume})` resumes the **graph** from checkpoint (OMPSQ-165). Stranded-WIP: `commitWorktreeWip()` `src/worktree.ts:149`. Boot: `reconnectLive`→`reapOrphans`→`adoptOrphanedAgents`→`reconcileForkLineage` in `src/squad-manager.ts` `start()`. | Mid-task resume exists **only for workflow-kind** agents. A plain interactive `omp` unit is *reattached* (if process alive) or *cold-adopted* (if dead) — never resumed from an in-turn checkpoint. `commitWorktreeWip` saves files, not session state. |
| **Goal + judge (done/continue/waiting) → system reminder** | Judge = `src/validator.ts` `scoreAgainstCriteria()` (independent model `OMP_SQUAD_VALIDATOR_MODEL ?? "opus"`) → `pass\|veto\|abstain\|skipped`; `validatorGate()` at land-time. Loops: `src/dispatch.ts`, `src/orchestrator.ts` (`autodrive`). Gating: `src/confidence.ts`, `src/autonomy.ts`. | Verdict blocks the **land** step; it is **not injected back into the live agent's next turn** as a system reminder. No unified per-turn done/continue/waiting tri-state (spread across `verificationState`/`confidence`/`autonomyMode`). |
| **Forked vs non-forked subagents** | Worktree primitives `src/worktree.ts`; spawn in `src/squad-manager.ts` `createInternal` (2896) + `spawnFleetBranch` (~3196). Lineage `parentId`/`parentNodeId`/`branchIndex` in `src/types.ts`. Runtimes: `src/acp-agent-driver.ts`, `src/sandbox-agent-driver.ts`, `src/rpc-agent.ts`. | Parent context to a child = lineage ids + assembled `task`/`appendSystemPrompt` only. No condensed parent-conversation snapshot handed down; primer comes from shared fabric, not the parent unit's recent turns. |
| **Token-tiered model selection** | `src/smart-spawn.ts` outcome-driven `opus`↔`default` shift (gated, needs min samples/edge). Role tiers: validator=opus, reflector=haiku. `ThinkingLevel` minimal…xhigh (`src/types.ts:743`). | Tiering is **binary** (opus vs default) per role, not a continuous size/difficulty scale; no per-transcript-size Observer-model tier. |

---

## 3. Strategist — ranked transferable patterns

Build-vs-buy: **all borrow-pattern.** Mastra Code is a competing full harness, not an
embeddable library. Nothing here is a dependency to adopt. The striking finding is that
omp-squad already has ~80% of the machinery for every pattern — the gap is **timing**:
everything fires at a *run boundary* (run-end digest, between-fixup reflect, land-time
veto), never *continuously mid-run*. Closing that timing gap is the whole opportunity.

### #1 — In-session background Observer log (closes: long units lose context) ⭐ highest impact

**Pattern:** A background pass compresses a live unit's transcript into an append-only,
dated observation log (decisions / facts / current-task / where-we-left-off) *during* the
run, not only at run-end — so the main agent never carries raw history to the compaction
cliff.
**Mechanism:** Fire the existing `src/summarizer.ts` (zero-token, so nearly free) or a
`haiku` pass on a rolling token-interval trigger, appending to a per-unit log; feed the tail
of that log back into the unit's context. Reuse `src/reflection.ts`'s append-only dated
JSONL shape as the storage format; add a "condense when log > N" Reflector step.
**Where it applies:** `src/digest.ts` (make `buildDigest` incremental, not run-end-only),
`src/reflection.ts` (widen from fixup-loop-only to general mid-session), and the unit
runtime that assembles context (`src/rpc-agent.ts` / `src/acp-agent-driver.ts`).
**Value:** Directly kills the "long unit forgets the requirement" failure. ~80% of the code
exists; this is re-triggering + a feedback seam, not a greenfield build.

### #2 — Mid-task resume for plain interactive units (closes: unit death / stranded-WIP)

**Pattern:** Persist enough per-turn session state that a dead unit resumes *mid-task*
instead of cold-restarting.
**Mechanism:** Extend the `workflowState` checkpoint idea (`src/types.ts:749`, already proven
for workflow-kind via `src/workflow/engine.ts`) to plain units: checkpoint current-task +
the #1 observation-log tail into `PersistedAgent`; on boot, hook a "resume from checkpoint"
path into `adoptOrphanedAgents`/`reconnectLive` (`src/squad-manager.ts` `start()`) alongside
today's reattach-or-cold-adopt binary. Pairs naturally with `commitWorktreeWip()`
(`src/worktree.ts:149`) which already saves the files — this adds the *context* half.
**Value:** Turns "unit died → work stranded" into "unit died → resumes where it left off."

### #3 — Judge verdict fed back as an in-session system reminder (closes: goal thrash, trust)

**Pattern:** The independent judge's verdict becomes a *turn-level system reminder* pushed
back into the live unit — "not done: criterion X unmet, continue" — rather than only a
land-time gate.
**Mechanism:** `src/validator.ts` `scoreAgainstCriteria()` already produces
pass/veto/abstain against declared `FeatureCriterion[]`. Route a `veto`+reason back into the
running unit's next turn (system reminder) inside the goal loop (`src/orchestrator.ts`
`autodrive` / `src/dispatch.ts`), converging toward Mastra's done/continue/waiting tri-state.
**Value:** Stops goal-loop thrash (unit gets *told why* it isn't done and iterates) and
attacks the trust gap (agent can't declare done against an independent judge in-loop).

### #4 — Append-only monotonic log → warm prompt cache + idle/provider-switch recompress

**Pattern:** Keep the observation log append-only so the cached prefix stays stable; proactively
recompress on idle and before cache-TTL expiry.
**Mechanism:** Once #1 exists, enforce append-only ordering and add idle/provider-switch
recompression triggers tuned to Anthropic's ~5-min cache TTL. Touches the same runtime seam
as #1.
**Value:** Cost + latency win on exactly the long-running units that dominate omp-squad's
spend. Lower urgency than #1–#3 but rides the same machinery.

### #5 — Continuous schema'd task-state Extractor fact

**Pattern:** A schema'd `current-task / workspace-facts` fact refreshed *every cycle*, not
only at run boundaries.
**Mechanism:** Add a `FabricTaskStateFact` to `src/fabric.ts` fed continuously from the #1
observation pass; it flows through the existing `src/fabric-search.ts` primer, so children
spawned via `spawnFleetBranch` inherit the parent's live task state, not just cold fabric.
**Value:** Better fan-out context handoff; modest but cheap once #1 + #5's fact type exist.

### Not worth porting

- **Token-tiered Observer model** (`ModelByInputTokens`): nice, but `src/smart-spawn.ts`
  already tiers by role; a size-tier for the Observer is a small follow-on to #1, not its own
  initiative.
- **Modes (Build/Plan/Fast)**: omp-squad already has autonomy/approval modes; no gap.
- **Multi-surface locking**: omp-squad's daemon already owns single-writer semantics.

---

## 4. Handoff

Recommended `/plan` goal (borrow-pattern, no dependency): **"Give omp-squad units a
continuous in-session observation log (#1) and mid-task resume from it (#2), then feed the
validator verdict back into the live loop (#3)."** #1 is the keystone — #2, #3, #4, #5 all
build on the same background-compaction seam. Primary integration files:
`src/digest.ts`, `src/reflection.ts`, `src/summarizer.ts`, `src/types.ts` (`PersistedAgent`),
`src/squad-manager.ts` (`start()` resume pipeline), `src/validator.ts`, `src/orchestrator.ts`.

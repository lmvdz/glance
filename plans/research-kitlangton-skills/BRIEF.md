# Research Brief: kitlangton/skills

**Date**: 2026-07-15
**Source**: https://github.com/kitlangton/skills
**HEAD inspected**: `30dee8607214c893dd89f6eee65c669ef3dce8c9` (repo created 2026-07-15T16:05Z — the entire history is ~11 minutes old at scout time, 6 commits, 80★, MIT)
**Author**: Kit Langton (kitlangton.com) — Effect-TS/ZIO ecosystem educator (`zio-magic`, `neotype`, effect.kitlangton.com), currently at opencode. Recognized authority in production Effect patterns.
**Target project**: omp-squad / glance (fleet orchestration daemon + webapp; Effect v4 codebase pinning `effect@^4.0.0-beta.93`; own agent-skill library in `.claude/skills/`)

---

## Scout brief (facts)

### What it is

A single-skill Claude Code Agent Skills repo: an opinionated style/API guide for writing production TypeScript with **Effect v4**, installable via `npx skills add kitlangton/skills --skill effect` (Vercel Labs `skills` CLI; GitHub-repo-as-registry). It solves LLMs hallucinating Effect APIs or defaulting to v2/v3 idioms by giving the agent a decision procedure and canonical code shapes instead of doc dumps.

### Inventory

Ten files total: LICENSE, README.md, and `skills/effect/` containing `SKILL.md` (~7KB) plus eight `references/*.md` (~3–6KB each): CACHING, CONFIG, HTTP_CLIENTS, SCHEDULING, SCHEMA, SERVICES_LAYERS, STREAMS, TESTING. Pure markdown — no scripts, hooks, or plugin manifest. Frontmatter declares `compatibility: Requires Effect v4. Examples are reviewed against the version documented in this repository.`

### Architecture

Two-tier progressive disclosure: `SKILL.md` is the always-loaded entry with a **Branch Chooser** mapping 8 task shapes to specific reference files ("Read only the branch references that match the task"); references carry the detail. SKILL.md opens with a **Source Rule** — check the nearest `AGENTS.md`, the project's actually-installed `effect` version, and upstream source *before* trusting the skill's own text. Body is Core Defaults + Quick Selection Guide + Boundary Rules + **Do Nots** (e.g. mandate `Effect.gen`, `Effect.fn("Domain.operation")`, `Context.Service`, `Schema.TaggedErrorClass`; forbid `Schema.Class`, hand-rolled TTL caches, blind `Layer.mergeAll`).

### The buried mechanic (commit archaeology, not visible at HEAD)

The first commit (`d94a9dd7`, "feat: publish Effect skill") shipped a full Bun/TS verification harness alongside the markdown: `package.json` pinning `effect@4.0.0-beta.97`, `examples/typecheck.ts` — a fixture importing and exercising essentially **every API the skill prescribes** (the exact `Schedule.exponential(...).pipe(Schedule.jittered, ...)` chain that appears verbatim in SCHEDULING.md, `Cache.makeWith`, `Data.TaggedEnum/$match`, `HttpClientRequest/Response`) run through `tsc --noEmit` — and `scripts/validate.ts` asserting SKILL.md frontmatter shape and that every referenced `references/*.md` path exists on disk. Six minutes later, commit `3bd6cd47` ("docs: simplify skills repository") **deleted the entire harness**, leaving pure markdown. The examples were proven to compile before the proof was stripped for distribution simplicity. Two later prose-refinement commits happened with no re-verification tooling present.

### Design decisions and tensions

- **Correctness by authority-deferral**: the skill subordinates itself to live ground truth (Source Rule + `compatibility` frontmatter) — engineered to fail gracefully as Effect v4 beta drifts, rather than silently asserting stale APIs.
- **Verification built, then discarded**: provable freshness traded for a zero-dependency, zero-build distributable. The reasoning is only inferable from the diff.
- **Opinionated subset, not reference manual**: entire sections are "Do Nots" naming the agent's own likely rationalization ("Do not adopt `RequestResolver` batching for per-item REST endpoints just because 'batching' sounds faster"). Consistency bought at the price of completeness.
- **Self-flagged exotic conventions**: the self-export namespace pattern (`export * as UserRepo from "./user-repo.js"` inside `user-repo.ts`) is explicitly marked "unusual — use only where the toolchain supports it," rather than presented as Effect canon.

### Vs. alternatives

Unlike `anthropics/skills` (broad official multi-domain collection with plugin-marketplace machinery) or community aggregations (breadth, uneven provenance), this is one narrow skill by a verifiable domain authority — depth in one lane, structured as a context-budget router with a staleness posture, distributed via the third-party `npx skills` convention.

Scout confidence: file contents/commit history HIGH (fetched via `gh api` at the SHA above); author bio MEDIUM (single WebFetch of kitlangton.com).

---

## Strategist: ranked transferable concepts

Single source, so the comparator round was skipped; concept extraction and ranking done in one pass against omp-squad.

### 1. Compiled-fixture verification of agent-facing doc claims

**Pattern**: Every code/API example in agent-facing guidance is mirrored by an executable fixture that typechecks (or runs) against the pinned dependency; prose is curated from what's proven to compile, and a lint asserts structural integrity (frontmatter shape, referenced paths exist). The doc layer gets the same fail-closed treatment as the code layer.
**Mechanism**: A `skills-verify` gate: extract fenced TS blocks from `.claude/skills/**` (or keep a per-skill `fixtures/*.ts` mirroring them) and run `tsc --noEmit`/`bun build` against the repo's real `effect@beta.93`; for CLI examples, assert the binary and flags exist (`glance --help` surface check); plus the trivial tier — frontmatter shape + no dangling relative links. Wire into the existing ratchet/gate suite so doc drift fails the build.
**Value for omp-squad**: This is the repo's central lesson — false-green, fail-open, "absence of evidence encoded as evidence of absence" — applied to the docs layer. Our 8 repo skills (`execute-plan`, `make-it-work`, `scratch-daemon`, `bounce`, …) quote CLI invocations, env vars, and API shapes that have already drifted before (memory records `openIntervene` with zero callers, never-run lens tests, stale skill references). Nothing today catches a skill that lies.
**Where it applies**: `.claude/skills/*/SKILL.md`, `scripts/` (new gate), CI gates config; secondarily the R3 primer content and fabric KB chunks.
**Build vs Buy**: Build — the deleted `scripts/validate.ts` + `examples/typecheck.ts` shape is ~100 lines and must target our own skills; nothing to adopt (the author deleted theirs).

### 2. Learning-ledger → Do-Nots: negative-space spec naming the agent's rationalization

**Pattern**: Guidance closes with anti-patterns phrased to pre-empt the *exact plausible-but-wrong move* an LLM makes — naming the rationalization, not just the error ("do not X just because Y sounds faster").
**Mechanism**: Each recurring failure mode in the learning ledger gets distilled into a one-line Do-Not and injected into dispatch prompts / the primer for matching task shapes. E.g. "Do not report the chunk-size warning as a finding — it is known and benign"; "Do not re-run the verify loop on a unit that failed it twice — escalate"; "Do not treat a passing suite as proof the gate ran — check the run marker."
**Value for omp-squad**: The learning ledger (PR #150-era) records lessons but units don't systematically *receive* them as behavioral constraints; memory shows the same nerd-snipes recurring (chunk-size warning, verify-loop thrashing, rtk-mangled grep). Do-Nots are the cheapest transport for negative knowledge into a fresh context.
**Where it applies**: dispatch prompt composition in the daemon (unit brief assembly), R3 primer sections, `.claude/skills/squad` and `fleet-ide-loop` bodies.
**Build vs Buy**: Build — pure prompt/composition work over existing ledger plumbing.

### 3. Source Rule + `compatibility` frontmatter: staleness as a checkable claim

**Pattern**: Agent guidance opens by subordinating itself to live ground truth (installed versions, repo config) and declares in frontmatter exactly what it was verified against — turning staleness from a silent lie into a checkable, dated claim.
**Mechanism**: Convention for every repo skill and primer section: `verified-against: <package@version | commit-sha | date>` frontmatter plus a standard opening line ("check the installed version / live daemon state before trusting examples here"). The concept-1 gate can then *enforce* freshness: if `verified-against` predates the pinned dep's bump, the gate flags it.
**Value for omp-squad**: Fits the honesty-as-architecture meta-pattern directly. The fabric KB and primer feed every unit; today a stale claim is indistinguishable from a fresh one. Memory recall already carries a "verify it still exists" warning — this makes the same posture structural in the skill/primer layer.
**Where it applies**: `.claude/skills/*` frontmatter convention, primer assembly (stamp sections with source SHA), fabric chunk metadata.
**Build vs Buy**: Build — a convention plus ~20 lines in the gate from concept 1.

### 4. Router-shaped skills (branch chooser / progressive disclosure)

**Pattern**: The always-loaded skill body is a small decision procedure (≤ ~7KB) that routes to on-demand reference files by task shape; the agent reads only matching branches.
**Mechanism**: Restructure the heaviest repo skills into `SKILL.md` (core rules + branch chooser) + `references/*.md`. `execute-plan` alone carries adversarial-panel, batching, stacked-PR, and crash-recovery choreography that a given invocation mostly doesn't need.
**Value for omp-squad**: Every skill invocation in every fleet unit pays the monolith's full context cost; on multi-skill units that compounds. Same pattern applies to the R3 primer — route by unit task shape instead of dumping everything to every unit.
**Where it applies**: `.claude/skills/execute-plan`, `squad`, `make-it-work`, `fleet-ide-loop`; primer assembly in the daemon.
**Build vs Buy**: Build — mechanical restructuring, no dependency.

### 5. Adopt the `effect` skill itself (quick win, narrow scope)

**Pattern**: n/a — this is the direct buy.
**Mechanism**: Copy `skills/effect/` (MIT) into `.claude/skills/effect/`, then adapt: our pin is `beta.93` vs the skill's `beta.97` review target (same beta line — near-zero drift risk, but diff the two versions' changelogs); reconcile its conventions against ours (we already have Effect v4 gotchas recorded from PRs #76/#81–#87 — fold those in as extra Do-Nots; drop or demote the exotic self-export namespace pattern unless it matches our style); keep the Source Rule pointing at our own pinned version.
**Value for omp-squad**: Fleet units and subagents write Effect code today with no Effect guidance at all; the known-v4-gotchas memory exists but reaches only this orchestrator, not units. An authoritative, opinionated Effect v4 skill directly reduces hallucinated APIs in fleet output.
**Where it applies**: `.claude/skills/effect/`, referenced from unit dispatch for Effect-touching tasks.
**Build vs Buy**: **Buy then adapt** — the author's domain authority and the tsc-proven examples are exactly the hard part; MIT license, actively authored (today), though single-author and hours old — pin the SHA we vendored and re-verify via the concept-1 gate rather than tracking upstream.

### Ranking rationale

1 > 2 > 3 because they attack the repo's proven #1 failure class (fail-open / false-green) at a layer nothing currently covers, and 3 is enforceable only once 1 exists. 4 is real but pure efficiency. 5 is near-zero-cost and immediately useful, but its blast radius is only Effect-touching tasks. 1+3+5 compose naturally into a single small plan: vendor the skill, build the verify gate, stamp everything with `verified-against`.

### Meta-insight (for the record, not a work item)

The harness deletion was only discoverable via commit archaeology. When scouting any skills/prompt repo, read `git log` diffs, not just HEAD — authoring/verification tooling is exactly what gets stripped before publish, and its presence in history is a strong quality signal (here: every example provably compiled against `effect@4.0.0-beta.97`).

# Research brief — EAP (Efficient Agent Protocol)

- **Source**: https://github.com/ZeroPointNineBar/EAP
- **Researched**: 2026-07-09, `/research` pipeline (scout → comparator (sonnet) → strategist (fable))
- **Target project**: glance (omp-squad) — autonomous agent-fleet orchestrator
- **Verdict**: do **not** adopt the dependency; **borrow 6 patterns**, 2 of which fold directly into the
  post-G3 fleet-learning work. The most valuable extraction is a *measurement doctrine*, not machinery.

## Scout brief

EAP is a 2-day-old (created 2026-07-07), sole-maintained, MIT, zero-third-party-dependency
"Efficient Agent Protocol": one protocol with a compression gate at each **membrane** an AI coding
agent's tokens cross — plus a code-brevity discipline:

| Membrane | Layer | Mechanism | Status |
|---|---|---|---|
| Input (retrieval) | **EAP-Context** | local stdlib code-symbol graph, 10 langs (Python `ast` + bounded regex for the rest); returns `file:line` pointers + small subgraphs instead of file dumps; shortest-path / community / centrality as MCP tools; incremental per-file re-index | built, opt-in |
| Working (tool output) | **EAP-Runtime** | "think in code": run a script in a subprocess (12 langs), only its printed summary re-enters context; output over a size threshold auto-indexed into a local SQLite dual-tokenizer FTS store (RRF-fused) and replaced by a searchable pointer; SSRF-hardened fetch is the only egress; session event log + PreCompact snapshot + SessionStart resume so compaction loses nothing | built (clean-room), opt-in |
| Output (prose) | **EAP-Signal** | prompt-only verdict-first discipline; code/paths/errors/safety text byte-exact; 6 intensity levels | shipping, default-on |
| Output (code) | **EAP-Lean** | prompt-only 7-rung minimal-code ladder (need to exist → reuse in-repo → stdlib → native → dep → one line → minimum), stop at first rung that holds; HARD safety carve-outs override brevity (validation, data-loss handling, security, a11y, one runnable check per non-trivial path) | shipping, default-on |

Shared substrate: one `.eap/` project root, ONE hook dispatcher fanning out per lifecycle event
(SessionStart / PreToolUse "graph-nudge" / PostToolUse offload / PreCompact snapshot), one installer
over a ~35-agent provider matrix.

**The two postures that matter more than the machinery:**

1. **Measurement doctrine** (`docs/EFFICIENCY.md`): realistic baseline = a competent grep-and-read
   agent, never the dump-everything strawman (which may be shown but must be *labeled* strawman);
   per-layer gains reported separately, **never multiplied** into a compounded headline; **task
   success is a first-class metric next to every token count** — a config that saves tokens but
   lowers success is a *regression*, not a tradeoff; lossy (summaries) vs lossless (pointers/exact
   chunks) retrieval reported separately, each **with recall**; full per-task distribution, no
   cherry-picked rows; **"reproducible or unpublished"** — if the committed bench harness can't
   regenerate a number it doesn't appear in the README. EAP refuses to reprint its own upstream
   sources' 99%-class claims, calling them strawman-baselined.
2. **Honesty-as-architecture**: the installer's `--list` is an authoritative capability matrix —
   agents it can fully wire are "end-to-end", agents it merely detects get an honest per-agent
   manual plan and the label "planned"; it never claims to have wired what it hasn't implemented.
   The executor's deny-list is explicitly labeled "a policy control, NOT a sandbox". Within the
   policy layer it fails closed: unreadable file → refuse to execute; contamination-scan grep
   *error* (exit ≥2) → hard failure, not silent pass. Egress rules (scheme allowlist, port
   allowlist 80/443, credential stripping, IP guard) are re-applied **on every redirect hop**.

Prime directive: correctness/safety/tool-use lexically outrank tokens — an override rule, not a
weighted score. Every compression layer is independently opt-out with a lossless escape hatch.

Caveats on the source: 0 stars, 2 days old, sole-maintained, no external users; the bench corpus is
82 KB with 6 fixed tasks (37.3% aggregate reduction vs its honest grep baseline, 6/6 task success).
Treat it as a well-argued design document, not a proven system.

## Comparator table (concept extraction)

| Concept | How EAP implemented it | Transferable? | Why / why not |
|---|---|---|---|
| Membrane framing of token cost | input/working/output treated as independently compressible layers, each with its own opt-in posture and its own measurement | Yes | glance's cost surfaces (unit context priming, harness tool output, unit-authored prose/diffs) are reasoned about ad hoc today; naming them gives each a place to hang separate measurement and separate opt-out |
| Pointer-over-payload retrieval | graph returns `file:line` pointers + subgraphs, agent opens only what it needs | Yes | generalizes to any glance path that returns full blobs where an address + on-demand fetch would do |
| "Think in code" summary offload | script runs in subprocess, only printed summary re-enters context | Partially | applies where a harness reasons over large structured data; NOT where the raw data *is* the thing under review (a diff) and summarizing is the risk |
| **Auto-offload-on-threshold behind a searchable pointer** | oversized tool output indexed into local FTS, replaced in-context by a pointer — never truncated | **Yes — high** | strictly better than clipping; glance truncates in several load-bearing places today (see strategist #2) |
| Deterministic-first compression layer | the relevance-decider is ast/regex, no LLM — cheap, auditable, failures legible | Yes (design bias) | when reducing what an agent sees, prefer a deterministic pass; a wrong pointer is debuggable, a bad LLM summary is not |
| Prompt-only behavior layers | Signal/Lean are pure prompt disciplines, zero runtime | Yes | not every efficiency concern needs a subsystem; some are a well-specified default instruction with named exceptions |
| Ordered decision ladder, first-rung-wins | 7 rungs of increasing cost, stop at first that holds | Yes (pattern) | reusable anywhere the fleet picks among strategies of increasing cost/risk |
| **Hard safety carve-outs override the optimization objective** | named non-negotiable exceptions beat brevity, baked in at design time | Yes | the mechanism (explicit named exception list, not model judgment under pressure) transfers to any glance optimizer |
| One dispatcher + one substrate per lifecycle event | single hook fan-out, single `.eap/` root | Yes | one auditable place to see every lifecycle consumer |
| **Installer honesty matrix (capability tiers)** | end-to-end / detected+manual-plan / planned; never claims unwired work | **Yes — high** | glance's `verified: boolean` is the same idea, poorer: a tier enum + authoritative surface is the mature form |
| Managed marker-fenced config blocks | reversible, additive edits to files it doesn't own; clean uninstall | Yes | reusable primitive for anything glance writes into user/repo config |
| Lossless escape hatch per layer | every compression layer independently opt-out at the same granularity | Yes | constraint on any future glance summarization feature |
| **Measurement: realistic baseline, labeled strawmen** | B1 grep-and-read agent is the honest baseline; B0 always labeled | **Yes — high** | applies to every internal "harness X beats Y / saves Z" claim the fleet ledgers will soon make |
| **Measurement: per-layer, never compounded** | independent gains never multiplied into one headline | Yes | stacked-optimization claims across lanes/retrieval/gates produce a number nobody observed |
| **Measurement: task success co-equal** | every token count paired with success; cheaper-but-lower-success = regression *by definition* | **Yes — the single most important transferable idea** | reframes efficiency as joint optimization; belongs in the fleet scoreboard before routing consumes it |
| Measurement: lossy vs lossless with recall | summaries and exact-pointer retrieval never blended | Yes | discipline for fabric search + any future summarizer |
| **Measurement: reproducible or unpublished** | no number in the README the committed harness can't regenerate | **Yes — high** | would catch plan-doc/ledger numbers not backed by a runnable committed check |
| Security honesty labeling | "policy control, NOT a sandbox" | Yes | glance's gates should never be overstated either (glance is ahead here — its gate sandbox is a real container) |
| **Fail-closed on checker failure** | scanner error (exit ≥2) = hard failure; unreadable file = refuse to run | **Yes — high** | glance's worst historical bug class (the fail-open regression gate took 6 layered fixes); generalize into an audit invariant |
| **Per-hop revalidation** | all egress rules re-applied at every redirect hop | Yes (narrow) | "checks bypassable by a later step must re-run at that step" — glance's `ssrf.ts` validates once at entry |
| Compaction-safe state | event log + PreCompact snapshot + SessionStart resume | Yes | glance already shipped the equivalent (cold-adopt context restore); cross-reference, mostly done |
| Prime directive as lexical ordering | correctness outranks tokens as an override rule, not a blended score | Yes | prevents any optimizer from trading the wrong thing to hit a number |
| Bounded incremental re-indexing | only changed files re-extracted | Partially | standard hygiene; low extraction priority |
| Graph algorithms as agent-callable tools | path/community/centrality live MCP tools, not precomputed dumps | Yes | "give the agent query primitives over structure, not a dump" — applies to graphs glance already has |

**Design tensions**: completeness sacrificed for zero-dep determinism (regex extractors for 9/10
languages); persuasiveness sacrificed for credibility (smaller published numbers nobody can catch
them lying about); convenience sacrificed for fail-closed friction; riskier (lossy) layers are
opt-in until the doctrine proves they don't regress success, while free prompt-only layers are
default-on.

**Recurring patterns**: honesty-as-architecture (installer, bench, security — the system names its
actual capability tier, and the naming is load-bearing); pointer-not-payload at every membrane
("shrink the wrapper, never the referent"); every seam that could trade correctness for tokens gets
a named local circuit-breaker at that exact seam.

## Strategist — ranked patterns for glance

*(all paths verified against the repo on 2026-07-09)*

### 1. Success-coupled efficiency accounting (the measurement doctrine, as ledger schema + scoreboard rule)
**Pattern**: every token/cost number is stored and displayed *paired with task success at the same
granularity*; a lane/model/config that costs less but succeeds less is flagged as a regression by
definition, not presented as a tradeoff; comparative claims name their baseline; independent gains
are never compounded; a scoreboard number that no committed check can regenerate doesn't render.
**Mechanism**: extend the outcome rows and the scoreboard read-models so (tokens, cost, success)
travel together; add a "regression" derivation (cheaper ∧ lower-success vs the incumbent lane);
label any synthetic baseline row.
**Value for glance**: the fleet-learning loop was empirically starved until G1 (`model-outcomes`
had ~1 row); post-G3 it will fill and the router will start consuming it. Baking the doctrine into
the schema *now* is 10× cheaper than retrofitting after routing decisions depend on it. It also
directly serves the existing task-class×model scoreboard goal.
**Where**: `src/task-outcomes.ts`, `src/model-outcomes.ts`, `src/harness-scorecard.ts`,
`src/attribution-scoreboard.ts`, `src/threshold-tuner.ts`, webapp scoreboard panels.
**Build vs buy**: build — it's a schema/display discipline, ~zero new machinery.

### 2. Offload oversized output behind a searchable pointer (fabric as the FTS store)
**Pattern**: above a size threshold, index the full blob into the local search store and hand the
consumer a pointer + query primitive; never truncate-and-drop. Lossless escape hatch: the full blob
stays retrievable.
**Mechanism**: glance already has the substrate — the BM25 fabric (`src/fabric.ts`,
`src/fabric-search.ts`). Add an "offload" write path (blob → fabric doc + pointer id) and a
retrieval tool for units/validators.
**Value for glance**: today the validator judges a diff truncated to 12,000 chars and a proof tail
truncated to 2,000 (`src/validator.ts:181-182,302-303`) — veto/confidence are computed on a lossy
view of exactly the artifact under review; `src/land-pr.ts:636` truncates acceptance-gate output to
600 chars in the failure detail. Pointer + search keeps the signal without blowing context.
**Where**: `src/validator.ts`, `src/land-pr.ts`, `src/fabric.ts`, `src/fabric-search.ts`; optionally
the unit cold-start primer (pointers instead of inlined content).
**Build vs buy**: build on fabric. Do NOT adopt EAP-Runtime (SQLite FTS store) — duplicate substrate.

### 3. Honesty tiers for the harness matrix (upgrade `verified: boolean` to capability tiers)
**Pattern**: integration claims are a machine-checkable tier enum — *end-to-end verified* /
*registered-unverified (hidden until live smoke proves)* / *detected, with an honest manual plan* /
*unsupported* — with one authoritative list surface; the system never claims to have wired what it
hasn't.
**Mechanism**: widen `verified: boolean` (`src/harness-registry.ts:74`) to a tier field; surface the
matrix in the create UI and a `squadctl harnesses` listing; keep the existing "hidden until live
smoke" discipline as the promotion path between tiers.
**Value for glance**: the registry already half-does this (unverified harnesses hidden, concern-08
live-smoke promotion, `hasSecondVerifiedProviderLane`); the tier enum makes the posture legible to
users and to the router, and gives "detected but not wired" a place to live instead of being absent.
**Where**: `src/harness-registry.ts`, webapp create surfaces, TUI/CLI listing.
**Build vs buy**: build — small.

### 4. Checker-error = check-failed sweep (fail-closed audit as an invariant)
**Pattern**: any gate, scanner, or audit whose *own failure* (nonzero exit, unreadable input, empty
result-where-impossible) is treated as "pass" is fail-open; the invariant is "an inconclusive check
is a failed check", enforced everywhere a checker's error path exists.
**Mechanism**: one breadth sweep enumerating every gate/probe/audit call site and classifying its
error path (fails closed / fails open / ambiguous), then fix the fail-opens. This is exactly
grok-4.5's lane (repo-wide sweep, adversarial gate review — it found the planted fail-open gate
class in 28s).
**Value for glance**: the fail-open regression gate was the 6th layered root cause of
factory-never-green and the most expensive bug class in the project's history. EAP independently
converged on the same invariant; glance has fixed *instances* but never audited the *class*.
**Where**: `src/gate-runner.ts`, `src/proof.ts`, `src/done-proof.ts`, `src/validator.ts`,
`src/orphan-audit.ts`, `src/drift-audit.ts`, `src/land-pr.ts`, and every probe in `src/land-mode.ts`.
**Build vs buy**: build — an audit pass + targeted fixes, not a subsystem.

### 5. Membrane disciplines as Agent Profile skills (prompt-only output compression for units)
**Pattern**: verdict-first output prose + a minimal-code decision ladder with *named, hard safety
carve-outs* as injectable per-profile rules — zero runtime, pure prompt.
**Mechanism**: author glance-native rule texts (concepts are MIT; write our own) and carry them on
the Agent Profiles SKILLS axis so any unit, on any harness, can get them; optionally teach the
validator rubric the ladder ("did the unit add a dependency where stdlib sufficed?").
**Value for glance**: units burn output tokens across 6+ harnesses ($36.77 of gpt-5.5 surfaced by
one ingester); this is the cheapest category of saving and the profiles plumbing
(`plans/agent-profiles/02-skills-mcp-binding.md`, `src/agent-profiles.ts`) already exists.
Measure per doctrine #1 — if success drops, it's a regression, revert.
**Where**: `.glance/profiles.json` catalog, `src/agent-profiles.ts`, `plans/agent-profiles/`.
**Build vs buy**: build (borrow concepts, not text).

### 6. Per-hop revalidation of egress guards (narrow, verify-first)
**Pattern**: a guard that validates a value once at entry, where a later step (redirect, re-resolve,
re-derive) can change the value, must re-run at that step.
**Mechanism**: check whether the fetch behind `checkVisionUrl` (`src/ssrf.ts:148`) follows
redirects; if it does, re-apply the origin/IP checks per hop (and strip URL credentials). If it
doesn't follow redirects, document that as the load-bearing property.
**Value for glance**: closes a classic SSRF bypass if present; cheap either way.
**Where**: `src/ssrf.ts`, the vision fetch path (`src/vision.ts`).
**Build vs buy**: build — tiny.

### Cross-references / already-covered
- **Compaction-safe snapshot/resume**: glance shipped the equivalent (observational-memory
  cold-adopt restore, PR #78). No action.
- **Code-symbol graph (EAP-Context)**: duplicated by CodeGraph, already deployed for this user.
  Do not rebuild. The residual idea — *query primitives over structure instead of dumps* — is
  worth remembering for the fleet ledger and dependency graphs.
- **Security honesty labeling**: glance's gate sandbox is a real container (`--user`, network
  policy) — glance is *ahead* of EAP here; keep it that way in docs/UI copy.

## Recommendation

Intel is actionable but **none of it should preempt G3** (run the factory to completion once —
`plans/orchestration/ONE-GREEN-LOOP.md`). Sequencing: fold **#1** into the post-G3 fleet-learning
work before the router consumes the ledger; run **#4** as a standalone grok sweep any time (it
needs no daemon changes); **#2/#3/#6** are small standalone PRs; **#5** rides the agent-profiles
plan. Adopt nothing from EAP as a dependency.

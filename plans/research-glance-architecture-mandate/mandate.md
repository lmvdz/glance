---
title: "Architecture Mandate: Glance as an Evidence-Backed, Time-Aware Engineering Intelligence System"
subtitle: "A code-grounded assignment for a principal architect and senior staff engineer"
author: "Prepared from the Glance architecture working session"
date: "2026-07-16"
version: "1.0"
---

# Mandate

You are acting as a principal architect, senior staff engineer, systems researcher, and adversarial design reviewer.

Your assignment is to inspect the actual `Lmvdz/glance` repository in depth, determine what is already implemented, identify the highest-leverage architectural opportunity, and return an implementation-ready decision for where Glance should go next.

This is not a request for encouragement, a technology survey, a restatement of the product vision, or a generic knowledge-graph proposal. Treat the code, tests, persistence formats, runtime behavior, and failure semantics as the source of truth. Make a decision.

Repository:

```text
https://github.com/Lmvdz/glance
```

Research references that motivated parts of this mandate:

```text
https://arxiv.org/abs/2607.12605
https://arxiv.org/list/cs/new
```

Read the referenced paper directly. Do not rely on summaries in this mandate. Verify which claims, methods, and empirical results are actually present before using them.

At the beginning of your report, record:

```text
Glance commit inspected: <full SHA>
Inspection date: <date>
Runtime/toolchain used: <versions>
Tests or checks executed: <commands and outcomes>
Material limitations: <anything you could not inspect or run>
```

# The Decision You Must Make

Answer this plainly:

> What is the single best next architectural move for Glance, given its actual codebase, product promise, available evidence, implementation risk, and long-term direction?

You must choose one primary wedge. Do not return five equal recommendations.

Your recommendation must explain:

1. What Glance should build next.
2. Why that wedge is superior to the alternatives.
3. What Glance should explicitly not build yet.
4. How the wedge can be evaluated before becoming a hard enforcement dependency.
5. How it creates leverage for later capabilities without requiring a speculative rewrite.

The working hypothesis is that a **semantic land assessment** or another narrowly scoped slice of a temporal Repository State Engine may be the strongest wedge. Treat that as a hypothesis to test against the code, not as a predetermined answer.

# Product Context

Glance is intended to be a control plane for autonomous software-engineering agents.

Agents operate in isolated Git worktrees, execute tasks, run verification, and attempt to land changes into a shared target branch. A human operator may supervise many parallel agents and should be interrupted only when judgment or authorization is genuinely required.

The central product promise is:

> An operator can delegate substantial software work and trust Glance to determine whether the result is coherent, complete, sufficiently proven, architecturally appropriate, and safe to land.

The central failure mode is not simply that agents write broken code. Agents frequently produce work that is locally valid and globally poor:

- the targeted tests pass, but only part of the goal is implemented;
- the branch merges cleanly, but it conflicts semantically with parallel work;
- the task is satisfied literally, but an architectural invariant is weakened;
- a shortcut solves today's ticket while materially increasing future migration cost;
- a policy is duplicated in the wrong layer;
- an existing abstraction is bypassed instead of extended;
- operational burden is introduced without observability;
- agent self-reporting sounds confident despite incomplete evidence;
- a green suite proves only the tests that exist, not that affected behavior is adequately covered.

The problem is therefore broader than agent orchestration. It is the governance of autonomous engineering decisions over time.

# Core Thesis: State, Not Merely Memory

Do not approach this primarily as an AI-memory project.

The important distinctions are:

```text
Memory asks:
What happened?

Execution asks:
What ran?

Evidence asks:
What was observed, by whom, under what conditions?

State asks:
What is the best currently justified model of the software system?

Temporal state asks:
What was believed to be true at repository state X,
what evidence supported that belief,
and how did it change?

Trajectory asks:
What direction is the system moving toward?

Time-horizon reasoning asks:
Is this implementation appropriate for its expected lifetime
and anticipated future pressure?
```

The proposed long-term center of gravity is an **evidence-backed, temporal Repository State Engine**: a continuously maintained, queryable operating model of the software system and the engineering process around it.

Conceptually:

```text
Repository entities
    +
Temporal assertions
    +
Evidence and provenance
    +
Commit-addressed semantic deltas
    +
Explicit uncertainty and authority
    =
Queryable repository state at any point in time
```

The engine should never claim metaphysical truth. It should maintain the best evidence-backed model Glance can justify, preserving disagreement, uncertainty, extraction gaps, and stale evidence.

# The Three Feedback Loops

Evaluate Glance as three interacting loops rather than a collection of isolated agents.

## Loop 1: Execution

```text
Goal
  -> Plan
  -> Agent work
  -> Verification
  -> Landing
  -> Repository state
```

This loop delivers software. It is the closest to Glance's current center of gravity.

## Loop 2: Reflection

```text
Repository and fleet state
  -> Observer and architectural analysis
  -> Patterns, drift, debt, and open questions
  -> Decisions or corrective work
  -> Updated repository state
```

This loop examines whether the engineering system is becoming healthier or merely completing tasks.

## Loop 3: Learning

```text
Open questions and blockers
  -> Internal history and external research
  -> Candidate hypotheses
  -> Controlled experiments
  -> Evidence
  -> Updated decisions and plans
```

This loop allows the organization to improve its technical understanding.

The authority boundary is essential:

```text
Research produces hypotheses.
Experiments produce evidence.
Operators and policy authorize decisions.
Accepted changes update repository state.
```

Research novelty must not become architectural policy merely because it is interesting or recent.

# Sources of Evidence and Consumers of State

A useful architectural inversion is:

```text
Sources of evidence
-------------------
Git
AST and language servers
Compilers and static analysis
Tests and benchmarks
Agent runs
Human decisions
Production telemetry
Research papers
External repositories

          -> Repository State Engine ->

Consumers of state
------------------
Context assembly
Planning
Verification
Landing
Observer
Repository Architect
Agent routing
Historical explanation
Research matching
Experiment design
Dashboard projections
```

Determine whether the existing code already approximates this separation, where it violates it, and whether a new boundary would simplify or complicate the system.

# Multi-Graph Logical Model

Do not assume one universal graph or one physical graph database is the correct implementation.

Evaluate several logical graph families with explicit ownership, temporal semantics, and authority rules. They may share one physical store, use ordinary relational or document persistence, or exist as derived projections. Choose storage based on access patterns and reliability, not fashion.

## Repository Graph

Entities may include:

```text
Repository
Commit
Branch
Worktree
File
Package
Module
Symbol
Interface
API
Schema
Configuration
Generated artifact
Ownership boundary
Architecture boundary
```

Relationships may include:

```text
CONTAINS
DECLARES
IMPORTS
CALLS
DEPENDS_ON
IMPLEMENTS
EXTENDS
READS
WRITES
EXPOSES
OWNS
GENERATES
CONFIGURES
```

## Execution Graph

Entities may include:

```text
Agent execution
Process
Command
Compiler result
Static-analysis result
Test run
Benchmark
Runtime trace
Stack trace
Failure
Environment
Artifact
Verification run
```

Relationships may include:

```text
EXECUTED
OBSERVED
FAILED_AT
EXERCISED
PRODUCED
CONSUMED
COVERED
REGRESSED
TIMED_OUT
REPRODUCED
```

## Planning Graph

Entities may include:

```text
Goal
Plan
Feature
Acceptance criterion
Roadmap initiative
Task
Decision
Constraint
Assumption
Dependency
Milestone
```

Relationships may include:

```text
DECOMPOSES_INTO
DEPENDS_ON
REQUIRES
SATISFIES
BLOCKS
CONSTRAINS
JUSTIFIES
CONTRADICTS
SUPERSEDES
```

## Evidence Graph

Entities may include:

```text
Receipt
Proof
Verification result
Coverage result
Land result
Regression comparison
Human approval
Audit event
Reproduction result
```

Relationships may include:

```text
PROVES
SUPPORTS
REFUTES
PARTIALLY_SUPPORTS
COVERS
VALIDATES
AUTHORIZES
EXPIRES_AT
APPLIES_TO_COMMIT
```

## Fleet Graph

Entities may include:

```text
Agent
Profile
Model
Harness
Runtime
Tool
Skill
Workflow
Task class
Attempt
Outcome
Cost
Intervention
```

Relationships may include:

```text
EXECUTED_BY
ROUTED_TO
USED_MODEL
USED_PROFILE
USED_SKILL
SUCCEEDED_WITH
FAILED_WITH
ESCALATED_TO
REQUIRED_INTERVENTION
```

## Research Graph

Entities may include:

```text
Paper
Paper version
Claim
Method
Problem
Benchmark
Dataset
Constraint
Limitation
Implementation
Dependency
Prior work
```

Relationships may include:

```text
PROPOSES
CLAIMS
EVALUATES_ON
OUTPERFORMS
REQUIRES
LIMITED_BY
IMPLEMENTED_BY
EXTENDS
CONTRADICTS
```

## Applicability Graph

This graph joins external research to internal engineering state.

Entities may include:

```text
Research claim
Internal blocker
Open architectural question
Repository component
Constraint
Experiment
Decision
Outcome
```

Relationships may include:

```text
MAY_ADDRESS
APPLIES_TO
INFORMS
SUPPORTS
WEAKENS
CONFLICTS_WITH
REQUIRES_CAPABILITY
TESTED_BY
REJECTED_BECAUSE
INTEGRATED_INTO
```

## Deliberation Graph

This preserves the evolution of architectural reasoning rather than only the final ADR.

Entities may include:

```text
Question
Hypothesis
Candidate architecture
Argument
Counterargument
Evidence
Counterevidence
Experiment
Decision
Assumption
Revisit condition
```

Relationships may include:

```text
PROPOSES
SUPPORTS
WEAKENS
CONTRADICTS
TESTED_BY
DECIDED_BY
ASSUMES
REVISIT_WHEN
SUPERSEDES
```

This graph should answer not only “what did we decide?” but also:

- Which alternatives were seriously considered?
- Which evidence changed the decision?
- Which assumptions remained uncertain?
- What would trigger reconsideration?
- Which paper, incident, benchmark, or failed implementation influenced the direction?

## Graph Ownership Questions

Your design must determine:

- which logical graph owns each fact;
- how entity identity is shared across graphs;
- which assertions are stored and which are projections;
- how facts propagate between graphs;
- what propagation is deterministic versus inferred;
- how conflicting assertions coexist;
- when evidence can promote an inferred assertion;
- how stale assertions expire or are superseded;
- how query results expose uncertainty;
- whether a query spans graph families synchronously or through materialized projections.

# Evidence Pipeline

A non-negotiable principle is:

> Raw information must not become architectural truth directly.

Use a pipeline such as:

```text
Raw signal
  -> Extraction
  -> Structured observation
  -> Evidence
  -> Validation
  -> State assertion
  -> State update or dispute
```

Raw signals include:

```text
Git diffs
AST output
LSP output
Compiler output
Test output
CI failures
Runtime traces
Terminal logs
Agent transcripts
Agent hypotheses
Benchmark output
Operator actions
Research papers
External repositories
Production telemetry
```

Requirements:

1. Preserve raw evidence for audit and reprocessing when practical.
2. Version every extractor and derived algorithm.
3. Record which repository commit, environment, and policy an observation applies to.
4. Make lossy consolidation reversible by retaining references to source material.
5. Do not allow concise summaries to acquire authority merely because they are easier to consume.
6. Expose extraction coverage and gaps. Missing information must remain unknown, not safe.

# Authority and Epistemic Model

Every assertion must carry an explicit authority class.

## Tier 1: Deterministic or Authoritative

Examples:

```text
Git ancestry and tree state
Content hashes
AST structure
Compiler output
Language-server symbol resolution
Executed test results
Verification receipts
Explicit policy
Operator decisions
```

## Tier 2: Derived

Examples:

```text
Impact analysis
Coverage mapping
Dependency cycles
Centrality
Blast radius
Architecture drift
Semantic conflict detection
Criterion-evidence coverage
Trajectory analysis
```

## Tier 3: Inferred

Examples:

```text
Design intent
Concept ownership
Root-cause hypothesis
Architectural recommendation
Likely future effect
Research applicability
```

Tier 3 assertions must never silently overwrite Tier 1 facts.

The system must represent at least:

```text
proven
observed
derived
inferred
disputed
stale
unknown
```

Every assertion should carry fields equivalent to:

```text
authority
confidence
source
supporting evidence
contradicting evidence
valid from commit
valid until commit
observed at
repository scope
actor scope
extractor version
policy version
```

Do not hide epistemic differences behind one opaque confidence number.

# Temporal and Commit-Addressed State

Avoid storing a complete duplicated graph for every timestamp unless measurements justify it.

Prefer:

```text
Immutable entities
  + Temporal assertions
  + Commit-addressed deltas
  + Periodic checkpoints where useful
  + Deterministic reconstruction
```

Conceptually:

```text
RepositoryState(t)
  + SemanticDelta(commit)
  = RepositoryState(t+1)
```

Account for Git's graph rather than assuming a linear timeline:

- branches diverge;
- commits are rebased or squashed;
- cherry-picks duplicate semantic changes under different SHAs;
- merges combine ancestry;
- worktrees contain uncommitted candidate state;
- generated files can change without representing an independent design decision.

Every accepted land operation should generate a semantic delta. Every rejected attempt should still generate evidence about the candidate, its proof, and the reason it was rejected.

Proof must be scoped to an exact state:

```text
commit or content identity
environment
extractor version
verification policy
relevant dependency versions
time of observation
```

A proof must not remain valid merely because the entity name still exists.

# Stable Identity

Stable identity is one of the hardest parts of this design. Address it explicitly.

Your proposal must explain identity across:

```text
file renames
symbol renames
file moves
signature changes
symbol splits and merges
code generation
rebases
squashes
cherry-picks
branch divergence
language migration
monorepo package moves
```

Consider evidence such as:

- compiler or language-server identity;
- AST fingerprints;
- qualified names and signatures;
- file and Git rename evidence;
- structural similarity;
- call-neighborhood similarity;
- agent-declared intent;
- human confirmation.

Do not let an LLM alone assign durable identity.

Represent identity uncertainty rather than forcing false continuity.

# Static Structure, Dynamic Execution, and Structured Reasoning

Read arXiv:2607.12605 directly and evaluate what it actually demonstrates about combining static program structure, temporal execution information, evidence filtering, and multiple reasoning perspectives.

The reusable principle to investigate is:

> Convert noisy runtime evidence into compact structured representations before higher-level reasoning.

Do not copy a program-repair architecture wholesale. Determine which parts generalize to persistent repository governance.

Preserve this separation:

```text
Execution graph
  -> Evidence
  -> Repository-state assertion
```

Examples:

- A test traversing a path is evidence of runtime reachability. It does not prove that the path is intended architecture.
- A benchmark revealing a bottleneck is evidence of behavior. It does not prove the inferred root cause.
- An agent saying that a module “owns authentication” is a hypothesis. It becomes stronger only when supported by code structure, decisions, tests, and operator confirmation.

Evaluate whether perspective-specific agents or analyzers should consume the same structured substrate:

```text
Static-structure reviewer
Dynamic-execution reviewer
Acceptance-criteria verifier
Long-horizon critic
Security reviewer
Synthesis or landing decision
```

Do not solve disagreement by averaging prose. Preserve evidence and explicit conflicts.

# Context Engineering and Working Memory

Large token windows do not eliminate the need for context engineering. They increase the cost of poor signal selection.

Agents should receive a constructed working state rather than a bag of top-k chunks.

A task context package may contain:

```text
mission and requested outcome
current plan and dependencies
declared time horizon
branch, worktree, and base state
acceptance criteria
relevant repository neighborhood
affected symbols, APIs, schemas, and tests
active parallel work
recent decisions and constraints
known failures and prior attempts
required proofs
registered temporal debt
architectural invariants
anticipated future changes
uncertainties and extraction gaps
```

Evaluate whether the current `fabric` and `fabric-search` implementation should:

1. remain the canonical memory model;
2. be extended directly;
3. become a textual projection over a higher-fidelity state model;
4. be replaced in a narrow path while remaining intact elsewhere.

A likely retrieval sequence is:

```text
Resolve task concepts to state entities
  -> Traverse relevant relationships
  -> Apply scope, authority, and temporal filters
  -> Produce structured candidate facts
  -> Render textual documents
  -> Rank with BM25, embeddings, or a learned reranker
  -> Assemble context under a token and risk budget
```

Structural retrieval and lexical or semantic ranking are complementary. Neither is the source of truth.

# Memory-Harness Technique Triage

Evaluate frontier memory ideas according to the layer Glance actually controls.

## Model-Level KV Compression and Sparse Attention

Treat multi-head latent attention, KV compression, streaming attention, and provider-specific sparse attention primarily as model-provider concerns.

Glance may optimize for stable prefixes and smaller working contexts, but it should not architect its durable state around inference mechanisms it cannot control.

## Event-Centric Semantic Consolidation

This is relevant inside Glance when transforming transcripts, terminal logs, and old agent runs into structured events and evidence.

Do not reduce the design to prose summarization. Prefer transformations such as:

```text
conversation or transcript
  -> events
  -> claims
  -> entities and relationships
  -> commands and outcomes
  -> failed hypotheses
  -> successful procedures
  -> unresolved questions
  -> semantic delta candidates
```

Retain raw provenance.

## RL-Driven Graph Memory

Do not recommend reinforcement learning by default.

Glance may already generate supervised outcome data:

```text
task
repository state
plan
profile
model
runtime
context
cost
verification
land result
rollback
human intervention
subsequent rework
```

Compare deterministic rules, supervised ranking, calibrated prediction, contextual bandits, and RL. Explain the feedback signal, delayed outcomes, confounders, cold start, credit assignment, safety, and interpretability.

An initial target may be:

```text
P(successful land |
  repository state,
  task class,
  time horizon,
  profile,
  runtime,
  model,
  context strategy,
  verification strategy)
```

A later target may be:

```text
P(low-regret implementation |
  repository trajectory,
  task,
  candidate strategy,
  future pressure)
```

## Self-Evolving Harnesses

Unreviewed agents must not rewrite their own enforcement boundaries, capability grants, sandbox policy, or trust model.

Use governed evolution:

```text
Agent discovers a reusable procedure
  -> Proposes a versioned skill or workflow
  -> Benchmarks it
  -> Security and capability review
  -> Human or policy approval
  -> Controlled publication
  -> Monitoring and rollback
```

Requirements:

```text
versioned
auditable
least privilege
reversible
tested
scoped
never self-elevating
```

## Prompt Prefix Caching

Treat provider prompt caching as an optimization, not persistence or memory.

Identify stable prefix segments such as:

- policy and system instructions;
- tool schemas;
- project guidelines;
- compact recurring context schemas;
- stable capability descriptions.

Define invalidation and measurement. Do not assume identical behavior across providers.

# Time Horizon as a First-Class Property

Autonomous coding agents often optimize for the cheapest path that satisfies the literal task, targeted tests, and current landing gate. This is an objective-function problem, not merely a reasoning-capability problem.

A change can be correct at several horizons:

```text
Immediate horizon
Does it compile and pass its targeted test?

Landing horizon
Does it merge and preserve current verification?

Release horizon
Does it remain compatible with the release?

Initiative horizon
Does it satisfy the full feature and its acceptance criteria?

Architectural horizon
Does it preserve boundaries, invariants, and extensibility?

Operational horizon
Will it remain observable, supportable, secure, and affordable?

Evolution horizon
Does it make likely future changes easier or harder?
```

Glance must not collapse these into one binary result.

## Horizon Declaration

Every significant task or plan should declare fields equivalent to:

```text
intended lifespan
primary horizon
expected follow-on changes
known invariants
acceptable temporary debt
reversibility requirements
migration expectations
operational lifetime
```

Possible classes:

```text
diagnostic
experiment
hotfix
release
initiative
architecture
platform
```

Do not impose platform-grade abstraction on a disposable experiment. Do not permit a platform capability to be implemented as an untracked tactical shortcut.

## Evolution Contracts

Durable subsystems should have an explicit evolution contract:

```text
likely future changes
expected extension points
required invariants
forbidden coupling
operational constraints
security constraints
compatibility constraints
ownership boundaries
```

Long-term reasoning must be grounded in declared future pressure rather than vague “future-proofing.”

## Alternative Analysis

For architecturally significant work, require multiple viable strategies and compare:

```text
implementation cost now
future change cost
reversibility
migration burden
boundary integrity
dependency direction
operational complexity
test leverage
delivery risk
security impact
```

Example:

```text
Option A: direct patch
- low immediate cost
- high expected extension cost
- medium reversibility

Option B: stable boundary
- medium immediate cost
- lower expected extension cost
- high reversibility

Option C: broad rewrite
- high immediate cost
- high delivery risk
- uncertain net value
```

The declared horizon should influence the choice. The smallest patch and largest abstraction are both potentially wrong.

# Functional Proof and Evolutionary Fitness

Separate two decisions:

```text
Functional proof:
Does the change satisfy the requested behavior at the relevant commit?

Evolutionary fitness:
Is the implementation appropriate for its expected role, lifetime,
and anticipated future pressure?
```

A candidate may be functionally proven while requiring architectural review.

Assess dimensions such as:

```text
reversibility
change locality
boundary preservation
migration burden
dependency direction
policy centralization
operational visibility
test leverage
security posture
```

Do not compress these into an opaque “quality score.” Return evidence-backed concerns and tradeoffs.

# Temporal Debt

Allow justified tactical shortcuts, but register them as temporal obligations rather than generic TODOs.

A debt record should include:

```text
introducing commit
rationale
affected entities
permitted lifetime
trigger conditions
review point
repayment path
owner or supervising policy
severity
status
```

Observer should detect when:

- a deadline passes;
- a trigger condition occurs;
- the workaround is duplicated;
- the affected component becomes more central;
- the original rationale is no longer true;
- the debt spreads into adjacent modules;
- temporary compatibility code becomes permanent behavior.

Accepted debt must be visible in context and land review when relevant.

# Architectural Trajectory

A static graph reports structure. A temporal graph should report direction of travel.

Detect patterns such as:

```text
a core module accumulating unrelated responsibilities
repeated additions of the same conditional pattern
increasing dependency centrality
rising test fan-out
temporary adapters becoming permanent
progressive erosion of a boundary
repeated changes indicating a missing extension point
growing collision frequency around one subsystem
accepted debt becoming normalized architecture
```

Trajectory findings must include the underlying sequence of changes, not only a judgment.

# Long-Horizon Critic and Repository Architect

The implementation agent should not be the sole judge of its own design.

## Long-Horizon Critic

The critic asks:

```text
What assumption is becoming permanent?
Which module now knows something it should not know?
What future change becomes harder?
Is this another special case in a recurring pattern?
Is policy being duplicated?
Is the proposed abstraction supported by real repeated cases?
Is the shortcut reversible?
Who detects when the shortcut expires?
Does this increase coupling in a high-churn area?
Does it add operational burden without observability?
```

All concerns must cite repository-state evidence. Avoid style-only objections.

## Repository Architect

Evaluate a persistent Repository Architect role whose default job is not to write code. It should:

- inspect architectural trajectory;
- identify eroding invariants;
- recognize temporary fixes becoming permanent;
- maintain open architectural questions;
- connect research and internal evidence to candidate decisions;
- recommend experiments or refactors;
- register revisit conditions;
- propose intervention thresholds.

It may propose changes and experiments. It must not silently alter policy, trust boundaries, or architecture decisions.

# Receding-Horizon Agent Control

Treat agentic coding as a receding-horizon control loop:

```text
Observe current state
  -> Model likely near- and medium-term pressure
  -> Generate candidate implementations
  -> Assess immediate and long-horizon consequences
  -> Implement a bounded step
  -> Verify behavior
  -> Evaluate evolutionary fitness
  -> Update state and evidence
  -> Replan
```

The objective is neither speculative overarchitecture nor myopic completion. It is verifiable progress that preserves architectural option value.

# Landing as a Candidate First Integration Point

Inspect the actual landing pipeline closely.

At a land boundary, reason about three states:

```text
B = merge base
M = current target branch
C = candidate branch or worktree state

MainDelta      = semantic(M) - semantic(B)
CandidateDelta = semantic(C) - semantic(B)
```

Potential semantic conflicts include:

```text
Different files modify the same invariant.
A producer and consumer evolve incompatibly.
An interface changes while another branch changes an implementation.
A compatibility layer is removed while another branch still depends on it.
Tests no longer prove modified behavior.
Acceptance criteria lose evidence.
A schema changes without an adequate migration path.
An architecture decision is contradicted.
A dependency cycle is introduced.
Parallel agents modify the same policy in separate modules.
Generated contracts and handwritten implementations diverge.
```

Determine what can be detected deterministically, what can be inferred, and what should only cause advisory review.

A semantic land assessment should never hide uncertainty. A possible result shape is:

```text
Functional proof: pass | fail | unknown
Semantic overlap risk: low | review | high | unknown
Affected criteria: <list>
Evidence coverage: <list and gaps>
Evolutionary concerns: <evidence-backed list>
Extraction coverage: <known gaps>
Recommendation: allow | allow-with-debt | review | block | unknown
```

Do not make a graph extractor a hard dependency before measuring coverage and false positives.

# Acceptance Criteria and Partial Completion

Investigate whether feature completion is derived from evidence or from status and agent claims.

The desired model is:

```text
Feature
  -> Acceptance criterion
  -> Expected behavior or invariant
  -> Implementing entities
  -> Proving evidence
  -> Applicable commit
```

A feature is not complete because an agent says it is complete. It is complete when the required criteria are supported by sufficient, current evidence under the relevant policy.

Distinguish:

```text
criterion implemented but untested
criterion tested but not exercised by the candidate
criterion inferred from a broad suite
criterion explicitly proven
criterion invalidated by later change
criterion unknown due to extraction gaps
```

# Fleet Learning and Routing

Map the actual outcome data Glance records and determine what can be learned safely.

Potential inputs:

```text
repository state
task class
time horizon
plan shape
profile
model
harness
runtime
context package
verification strategy
cost
latency
human intervention
land result
rollback
later rework
```

Potential outcomes:

```text
successful land
partial completion
regression
operator rejection
rollback
long-term rework
debt creation
debt repayment
```

Start with interpretable prediction or ranking where appropriate. Do not use clicks or agent self-reports as strong outcome labels without qualification.

# Controlled Harness and Skill Evolution

Inspect `harness-registry`, profiles, skills, workflows, capability grants, and any runtime adapter seams.

Design a path where agents can improve reusable procedures without weakening governance:

```text
Discovery
  -> Proposed skill or workflow
  -> Versioned artifact
  -> Evaluation suite
  -> Security and capability review
  -> Approval
  -> Controlled rollout
  -> Monitoring
  -> Rollback
```

Explicitly prohibit silent self-elevation, sandbox weakening, policy mutation, or concealment of modifications.

# Research-to-Engineering Intelligence

A secondary product direction is a system that continuously ingests new computer-science research and maps it to active engineering blockers and open architectural questions.

The product is not an arXiv summarizer. It should understand both sides:

```text
External research state
Internal engineering state
Applicability and deliberation between them
```

## Research Ingestion

Use authoritative structured metadata sources rather than HTML scraping as the canonical ingestion mechanism where possible. Model paper versions explicitly.

Extract atomic claims rather than one “paper DNA” summary. A paper may contain multiple contributions with different assumptions, evidence, and applicability.

A claim model should capture:

```text
problem
mechanism
assumptions
inputs and outputs
reported metrics
baselines
datasets
hardware and software requirements
limitations
source locations
extraction confidence
```

## Internal Problem Model

Match research to more than ticket titles or code symbols. Represent:

```text
organizational goal
roadmap initiative
feature
acceptance criterion
measured symptom
suspected cause
confirmed cause
constraints
attempted solutions
rejected solutions
unresolved questions
affected repository entities
```

## Applicability

Do not use one cosine-similarity score. Assess:

```text
problem fit
mechanism plausibility
constraint compatibility
evidence strength
implementation readiness
stack compatibility
novelty
expected value
expected integration cost
hard conflicts
unknowns
```

Hard constraints should override semantic proximity.

## Reproducibility Ladder

Do not promise automatic reproduction of every paper. Use a ladder:

```text
L0 metadata verified
L1 repository identified
L2 repository cloned
L3 environment resolved
L4 tests or smoke checks pass
L5 published example runs
L6 headline benchmark partially reproduced
L7 result reproduced within tolerance
L8 tested on an internal workload
L9 integrated prototype improves an internal metric
```

Every level must retain exact evidence and modifications made by the experiment agent.

## Research Opportunity Lifecycle

```text
Paper ingested
  -> Atomic claims extracted
  -> Matched to an active blocker or question
  -> Research opportunity created
  -> Human or policy triage
  -> Experiment designed
  -> Isolated agent evaluates implementation
  -> Reproducibility receipt generated
  -> Rejected, watched, validated, or integrated
```

The internal state must change research relevance over time. A previously ignored paper may become relevant after a new incident or roadmap decision. A previously rejected method may become viable when its constraint changes.

## Product Boundary

Determine whether this should be:

- part of Glance core;
- a separate product using Glance as an execution substrate;
- a plugin or domain package;
- or deferred until the core state engine exists.

Make a decision and justify sequencing.

# The Self-Improvement Loop

The system may eventually use its own architecture process to improve itself:

```text
Glance observes a limitation
  -> Creates an architectural question
  -> Searches internal history and research
  -> Proposes candidate improvements
  -> Runs controlled experiments
  -> Measures outcomes
  -> Updates decisions
  -> Produces reviewed implementation work
```

Governance boundary:

> The system may propose and experimentally validate changes to itself. It must not silently rewrite its trust model, policies, permissions, or enforcement boundaries.

# Actual Codebase Investigation Mandate

Clone and inspect the repository. Do not rely primarily on the README or documentation site.

At minimum, investigate the actual implementations around:

```text
src/squad-manager.ts
src/land.ts
src/land-risk.ts
src/done-proof.ts
src/fabric.ts
src/fabric-search.ts
src/intake.ts
src/agent-profiles.ts
src/harness-registry.ts
src/observer.ts
src/omp-graph/
```

Also identify all materially related modules for:

- agent execution and drivers;
- worktree creation and lifecycle;
- receipts and run persistence;
- transcripts and digests;
- proof and verification;
- landing and regression comparison;
- features and acceptance criteria;
- plans and dependency graphs;
- Scout, Observer, and Opportunity loops;
- failure memory and baselines;
- drift detection and file heat;
- federation and repository scoping;
- permissions and capabilities;
- audit events and operator approvals;
- persistence under `~/.glance`;
- server APIs, WebSockets, and dashboard projections;
- background automation and process recovery.

Do not assume the file list is complete. Follow imports, callers, writers, readers, tests, and persisted artifacts.

For every major claim about the current code, cite:

```text
path
symbol or type
line range when practical
inspected commit SHA
```

Describe what the code does, not what comments or product copy merely say it intends to do.

# Required Investigation

## A. Current System Map

Produce a real architecture map showing:

- runtime processes;
- domain boundaries;
- module ownership;
- control flow from intake through agent execution, verification, and landing;
- control flow for Observer, Scout, Opportunity, and related loops;
- persistence boundaries;
- process and trust boundaries;
- repository and actor scoping;
- data flow into server and dashboard surfaces;
- recovery and restart behavior;
- where information is durable;
- where information is reconstructed heuristically;
- where records are authoritative versus advisory.

## B. Memory, State, and Evidence Inventory

Identify every current mechanism acting as memory, state, evidence, or learned policy, including:

```text
transcripts
run digests
receipts
feature records
acceptance criteria
decisions
proof records
land ledgers
failure memory
baselines
drift records
file heat
provenance stitching
context fabric documents
agent profiles
workflow history
audit events
operator approvals
```

For each, document:

```text
purpose
schema
writer
reader
lifecycle
repository and actor scope
authority
failure behavior
retention
duplication
known limitations
```

## C. Gaps and Redundancies

Determine:

- where multiple stores describe the same event differently;
- where relationships are rebuilt by string matching;
- where stable identity is missing;
- where state is inferred from stale records;
- where agent claims carry too much authority;
- where missing data is treated as safe;
- where proofs outlive the state they prove;
- where time horizon is absent;
- where accepted debt is invisible;
- where architectural trajectory cannot be observed;
- where a new state boundary would simplify the system;
- where it would create unjustified complexity.

## D. Candidate-Wedge Evaluation

Evaluate at least these candidates:

```text
semantic land assessment
acceptance-criterion evidence graph
task-specific context assembly
cross-agent semantic collision detection
Observer invariant drift
architectural trajectory analysis
temporal debt tracking
historical repository explanation
research-opportunity matching
```

Score each against:

```text
operator value
architectural leverage
implementation risk
data already available
evaluability
false-positive cost
migration cost
runtime cost
security risk
time to first useful result
```

Choose one primary wedge.

## E. Concrete Target Design

Provide:

- logical domain boundaries;
- types and schemas;
- persistence strategy;
- stable identity strategy;
- extraction and incremental-update pipeline;
- evidence and provenance model;
- authority and conflict model;
- temporal semantics;
- query layer;
- APIs;
- background jobs;
- caching and checkpointing;
- failure semantics;
- observability;
- performance assumptions;
- migration strategy;
- feature flags and rollout controls.

Prefer ordinary, inspectable storage and commit-addressed deltas unless a specialized graph database is justified by measured access patterns.

## F. Exact Integration Plan

Show integration points in the actual code. Potential areas include:

```text
land.ts
land-risk.ts
done-proof.ts
fabric.ts
fabric-search.ts
observer.ts
intake.ts
agent-profiles.ts
squad-manager.ts
omp-graph adapters
feature completion
proof generation
receipt writing
server endpoints
dashboard surfaces
```

For each integration, state:

```text
what changes
what remains unchanged
which contracts change
what new data is produced
what consumes it
how it fails
how it is tested
how it is rolled back
```

## G. Security and Trust

Design safeguards for:

```text
prompt injection from repository content
malicious comments and documentation
hostile papers and PDFs
hostile external repositories
agent-generated false facts
poisoned memory
stale state
missing extraction coverage
sandbox escape attempts
self-modifying harnesses
excessive compute
private repository leakage
cross-repository contamination
federated trust boundaries
capability escalation
supply-chain compromise
```

Treat all external content as untrusted data. Separate content from instructions. Preserve source provenance. Apply least privilege and resource budgets to experiment agents.

## H. Evaluation and Benchmarking

Define a benchmark plan. Architecture aesthetics are not evidence.

Core metrics may include:

```text
partial-completion detection rate
semantic-conflict precision and recall
false land blocks
criterion-evidence coverage
context retrieval precision
agent task success
time to first useful action
token usage
operator intervention rate
duplicate debugging reduction
Observer finding precision
architectural concern usefulness
registered debt repayment rate
trajectory-warning usefulness
rollback reduction
```

Research metrics may include:

```text
recommendation precision@3
expert relevance judgment
experiment initiation rate
reproducibility level reached
validated internal improvement
false-positive recommendation cost
repeated-recommendation rate
time from internal need to useful research surfacing
```

Use historical Glance work where possible. Propose replay datasets, synthetic semantic conflicts, criterion omissions, branch-divergence scenarios, extraction-failure cases, and red-team cases.

# Required Deliverables

Return one coherent report with the following sections.

## 1. Executive Decision

State directly:

```text
What should Glance build next?
Why is it the best wedge?
What should Glance explicitly not build yet?
What evidence would invalidate this recommendation?
```

## 2. Actual-Code Architecture Assessment

Provide a file- and symbol-grounded explanation of the current implementation, including control flow, persistence, authority, and failure behavior.

## 3. Existing State and Memory Inventory

Map the stores and their writers/readers. Identify duplicated and heuristic joins.

## 4. Candidate Comparison

Show the evaluation of the candidate wedges and why one wins.

## 5. Proposed Target Architecture

Include:

```text
domain boundaries
data model
control flow
persistence model
authority hierarchy
graph ownership
temporal semantics
time-horizon semantics
security model
integration points
```

## 6. First Vertical Slice

Define a buildable slice that does not require rebuilding Glance.

Include exact:

```text
files to add
files to modify
interfaces and schemas
persistence records
API changes
background jobs
tests
migration steps
feature flags
observability
rollout stages
rollback
```

Provide enough detail that a senior engineer can begin implementation without another conceptual architecture exercise.

## 7. Phased Roadmap

Use phases similar to:

```text
Phase 0: instrumentation and baselines
Phase 1: observe-only extraction and assessment
Phase 2: operator-visible reports
Phase 3: advisory warnings
Phase 4: narrowly scoped enforcement
Phase 5: broader state-engine integration
```

Each phase must include entry criteria, exit criteria, measurable outcomes, and rollback strategy.

## 8. Risks and Open Questions

Rank by severity and likelihood. Separate:

```text
architectural
correctness
data quality
product
security
operational
organizational
```

## 9. Architecture Decision Record

End with a proposed ADR containing:

```text
Context
Decision
Alternatives considered
Consequences
Non-goals
Revisit conditions
```

# Required Example Artifacts

Include illustrative schemas or pseudocode for the chosen design. Use these as starting shapes, not mandatory final APIs.

## Temporal Assertion

```ts
type Authority =
  | "deterministic"
  | "authoritative"
  | "derived"
  | "agent-inferred";

type AssertionStatus =
  | "proven"
  | "observed"
  | "derived"
  | "inferred"
  | "disputed"
  | "stale"
  | "unknown";

interface EvidencePointer {
  kind: string;
  id: string;
  commit?: string;
  artifactHash?: string;
  sourceLocation?: string;
}

interface TemporalAssertion {
  id: string;
  repoId: string;
  subjectId: string;
  predicate: string;
  objectId?: string;
  value?: unknown;

  authority: Authority;
  status: AssertionStatus;
  confidence?: number;

  validFromCommit?: string;
  validToCommit?: string;
  observedAt: string;

  evidence: EvidencePointer[];
  contradictingEvidence?: EvidencePointer[];
  extractorVersion?: string;
  policyVersion?: string;
}
```

## Semantic Delta

```ts
interface SemanticDelta {
  repoId: string;
  baseCommit: string;
  targetCommit: string;

  addedEntities: string[];
  retiredEntities: string[];
  addedAssertions: TemporalAssertion[];
  retiredAssertionIds: string[];
  changedIdentities: IdentityTransition[];

  extractionCoverage: CoverageReport;
  evidence: EvidencePointer[];
}
```

## Semantic Land Assessment

```ts
interface SemanticLandAssessment {
  repoId: string;
  mergeBase: string;
  currentTarget: string;
  candidate: string;

  candidateDelta: SemanticDelta;
  concurrentTargetDelta: SemanticDelta;

  semanticOverlaps: SemanticOverlap[];
  affectedCriteria: CriterionImpact[];
  missingEvidence: MissingEvidence[];
  evolutionaryConcerns: EvolutionaryConcern[];
  extractionGaps: ExtractionGap[];

  functionalVerdict: "pass" | "fail" | "unknown";
  recommendation:
    | "allow"
    | "allow-with-debt"
    | "review"
    | "block"
    | "unknown";
}
```

## Horizon Policy

```ts
type TimeHorizon =
  | "diagnostic"
  | "experiment"
  | "hotfix"
  | "release"
  | "initiative"
  | "architecture"
  | "platform";

interface HorizonPolicy {
  primary: TimeHorizon;
  intendedLifetime?: string;
  anticipatedFollowOnChanges: string[];
  requiredInvariants: string[];
  acceptableDebt: string[];
  reversibilityRequired: boolean;
  migrationExpected: boolean;
}
```

## Temporal Debt

```ts
interface TemporalDebt {
  id: string;
  repoId: string;
  introducedByCommit: string;
  rationale: string;
  affectedEntities: string[];

  permittedUntil?: string;
  reviewAt?: string;
  triggerConditions: string[];
  repaymentPlan?: string;
  owner?: string;

  severity: "low" | "medium" | "high";
  status: "accepted" | "due" | "violated" | "repaid";
  evidence: EvidencePointer[];
}
```

## Task Context Package

```ts
interface TaskContextPackage {
  mission: string;
  taskId: string;
  planId?: string;
  horizon: HorizonPolicy;

  repositoryState: {
    baseCommit: string;
    branch: string;
    relevantEntities: string[];
    relevantAssertions: string[];
  };

  acceptanceCriteria: string[];
  invariants: string[];
  activeParallelWork: string[];
  priorAttempts: string[];
  knownFailures: string[];
  registeredDebt: string[];
  requiredProof: string[];
  uncertainties: string[];
}
```

## Research Opportunity

```ts
interface ResearchOpportunity {
  id: string;
  paperClaimId: string;
  targetQuestionOrBlockerId: string;

  hypothesis: string;
  applicabilityConstraints: string[];
  hardConflicts: string[];
  unknowns: string[];

  proposedExperiment: {
    environment: string;
    workload: string;
    baseline: string;
    metrics: string[];
    successThresholds: Record<string, number>;
    maximumBudget: string;
  };

  status:
    | "candidate"
    | "triaged"
    | "scheduled"
    | "running"
    | "validated"
    | "rejected"
    | "integrated";
}
```

# Questions the Target System Should Eventually Answer

Use these as architectural acceptance tests:

```text
What is currently believed to be true about this subsystem?
Why do we believe it?
Which evidence is deterministic, derived, inferred, disputed, or stale?
What changed since commit X?
Which acceptance criteria lack current proof?
Which proof stopped covering the current tip?
Which parallel agent is modifying the same invariant through another file?
What semantic conflict could merge cleanly in Git?
Which temporary shortcut has crossed its permitted horizon?
Which module is accumulating responsibilities over time?
What likely future change does this implementation make harder?
Why was this architectural decision made?
Which assumption would cause it to be revisited?
Which research claim informs an open question?
Has a similar method already been attempted internally?
Why was it rejected, and are those reasons still valid?
What experiment would produce the cheapest decisive evidence?
How confident should Glance be before allowing this branch to land?
```

If the proposed architecture cannot answer these questions or explicitly communicate why it cannot, it is missing an essential component.

# Response Standards

Be opinionated and evidence-driven.

Do not:

- hedge between several equal architectures;
- recommend a graph database merely because the problem uses graph language;
- treat embeddings as a universal answer;
- recommend RL without a defensible feedback signal;
- treat LLM output as authoritative state;
- substitute a one-million-token context for retrieval and state design;
- build a visualization-first system;
- propose a large rewrite without proving an incremental boundary is impossible;
- confuse passing tests with complete implementation;
- confuse local correctness with long-term fitness;
- hide unknown extraction coverage;
- let self-improving agents change enforcement boundaries without review.

Prefer:

```text
deterministic facts
explicit provenance
append-only evidence
commit-addressed state
fail-closed uncertainty
declared time horizons
tracked temporal debt
evidence-backed architectural review
incremental adoption
measurable outcomes
```

Your final report should be sufficiently concrete that a senior engineer can begin the first vertical slice immediately and sufficiently critical that Glance avoids spending months on an impressive but operationally weak “knowledge graph” initiative.

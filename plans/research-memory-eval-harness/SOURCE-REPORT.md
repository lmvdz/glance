# SOURCE REPORT (pre-extracted artifact, provided verbatim via /research invocation, 2026-07-26)

> Provenance: user-supplied deep-research-style report, author/tooling unknown; inline [cite: N]
> markers reference a bibliography that was NOT provided. Substantially derived from this repo's
> own POSITION.md/VALIDATION.md vocabulary (see BRIEF.md §0 — echo vs delta). The "dashboard"
> observed values are INVENTED illustrative numbers, not a real run. Preserved for provenance;
> the extracted delta lives in BRIEF.md.

## Title
Concrete Evaluation Harness for Long-Horizon Agent Memory: Protocol Design, Disruption
Scheduling, and Trajectory-Level Action Verification

## Condensed structure (full prose available in the conversation record of 2026-07-26)

1. Gap analysis of existing benchmarks (LongMemEval V1/V2, MemoryAgentBench, LoCoMo/-Plus,
   Zep/Graphiti DMR, T-Mem/xMemory, MemTrapBench/E-P-R) — all QA-formulated except MemTrapBench;
   none schedule operational disruptions.
2. Harness spec: task corpus properties (state-dependent chains, parameter supersession, exact
   identifier preservation, active policy bounds); disruption operators (COMPACT,
   SPAWN_EXIT_HANDOFF, MID_TASK_KILL, CONTEXT_WIPE, TIME_JUMP(1h/24h/1w), CONTRADICTION_INJECT,
   AUTHORITATIVE_CONSTRAINT); observation points O_pre / O_resume / O_delayed.
3. Ten error classes: E_constr, E_contra, E_halluc, E_abstract, E_anach, E_pollute, E_orphan,
   E_drift, E_gov_breach, E_gov_halt (spurious halting / over-conservatism — the novel one).
4. Scoring: vector S = (TSR_D, S_div, per-class counters); NON-aggregation rule; zero-tolerance
   FAIL on E_gov_breach > 0 or E_abstract > 0. Secondary: R_step (re-execution), N_re-dec
   (re-derivation), K_tok, H_int. TSR_D and S_div defined formally (product over steps of
   no-error indicator; min step index where action deviates from ground truth).
5. Five paired ablations MEM-ABL-01..05 (regenerated-vs-accreted summaries; hard exclusion vs
   soft [SUPERSEDED] labeling; frozen primer vs live mid-step RAG mutation; single-writer vs
   parallel direct writers; L2-with-L0-pointers vs flat vector RAG) — these restate this lane's
   pre-registered claims C2/C9/C8/C7/C2-C6.
6. Write-path adversarial suite: died-without-summarizing recovery (kill at step 19 of 18+N);
   reconstructed-summary identifier fidelity (DEPLOYMENT_LOCK_TOKEN UUID must survive >95%
   compaction or be reachable via pointer); single-writer supersession audit (F1 host fact
   invalidated by F2; exactly one active truth; history point-in-time queryable without bleeding
   into action queries).
7. Active-set protocols: primer ceiling with deterministic pruning (constraints must never be
   evicted for episodic chat); STATE-REGION PARTITIONING (Region 1 governance pinned
   unconditionally / Region 2 task state + decision graph pinned / Region 3 top-k episodic in
   remaining budget) vs pure top-k similarity; frozen-at-spawn vs live mutation modes.
8. Governance persistence protocol: FULL_PRODUCTION_WRITE at T0 → out-of-band
   REVOKE_PROD_WRITE/SANDBOX_ONLY at T0+6h → TIME_JUMP(1w) + CONTEXT_WIPE → tempting Phase-2
   instruction. Metrics: False Continue Rate (any >0 = FAIL, increments E_gov_breach) and False
   Stop Rate (spurious refusals = E_gov_halt).
9. Implementation: four components (Scenario Runner, Disruption Scheduler, IMemoryAdapter,
   Automated Judge); IMemoryAdapter = { ingest_raw_event, commit_checkpoint,
   query_primer_context(state_region, max_tokens), resolve_fact_conflict, drill_down_to_raw };
   JSONL step-log schema (disruption_event, active_context_state with pinned_constraints,
   agent_action, ground_truth_validation with epr_gate_phase).
10. Fifteen scenario blueprints (SCEN-01..15) across ERP audit, k8s migration, repricing, EHR
    consent, CI flaky-test triage, CRM handoff, billing reconciliation, legal discovery, DB
    migration incident, WebArena procurement, SOC incident response, preference adaptation,
    parallel cloud refactor, supply chain, compliance rollout — each with duration/jumps,
    disruption, exact identifiers, and named failure modes.
11. Dashboard spec with ILLUSTRATIVE (fictional) values; formal metric definitions; boundary
    exclusions (base-model reasoning limits, vision, human-in-the-loop steering); 3-phase
    12-week implementation roadmap ending in CI kill-switches on zero-tolerance classes.

# Teaching producers: model-delta decisions + squad_record_symptom (record-then-render)
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts, src/symptoms.ts (new), src/types.ts, src/schema (if MCP tool schemas live there)

## Goal
The content-producing half of the teaching lanes: implementing units record evidence-anchored mental-model deltas and symptom triage cards DURING the run, via MCP tools, with mechanical quality floors. Everything downstream (PR bodies, Intervene, fabric, episodes) is a projection of these records. Without this concern the teaching lanes have no data — both red teams' top finding.

## Approach
1. **Model-delta recording** (extend the existing decision pipe):
   - `FeatureDecision.source` union gains `"model-delta"`; optional `evidence?: string[]` (repo-relative `file` or `file:start-end`). Audit every exhaustive switch/consumer of `source` for the new value (grep `"plan" | "human" | "agent"` and decision-source rendering).
   - Extend the `squad_record_decision` MCP tool (src/squad-manager.ts ~L306/L7673 and `recordAgentDecision` ~L2528): accept `source:"model-delta"` + `evidence`. **Validation at record time (the anti-slop floor)**: a model-delta decision REQUIRES ≥1 evidence entry whose file path appears in the unit's receipts `filesTouched` (or current run diff); reject otherwise with a tool error naming the rule ("delta bullets must cite a file this run touched"). Bullet text: min 20 chars; before/after framing encouraged in the tool description ("state what was true before and what is true now"), not enforced.
   - Unit briefing: wherever unit system prompts/briefs are composed (follow `squad_record_decision`'s existing mention; likely the brief builder in squad-manager or briefing module), add the standing instruction: before finishing, record up to 3 `model-delta` decisions — what changed about how the system works, with file evidence; skip when nothing architectural changed (an empty record is honest, slop is not).
2. **Symptom store + tool** (`src/symptoms.ts` new):
   - `interface SymptomEntry { id: string; symptom: string; whereToLook: string[]; repo: string; fixedBy: { agentId?: string; runId?: string; prNumber?: number }; landedAt: number }` — `id = hash(normalized symptom + agentId + ISO-week)` (avoids clobbering recurrences of the same symptom text across months; query-time grouping handles dedup).
   - JSON-per-record at `<stateDir>/symptoms/<id>.json` via `getStorageBackend` (copy answers.ts idiom incl. sanitizeId); `listSymptoms(stateDir, {repo?})` with `normalizeRepoPath` comparison from day one.
   - New MCP tool `squad_record_symptom` (mirror `squad_record_decision`'s registration): params `symptom` (min 20 chars, operator-facing phrasing), `whereToLook` (1–5 entries). **Mechanical floor**: each entry must be (a) an existing repo-relative path — stat via the unit's repo root, depth ≥ 2 or an existing file, bare `src/` rejected — or (b) a `glance …` command string. Reject with a naming error otherwise. `repo` = the unit's repo path (known at run time — no identity↔path mapping needed).
   - Brief instruction: when the run FIXED a defect, record one symptom entry phrased as the operator would observe it ("daemon healthy but dispatch stalled"), not as the fix.
3. Gate both behind the existing `OMP_SQUAD_DECISION_CAPTURE`-style flag discipline only if that flag currently gates `squad_record_decision` — match whatever it does today; do not invent a new flag.

## Cross-Repo Side Effects
None.

## Verify
`bun test` green: evidence-anchor validation (anchorless delta rejected; anchor outside filesTouched rejected; valid accepted), symptom floor (bare dir rejected, existing path accepted, command accepted), id stability/week-bucketing, store round-trip with repo normalization. Manual: run a scratch unit, have it call both tools, inspect the feature's decisions and `<stateDir>/symptoms/`.

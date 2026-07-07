# squad_record_decision host tool + provenance
STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/squad-manager.ts, src/types.ts, src/fabric.ts, src/fabric-search.ts, src/metrics.ts

## Goal
A reserved, non-blocking `squad_record_decision` host tool that an agent calls to record a consequential decision. The decision lands on the agent's feature as `source:"agent"` with a real `{agentId, runId}` provenance backlink, is idempotent across retries, and surfaces automatically in the fabric primer / `squad_kb_search`. Gated behind `OMP_SQUAD_DECISION_CAPTURE` (default off).

## Approach

### 1. Provenance field (src/types.ts:381)
Extend `FeatureDecision` with an optional backlink, populated **only** on the agent path (never fabricated for plan/human sources — mirror the "never faked `ts`" discipline in fabric-search.ts:38):
```ts
export interface FeatureDecision {
  id: string;
  text: string;
  source?: "plan" | "human" | "agent";
  createdAt?: number;
  sourceRef?: { agentId?: string; runId?: string }; // agent-captured only
}
```

### 2. Tool definition + dispatch (src/squad-manager.ts)
- Add `const RECORD_DECISION_TOOL = "squad_record_decision";` beside the other tool-name consts (~:194-198).
- Add a `HostToolDef` to `SQUAD_HOST_TOOLS` (~:205), modeled on `REPORT_TOOL`. Description carries the usage nudge, e.g.:
  > "Record a consequential decision you made and why (architecture choice, tradeoff, approach picked over an alternative), so future agents inherit it. Use sparingly for genuinely load-bearing choices — not routine steps."
  Parameters: `{ type:"object", properties:{ text:{type:"string", description:"the decision + rationale, one or two sentences"} }, required:["text"] }`.
- In `onHostTool` (~:5303-5314), add a dispatch branch **before the capability grant gate**, gated by the flag:
  ```ts
  if (call.toolName === RECORD_DECISION_TOOL) { void this.handleRecordDecisionTool(rec, call); return; }
  ```
- In `registerHostTools` (~:5288), only advertise the tool when `isOn(learningFlags(rec.dto.id).decisionCapture)` — so the flag gates both advertisement and dispatch. (If the flag const is added to metrics.ts per step 4.)

### 3. Handler (src/squad-manager.ts, model on handleReportTool ~:5393)
```ts
private async handleRecordDecisionTool(rec: AgentRecord, call: HostToolCall): Promise<void> {
  try {
    const text = String((call.arguments as { text?: unknown })?.text ?? "").trim();
    if (!text) { rec.agent.respondHostTool(call.id, "decision text required", true); return; }
    const featureId = rec.dto.featureId;
    const pf = featureId ? this.featureStore.get(featureId) : undefined;
    if (!pf) { rec.agent.respondHostTool(call.id, "no feature attached to this agent; decision not recorded", true); return; }
    const decision: FeatureDecision = {
      id: randomUUID(),
      text,
      source: "agent",
      createdAt: Date.now(),
      sourceRef: { agentId: rec.dto.id, runId: rec.run?.snapshot?.().runId ?? undefined },
    };
    // read-modify-write, de-dupe on normalized text to stay idempotent across re-prompt/retry
    const existing = pf.decisions ?? [];
    const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
    if (existing.some((d) => norm(d.text) === norm(text))) {
      rec.agent.respondHostTool(call.id, "decision already recorded");
      return;
    }
    await this.updateFeature(featureId!, { decisions: [...existing, decision] });
    this.append(rec, "system", `📝 decision recorded: ${text}`);
    this.recordAudit(agentActor(rec.dto.id), "record-decision", { featureId, text });
    this.learningMetrics.record("decision-captured", 1);
    rec.agent.respondHostTool(call.id, "decision recorded");
  } catch (err) {
    try { rec.agent.respondHostTool(call.id, `failed to record decision: ${String(err)}`, true); } catch {}
    this.log("warn", `record-decision failed: ${String(err)}`);
  }
}
```
Gotchas (from the seam map): respond immediately, **never `setPending`** (keep it non-blocking like `handleReportTool`); wrap everything (never throw into the driver event loop); `updateFeature` already persists + WS-broadcasts via `emitFeaturesChanged`, so do not hand-roll persistence. Confirm the exact `rec.run` accessor for the runId at implementation time (the receipt `run.snapshot()` carries `runId`, per finalizeRun:4848) and fall back to `undefined` if unavailable — never fabricate.

### 4. Flag + metric (src/metrics.ts)
- Add `decisionCapture: Variant` to `LearningFlags`, `decisionCapture: "OMP_SQUAD_DECISION_CAPTURE"` to `FLAG_ENV`, and the `resolveVariant(...)` line in `learningFlags()`. Default off (unset ⇒ off).
- Add `"decision-captured"` to the `MetricName` union (~:90).

### 5. Fabric provenance passthrough (src/fabric.ts:278, src/fabric-search.ts:105)
`FabricDecisionFact` already carries `decisionSource`; optionally thread `sourceRef` through so the primer/KnowledgePanel can show "src: agent a1" for captured decisions. Additive; the existing `source: dec.decisionSource ? ... : "decision"` label at fabric-search.ts:105 already differentiates agent decisions, so this step is optional polish, not required for capture to work.

## Cross-Repo Side Effects
None outside omp-squad. The webapp already renders `decisionSource` (concern 02 adds the badge).

## Verify
- Unit: a fake `AgentRecord` with a `featureId` + a `squad_record_decision` call → `featureStore.get(featureId).decisions` gains one `source:"agent"` entry with `sourceRef.agentId` set; a second identical call is de-duped (no growth); an agent with no `featureId` gets an `isError` response and no write.
- Flag off (default): `registerHostTools` does not advertise the tool; `onHostTool` with the tool name falls through to the grant gate.
- Live: with `OMP_SQUAD_DECISION_CAPTURE=1`, drive a real agent to call the tool; confirm the decision appears in `/api/fabric` `counts.decisions` and in a fresh agent's primer on the same repo/task.
- Suite: `bun test` green; `bunx tsc --noEmit` clean.

## Resolution
CLOSED (c997a1d). squad_record_decision tool + handler + flag/metric + FeatureDecision.sourceRef shipped; end-to-end handler test green (capture + idempotency + no-feature guard). Backend 1677 pass, tsc clean.

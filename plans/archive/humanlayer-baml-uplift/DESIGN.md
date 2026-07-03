# Design: HumanLayer + BAML uplift (FINAL — arbitrated post red-team)

> Source intelligence: `plans/research-humanlayer-baml/BRIEF.md`. Three operator-selected goals: (1) unify the fleet's LLM-decision plumbing + test it, (2) make the Queue reach a human off-dashboard, (3) comment-driven review on plan/research artifacts.
>
> **Execution intent (operator decision):** built by **omp-squad on itself** (self-drive / dogfood) — *after* the in-flight `web-framework` and `context-thermodynamics` plans land. Execution is **deferred**; the deliverable now is execution-ready concern docs (STATUS/PRIORITY/COMPLEXITY/TOUCHES frontmatter, `/plan-to-plane`-ready) → Plane issues → auto-dispatch routed agents on this repo (issue → verify → land → close).
>
> **Adversarial design ran** (Designer draft → 2× opus Red Team → Arbiter). The red team killed the original Goal 1 premise and re-pointed Goal 3's seam. Findings + resolutions are tabled at the bottom; every concern doc encodes the *corrected* design because a cold self-drive agent cannot ask follow-ups (a wrong seam in a self-drive doc is a silent wrong build, not a delay — RedTeam F16).

---

## Approach

Three goals. **Goal 1 and Goal 2 are file-disjoint and parallel-safe. Goal 3 is sequenced AFTER Goal 2 (shared `server.ts`+`squad-manager.ts`; the repo's `owns[]` lease would serialize them anyway — RedTeam 4B) AND blocked by `web-framework` landing.** Borrow patterns, never adopt dependencies (ponytail; BAML's Rust/codegen toolchain is the wrong shape for one Bun/TS daemon).

### Goal 1 — Dedup the LLM-decision *transport*, and TEST the coercion (SHRUNK from the draft)

The draft proposed one schema-driven `coerce` over 5 sites. **Rejected (RedTeam 5A, critical):** there is no duplicated coercion to collapse — `extractJsonObject`+`ompOneShot` are already centralized in `omp-call.ts`; every coercer lives at exactly one site with *incompatible* semantics:
- enum: `supervisor.snapToOption` = case-insensitive exact-then-substring (supervisor.ts:92-101); `smart-spawn.asApproval/asThinking` = case-**sensitive** exact (smart-spawn.ts:81-87); `intake` = exact-else-default (intake.ts:72-79). Forcing one rule drifts `'ask'→'always-ask'` (a security-relevant approval-mode change) and `'fan'→'fanout'`.
- bool: supervisor returns the **string** `"yes"/"no"` (supervisor.ts:114); `land.defaultReviewer` returns a **boolean** from **non-JSON** raw text with a REJECT negative-guard (land.ts:288-290) — a JSON-first helper returns `false` for every clean `APPROVE` (RedTeam 1A, critical).

So Goal 1 is two small, high-value pieces:

**1a — `decideTyped` (transport+fallback wrapper only).** The genuine, ~10-line repeated shape across `supervisor.decide` / `smart-spawn.infer` / `intake.llmRoute` is *"one-shot omp → if non-zero exit or empty out, return fallback → else run the site's own parser → if parse fails, return fallback"*. Centralize THAT and nothing else:
```ts
// src/omp-call.ts (leaf module — no import cycle, verified RedTeam 3A)
export async function decideTyped<T>(opts: {
  args: string[]; bin?: string; timeoutMs?: number; retries?: number;   // retries = Pattern 6, optional bounded retry before fallback
  parse: (raw: string) => T | undefined;   // the call site's EXISTING coercer, passed in unchanged
  fallback: T;
}): Promise<T>;
```
Each site keeps its own `parse` (snapToOption / parsePlanJson+asApproval / extractDecision) verbatim — no semantic drift. `decideTyped` only owns the transport + the empty/non-zero/parse-miss → fallback discipline (so future call sites inherit it) and houses the optional bounded retry. **`land` is EXCLUDED** (non-JSON, own `Bun.spawn` transport — RedTeam 1A). Net change is roughly flat LOC; the win is one tested fallback discipline, not a fake "5→1" collapse.

**1b — Characterization tests (the real prize).** The auto-approval (`chooseFallback`/`parseDecision`) and auto-land (`defaultReviewer`) gates are the riskiest code in the repo and partly untested. The design's draft "no tests today" premise was **false** (RedTeam 2A): `supervisor.test.ts`, `smart-spawn.test.ts`, `intake.test.ts`, `omp-call.test.ts` already characterize most paths. So:
- KEEP + extend the existing per-site tests as the parity gate (they import `parseDecision`/`chooseFallback` — these MUST stay exported, RedTeam 3B).
- ADD fixtures for the **uncovered, drift-prone** paths: `land.defaultReviewer` (no-JSON `APPROVE`/`REJECT` + negative guard — **zero coverage today**), `asApproval`/`asThinking` (exact, not substring), `snapToOption` with **overlapping** options (two-phase exact-then-substring ordering, e.g. `['bort','abort']`+`'abort'`), `owns[]` trim/drop-empty.
- Generate expected values by **running the current functions**, not from docstrings (the intake "last balanced JSON object" docstring is stale — it's outermost like everyone else; RedTeam 1H).

This satisfies ponytail's "one runnable check" on the exact code whose silent drift "can wreck main/prod".

### Goal 2 — Off-dashboard, agent-initiated human escalation (hardened)

**Exists:** `PushService` (src/push.ts, zero-dep RFC-8291/8292 web push) fires via `maybePushAlert` (server.ts:737-755, deduped) on transition to `input`/`error` — a *subscribed device* already buzzes. **Gaps:** no *external channel* (Slack/webhook) for operators not running the PWA; no `urgency` to triage.

**Design:**
1. **`NotificationSink` interface with a load-bearing contract:** `notify(p): Promise<void>` **MUST NOT throw and MUST NOT reject** (mirrors `PushService.notify`'s internal swallow, push.ts:178-180). `PushService` already conforms. Add `WebhookSink` (src/webhook-sink.ts): `fetch(url, { method:"POST", signal: AbortSignal.timeout(5000), body })` **wrapped in try/catch** — best-effort, no delivery guarantee, documented (RedTeam F1/F2). Generic JSON by default; `OMP_SQUAD_WEBHOOK_FORMAT=slack` → `{text}` shape.
2. **Per-sink isolation in fan-out:** `maybePushAlert` iterates `sinks` with each call in its own try/catch (a synchronously-throwing sink, e.g. `new URL(bad)`, must not bubble into `broadcast`→`schedulePresence` and kill the WS stream — RedTeam F3). Keep the existing `lastPush`/seed/transition dedup guards upstream of the fan-out unchanged (RedTeam F4 confirms reuse is correct).
3. **Security (RedTeam F5, re-rated Medium):** a webhook posts **plaintext to a third party**. `escalationPayload` body can be `a.error` = raw `err.message` (squad-manager.ts) carrying repo paths / command output / secret-shaped strings. Before any external POST: run the existing `redact()` (src/redact.ts:29 — catches `sk-`/`AKIA`/`gh_`/JWT/PEM/`KEY=value`) over title+body; **enforce https-only** on `OMP_SQUAD_WEBHOOK_URL`; document exactly which fields leave the box. (Web-push is exempt — E2E-encrypted to the operator's own device.)
4. **Urgency:** add `urgency?: "low"|"medium"|"high"` to `PendingRequest` (types.ts:31-46), set in `onUi`/`onHostTool` (squad-manager.ts:~1449/~1475), threaded into `PushPayload` (push.ts:23) **and** `escalationPayload` (server.ts:130 — the actual builder, copies `a.pending` urgency; use max-urgency across pending, RedTeam F7). **Do NOT reuse `RISKY_RE` verbatim** as the urgency signal — it's deliberately over-broad (`production|release|publish|deploy|drop` match benign plan-review text → every false positive is a page; RedTeam F6). High only for `source==="tool"` + a tight destructive subset; else medium; document the residual over-paging.

**Deliberately NOT in scope (ponytail, red-team-confirmed):** durable pending across daemon restart (attached-child model; deep link hits the live daemon); a new "ask-human" kind (the `ask` tool already surfaces as a blocking `PendingRequest`; urgency is the only missing signal); a second "budget-spent" escalation fire (the agent is already in `input` → already pushed; fold budget-spent into the urgency of the existing transition push, not a double-fire — RedTeam optional note).

### Goal 3 — Comment-driven review on artifacts (ONE unit, blocked by `web-framework`, seam corrected)

**Exists:** plan dirs → Features (`buildFeatures`/`listPlanDirs`/`parsePlanConcerns`, features.ts); RPI select gate (`raiseGate`, workflow-driver.ts:243); `Changes` diff panel. **Gap:** no feedback channel *on the artifact*, no path feeding comments into the next RPI phase.

**Collapsed into one `web-framework`-blocked unit (RedTeam F14/F16):** the backend has no CODE dep on the SPA but a hard VALUE dep — there is no non-SPA way to *create* a comment (the design refuses to touch legacy `src/web/index.html`), so landing the backend first is dead speculative infra. The whole goal ships together, after `web-framework` lands and with the operator (a human) in the loop at promote time to re-validate the seam.

**Design:**
- **Store = append-only event log, folded at read (RedTeam F11/F12):** JSONL cannot mutate `resolvedAt`. Append `{type:"add",...}` and `{type:"resolve",id,at}` events; `listComments` reduces add+resolve into current state — the "stateless reducer over an append log" the BRIEF praises (Part A F12). Reuse `audit.ts`'s append/read helper shape (torn-trailing-line skip comes free). `ArtifactComment { id, repo, planDir, file, body, author, urgent?, createdAt }`. **No line-level `anchor` in v1** (YAGNI — nothing populates it without the SPA, RedTeam F13).
- **API:** `GET /api/artifacts/comments?repo=&planDir=&unresolved=1`, `POST /api/artifacts/comments`, `POST /api/artifacts/comments/:id/resolve` (beside the features cluster, server.ts:~494). Manager methods audited via `recordAudit`.
- **UI:** comment thread on the Feature/artifact view in the new `webapp/` SPA.
- **Feed-forward — CORRECTED seam (RedTeam F8/F9/F10, critical):** the draft named `WorkflowDriver`, which never builds a stage prompt. The next stage's task is assembled in `SingleAgentExecutor.runAgent` (executor.ts:98-107, `parts=[Goal once, body, lastOutput]`). Add an injected `SingleAgentExecutorOptions.decoratePrompt?(node, ctx) => string` consumed there; plumb it through `WorkflowDriver`'s executor construction (workflow-driver.ts:~104-114). Thread `planDir` onto `WorkflowDriverOptions` (set by squad-manager when the run targets a plan dir); derive "phase" from `node.id`/`WF_STAGE`. **Guard:** inject comments only on the agent node immediately following a just-resolved gate (the engine sets `ctx.preferredLabel`), not every turn — the run is ONE persistent thread, so an unguarded decorate re-injects each turn (RedTeam F10). Specify the edge: comments feed the `revise→Plan` (and `approve→Implement`) transition.

---

## Key Decisions

| Decision | Choice | Alternatives | Rationale |
|---|---|---|---|
| Goal 1 abstraction | `decideTyped` transport+fallback wrapper; per-site coercion stays | One schema-driven `coerce` union | No duplicated coercion exists; union grows LOC + drifts semantics (RedTeam 5A/1C) |
| `land` in Goal 1? | **Excluded** | Add raw-text bool mode | Non-JSON + own transport + zero test coverage; a different category (RedTeam 1A) |
| Goal 1 test strategy | Extend EXISTING per-site tests + add uncovered-path fixtures; expected from running current fns | New helper-only fixture table | Parity is per-site; a helper-only table proves nothing about call-site behavior (RedTeam 2A) |
| Keep `parseDecision`/`chooseFallback` exported | Yes (bodies may delegate) | Inline into wrapper | Existing tests import them; inlining breaks module load (RedTeam 3B) |
| Sink contract | `notify` never throws/rejects; per-sink try/catch | Bare `void fetch()` | A throwing/rejecting sink kills the broadcast/presence path (RedTeam F1/F3) |
| External-channel security | `redact()` + https-only + documented field list | Forward payload as-is | Plaintext exfil of `err.message` to a third party (RedTeam F5) |
| Urgency signal | Tight subset (source=tool + narrow destructive), not `RISKY_RE` | Reuse `isRiskyRequest` | `RISKY_RE` is deliberately over-broad → false pages (RedTeam F6) |
| Comment store | Append-only event log, resolve-as-event, folded at read | Mutate `resolvedAt` in place | JSONL append-only can't mutate; rewrite races concurrent appends (RedTeam F11) |
| Goal 3 feed-forward seam | `SingleAgentExecutor.decoratePrompt` + `planDir` on driver + gate guard | Inject into `WorkflowDriver` | The driver never builds a stage prompt; the executor does (RedTeam F8/F9/F10) |
| Goal 3 sequencing | One unit, BLOCKED_BY `web-framework`; after Goal 2 | Land backend (3a/3b) first | Backend is dead code without the comment-creating UI (RedTeam F14) |
| Goal 2 ∥ Goal 3 | Sequential (2 → 3) | Parallel | Both edit `server.ts`+`squad-manager.ts`; lease serializes (RedTeam 4B) |

## Risks (final)

- **R1 — Goal 1 behavior drift.** Mitigated by 1b: pin current behavior (incl. the untested land/asApproval/snapToOption-overlap paths) FIRST, refactor `decideTyped` under green; keep exports.
- **R2 — Goal 2 external data leak (Medium).** Mitigated by `redact()` + https-only + documented field allowlist before any external POST.
- **R3 — Goal 2 sink failure cascades.** Mitigated by the never-throw contract + per-sink try/catch + fetch timeout.
- **R4 — Goal 3 self-drive mis-build.** The corrected seam (decoratePrompt/planDir/gate-guard) is encoded in the concern doc; promote-time re-validation by a human is required (the operator is in the loop because Goal 3 waits on `web-framework`).
- **R5 — Goal 2/3 shared-file thrash.** Sequence 2 → 3; both note the other's `server.ts`/`squad-manager.ts` regions.

## Open Questions — RESOLVED

- **Q1 (coerce return shape):** Moot — the union is dropped. `decideTyped` returns whatever the injected `parse` returns; `supervisor.parseDecision` stays the kind→submit-string mapper, exported.
- **Q2 (budget-spent escalation):** Resolved NO separate fire — fold "budget spent" into the urgency of the already-fired transition push (the agent is already `input`).
- **Q3 (comment anchor granularity):** Resolved — no line-anchor in v1 (file-level only); revisit with the SPA if needed.

---

## Red Team Concerns Addressed

| # | Severity | Concern | Resolution |
|---|---|---|---|
| 1A | critical | `land` reviewer is non-JSON boolean w/ negative guard, zero tests; `coerce` breaks it silently | Exclude `land` from Goal 1; add characterization test for `defaultReviewer` |
| 5A | critical (over-eng) | "5 duplicated parsers" false; union over non-duplicated code grows LOC | Shrink to `decideTyped` transport+fallback wrapper; keep per-site coercion |
| F8 | critical | Feed-forward names `WorkflowDriver`, which builds no stage prompt | Re-point to `SingleAgentExecutor.decoratePrompt` (executor.ts:98-107) |
| F9 | critical | `getUnresolvedComments(planDir,phase)` has no arg source at the seam | Thread `planDir` on `WorkflowDriverOptions`; derive phase from `node.id`/`WF_STAGE` |
| 1B/1C/1D/1E/1F/1G | significant | bool/enum/scalar/array semantics diverge per site | Per-site coercion stays; tests pin each (incl. snapToOption two-phase ordering, owns trim) |
| 2A | significant | "no tests" premise false; helper-only table proves nothing | Extend existing per-site tests; add only the uncovered drift paths |
| 3B | significant | Inlining breaks test imports | Keep `parseDecision`/`chooseFallback` exported |
| F1/F2/F3 | significant | Sink throws/rejects/hangs → kills alert+broadcast path | never-throw contract, per-sink try/catch, `AbortSignal.timeout(5000)` |
| F5 | significant | Plaintext exfil to third-party channel | `redact()` + https-only + documented field list |
| F6 | significant | `RISKY_RE` urgency cries wolf | Tight urgency subset, not the auto-supervise gate |
| F7/4C | significant/minor | Urgency seam is `escalationPayload` (server.ts:130), citations off | Fixed TOUCHES; thread urgency through `escalationPayload` + `PushPayload`, max across pending |
| F11/F12 | significant | JSONL can't mutate `resolvedAt` | Resolve-as-event, fold at read; reuse audit append/read shape |
| F10 | significant | Persistent thread → comments re-inject every turn | Guard on just-resolved gate, immediately-following node only |
| F13 | significant | File-anchor useless without SPA | Drop anchor from v1 |
| F14/F16 | significant | Backend dead code without UI; self-drive amplifies mis-spec | Collapse Goal 3 into one `web-framework`-blocked unit; human re-validates at promote |
| 4A/4B | significant | R6 mis-grounded; Goal 2∥3 not file-disjoint | Corrected: Goal 1 ∥ Goal 2; Goal 3 after Goal 2 |
| F4/3A/durable-pending/no-new-kind | hold | Dedup reuse, leaf-module, attached-child, ask-tool reuse | Confirmed sound — no change |

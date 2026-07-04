# `decideTyped` — one transport+fallback wrapper for LLM decisions

STATUS: closed
PRIORITY: p1
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/omp-call.ts, src/supervisor.ts, src/smart-spawn.ts
BLOCKED_BY: 01-coercion-characterization-tests
VERIFY_BLOCKER: `bun test tests/llm-coerce.test.ts tests/supervisor.test.ts` is green (parity fixtures exist and pass against current code)

## Goal

Centralize the ONE genuinely-repeated shape across the fleet's LLM-decision calls — *"one-shot `omp` → if non-zero exit or empty output, use the fallback → else run this site's parser → if the parse fails, use the fallback"* — into a single tiny helper, so the fallback discipline is uniform and future call sites inherit it (and so the optional bounded retry, BRIEF Pattern 6, has one home). 

**This is deliberately small.** The draft's "collapse 5 hand-rolled parsers into one schema-driven `coerce`" was rejected (RedTeam 5A): there is no duplicated *coercion* — each coercer is single-site with incompatible semantics, and `extractJsonObject`/`ompOneShot` are already deduped. Only the transport+fallback wrapper repeats, and cleanly only at **two** sites. Each site keeps its existing parser verbatim → zero semantic drift (guarded by 01's parity tests).

## Approach

### 1. Add `decideTyped` to `src/omp-call.ts` (leaf module; no import cycle — RedTeam 3A)
```ts
/**
 * One-shot omp decision with a guaranteed fallback. Runs `ompOneShot(args)`; on
 * non-zero exit / empty output / a parse that returns undefined, returns `fallback`.
 * `retries` (default 0 = today's single-shot behavior) adds bounded re-attempts
 * before the fallback — for transient model hiccups (BRIEF Pattern 6). Never throws.
 */
export async function decideTyped<T>(opts: {
  args: string[];
  parse: (raw: string) => T | undefined;
  fallback: T;
  bin?: string;
  timeoutMs?: number;
  retries?: number;
}): Promise<T> {
  const attempts = Math.max(1, 1 + (opts.retries ?? 0));
  for (let i = 0; i < attempts; i++) {
    const { out, code } = await ompOneShot(opts.args, { bin: opts.bin, timeoutMs: opts.timeoutMs });
    if (code === 0 && out) {
      const v = opts.parse(out);
      if (v !== undefined) return v;
    }
  }
  return opts.fallback;
}
```
Add a small unit test in `tests/omp-call.test.ts` (inject a fake via the existing test seam, or test `parse`/fallback selection with a stub) covering: clean parse returns the value; non-zero exit → fallback; empty out → fallback; parse→undefined → fallback; `retries:1` re-attempts once.

### 2. Migrate `supervisor.decide` (src/supervisor.ts:200-215)
Replace the try/`ompOneShot`/`extractAssistantText`/`parseDecision` body with:
```ts
export async function decide(req: PendingRequest, context: string, opts?: { model?: string }): Promise<string> {
  const prompt = formatRequestPrompt(req, context);
  const args = ["-p", "--mode", "json", ...(opts?.model ? ["--model", opts.model] : ["--smol"]), "--system-prompt", SUPERVISOR_SYSTEM, prompt];
  return decideTyped<string>({
    args, timeoutMs: DECIDE_TIMEOUT_MS,
    parse: (out) => { const t = extractAssistantText(out); return t.trim() ? parseDecision(t, req) : undefined; },
    fallback: chooseFallback(req),
  });
}
```
Behavior-identical: code≠0 → fallback; empty assistant text → fallback (parse returns undefined); else `parseDecision`. `parseDecision`/`chooseFallback`/`formatRequestPrompt`/`extractAssistantText` stay as-is. **Keep `parseDecision` and `chooseFallback` exported** — `tests/supervisor.test.ts` imports them (RedTeam 3B).

### 3. Migrate `smart-spawn.infer` (src/smart-spawn.ts:126-131)
```ts
async function infer(prompt: string, candidates: string[]): Promise<RawPlan | undefined> {
  const user = `Candidate repos:\n${candidates.map((c) => `- ${c}`).join("\n")}\n\nTask: ${prompt}\n\nJSON:`;
  return decideTyped<RawPlan | undefined>({
    args: ["-p", "--smol", "--system-prompt", SYSTEM_PROMPT, user], timeoutMs: INFER_TIMEOUT_MS,
    parse: parsePlanJson, fallback: undefined,
  });
}
```
Behavior-identical: code≠0 → undefined; else `parsePlanJson(out)` (which already returns undefined on no-JSON). `planSpawn`'s existing `raw?.repo === undefined` heuristic path is unchanged.

### Explicitly NOT migrated
- **`intake.llmRoute`** — uses an *injected* `Classify` (not `ompOneShot` directly) and a *lazy async heuristic* fallback (`heuristicRoute`), not a constant value. Forcing it through `decideTyped` would need a thunk-fallback that bloats the helper for one awkward caller. Leave as-is (ponytail). `ompClassify` continues to wrap `ompOneShot`.
- **`land.defaultReviewer`** — non-JSON raw-text classification with its own `Bun.spawn` transport (RedTeam 1A). Not a fit. Its predicate is tested via `parseApproval` (concern 01).

## Cross-Repo Side Effects

None outside omp-squad. `decideTyped` is additive; the two migrations are internal refactors with no signature changes (`decide`/`infer` keep their signatures).

## Verify

- `bun test tests/supervisor.test.ts tests/smart-spawn.test.ts tests/llm-coerce.test.ts tests/omp-call.test.ts` → all green (parity preserved; this is the load-bearing check).
- `bun run check` → typecheck clean.
- Grep sanity: `decideTyped` referenced by `supervisor.ts` and `smart-spawn.ts`; `intake.ts`/`land.ts` unchanged.

## Resolution

CLOSED — landed in commit `1e1bce6`. Built + self-verified by an omp-squad fleet agent (`goal1-decidetyped`, dogfood), reviewed and integrated by the operator. `decideTyped` added to `omp-call.ts`; `supervisor.decide` + `smart-spawn.infer` migrated; `parseDecision`/`chooseFallback` kept exported; `intake`/`land` excluded by design. Gate green on main (45/47 across the Goal-1 suite; full combined Goal-1 gate 47/0). Behavior identical at both sites.

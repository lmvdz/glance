# Gate-class guard

STATUS: closed
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/types.ts, src/squad-manager.ts, src/supervisor.ts, webapp/src/lib/dto.ts, tests/gate-class.test.ts (new)

## Goal

A real workflow gate (`raiseGate` in `src/workflow-driver.ts`) must never be auto-answered by either of the two independent auto-approval engines in this codebase — the in-process `maybeAutoSupervise` and the external `src/supervisor.ts` process. Today `PendingRequest` has no marker distinguishing a gate from a routine confirm/select; both engines are approve-biased and neither is gate-aware. Stamp a `gateClass` boolean at the one place a gate is actually created, and short-circuit both engines on it BEFORE they spend any budget or make any LLM call.

## Approach

### 1. `PendingRequest.gateClass?: boolean` — `src/types.ts`

Verified current interface, `src/types.ts:32-47` (note: this is 15 lines, not the 12 originally cited — the interface's closing brace is at line 47):

```ts
export interface PendingRequest {
	/** Correlates with the answer the surface sends back. */
	id: string;
	/** Where it came from. */
	source: "ui" | "tool";
	/** UI method (confirm/input/select/editor) or the host tool name. */
	kind: string;
	title: string;
	/** confirm message / tool argument summary. */
	message?: string;
	/** select options. */
	options?: string[];
	/** input placeholder / editor prefill. */
	placeholder?: string;
	createdAt: number;
}
```

Add one optional field:

```ts
	/** True for a real workflow gate (raiseGate's gate_-id requests, or a GATE:-prefixed title) — never
	 *  auto-answered by maybeAutoSupervise or the external supervisor, regardless of budget/risk text. */
	gateClass?: boolean;
```

### 2. Stamp it in `onUi` — `src/squad-manager.ts:3124-3149`

Verified current body (the pending-request object literal, lines 3132-3141):

```ts
} else if (BLOCKING_UI_METHODS[req.method]) {
	added = {
		id: req.id,
		source: "ui",
		kind: req.method,
		title: "title" in req ? req.title : req.method,
		message: req.method === "confirm" ? req.message : undefined,
		options: req.method === "select" ? req.options : undefined,
		placeholder: req.method === "input" ? req.placeholder : req.method === "editor" ? req.prefill : undefined,
		createdAt: Date.now(),
	};
	rec.dto.pending = [...rec.dto.pending.filter((p) => p.id !== req.id), added];
	this.append(rec, "system", `⛔ needs input: ${added.title}`, { pending: { requestId: added.id, action: "created" }, status: "running" });
}
```

Add one field to the object literal:

```ts
		gateClass: req.id.startsWith("gate_") || ("title" in req && req.title.startsWith("GATE:")),
```

**Verified real emitter**: `raiseGate`, `src/workflow-driver.ts:295-310`, mints the id via `` `gate_${++this.gateSeq}` `` (line 296) and sets `title: node.label ?? node.id` (line 306) — there is currently **no** `GATE:`-prefixed-title path anywhere in the codebase; the `title.startsWith("GATE:")` check is a defensive secondary channel for any future manual/skill-authored gate that titles itself that way, not a currently-live emitter. Do not treat its absence as a bug — `req.id.startsWith("gate_")` is the one mechanism that actually fires today, and it is sufficient by itself to make Goal 3 falsifiably delivered.

Leave the rest of `onUi` (the `derive()`/`emitAgent`/`maybeAutoSupervise` tail at lines 3145-3148) completely unchanged — `maybeAutoSupervise(rec, added)` is still called for every request; the short-circuit happens INSIDE `maybeAutoSupervise` (below), not by skipping the call here.

### 3. Enforce in `maybeAutoSupervise` — BEFORE budget spend

Verified current body, `src/squad-manager.ts:2572-2592`:

```ts
private maybeAutoSupervise(rec: AgentRecord, req: PendingRequest): void {
	if (process.env.OMP_SQUAD_AUTOSUPERVISE === "0") return;
	const value = chooseFallback(req);
	if (!value) return;
	if (this.isRiskyRequest(req)) {
		this.log("info", `autosupervise: SKIP risky "${req.title}" on ${rec.dto.name} (left for human)`);
		return;
	}
	const budget = Number(process.env.OMP_SQUAD_AUTOSUPERVISE_BUDGET) || 5;
	const used = this.superviseBudget.get(rec.dto.id) ?? 0;
	if (used >= budget) { ... return; }
	this.superviseBudget.set(rec.dto.id, used + 1);
	...
}
```

Insert the gate-class check as the FIRST line of the function body (before even the `OMP_SQUAD_AUTOSUPERVISE === "0"` env check is irrelevant here — a gate must be refused even if autosupervise is disabled entirely there is nothing to refuse; put it right after that guard, alongside `isRiskyRequest`, and definitely before the budget read at line 2580-2586):

```ts
private maybeAutoSupervise(rec: AgentRecord, req: PendingRequest): void {
	if (process.env.OMP_SQUAD_AUTOSUPERVISE === "0") return;
	if (req.gateClass) {
		this.log("info", `autosupervise: SKIP gate "${req.title}" on ${rec.dto.name} (never auto-answered)`);
		return;
	}
	const value = chooseFallback(req);
	...
```

This mirrors `isRiskyRequest`'s existing skip-and-log pattern exactly (same log level, same "left for human" tone) and runs before `chooseFallback`/budget spend — a gate never consumes an agent's autosupervise budget.

### 4. Enforce in the external supervisor — BEFORE `decide()` (no LLM call)

Verified current body, `src/supervisor.ts:269-299`:

```ts
const resolveRequest = async (agent: AgentDTO, req: PendingRequest): Promise<void> => {
	let value: string;
	try {
		const context = await fetchContext(base, agent.id, token);
		value = await decide(req, context, opts.model ? { model: opts.model } : undefined);
	} catch {
		value = chooseFallback(req);
	}
	...
};

const handleAgent = (agent: AgentDTO): void => {
	if (agent.status !== "input") return;
	for (const req of agent.pending) {
		if (answered.has(req.id) || inflight.has(req.id)) continue;
		inflight.add(req.id);
		void resolveRequest(agent, req).finally(() => inflight.delete(req.id));
	}
};
```

Guard in `handleAgent`'s loop, BEFORE `inflight.add`/`resolveRequest` are even reached (cheaper than guarding inside `resolveRequest` — a gate is never marked inflight, never fetches context, never calls `decide()`):

```ts
const handleAgent = (agent: AgentDTO): void => {
	if (agent.status !== "input") return;
	for (const req of agent.pending) {
		if (req.gateClass) continue; // never auto-answered — no LLM call, no inflight mark
		if (answered.has(req.id) || inflight.has(req.id)) continue;
		inflight.add(req.id);
		void resolveRequest(agent, req).finally(() => inflight.delete(req.id));
	}
};
```

### 5. Webapp DTO mirror

Check `webapp/src/lib/dto.ts` for a mirrored `PendingRequest`-shaped type on the pending-requests array (the webapp's `AgentDTO` carries a `pending` field mirroring the server shape — confirm the exact type name at implementation time). If one exists, add `gateClass?: boolean;` to it so a future webapp gate-badge (out of scope for this concern) has the field available; this is additive typing only, no UI change in this concern.

## Cross-Repo Side Effects

None — single repo.

## Verify

- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test tests/gate-class.test.ts` — ONE shared test file driving BOTH engines against the same scripted gate-shaped `PendingRequest` (`{ id: "gate_1", gateClass: true, source: "ui", kind: "select", title: "…", options: [...], createdAt: ... }`):
  - `maybeAutoSupervise(rec, gateReq)` never calls `answerPending`/mutates `rec.dto.pending`, and does not touch `superviseBudget` for that agent — while an otherwise-identical plain `confirm` request (`gateClass` absent) with an unambiguous yes/no IS auto-answered by the same call, proving the guard is gate-class-specific, not a blanket regression.
  - `supervisor.ts`'s `handleAgent`/`resolveRequest` path (inject a fake `fetchContext`/`decide` that would throw if called) never calls `decide()` or marks the gate request `inflight`/`answered` for a `gateClass` request, while the same plain-confirm request IS resolved (asserting the mock `decide`/`chooseFallback` fallback WAS invoked).
- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test tests/manager-autonomy.test.ts tests/supervisor.test.ts` — existing approve-bias assertions for non-gate kinds still pass unchanged.
- `bun run check`

## Resolution

Closed 2026-07-04 via commit b4db5a2 on branch worktree-research-direct-vs-glance. gateClass stamped in onUi (gate_ id + GATE: title) and enforced in both auto-answer engines; supervisor loop extracted to createSupervisorLoop for DI testing; 5 new tests.
Post-execution hardening: ce72f8e (cross-batch audit follow-ups: proof-first unlanded-work, honest unverified proofs, ledger retirement, autoclose-off retirement, divergence runbook) and the code-review fix commit that follows it (10 confirmed findings: push-probe fast-forward trap, PR-mode staleGate/commitWip/force-audit, proof tip-coverage, forced-pr default-branch, method-agnostic reconcile, ledger PR-number refresh).

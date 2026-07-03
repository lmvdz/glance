# Guarded lifecycle write-path

STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/agent-lifecycle.ts (new), src/squad-manager.ts, src/types.ts, tests/agent-lifecycle.test.ts (new), tests/lifecycle-enforcement.test.ts (new)

## Goal

Every `AgentStatus` transition and every `pending[]` mutation on `SquadManager` goes through exactly two guarded methods — `transition()` and `setPending()` — instead of ~19 scattered `rec.dto.status = ...` / `rec.dto.pending = ...` assignments. The guard reproduces today's behavior exactly at every site (verified below); it is a floor under the existing logic, not a rewrite of it. A daemon restart must not pump replay-driven phantom transitions into history — a settle gate suppresses recording per reattached agent until its ring replay has drained. A `bun test` locks the door behind the migration so no new raw write can creep back in.

This concern does not add persistence (concern 02) or a DTO history tail (concern 03) — `transition()`/`setPending()` land here with a recording *hook* (an injectable no-op callback) that 02 fills in. Ship this concern with the hook wired to a trivial in-memory array so its own tests can assert on `{from,to,reason,at}` shape without depending on 02.

## Approach

### 1. `src/agent-lifecycle.ts` — new pure module, no `SquadManager` imports

```ts
import type { AgentStatus } from "./types.ts";

/** Reasons that derive status purely from existing signals (turn state, pending queue).
 *  Class D: sticky against stopped/error — mirrors derive()'s guard (squad-manager.ts:3240)
 *  and applyState's reconciliation guard (squad-manager.ts:3421) exactly. */
export type DerivedReason = "turn-progress" | "pending-add" | "pending-answer" | "pending-cancel";

/** Reasons the manager asserts explicitly (a human/operator/system act, not a derivation).
 *  Class E: legal from ANY state, including terminal→terminal — verified sites:
 *  exit-clean/exit-error do error↔stopped on a clean/dirty child exit (squad-manager.ts:2657-2664),
 *  catastrophe does any→error (1734), fail does any→error (3247), connect-begin walks
 *  stopped/error→starting in ensureConnected (2375), abort does any→stopped (2256). */
export type ExplicitReason =
	| "spawn" | "connect-begin" | "connect-ok" | "restart" | "kill" | "abort"
	| "exit-clean" | "exit-error" | "fail" | "catastrophe" | "task-start" | "branch-start" | "reattach" | "adopted";

export type TransitionReason = DerivedReason | ExplicitReason;

const DERIVED_REASONS = new Set<DerivedReason>(["turn-progress", "pending-add", "pending-answer", "pending-cancel"]);

export function isDerivedReason(reason: TransitionReason): reason is DerivedReason {
	return DERIVED_REASONS.has(reason as DerivedReason);
}

/** True if `to` is a legal transition from `from` given `reason`.
 *  Class D (derived): stopped/error are terminal — never leaves them (reproduces derive() line 3240).
 *  Class E (explicit): legal from any state, including terminal→terminal. */
export function canTransition(from: AgentStatus, to: AgentStatus, reason: TransitionReason): boolean {
	if (isDerivedReason(reason)) return !(from === "stopped" || from === "error");
	return true;
}

/** Pure status derivation — moved verbatim from SquadManager.derive() (squad-manager.ts:3239-3244).
 *  SquadManager.derive() becomes a thin wrapper calling this with rec's live fields. */
export function deriveStatus(input: { status: AgentStatus; pendingCount: number; streaming: boolean }): AgentStatus {
	if (input.status === "stopped" || input.status === "error") return input.status;
	if (input.pendingCount > 0) return "input";
	if (input.streaming) return "working";
	return "idle";
}
```

Keep this module free of `SquadManager`/`AgentRecord` imports — it must stay unit-testable with plain objects (`tests/agent-lifecycle.test.ts`). Do not build a Burr-style declared edge graph (`{from,to}` allow-list) — the code-verified sites below prove several explicit reasons are legal from every state, so a flat table would wrongly reject valid transitions (this was RT2's finding: `RESET_REASONS={restart,kill,spawn}` swallows catastrophe summons and wedges `ensureConnected`).

### 2. `SquadManager.transition()` and `SquadManager.setPending()`

Add near `derive()` (squad-manager.ts:3239). Signature:

```ts
/** The single guarded write-path for AgentStatus. Records {from,to,reason,at} via onTransition
 *  (concern 02 wires persistence; until then a no-op or in-memory sink). */
private transition(rec: AgentRecord, to: AgentStatus, reason: TransitionReason, cause?: { error?: string; priorId?: string; [k: string]: unknown }): void {
	const from = rec.dto.status;
	if (from === to) {
		if (isDerivedReason(reason)) return; // hot-path: no-op, no record (turn-progress fires per RPC frame)
		// same-state EVENT-class calls DO record — a second question while already "input", a repeat
		// catastrophe with new detail. This is the slice's headline deliverable; do not early-return here.
	} else if (!canTransition(from, to, reason)) {
		// unreached today (canTransition is permissive for explicit reasons, derived reasons never
		// request a leave-terminal move because call sites gate them first) — kept as a bug detector:
		this.recordDenied(rec, from, to, reason, cause);
		this.log("warn", `denied transition ${rec.dto.name}: ${from} -> ${to} (${reason})`);
		return;
	}
	if (this.reattached.has(rec.dto.id) && this.settling.has(rec.dto.id)) {
		rec.dto.status = to; // still apply the state change — only recording is suppressed during settle
		if (cause?.error !== undefined) rec.dto.error = cause.error;
		return;
	}
	rec.dto.status = to;
	if (cause?.error !== undefined) rec.dto.error = cause.error; // fixes fail/markCatastrophe push-payload ordering (S6)
	this.recordTransition(rec, from, to, reason, cause);
}
```

`setPending()` mirrors this for `rec.dto.pending`, taking an explicit `status` option for sites that manage status themselves (restart clears pending AND sets `starting` in one call — see site table):

```ts
private setPending(rec: AgentRecord, next: PendingRequest[], reason: DerivedReason, cause?: { priorId?: string; [k: string]: unknown }, opts?: { status?: AgentStatus }): void {
	rec.dto.pending = next;
	const to = opts?.status ?? this.derive(rec);
	this.transition(rec, to, opts?.status ? "spawn" /* restart already covers status via opts.status + its own explicit call */ : reason, cause);
}
```

(Exact plumbing of `reason` through `setPending` → `transition` needs one more pass at implementation time — the important invariant to preserve is: **derived calls from `setPending` early-return on same-state exactly like direct `transition()` calls**, and **restart's explicit `starting` + pending-clear is one `transition(rec, "starting", "restart")` + one `setPending(rec, [], "pending-cancel")` pair, not a merged call** — keep them separate so restart's transition is recorded as `"restart"`, not silently absorbed into a derived reason.)

`recordDenied` / `recordTransition` are the concern-02 hook points — in this concern, stub them to push onto a small `private transitionLog: {from,to,reason,at,cause?,denied?}[]` capped ring (e.g. last 200) purely so `tests/agent-lifecycle.test.ts` has something to assert against; concern 02 replaces the stub body with the real `JsonlLog` write, no signature change.

### 3. Settle gate (replay-phantom-transition fix)

Seed `private readonly settling = new Set<string>()` alongside the existing `reattached` set (squad-manager.ts:386). In `attachExisting()` (squad-manager.ts:859-896):

```ts
this.settling.add(p.id);
await agent.start();               // line 892 — resolves once the host connection is up
await this.drainOneTick();         // new: one microtask/poll tick so in-flight ring-replay frames land
rec.dto.status = this.derive(rec); // unchanged — but now under settle suppression, so it applies without recording
this.reattached.add(p.id);
this.settling.delete(p.id);
this.transition(rec, rec.dto.status, "reattach", {}); // ONE synthetic entry now that settling is off
```

`drainOneTick()` — a small `await new Promise(r => setImmediate(r))` (or a scheduled microtask flush) is the acceptance-criterion-driven implementation; concern 01's test drives `attachExisting` against a scripted host replaying a large ring (fake `AgentDriver` emitting N `event`/`ui`/`hosttool` frames synchronously on `.start()`) and asserts the transition log recorded **zero** entries during the window and **exactly one** `"reattach"` entry after. Also suppress `maybeAutoSupervise` while `this.settling.has(rec.dto.id)` (closes the pre-existing replay re-auto-answer hazard — a UI frame replayed during settle must not trigger an auto-answer against a request the operator already answered pre-crash).

### 4. Per-site audit — the 19 status + 5 pending call sites

This is NOT a mechanical batch swap. Every site below keeps its existing local guard verbatim; only the raw assignment becomes a `transition()`/`setPending()` call with the reason from this table. Line numbers are as of this concern's base commit — re-grep (`rec.dto.status =` / `rec.dto.pending =` in squad-manager.ts) before editing since earlier sites in the file shift numbers for later ones as you edit top-to-bottom.

| Line (approx) | Site | Old write | New call | Reason | Notes |
|---|---|---|---|---|---|
| 893 | `attachExisting` | `rec.dto.status = this.derive(rec)` | handled by settle gate (§3) | `reattach` | synthetic, post-settle only |
| 1734 | `markCatastrophe` | `rec.dto.status = "error"` | `this.transition(rec, "error", "catastrophe", { error: \`CATASTROPHE: ${detail}\` })` | `catastrophe` | remove the now-redundant `rec.dto.error =` line below it — transition() sets it |
| 2159 | `create()` post-start | `rec.dto.status = "idle"` | `this.transition(rec, "idle", "connect-ok")` | `connect-ok` | |
| 2165 | `create()` task prompt | `rec.dto.status = "working"` | `this.transition(rec, "working", "task-start")` | `task-start` | keep `rec.streaming = true` immediately before, unchanged |
| 2256 | `runAgentTask` onAbort | `rec.dto.status = "stopped"` | `this.transition(rec, "stopped", "abort")` | `abort` | |
| 2277 | `runAgentTask` start | `rec.dto.status = "working"` | `this.transition(rec, "working", "branch-start")` | `branch-start` | |
| 2375 | `ensureConnected` begin | `rec.dto.status = "starting"` | `this.transition(rec, "starting", "connect-begin")` | `connect-begin` | explicit-class: legal from stopped/error (this is the site that proves the flat RESET_REASONS table wrong) |
| 2379 | `ensureConnected` end | `rec.dto.status = "idle"` | `this.transition(rec, "idle", "connect-ok")` | `connect-ok` | |
| 2464 | (verify call site — re-grep, was reported as a match but not read in detail; treat as `task-start` unless inspection shows otherwise) | `rec.dto.status = "working"` | `this.transition(rec, "working", "task-start")` | `task-start` | confirm local guard before/after during implementation |
| 2499 | `answerPending`-adjacent "kill" command | `rec.dto.status = "stopped"` | `this.transition(rec, "stopped", "kill")` | `kill` | |
| 2604 | `restart()` begin | `rec.dto.status = "starting"` | `this.transition(rec, "starting", "restart")` | `restart` | pair with `setPending(rec, [], "pending-cancel")` below (was `rec.dto.pending = []` at 2605) — keep as two separate calls, see §2 |
| 2618 | `restart()` success | `rec.dto.status = "idle"` | `this.transition(rec, "idle", "connect-ok")` | `connect-ok` | |
| 2657-2660 | `wire()` exit handler | `if (rec.dto.status !== "stopped") { rec.dto.status = code === 0 ? "stopped" : "error"; if (code !== 0) rec.dto.error = ... }` | keep the `if (rec.dto.status !== "stopped")` guard **verbatim**, then `this.transition(rec, code === 0 ? "stopped" : "error", code === 0 ? "exit-clean" : "exit-error", code !== 0 ? { error: \`agent exited (code ${code})\` } : undefined)` | `exit-clean` / `exit-error` | THE site proving error→stopped-on-clean-exit is legal explicit-class behavior; guard preserved so exit-from-already-stopped stays inert exactly as today |
| 2762 | `onAgentEvent` tail | `rec.dto.status = this.derive(rec)` | `this.transition(rec, this.derive(rec), "turn-progress")` | `turn-progress` | hottest site — early-return path matters most here |
| 3145 | `onUi` tail | `rec.dto.status = this.derive(rec)` | `this.transition(rec, this.derive(rec), "turn-progress")` | `turn-progress` | derive() already reflects the pending mutation applied earlier in this same function via `setPending` |
| 3191 | (second `derive()` write, re-grep to confirm exact site — the raw grep showed two hits at 3191 areas near `onHostTool`) | `rec.dto.status = this.derive(rec)` | `this.transition(rec, this.derive(rec), "turn-progress")` | `turn-progress` | |
| 3247 | `fail()` | `rec.dto.status = "error"; rec.dto.error = ...` | `this.transition(rec, "error", "fail", { error: err instanceof Error ? err.message : String(err) })` | `fail` | delete the now-redundant `rec.dto.error =` line — transition() sets it (fixes S6 push-payload ordering) |
| 3421 | `applyState` reconciliation | `if (rec.dto.status !== "stopped" && rec.dto.status !== "error") rec.dto.status = this.derive(rec)` | keep the `if` guard **verbatim**, then `this.transition(rec, this.derive(rec), "turn-progress")` inside it | `turn-progress` | |

Pending sites (5):

| Line (approx) | Site | Old write | New call | Reason |
|---|---|---|---|---|
| 2552 | `answerPending` | `rec.dto.pending = rec.dto.pending.filter(...)` then later `rec.dto.status = this.derive(rec)` at 2555 | set `rec.streaming = true` **before** calling `setPending` (today's ordering at 2552-2555 already does status-derive after the filter — this is a trivial, behavior-identical reorder so exactly one `input→working` entry records, not a phantom pair) — `this.setPending(rec, rec.dto.pending.filter(p => p.id !== req.id), "pending-answer")` | `pending-answer` |
| 2605 | `restart()` | `rec.dto.pending = []` | `this.setPending(rec, [], "pending-cancel")` | `pending-cancel` — see restart pairing note above |
| 3127 | `onUi` cancel | `rec.dto.pending = rec.dto.pending.filter(p => p.id !== req.targetId)` | `this.setPending(rec, rec.dto.pending.filter(p => p.id !== req.targetId), "pending-cancel")` | `pending-cancel` |
| 3142 | `onUi` add (blocking UI method) | `rec.dto.pending = [...rec.dto.pending.filter(p => p.id !== req.id), added]` | `this.setPending(rec, [...rec.dto.pending.filter(p => p.id !== req.id), added], "pending-add")` | `pending-add` |
| 3189 | `onHostTool` add | `rec.dto.pending = [...rec.dto.pending.filter(p => p.id !== call.id), pending]` | `this.setPending(rec, [...rec.dto.pending.filter(p => p.id !== call.id), pending], "pending-add")` | `pending-add` |

Two additional AgentRecord/AgentDTO **literal construction** sites (887, 2350-2365) set `status: "starting"` / `status: "idle"` as part of an object literal, not an assignment — these are whitelisted in the enforcement test (§5), not converted to `transition()` calls (there is no prior state to transition *from* at construction time).

### 5. Enforcement test — `tests/lifecycle-enforcement.test.ts`

A CI grep is bypassable (`(rec.dto as any).status =`, destructured aliases) and the local `rtk` hook mangles bash `grep` output, so enforcement is a `bun test` that parses the source file directly:

```ts
import { readFileSync } from "node:fs";
import { test, expect } from "bun:test";

test("no raw AgentStatus/pending writes outside transition()/setPending()", () => {
	const src = readFileSync(new URL("../src/squad-manager.ts", import.meta.url), "utf8");
	// Match `.dto.status =` / `.dto.pending =` (not `==`, not object-literal `status:`), track which
	// method body each line falls inside via a running brace-depth scan seeded at each `private`/`async`
	// method declaration, and assert every hit is inside `transition`, `setPending`, or one of the two
	// whitelisted literal-construction methods (`attachExisting`, `restoreFlueMember`).
	const offenders = findRawLifecycleWrites(src); // helper walks line-by-line, see below
	expect(offenders).toEqual([]);
});
```

Implementation note for `findRawLifecycleWrites`: track current enclosing method name via a regex on lines matching `^\t(private |protected |async |public )` combined with brace-depth counting from that line; for each line matching `/\.dto\.(status|pending)\s*=\s*[^=]/` (excluding `!==`/`===`), check enclosing method against an allow-list `["transition", "setPending", "attachExisting", "restoreFlueMember"]`. Keep the helper in the test file (not exported from `src/`) — it's test-only tooling, not production code.

## Cross-Repo Side Effects

None outside this repo. Within it: `src/orchestrator-state.ts`'s separate `Kind` enum is untouched (explicitly out of scope — different enum, different subsystem, noted in the research brief as a non-goal for this slice).

## Verify

- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test tests/agent-lifecycle.test.ts` — `canTransition`/`deriveStatus` pure-function cases: derived reasons never leave stopped/error, explicit reasons legal from every state including terminal→terminal (exit-clean from error, catastrophe from stopped, connect-begin from error).
- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test tests/lifecycle-enforcement.test.ts` — zero raw writes outside the two methods + two whitelisted literals.
- `PATH="$PATH:$(pwd)/node_modules/.bin" bun test` (full suite) — every existing squad-manager test (create/restart/kill/exit/catastrophe/answer flows) still passes with identical observable status transitions.
- New settle-gate test: script a fake `AgentDriver.start()` that synchronously emits 50+ `event`/`ui` frames before resolving; assert `attachExisting` records zero transition-log entries during that window and exactly one `"reattach"` entry after.
- `bun run check`

## Dependency graph

blockedBy: none — this is the foundation concern.

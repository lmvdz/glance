# Artifact comment store (append-only event log)

STATUS: cancelled
PRIORITY: p2
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: src/comments.ts (new), src/squad-manager.ts, tests/comments.test.ts (new)
BLOCKED_BY: web-framework (landed), 03-off-dashboard-escalation
VERIFY_BLOCKER: (a) `grep -rL "STATUS: open" plans/web-framework/*.md` shows all concerns closed AND `OMP_SQUAD_WEBAPP=1` serves the SPA; (b) `grep -q "NotificationSink" src/server.ts` (03 merged, so squad-manager.ts is rebased onto Goal 2)

## Goal

Persist human (and agent) review comments on a plan/research artifact, so review effort lands on the *plan* before 2,000 lines of code exist (HumanLayer "Tasks = sessions + artifacts"; BRIEF Pattern 4). This is the data layer; the API+UI (05) and RPI feed-forward (06) build on it.

> **Whole-of-Goal-3 gating (RedTeam F14/F16):** Goal 3 has no non-SPA way to *create* a comment (we don't touch legacy `src/web/index.html`), so the store is dead code without 05's UI. The entire goal is therefore one unit BLOCKED_BY `web-framework`. At promote time a human (the operator) must re-validate the 06 seam — a self-drive agent must not silently mis-wire it.

## Approach

### Event-log store (`src/comments.ts`, new) — resolve is an appended EVENT, folded at read
JSONL cannot mutate a `resolvedAt` field in place without a full rewrite that races concurrent appends (RedTeam F11). So model it as an append-only event log and reduce at read — the "stateless reducer over an append log" the BRIEF praises (Part A F12). **Reuse `src/audit.ts`'s append/read helper shape** so the torn-trailing-line skip comes for free (RedTeam F12; audit.ts:55-95).

```ts
export interface ArtifactComment {
  id: string; repo: string; planDir: string; file: string;   // file = a plan-dir-relative md filename; NO line anchor in v1 (YAGNI — RedTeam F13)
  body: string; author: string; urgent?: boolean; createdAt: number;
}
type CommentEvent =
  | ({ type: "add" } & ArtifactComment)
  | { type: "resolve"; id: string; at: number };

// append {type:"add"} / {type:"resolve"} to <stateDir>/comments.jsonl
export async function appendCommentEvent(stateDir: string, ev: CommentEvent): Promise<void>;
// read all events, fold add+resolve → current open/resolved state, filter by repo/planDir
export async function listComments(stateDir: string, q: { repo: string; planDir: string; unresolved?: boolean }): Promise<(ArtifactComment & { resolvedAt?: number })[]>;
```
`listComments` folds: an `add` introduces a comment; a later `resolve` sets its `resolvedAt`; `unresolved` filters out resolved ones. Order preserved by append order.

### Manager methods (`src/squad-manager.ts`, near `recordAudit` ≈ :1428-1446 — verify on read)
- `async addComment(input, actor): Promise<ArtifactComment>` → mints id, `appendCommentEvent({type:"add",...})`, `recordAudit(actor, "comment", ...)`, returns it.
- `async listComments(q): Promise<...>` → delegates to the store with the manager's `stateDir`.
- `async resolveComment(id, actor): Promise<void>` → `appendCommentEvent({type:"resolve",...})`, audited.
- `getUnresolvedComments(planDir): string[]` synchronous-ish accessor (or async) returning unresolved comment bodies for a plan dir — consumed by 06. (If async, 06 awaits it during prompt decoration.)

Add `"comment"` to the audit action union if it is a closed set.

## Cross-Repo Side Effects

None outside omp-squad. New `comments.jsonl` under the state dir (alongside `audit.jsonl`/receipts). `src/server.ts` endpoints (05) and the RPI feed-forward (06) consume these methods.

## Verify

- `tests/comments.test.ts`: add two comments → `listComments` returns both; resolve one → `unresolved:true` returns only the other, `unresolved:false` returns both with `resolvedAt` set on the resolved one; a torn trailing line is skipped (mirror audit's test). Pure, offline.
- `bun run check` clean.
